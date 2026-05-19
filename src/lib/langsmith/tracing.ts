import { RunTree, uuid7 } from 'langsmith';
import {
  buildLangSmithMetadata,
  createLangSmithThreadId,
  getLangSmithClient,
  getLangSmithRuntimeConfig,
  toLangSmithRecord,
  type LangSmithRuntimeConfig,
} from './config';

export interface LangSmithRunContext {
  enabled: boolean;
  runId: string;
  threadId: string;
  projectName: string;
}

export async function runWithLangSmithRootRun<T>(
  input: {
    name: string;
    runType?: string;
    inputs?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    tags?: string[];
    userId?: string;
    sessionId?: string;
    conversationId?: string;
    route?: string;
    policyId?: string;
    fallbackRunId?: string;
    output?: (result: T) => Record<string, unknown>;
  },
  execute: (context: LangSmithRunContext) => Promise<T>
): Promise<T> {
  const config = getLangSmithRuntimeConfig();
  const threadId = createLangSmithThreadId({
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    fallback: input.fallbackRunId,
  });
  const runId = config.enabled ? uuid7() : input.fallbackRunId ?? uuid7();
  const context: LangSmithRunContext = {
    enabled: config.enabled,
    runId,
    threadId,
    projectName: config.projectName,
  };

  const client = getLangSmithClient(config);
  if (!client) {
    return execute(context);
  }

  const run = new RunTree({
    id: runId,
    trace_id: runId,
    name: input.name,
    run_type: input.runType ?? 'chain',
    project_name: config.projectName,
    client,
    inputs: input.inputs ?? {},
    metadata: buildLangSmithMetadata({
      threadId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      userId: input.userId,
      route: input.route,
      policyId: input.policyId,
      metadata: input.metadata,
    }),
    tags: input.tags,
    start_time: Date.now(),
  });

  try {
    await run.postRun(true);
  } catch (error) {
    console.warn('[LangSmith] root run create failed; continuing locally:', error);
    return execute({ ...context, enabled: false });
  }

  try {
    const result = await execute(context);
    await run.end(input.output?.(result) ?? { ok: true });
    await run.patchRun();
    return result;
  } catch (error) {
    await endRunWithError(run, error);
    throw error;
  }
}

export async function recordLangSmithFeedback(input: {
  runId: string;
  key: string;
  value: number | boolean | string;
  comment?: string;
  sourceInfo?: Record<string, unknown>;
  config?: LangSmithRuntimeConfig;
}): Promise<string | null> {
  const config = input.config ?? getLangSmithRuntimeConfig();
  const client = getLangSmithClient(config);
  if (!client || !isUuidLike(input.runId)) return null;

  try {
    const feedback = await client.createFeedback(input.runId, input.key, {
      score: typeof input.value === 'number' || typeof input.value === 'boolean'
        ? input.value
        : undefined,
      value: input.value,
      comment: input.comment,
      feedbackSourceType: 'app',
      sourceInfo: {
        app: 'rag-system',
        ...input.sourceInfo,
      },
    });
    return feedback.id;
  } catch (error) {
    console.warn('[LangSmith] feedback sync failed:', error);
    return null;
  }
}

export function getLangSmithStatus() {
  const config = getLangSmithRuntimeConfig();
  return {
    enabled: config.enabled,
    projectName: config.projectName,
    apiUrl: config.apiUrl,
    workspaceConfigured: Boolean(config.workspaceId),
    apiKeyConfigured: Boolean(config.apiKey),
    hideInputs: config.hideInputs,
    hideOutputs: config.hideOutputs,
    hideMetadata: config.hideMetadata,
    tracingSamplingRate: config.tracingSamplingRate,
  };
}

async function endRunWithError(run: RunTree, error: unknown): Promise<void> {
  try {
    await run.end(
      { ok: false },
      error instanceof Error ? error.message : String(error)
    );
    await run.patchRun();
  } catch (patchError) {
    console.warn('[LangSmith] root run error patch failed:', patchError);
  }
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export { toLangSmithRecord };
