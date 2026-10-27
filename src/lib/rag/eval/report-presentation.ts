import { z } from 'zod';
import { summarizeEvalCaseResults } from './metrics';
import type { RagEvalCaseResult, RagEvalCompletedCaseResult, RagEvalRunReport } from './types';

const identity = z.string().min(1).max(1024);
const count = z.number().int().nonnegative();
const measurement = z.number().nonnegative();
const score = z.number().min(0).max(1).nullable();
const evidenceSchema = z.object({
  evidenceId: identity, score: z.number(), content: z.string(), source: z.string(),
  tenantId: z.string().optional(), corpusId: z.string().optional(), documentId: z.string().optional(),
  documentVersion: z.string().optional(), laneId: z.string().optional(),
  trustLevel: z.enum(['trusted', 'reviewed', 'external', 'quarantined']).optional(),
});
const caseSchema = z.discriminatedUnion('status', [
  z.object({ caseId: identity, status: z.literal('failed'), error: z.string() }),
  z.object({
    caseId: identity, status: z.literal('completed'), answer: z.string(),
    abstained: z.boolean(), expectedAbstain: z.boolean(),
    evidence: z.array(evidenceSchema).max(2000),
    retrieval: z.object({ recallAtK: score, reciprocalRankAtK: score, ndcgAtK: score }),
    answerMetrics: z.object({ requiredFactCoverage: score, abstainCorrect: z.boolean() }),
    citations: z.object({ validity: score, precision: score, coverage: score, meanSpanIou: score }),
    citationDetails: z.array(z.object({ evidenceId: identity, startOffset: count, endOffset: count })).max(2000),
    security: z.object({
      crossTenantHits: count, crossCorpusHits: count, disallowedTrustHits: count,
      forbiddenEvidenceHits: count, forbiddenAnswerPatternHits: count, disallowedPolicyHits: count, disallowedLaneHits: count,
    }),
    usage: z.object({
      retrievalLatencyMs: measurement, generationLatencyMs: measurement, totalLatencyMs: measurement,
      embeddingCalls: count, generationCalls: count,
      inputTokens: count.optional(), outputTokens: count.optional(), costUsd: measurement.optional(),
      tokenMeasurement: z.enum(['provider', 'partial', 'estimated', 'unavailable']),
      costMeasurement: z.enum(['provider', 'configured-estimate', 'unavailable']),
    }),
    policyId: z.string().optional(), laneIds: z.array(z.string()).optional(), traceId: z.string().optional(),
  }),
]);
const reportSchema = z.object({
  schemaVersion: z.literal('rag-eval-run/v1'),
  runId: identity, startedAt: z.string(), completedAt: z.string(),
  dataset: z.object({
    schemaVersion: z.enum(['rag-eval-dataset/v1', 'rag-eval-dataset/v2']),
    id: identity, version: identity, sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }),
  target: z.object({ id: identity }), configuration: z.object({ topK: z.number().int().positive() }),
  metadata: z.record(z.string(), z.unknown()).optional(),
  cases: z.array(caseSchema).max(10000),
});

function readReport(value: unknown): RagEvalRunReport {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('评测报告格式无效：' + parsed.error.issues[0].path.join('.'));
  }
  const report = parsed.data;
  const caseIds = new Set<string>();
  for (const item of report.cases) {
    if (caseIds.has(item.caseId)) throw new Error('评测报告包含重复的问题 ID');
    caseIds.add(item.caseId);
    if (item.status === 'completed') {
      const usage = item.usage;
      const completeTokens = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
      const anyTokens = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
      if ((usage.tokenMeasurement === 'provider' || usage.tokenMeasurement === 'estimated') ? !completeTokens : anyTokens) {
        throw new Error('评测报告的 Token 计量声明与完整总量不一致');
      }
      if ((usage.costMeasurement === 'unavailable') !== (usage.costUsd === undefined)) {
        throw new Error('评测报告的费用计量声明与总量不一致');
      }
    }
    if (item.status === 'completed' && new Set(item.evidence.map(evidence => evidence.evidenceId)).size !== item.evidence.length) {
      throw new Error('评测报告包含重复的证据 ID');
    }
  }
  return { ...report, summary: summarizeEvalCaseResults(report.cases) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseRagEvalArtifact(text: string): { reports: RagEvalRunReport[]; baselineRunId?: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('无法解析评测 JSON，请选择完整的报告文件'); }
  if (!isRecord(value)) throw new Error('评测报告必须是 JSON 对象');
  let reports: RagEvalRunReport[];
  let baselineRunId: string | undefined;
  if (value.schemaVersion === 'rag-eval-run/v1') {
    reports = [readReport(value)];
  } else if (value.schemaVersion === 'rag-eval-matrix/v1' && Array.isArray(value.targets) && value.targets.length <= 24) {
    reports = value.targets.map(item => readReport(isRecord(item) ? item.report : undefined));
    baselineRunId = reports.find(report => report.target.id === value.baselineTargetId)?.runId;
  } else if (value.schemaVersion === 'scoped-agent-eval/v1' && Array.isArray(value.reports) && value.reports.length <= 24) {
    reports = value.reports.map(readReport);
  } else {
    throw new Error('不支持此评测报告版本，请导入 rag-eval、matrix 或 scoped-agent 报告');
  }
  if (!reports.length || new Set(reports.map(report => report.runId)).size !== reports.length) {
    throw new Error('评测报告为空或包含重复的运行 ID');
  }
  return { reports, baselineRunId: baselineRunId ?? reports[0].runId };
}

export function describeEvalProvenance(report: RagEvalRunReport): {
  kind: 'fixture' | 'production' | 'unknown'; label: string;
} {
  const metadata = report.metadata ?? {};
  const fixture = report.target.id.startsWith('fixture-') || metadata.provider === 'fake'
    || [metadata.runner, metadata.retrieval, metadata.rerank].some(value =>
      typeof value === 'string' && /fixture|hermetic|deterministic/i.test(value));
  if (fixture || metadata.productionQualityMeasured === false) return { kind: 'fixture', label: '模拟 / 夹具评测' };
  if (metadata.productionQualityMeasured === true) return { kind: 'production', label: '真实链路（报告声明）' };
  return { kind: 'unknown', label: '评测来源未声明' };
}

export function describeEvalUsage(report: RagEvalRunReport): { tokens: string; cost: string } {
  const completed = report.cases.filter((item): item is RagEvalCompletedCaseResult => item.status === 'completed');
  const tokenLabels = { provider: '提供方计量', estimated: '估算', partial: '部分计量', unavailable: '未计量' };
  const costLabels = { provider: '提供方计量', 'configured-estimate': '配置估算', unavailable: '未计量' };
  return {
    tokens: [...new Set(completed.map(item => tokenLabels[item.usage.tokenMeasurement]))].join(' / ') || '未计量',
    cost: [...new Set(completed.map(item => costLabels[item.usage.costMeasurement]))].join(' / ') || '未计量',
  };
}

export interface EvalMetricComparison {
  id: string;
  label: string;
  description: string;
  unit: 'score' | 'ms' | 'count' | 'usd';
  higherIsBetter: boolean;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  note?: string;
}

interface MetricSpec extends Pick<EvalMetricComparison, 'id' | 'label' | 'description' | 'unit' | 'higherIsBetter'> {
  read: (report: RagEvalRunReport) => number | null;
  caseValue: (item: RagEvalCompletedCaseResult) => number | null;
}

const METRICS: MetricSpec[] = [
  { id: 'recall', label: 'Recall@K', description: '标注相关证据的召回比例', unit: 'score', higherIsBetter: true,
    read: r => r.summary.meanRecallAtK, caseValue: c => c.retrieval.recallAtK },
  { id: 'mrr', label: 'MRR@K', description: '首条相关证据排名倒数的均值', unit: 'score', higherIsBetter: true,
    read: r => r.summary.meanReciprocalRankAtK, caseValue: c => c.retrieval.reciprocalRankAtK },
  { id: 'ndcg', label: 'NDCG@K', description: '按相关性等级衡量前排证据质量', unit: 'score', higherIsBetter: true,
    read: r => r.summary.meanNdcgAtK, caseValue: c => c.retrieval.ndcgAtK },
  { id: 'facts', label: '事实覆盖', description: '标注要点的文本匹配比例，非语义正确率', unit: 'score', higherIsBetter: true,
    read: r => r.summary.meanRequiredFactCoverage, caseValue: c => c.answerMetrics.requiredFactCoverage },
  { id: 'citations', label: '引用覆盖', description: '标注原文区间的覆盖率，非语义支持度', unit: 'score', higherIsBetter: true,
    read: r => r.summary.citation.meanCoverage, caseValue: c => c.citations.coverage },
  { id: 'abstain', label: '拒答准确率', description: '是否正确区分可回答与应拒答问题', unit: 'score', higherIsBetter: true,
    read: r => r.summary.abstainAccuracy, caseValue: c => c.answerMetrics.abstainCorrect ? 1 : 0 },
  { id: 'latency', label: 'P95 延迟', description: '95% 请求的总耗时不超过此值', unit: 'ms', higherIsBetter: false,
    read: r => r.summary.latencyMs.p95, caseValue: c => c.usage.totalLatencyMs },
  { id: 'tokens', label: '总 Token', description: '输入和输出合计；只比较完整计量', unit: 'count', higherIsBetter: false,
    read: r => r.summary.tokens.inputTotal === null || r.summary.tokens.outputTotal === null ? null
      : r.summary.tokens.inputTotal + r.summary.tokens.outputTotal,
    caseValue: c => c.usage.inputTokens === undefined || c.usage.outputTokens === undefined ? null
      : c.usage.inputTokens + c.usage.outputTokens },
  { id: 'cost', label: '总费用', description: 'USD；可能来自提供方或配置估算', unit: 'usd', higherIsBetter: false,
    read: r => r.summary.costUsd.total, caseValue: c => c.usage.costUsd ?? null },
];

export interface EvalCaseComparison {
  caseId: string;
  status: 'improved' | 'regressed' | 'unchanged' | 'unmeasured' | 'failed';
  baseline?: RagEvalCaseResult;
  candidate?: RagEvalCaseResult;
}

export function compareRagEvalReports(baseline: RagEvalRunReport, candidate: RagEvalRunReport): {
  issues: string[]; metrics: EvalMetricComparison[]; cases: EvalCaseComparison[];
} {
  const issues: string[] = [];
  if (baseline.dataset.sha256 !== candidate.dataset.sha256 || baseline.dataset.id !== candidate.dataset.id
    || baseline.dataset.version !== candidate.dataset.version || baseline.dataset.schemaVersion !== candidate.dataset.schemaVersion) {
    issues.push('数据集或文档快照不同，无法计算优化差值。');
  }
  if (baseline.configuration.topK !== candidate.configuration.topK) issues.push('Top K 不同，请固定相同的检索窗口再比较。');
  const baseCases = new Map(baseline.cases.map(item => [item.caseId, item]));
  const candidateCases = new Map(candidate.cases.map(item => [item.caseId, item]));
  if (baseCases.size !== candidateCases.size || [...baseCases.keys()].some(id => !candidateCases.has(id))) {
    issues.push('问题集合不同，请对同一批问题进行配对评测。');
  }
  if (describeEvalProvenance(baseline).kind !== describeEvalProvenance(candidate).kind) {
    issues.push('评测来源类型不同，模拟结果与真实链路不能混作优化对照。');
  }
  if (baseline.summary.failedCases || candidate.summary.failedCases) issues.push('存在执行失败；差值暂停计算，避免失败样本退出均值造成虚假提升。');
  if (!baseline.summary.completedCases || !candidate.summary.completedCases) issues.push('没有完整执行的样本。');
  for (const [id, item] of baseCases) {
    const other = candidateCases.get(id);
    if (item.status === 'completed' && other?.status === 'completed' && item.expectedAbstain !== other.expectedAbstain) {
      issues.push('同一问题的拒答标注不同。'); break;
    }
  }
  const metrics = METRICS.map(spec => {
    const eligible = (report: RagEvalRunReport) => report.cases.filter((item): item is RagEvalCompletedCaseResult =>
      item.status === 'completed' && spec.caseValue(item) !== null).map(item => item.caseId).sort();
    const baseEligible = eligible(baseline);
    const nextEligible = eligible(candidate);
    const coverageMismatch = baseEligible.length !== nextEligible.length || baseEligible.some((id, index) => id !== nextEligible[index]);
    const incompleteUsage = (spec.id === 'tokens' || spec.id === 'cost')
      && (baseEligible.length !== baseline.cases.length || nextEligible.length !== candidate.cases.length);
    const measurementMismatch = (spec.id === 'tokens' || spec.id === 'cost') && [...baseCases].some(([id, item]) => {
      const other = candidateCases.get(id);
      if (item.status !== 'completed' || other?.status !== 'completed') return false;
      return spec.id === 'tokens' ? item.usage.tokenMeasurement !== other.usage.tokenMeasurement
        : item.usage.costMeasurement !== other.usage.costMeasurement;
    });
    const before = spec.read(baseline);
    const after = spec.read(candidate);
    const note = measurementMismatch ? '计量方式不同，未计算差值'
      : coverageMismatch ? '标注或计量覆盖的问题不同，未计算差值'
      : incompleteUsage ? '计量覆盖不完整，未计算差值'
        : before === null || after === null ? '未标注 / 未计量' : undefined;
    return {
      id: spec.id, label: spec.label, description: spec.description, unit: spec.unit, higherIsBetter: spec.higherIsBetter,
      baseline: before, candidate: after, delta: issues.length || note ? null : after! - before!,
      ...(note ? { note } : {}),
    };
  });
  const cases: EvalCaseComparison[] = [...new Set([...baseCases.keys(), ...candidateCases.keys()])].map(caseId => {
    const before = baseCases.get(caseId);
    const after = candidateCases.get(caseId);
    let status: EvalCaseComparison['status'] = 'unmeasured';
    if (before?.status === 'failed' || after?.status === 'failed') status = 'failed';
    else if (!issues.length && before?.status === 'completed' && after?.status === 'completed') {
      const deltas = METRICS.filter(spec => spec.unit === 'score').flatMap(spec => {
        const a = spec.caseValue(before), b = spec.caseValue(after);
        return a === null || b === null ? [] : [b - a];
      });
      status = deltas.some(value => value < -1e-9) ? 'regressed'
        : deltas.some(value => value > 1e-9) ? 'improved' : deltas.length ? 'unchanged' : 'unmeasured';
    }
    return { caseId, status, baseline: before, candidate: after };
  });
  const priority = { regressed: 0, failed: 1, improved: 2, unchanged: 3, unmeasured: 4 };
  cases.sort((a, b) => priority[a.status] - priority[b.status] || a.caseId.localeCompare(b.caseId));
  return { issues, metrics, cases };
}

export function formatEvalMetric(value: number | null, unit: EvalMetricComparison['unit'], signed = false): string {
  if (value === null) return '—';
  const prefix = signed && value > 0 ? '+' : '';
  if (unit === 'score') return prefix + (value * 100).toFixed(1) + (signed ? ' pp' : '%');
  if (unit === 'usd') return prefix + '$' + value.toFixed(4);
  return prefix + value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + (unit === 'ms' ? ' ms' : '');
}
