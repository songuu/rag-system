import {
  CallbackManager,
  ensureHandler,
  type Callbacks,
} from '@langchain/core/callbacks/manager';
import {
  LangChainTracer,
  OVERRIDABLE_LANGSMITH_INHERITABLE_METADATA_KEYS,
  type LangChainTracerFields,
} from '@langchain/core/tracers/tracer_langchain';
import type {
  Client,
  LangSmithTracingClientInterface,
  RunTree,
} from 'langsmith';
import { ROOT, traceable } from 'langsmith/traceable';

const PRIVATE_TRACE_PROJECT = 'rag-system-private-discard';

const privateLangSmithClient: LangSmithTracingClientInterface = Object.freeze({
  async createRun() {},
  async updateRun() {},
});

class PrivateLangChainTracer extends LangChainTracer {
  constructor(
    fields: Pick<LangChainTracerFields, 'metadata' | 'tags'> = {}
  ) {
    super({
      ...fields,
      client: privateLangSmithClient,
      projectName: PRIVATE_TRACE_PROJECT,
    });
    this.enforcePrivateSink();
    // super() may have discovered an enclosing upload-capable RunTree. It is
    // unrelated to this private tracer and must not remain in the local map.
    this.runMap.clear();
    this.runTreeMap.clear();
  }

  override updateFromRunTree(runTree: RunTree): void {
    super.updateFromRunTree(runTree);
    // LangChain invokes updateFromRunTree after callback configuration. Never
    // let that lifecycle hook replace the non-networked sink.
    this.enforcePrivateSink();
  }

  override copyWithTracingConfig(input: {
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): LangChainTracer {
    const metadata = mergeTracingMetadata(this.tracingMetadata, input.metadata);
    const tags = input.tags
      ? Array.from(new Set([...this.tracingTags, ...input.tags]))
      : [...this.tracingTags];
    const copied = new PrivateLangChainTracer({ metadata, tags });
    copied.runMap = this.runMap;
    copied.runTreeMap = this.runTreeMap;
    return copied;
  }

  private enforcePrivateSink(): void {
    this.client = privateLangSmithClient;
    this.projectName = PRIVATE_TRACE_PROJECT;
    this.exampleId = undefined;
    this.replicas = undefined;
    this.fields = {
      ...this.fields,
      client: privateLangSmithClient,
      projectName: PRIVATE_TRACE_PROJECT,
      exampleId: undefined,
      replicas: undefined,
    };
  }
}

/**
 * Replace every upload-capable LangChain tracer with a tracer whose client is
 * deliberately non-networked. Non-LangSmith handlers are retained so local
 * timing, test, and application callbacks continue to work.
 */
export function createPrivateLangChainCallbacks(
  callbacks?: Callbacks
): CallbackManager {
  const manager = Array.isArray(callbacks)
    ? new CallbackManager()
    : callbacks?.copy() ?? new CallbackManager();

  if (Array.isArray(callbacks)) {
    for (const callback of callbacks) {
      manager.addHandler(ensureHandler(callback), true);
    }
  }

  let retainedPrivateTracer: LangChainTracer | undefined;
  const allHandlers = new Set([
    ...manager.handlers,
    ...manager.inheritableHandlers,
  ]);
  for (const handler of allHandlers) {
    if (handler.name !== 'langchain_tracer') continue;
    if (
      retainedPrivateTracer === undefined
      && isPrivateLangSmithTracingClient(
        (handler as { client?: unknown }).client
      )
      && handler instanceof LangChainTracer
      && manager.handlers.includes(handler)
      && manager.inheritableHandlers.includes(handler)
    ) {
      retainedPrivateTracer = handler;
      continue;
    }
    manager.removeHandler(handler);
  }

  if (!retainedPrivateTracer) {
    // A copied parent without its original tracer is a dangling cross-client
    // reference. Nested managers that already carry our private tracer retain
    // their local parentage through the branch above.
    Object.assign(manager, { _parentRunId: undefined });
    manager.addHandler(new PrivateLangChainTracer(), true);
  }

  return manager;
}

/**
 * Keep the LangSmith async context enabled, but bind it to a discard client.
 * LangGraph may recreate a LangChainTracer after an async boundary; the active
 * RunTree then rebinds that tracer to this client instead of the environment's
 * upload-capable default client.
 */
export async function executeWithPrivateLangChainTracing<T>(
  execute: () => Promise<T>
): Promise<T> {
  const guardedExecute = traceable(execute, {
    name: 'Private LangChain child boundary',
    project_name: PRIVATE_TRACE_PROJECT,
    tracingEnabled: true,
    // RunTree currently types this field as the concrete Client although it
    // only calls the two methods in LangSmithTracingClientInterface.
    client: privateLangSmithClient as Client,
    processInputs: () => ({}),
    processOutputs: () => ({}),
  });
  // Force a fresh private root. Without ROOT, an enclosing upload-capable
  // traceable context can override the child RunTree's client.
  return guardedExecute(ROOT);
}

export function isPrivateLangSmithTracingClient(
  client: unknown
): boolean {
  return client === privateLangSmithClient;
}

function mergeTracingMetadata(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (incoming === undefined) return existing ? { ...existing } : undefined;
  if (existing === undefined) return { ...incoming };

  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (
      !Object.prototype.hasOwnProperty.call(merged, key)
      || OVERRIDABLE_LANGSMITH_INHERITABLE_METADATA_KEYS.has(key)
    ) {
      merged[key] = value;
    }
  }
  return merged;
}
