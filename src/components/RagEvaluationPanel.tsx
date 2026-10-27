'use client';

import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  compareRagEvalReports, describeEvalProvenance, describeEvalUsage, formatEvalMetric, parseRagEvalArtifact,
  type EvalCaseComparison, type EvalMetricComparison,
} from '@/lib/rag/eval/report-presentation';
import type { RagEvalRunReport } from '@/lib/rag/eval/types';

const EMPTY_REPORTS: RagEvalRunReport[] = [];
const CASE_LABELS = { improved: '改善', regressed: '退步', unchanged: '持平', unmeasured: '未评测', failed: '执行失败' };
const CASE_STYLES = {
  improved: 'bg-emerald-50 text-emerald-800', regressed: 'bg-rose-50 text-rose-800',
  unchanged: 'bg-slate-100 text-slate-600', unmeasured: 'bg-slate-100 text-slate-500', failed: 'bg-amber-50 text-amber-800',
};

function Delta({ metric }: { metric: EvalMetricComparison }) {
  if (metric.delta === null) return <span className="text-slate-400" title={metric.note}>—</span>;
  const neutral = Math.abs(metric.delta) < 1e-9;
  const improved = metric.higherIsBetter ? metric.delta > 0 : metric.delta < 0;
  return <span className={'font-mono ' + (neutral ? 'text-slate-500' : improved ? 'text-emerald-700' : 'text-rose-700')}>
    {formatEvalMetric(neutral ? 0 : metric.delta, metric.unit, true)}
  </span>;
}

function CaseEvidence({ item }: { item: EvalCaseComparison }) {
  const before = item.baseline?.status === 'completed' ? item.baseline : undefined;
  const after = item.candidate?.status === 'completed' ? item.candidate : undefined;
  const baseRanks = new Map(before?.evidence.map((evidence, index) => [evidence.evidenceId, index + 1]));
  const nextRanks = new Map(after?.evidence.map((evidence, index) => [evidence.evidenceId, index + 1]));
  const evidence = new Map([...(before?.evidence ?? []), ...(after?.evidence ?? [])].map(value => [value.evidenceId, value]));
  return <div className="space-y-4 border-t border-slate-200 bg-slate-50 p-4 text-xs">
    <div className="grid gap-4 md:grid-cols-2">
      {([['基线回答', item.baseline], ['对照回答', item.candidate]] as const).map(([label, result]) => (
        <div key={label}>
          <h4 className="mb-2 font-medium text-slate-700">{label}</h4>
          <p className="max-h-36 overflow-auto whitespace-pre-wrap break-words leading-6 text-slate-600">
            {result?.status === 'completed' ? result.answer.slice(0, 2000) || '（空回答）'
              : result?.status === 'failed' ? '执行失败：' + result.error : '缺少此问题的结果'}
          </p>
          {result?.status === 'completed' ? <p className="mt-2 font-mono text-slate-500">
            Recall {formatEvalMetric(result.retrieval.recallAtK, 'score')} · NDCG {formatEvalMetric(result.retrieval.ndcgAtK, 'score')}
          </p> : null}
        </div>
      ))}
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[360px] text-left">
        <caption className="mb-2 text-left text-slate-500">输出证据排名（两次运行）；未出现表示该运行未返回此证据。</caption>
        <thead><tr className="border-b border-slate-200 text-slate-500">
          <th scope="col" className="py-2 font-medium">证据 / 来源</th>
          <th scope="col" className="py-2 font-medium">基线排名</th>
          <th scope="col" className="py-2 font-medium">对照排名</th>
        </tr></thead>
        <tbody>{[...evidence.values()].slice(0, 20).map(value => <tr key={value.evidenceId} className="border-b border-slate-100">
          <th scope="row" className="max-w-72 py-2 pr-4 text-left font-normal">
            <span className="block truncate" title={value.source}>{value.source}</span>
            <span className="block truncate font-mono text-[10px] text-slate-400" title={value.evidenceId}>{value.evidenceId}</span>
          </th>
          <td className="font-mono">{baseRanks.get(value.evidenceId) ?? '未出现'}</td>
          <td className="font-mono">{nextRanks.get(value.evidenceId) ?? '未出现'}</td>
        </tr>)}</tbody>
      </table>
      {evidence.size > 20 ? <p className="mt-2 text-slate-400">仅显示前 20 条证据，完整结果见原始报告。</p> : null}
    </div>
  </div>;
}

export default function RagEvaluationPanel({ initialReports = EMPTY_REPORTS }: { initialReports?: RagEvalRunReport[] }) {
  const [reports, setReports] = useState(initialReports);
  const [baselineId, setBaselineId] = useState(initialReports[0]?.runId ?? '');
  const [candidateId, setCandidateId] = useState(initialReports[1]?.runId ?? '');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [caseFilter, setCaseFilter] = useState('all');
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);
  const importSequence = useRef(0);
  const baseline = reports.find(report => report.runId === baselineId);
  const candidate = reports.find(report => report.runId === candidateId);
  const comparison = useMemo(() => baseline && candidate ? compareRagEvalReports(baseline, candidate) : null, [baseline, candidate]);
  const visibleCases = comparison?.cases.filter(item => caseFilter === 'all' || item.status === caseFilter) ?? [];
  const securityHits = candidate ? Object.values(candidate.summary.security).reduce((sum, value) => sum + value, 0) : 0;

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!files.length) return;
    const sequence = ++importSequence.current;
    setImporting(true);
    setError('');
    try {
      if (files.length > 8 || files.reduce((sum, file) => sum + file.size, 0) > 16 * 1024 * 1024) {
        throw new Error('每次最多导入 8 个文件，总大小不超过 16 MB。');
      }
      const artifacts = await Promise.all(files.map(async file => {
        if (file.size > 8 * 1024 * 1024) throw new Error(file.name + '：单个报告不能超过 8 MB。');
        try { return parseRagEvalArtifact(await file.text()); }
        catch (failure) { throw new Error(file.name + '：' + (failure instanceof Error ? failure.message : '读取失败')); }
      }));
      if (sequence !== importSequence.current) return;
      const incoming = artifacts.flatMap(artifact => artifact.reports);
      const merged = [...new Map([...reports, ...incoming].map(report => [report.runId, report])).values()];
      if (merged.length > 24) throw new Error('最多保留 24 次运行，请先清空再导入。');
      setReports(merged);
      const nextBaseline = baselineId || artifacts[0].baselineRunId || merged[0].runId;
      setBaselineId(nextBaseline);
      setCandidateId(candidateId || merged.find(report => report.runId !== nextBaseline)?.runId || '');
      setExpandedCaseId(null);
    } catch (failure) {
      if (sequence === importSequence.current) setError(failure instanceof Error ? failure.message : '评测报告导入失败');
    } finally {
      if (sequence === importSequence.current) setImporting(false);
    }
  }

  function clearReports() {
    importSequence.current++;
    setReports([]); setBaselineId(''); setCandidateId(''); setError(''); setImporting(false); setExpandedCaseId(null);
  }

  return <div className="space-y-6">
    <section className="rounded-xl border border-slate-200 bg-white p-5 md:p-6" aria-label="导入评测报告">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <h2 className="font-semibold">从一组可复现的对照开始</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
            支持单次、matrix 和 scoped-agent JSON 报告。文件仅在当前浏览器内读取，刷新页面后清空。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="relative cursor-pointer rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-900 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-sky-600">
            {importing ? '正在读取…' : '导入 JSON 报告'}
            <input aria-label="导入 JSON 报告" type="file" accept=".json,application/json" multiple
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0" onChange={event => { void importFiles(event); }} />
          </label>
          {reports.length ? <button type="button" onClick={clearReports} className="px-2 py-2 text-sm text-slate-500 hover:text-slate-900">清空</button> : null}
        </div>
      </div>
      <p role="status" aria-live="polite" className="mt-3 text-xs text-slate-400">{reports.length ? '已导入 ' + reports.length + ' 次运行' : '尚未导入报告 · 不展示模拟的优化数字'}</p>
      {error ? <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p> : null}
      <details className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-500">
        <summary className="cursor-pointer font-medium text-slate-700">如何生成报告</summary>
        <p className="mt-3 leading-6">在项目目录运行以下现有命令，再导入终端输出路径中的 JSON。默认报告使用模拟 / 夹具检索，只用于验证评测流程。</p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono leading-6 text-slate-700">pnpm rag:eval:matrix{'\n'}pnpm rag:eval:agent</pre>
        <p className="mt-2 leading-6">验证真实收益时，使用真实检索目标与人工审核的标注集，并固定文档快照、模型、提示词和上下文预算。</p>
      </details>
    </section>

    {reports.length ? <section className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2" aria-label="选择对照运行">
      {([['基线运行', baselineId, baseline], ['对照运行', candidateId, candidate]] as const).map(([label, value, report], index) => (
        <div key={label} className="min-w-0 rounded-xl border border-slate-200 bg-white p-5">
          <label className="block text-xs font-semibold text-slate-500">
            {label}
            <select aria-label={label} value={value} disabled={importing} onChange={event => {
              const id = event.target.value;
              if (index === 0) {
                setBaselineId(id);
                if (candidateId === id) setCandidateId(reports.find(item => item.runId !== id)?.runId ?? '');
              } else setCandidateId(id);
              setExpandedCaseId(null);
            }} className="mt-3 w-full min-w-0 max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-900">
              <option value="">请选择运行</option>
              {reports.filter(item => index === 0 || item.runId !== baselineId).map(item =>
                <option key={item.runId} value={item.runId}>{item.target.id + ' · ' + item.runId}</option>)}
            </select>
          </label>
          {report ? <div className="mt-3 space-y-2 text-xs text-slate-500">
            <span className={'inline-block rounded px-2 py-1 ' + (describeEvalProvenance(report).kind === 'production'
              ? 'bg-sky-50 text-sky-800' : 'bg-amber-50 text-amber-800')}>{describeEvalProvenance(report).label}</span>
            <p className="break-all">{report.dataset.id + ' @ ' + report.dataset.version} · K={report.configuration.topK} · {report.summary.completedCases}/{report.summary.totalCases} 题完成</p>
            <p>检索标注覆盖 {(report.summary.retrievalMetricCoverageRatio * 100).toFixed(0)}% · 答案标注覆盖 {(report.summary.answerMetricCoverageRatio * 100).toFixed(0)}%</p>
            <p>Token：{describeEvalUsage(report).tokens} · 费用：{describeEvalUsage(report).cost}</p>
            <p className="truncate font-mono text-[10px]" title={report.dataset.sha256}>快照 {report.dataset.sha256}</p>
          </div> : <p className="mt-3 text-xs text-slate-400">再导入一份报告，或选择 matrix 中的另一组运行。</p>}
        </div>
      ))}
    </section> : null}

    {comparison ? <>
      {comparison.issues.length ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <p className="font-semibold">当前结果不能直接比较</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">{comparison.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
      </div> : <p className="text-sm text-slate-600">已匹配数据集、快照、Top K 和问题集合。差值为“对照 − 基线”；绿色表示该指标改善。</p>}
      {securityHits ? <p role="alert" className="rounded-lg bg-rose-50 p-4 text-sm text-rose-800">对照运行存在 {securityHits} 项隔离或策略检查命中，请先处理这些失败。</p> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        {comparison.metrics.filter(metric => ['recall', 'ndcg', 'facts'].includes(metric.id)).map(metric => (
          <div key={metric.id} className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold text-slate-500">{metric.label.replace('@K', '@' + (candidate?.configuration.topK ?? 'K'))}</p>
            <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
              <strong className="font-mono text-3xl font-medium tracking-tight">{formatEvalMetric(metric.candidate, metric.unit)}</strong>
              <span className="text-sm"><Delta metric={metric} /></span>
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-400">基线 {formatEvalMetric(metric.baseline, metric.unit)}</p>
          </div>
        ))}
      </div>
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white" aria-label="指标对比">
        <div className="border-b border-slate-200 px-5 py-4"><h2 className="font-semibold">质量与代价，一起看</h2></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr>
            {['指标', '基线', '对照', '差值', '口径'].map(label => <th key={label} scope="col" className="px-5 py-3 font-medium">{label}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100">{comparison.metrics.map(metric => <tr key={metric.id}>
            <th scope="row" className="whitespace-nowrap px-5 py-4 text-left font-medium">{metric.label.replace('@K', '@' + (candidate?.configuration.topK ?? 'K'))} <span className="text-slate-400">{metric.higherIsBetter ? '↑' : '↓'}</span></th>
            <td className="whitespace-nowrap px-5 py-4 font-mono">{formatEvalMetric(metric.baseline, metric.unit)}</td>
            <td className="whitespace-nowrap px-5 py-4 font-mono">{formatEvalMetric(metric.candidate, metric.unit)}</td>
            <td className="whitespace-nowrap px-5 py-4"><Delta metric={metric} /></td>
            <td className="min-w-56 px-5 py-4 text-xs leading-5 text-slate-500">{metric.note ?? metric.description}</td>
          </tr>)}</tbody>
        </table></div>
        <p className="border-t border-slate-100 px-5 py-3 text-xs leading-6 text-slate-500">
          pp 表示百分点。未标注、未计量或覆盖范围不同的指标不计算差值。Token 和费用可能含估算；此页面未评估答案语义正确性与忠实度。
        </p>
      </section>
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white" aria-label="逐题变化">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div><h2 className="font-semibold">逐题检查，先看退步</h2>
            <p className="mt-1 text-xs text-slate-500">任一已测质量指标下降即标为退步；不将多个指标混成总分。</p></div>
          <select aria-label="筛选逐题结果" value={caseFilter} onChange={event => setCaseFilter(event.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
            <option value="all">全部（{comparison.cases.length}）</option>
            {Object.entries(CASE_LABELS).map(([status, label]) => <option key={status} value={status}>{label}（{comparison.cases.filter(item => item.status === status).length}）</option>)}
          </select>
        </div>
        <div className="divide-y divide-slate-100">{visibleCases.slice(0, 100).map(item => <article key={item.caseId}>
          <button type="button" aria-expanded={expandedCaseId === item.caseId} onClick={() => setExpandedCaseId(expandedCaseId === item.caseId ? null : item.caseId)}
            className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-slate-50">
            <span className="break-all font-mono text-xs text-slate-600">{item.caseId}</span>
            <span className="flex shrink-0 items-center gap-4"><span className={'rounded px-2 py-1 text-xs ' + CASE_STYLES[item.status]}>{CASE_LABELS[item.status]}</span><span aria-hidden="true" className="text-slate-400">{expandedCaseId === item.caseId ? '−' : '+'}</span></span>
          </button>
          {expandedCaseId === item.caseId ? <CaseEvidence item={item} /> : null}
        </article>)}</div>
        {!visibleCases.length ? <p className="p-8 text-center text-sm text-slate-400">没有符合筛选条件的问题。</p> : null}
        {visibleCases.length > 100 ? <p className="p-4 text-xs text-slate-500">当前显示前 100 题，请筛选结果或查看完整报告。</p> : null}
      </section>
    </> : <div className="grid gap-4 sm:grid-cols-3" aria-label="评测指标说明">
      {[
        ['01', '找得全', 'Recall@K', '相关证据进入候选集的比例。'],
        ['02', '排得好', 'NDCG@K / MRR@K', '关键证据是否出现在前排。'],
        ['03', '答得有据', '事实与引用覆盖', '对照标注检查要点和原文区间。'],
      ].map(([number, title, metric, description]) => <div key={number} className="rounded-xl border border-slate-200 bg-white p-6">
        <span className="font-mono text-xs text-sky-600">{number}</span>
        <h3 className="mt-5 text-lg font-medium">{title}</h3>
        <p className="mt-1 font-mono text-xs text-slate-500">{metric}</p>
        <p className="mt-4 text-xs leading-6 text-slate-400">{description}</p>
      </div>)}
    </div>}
  </div>;
}
