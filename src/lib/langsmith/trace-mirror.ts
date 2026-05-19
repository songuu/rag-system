import { RunTree } from 'langsmith';
import type { Generation, Observation, Trace } from '../observability';
import {
  buildLangSmithMetadata,
  createLangSmithThreadId,
  getLangSmithClient,
  getLangSmithRuntimeConfig,
  toLangSmithRecord,
} from './config';
import { recordLangSmithFeedback } from './tracing';

const rootRuns = new Map<string, RunTree>();
const observationRuns = new Map<string, RunTree>();
const finalizedRuns = new Set<string>();
const syncedScores = new Set<string>();

export function mirrorTraceToLangSmith(trace: Trace): void {
  void mirrorTrace(trace).catch((error) => {
    console.warn('[LangSmith] trace mirror failed:', error);
  });
}

async function mirrorTrace(trace: Trace): Promise<void> {
  const config = getLangSmithRuntimeConfig();
  const client = getLangSmithClient(config);
  if (!client) return;

  const threadId = createLangSmithThreadId({
    sessionId: trace.sessionId,
    fallback: trace.id,
  });
  const metadata = buildLangSmithMetadata({
    threadId,
    sessionId: trace.sessionId,
    userId: trace.userId,
    route: '/api/ask',
    metadata: {
      ...(trace.metadata ?? {}),
      local_trace_id: trace.id,
      mirror: 'observability-engine',
    },
  });

  const rootRun = await ensureRootRun(trace, client, config.projectName, metadata);
  await syncObservations(trace, rootRun, metadata);
  await syncScores(trace);

  if (trace.endTime && !finalizedRuns.has(trace.id)) {
    await rootRun.end(
      toLangSmithRecord(trace.output, 'output'),
      trace.status === 'ERROR' ? String(trace.metadata?.error ?? 'Trace failed') : undefined,
      trace.endTime.getTime(),
      metadata
    );
    await rootRun.patchRun();
    finalizedRuns.add(trace.id);
  }
}

async function ensureRootRun(
  trace: Trace,
  client: NonNullable<ReturnType<typeof getLangSmithClient>>,
  projectName: string,
  metadata: Record<string, unknown>
): Promise<RunTree> {
  const cached = rootRuns.get(trace.id);
  if (cached) return cached;

  const rootRun = new RunTree({
    id: trace.id,
    trace_id: trace.id,
    name: trace.name,
    run_type: 'chain',
    project_name: projectName,
    client,
    inputs: toLangSmithRecord(trace.input, 'input'),
    metadata,
    tags: trace.tags,
    start_time: trace.startTime.getTime(),
  });
  await rootRun.postRun(true);
  rootRuns.set(trace.id, rootRun);
  return rootRun;
}

async function syncObservations(
  trace: Trace,
  rootRun: RunTree,
  baseMetadata: Record<string, unknown>
): Promise<void> {
  for (const observation of trace.observations) {
    const run = await ensureObservationRun(observation, rootRun, baseMetadata);
    const endTime = getObservationEndTime(observation);
    if (endTime && !finalizedRuns.has(observation.id)) {
      await run.end(
        toLangSmithRecord(observation.output, 'output'),
        observation.level === 'ERROR' ? observation.statusMessage ?? 'Observation failed' : undefined,
        endTime.getTime(),
        {
          ...baseMetadata,
          ...(observation.metadata ?? {}),
          local_observation_id: observation.id,
          local_trace_id: observation.traceId,
        }
      );
      await run.patchRun();
      finalizedRuns.add(observation.id);
    }
  }
}

async function ensureObservationRun(
  observation: Observation,
  rootRun: RunTree,
  baseMetadata: Record<string, unknown>
): Promise<RunTree> {
  const cached = observationRuns.get(observation.id);
  if (cached) return cached;

  const run = rootRun.createChild({
    id: observation.id,
    name: observation.name,
    run_type: toRunType(observation),
    inputs: toLangSmithRecord(observation.input, 'input'),
    start_time: observation.startTime.getTime(),
    metadata: {
      ...baseMetadata,
      ...(observation.metadata ?? {}),
      local_observation_id: observation.id,
      local_trace_id: observation.traceId,
      parent_observation_id: observation.parentObservationId,
      observation_type: observation.type,
      model: observation.type === 'GENERATION' ? observation.model : undefined,
    },
    tags: ['rag-system', observation.type.toLowerCase()],
  });
  await run.postRun(true);
  observationRuns.set(observation.id, run);
  return run;
}

async function syncScores(trace: Trace): Promise<void> {
  for (const score of trace.scores) {
    if (syncedScores.has(score.id)) continue;
    const runId = score.observationId && observationRuns.has(score.observationId)
      ? score.observationId
      : trace.id;
    const feedbackId = await recordLangSmithFeedback({
      runId,
      key: score.name,
      value: score.value,
      comment: score.comment,
      sourceInfo: {
        local_score_id: score.id,
        local_trace_id: score.traceId,
        local_observation_id: score.observationId,
        source: score.source,
      },
    });
    if (feedbackId) syncedScores.add(score.id);
  }
}

function toRunType(observation: Observation): string {
  if (observation.type === 'GENERATION') return 'llm';
  if (observation.type === 'SPAN') {
    return /retrieval|vector|search/i.test(observation.name) ? 'retriever' : 'chain';
  }
  return 'tool';
}

function getObservationEndTime(observation: Observation): Date | undefined {
  if (observation.type === 'EVENT') return observation.startTime;
  return (observation as Generation).endTime;
}
