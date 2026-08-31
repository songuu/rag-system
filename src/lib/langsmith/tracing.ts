import { RunTree, uuid7 } from 'langsmith';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  buildLangSmithMetadata,
  createLangSmithThreadId,
  getLangSmithClient,
  getLangSmithRuntimeConfig,
  toLangSmithRecord,
  type LangSmithRuntimeConfig,
} from './config';
import {
  createPrivateLangChainCallbacks,
  executeWithPrivateLangChainTracing,
} from './private-tracing';

export interface LangSmithRunContext {
  enabled: boolean;
  runId: string;
  threadId: string;
  projectName: string;
  /**
   * Upload-disabled callbacks for every LangChain Runnable/model/tool invoked
   * by this request. They are intentionally not parented to the external root.
   */
  privateLangChainCallbacks: RunnableConfig['callbacks'];
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
    privateLangChainCallbacks: createPrivateLangChainCallbacks(),
  };

  let client;
  try {
    client = getLangSmithClient(config);
  } catch (error) {
    console.warn('[LangSmith] client initialization failed; continuing locally:', error);
    return executeWithPrivateLangChainTracing(
      () => execute({ ...context, enabled: false })
    );
  }
  if (!client) {
    return executeWithPrivateLangChainTracing(() => execute(context));
  }

  const run = new RunTree({
    id: runId,
    trace_id: runId,
    name: input.name,
    run_type: input.runType ?? 'chain',
    project_name: config.projectName,
    client,
    inputs: createContentFreeRootInputs(input.inputs),
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

  let result: T;
  try {
    await run.postRun(true);
  } catch (error) {
    console.warn('[LangSmith] root run create failed; continuing locally:', error);
    return executeWithPrivateLangChainTracing(
      () => execute({ ...context, enabled: false })
    );
  }

  try {
    // LangSmith input/output processors do not sanitize a child run's error or
    // stack fields. Agent/model/tool spans can therefore leak tenant evidence
    // through a thrown error even when both payload hiding flags are enabled.
    // Keep automatic children on a private discard client. A tracingEnabled
    // boundary alone is insufficient because createAgent/LangGraph can rebuild
    // a tracer after its async graph context changes.
    result = await executeWithPrivateLangChainTracing(
      () => execute(context)
    );
  } catch (error) {
    await endRunWithError(run, error);
    throw error;
  }

  await endRunWithSuccess(run, input.output?.(result) ?? { ok: true });
  return result;
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
    // Never send provider/tool/kernel error text to LangSmith: it can contain
    // prompts, evidence, endpoints, or credential fragments.
    void error;
    await run.end({ ok: false }, 'RAG_EXECUTION_FAILED');
    await run.patchRun();
  } catch (patchError) {
    console.warn('[LangSmith] root run error patch failed:', patchError);
  }
}

async function endRunWithSuccess(
  run: RunTree,
  output: Record<string, unknown>
): Promise<void> {
  try {
    await run.end(output);
    await run.patchRun();
  } catch (error) {
    // Telemetry is best-effort and must never turn a completed answer into an
    // application failure or invite a duplicate provider retry.
    console.warn('[LangSmith] root run completion patch failed:', error);
  }
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createContentFreeRootInputs(
  inputs: Record<string, unknown> | undefined
): Record<string, number | boolean> {
  const safeInputs: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (typeof value === 'boolean') {
      safeInputs[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      safeInputs[key] = value;
    }
  }
  return safeInputs;
}

export { toLangSmithRecord };
