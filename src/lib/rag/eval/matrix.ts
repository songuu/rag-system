import { randomUUID } from 'node:crypto';

import { runRagEval, type RunRagEvalOptions } from './runner';
import type {
  RagEvalDataset,
  RagEvalRunReport,
  RagEvalTarget,
} from './types';

export interface RagEvalMatrixDelta {
  meanRecallAtK: number | null;
  meanNdcgAtK: number | null;
  meanRequiredFactCoverage: number | null;
  meanCitationCoverage: number | null;
  p95LatencyMs: number | null;
}

export interface RagEvalMatrixTargetReport {
  targetId: string;
  report: RagEvalRunReport;
  deltaFromBaseline: RagEvalMatrixDelta;
}

export interface RagEvalMatrixReport {
  schemaVersion: 'rag-eval-matrix/v1';
  matrixRunId: string;
  baselineTargetId: string;
  targets: RagEvalMatrixTargetReport[];
}

export interface RunRagEvalMatrixOptions
  extends Omit<RunRagEvalOptions, 'runId'> {
  matrixRunId?: string;
  baselineTargetId?: string;
}

export async function runRagEvalMatrix(
  datasetInput: RagEvalDataset | unknown,
  targets: readonly RagEvalTarget[],
  options: RunRagEvalMatrixOptions = {}
): Promise<RagEvalMatrixReport> {
  if (targets.length === 0) {
    throw new Error('[rag-eval matrix] at least one target is required');
  }
  const seenTargets = new Set<string>();
  for (const [index, target] of targets.entries()) {
    if (!target.id.trim()) {
      throw new Error('[rag-eval matrix] target[' + index + '] id is required');
    }
    if (seenTargets.has(target.id)) {
      throw new Error('[rag-eval matrix] duplicate target id: ' + target.id);
    }
    seenTargets.add(target.id);
  }

  const baselineTargetId = options.baselineTargetId ?? targets[0].id;
  if (!seenTargets.has(baselineTargetId)) {
    throw new Error(
      '[rag-eval matrix] baseline target is not registered: ' + baselineTargetId
    );
  }
  const matrixRunId =
    options.matrixRunId ??
    'rag-eval-matrix-' + Date.now() + '-' + randomUUID().slice(0, 8);
  const reports: RagEvalRunReport[] = [];
  for (const target of targets) {
    reports.push(
      await runRagEval(datasetInput, target, {
        topK: options.topK,
        clock: options.clock,
        runId: matrixRunId + ':' + target.id,
        metadata: {
          ...(options.metadata ?? {}),
          matrix_run_id: matrixRunId,
          baseline_target_id: baselineTargetId,
        },
      })
    );
  }
  const baseline = reports.find(report => report.target.id === baselineTargetId);
  if (!baseline) {
    throw new Error('[rag-eval matrix] baseline report was not produced');
  }

  return {
    schemaVersion: 'rag-eval-matrix/v1',
    matrixRunId,
    baselineTargetId,
    targets: reports.map(report => ({
      targetId: report.target.id,
      report,
      deltaFromBaseline: createDelta(report, baseline),
    })),
  };
}

function createDelta(
  report: RagEvalRunReport,
  baseline: RagEvalRunReport
): RagEvalMatrixDelta {
  return {
    meanRecallAtK: subtractNullable(
      report.summary.meanRecallAtK,
      baseline.summary.meanRecallAtK
    ),
    meanNdcgAtK: subtractNullable(
      report.summary.meanNdcgAtK,
      baseline.summary.meanNdcgAtK
    ),
    meanRequiredFactCoverage: subtractNullable(
      report.summary.meanRequiredFactCoverage,
      baseline.summary.meanRequiredFactCoverage
    ),
    meanCitationCoverage: subtractNullable(
      report.summary.citation.meanCoverage,
      baseline.summary.citation.meanCoverage
    ),
    p95LatencyMs: subtractNullable(
      report.summary.latencyMs.p95,
      baseline.summary.latencyMs.p95
    ),
  };
}

function subtractNullable(
  value: number | null,
  baseline: number | null
): number | null {
  return value === null || baseline === null ? null : value - baseline;
}
