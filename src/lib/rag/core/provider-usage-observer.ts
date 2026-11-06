import { AsyncLocalStorage } from 'node:async_hooks';
import type { EvalUsageObservation, EvalTokenObservation } from '../eval/usage-metering';

type Stage = 'generation' | 'embedding' | 'rerank';
export type AskStage = Stage | 'auth' | 'route' | 'queue' | 'warmup' | 'retrieval' | 'citation' | 'validation';
export interface AskStageEvent { stage: AskStage; state: 'started' | 'completed'; elapsedMs: number }
interface Interval { start: number; end?: number }
interface Collector {
  active: boolean;
  cancelled: boolean;
  calls: Record<Stage, number>;
  intervals: Record<Stage, Interval[]>;
  input: { observed: number; total: number };
  output: { observed: number; total: number };
  phases: Partial<Record<AskStage, Interval[]>>;
  onStage?: (event: AskStageEvent) => void;
  onAnswerDelta?: (text: string) => void;
  signal?: AbortSignal;
}
// Next can load the observer through multiple route chunks during hot reload.
// A process-local registry keeps those calls in the same transient Ask scope.
const registryGlobal = globalThis as typeof globalThis & { __ragAskProviderUsageObserverV1?: {
  storage: AsyncLocalStorage<Collector>; responses: WeakMap<Response, EvalUsageObservation>;
  answerStreaming?: AsyncLocalStorage<boolean>;
} };
const registry = registryGlobal.__ragAskProviderUsageObserverV1 ??= {
  storage: new AsyncLocalStorage<Collector>(), responses: new WeakMap<Response, EvalUsageObservation>(),
};
const answerStreaming = registry.answerStreaming ??= new AsyncLocalStorage<boolean>();

/** Associate usage with the SAME response without changing product JSON. */
export async function captureAskProviderUsage<T extends Response>(operation: () => Promise<T>,
  options: { signal?: AbortSignal; onStage?: (event: AskStageEvent) => void; onAnswerDelta?: (text: string) => void } = {}): Promise<T> {
  // Evaluation can wrap the online entry. Reuse its collector instead of
  // making provider calls disappear into a nested, disconnected scope.
  const parent = registry.storage.getStore();
  if (parent?.active) {
    const previous = parent.onStage;
    const previousDelta = parent.onAnswerDelta;
    parent.onStage = options.onStage ?? previous;
    parent.onAnswerDelta = options.onAnswerDelta ?? previousDelta;
    if (options.signal) parent.signal = parent.signal ? AbortSignal.any([parent.signal, options.signal]) : options.signal;
    try { return await operation(); } finally { parent.onStage = previous; parent.onAnswerDelta = previousDelta; }
  }
  const collector: Collector = { active: true, cancelled: false,
    calls: { generation: 0, embedding: 0, rerank: 0 },
    intervals: { generation: [], embedding: [], rerank: [] },
    input: { observed: 0, total: 0 }, output: { observed: 0, total: 0 }, phases: {},
    onStage: options.onStage, onAnswerDelta: options.onAnswerDelta, signal: options.signal };
  const cancel = () => { collector.active = false; collector.cancelled = true; };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const started = performance.now();
  try {
    const response = await registry.storage.run(collector, operation);
    const ended = performance.now();
    collector.active = false;
    if (response instanceof Response) {
      const timings = Object.entries(collector.phases).map(([stage, intervals]) =>
        `${stage};dur=${wallTime(intervals!, ended).toFixed(1)}`);
      response.headers.set('server-timing', [...timings, `total;dur=${Math.max(0, ended - started).toFixed(1)}`].join(', '));
    }
    if (!collector.cancelled && response instanceof Response) {
      const total = Math.max(0, ended - started);
      registry.responses.set(response, { tokens: summarizeTokens(collector), calls: { ...collector.calls },
        latencyMs: { total, generation: Math.min(total, wallTime(collector.intervals.generation, ended)),
          rerank: Math.min(total, wallTime(collector.intervals.rerank, ended)) } });
    }
    return response;
  } finally {
    collector.active = false;
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** Transport adapters read at invocation time, never capture a request in a cached model. */
export function getAskExecutionSignal(): AbortSignal | undefined {
  return registry.storage.getStore()?.signal;
}

/** The route enables drafts only after authorization and selection of a plain
 * legacy answer. Published, mixed and tool workflows keep their final fences. */
export function withAskAnswerStreamingEnabled<T>(operation: () => Promise<T>): Promise<T> {
  return answerStreaming.run(true, operation);
}

export function isAskAnswerStreamingEnabled(): boolean {
  const collector = registry.storage.getStore();
  return Boolean(collector?.active && !collector.signal?.aborted
    && collector.onAnswerDelta && answerStreaming.getStore() === true);
}

export function emitAskAnswerDelta(text: string): void {
  if (!text || !isAskAnswerStreamingEnabled()) return;
  registry.storage.getStore()?.onAnswerDelta?.(text);
}

/** Only fixed stage names and durations leave the collector, never prompts or evidence. */
export async function observeAskStage<T>(stage: AskStage, operation: () => Promise<T>): Promise<T> {
  const collector = registry.storage.getStore();
  if (!collector?.active) return operation();
  const interval: Interval = { start: performance.now() };
  (collector.phases[stage] ??= []).push(interval);
  const notify = (state: AskStageEvent['state']) => {
    try { collector.onStage?.({ stage, state, elapsedMs: Math.max(0, performance.now() - interval.start) }); }
    catch { /* Optional progress reporting must not affect the operation. */ }
  };
  notify('started');
  try { return await operation(); }
  finally { if (collector.active) { interval.end = performance.now(); notify('completed'); } }
}

/** Outside an explicit collector this is a transparent provider invocation. */
export async function observeProviderInvocation<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
  const collector = registry.storage.getStore();
  if (!collector?.active || !['generation', 'embedding', 'rerank'].includes(stage)) return operation();
  collector.calls[stage]++;
  const interval: Interval = { start: performance.now() };
  collector.intervals[stage].push(interval);
  try {
    const result = await observeAskStage(stage, operation);
    if (stage === 'generation' && collector.active) await readProviderTokens(collector, result);
    return result;
  } finally {
    // Fire-and-forget work and non-cooperative providers must not modify a
    // completed or cancelled request's frozen observation.
    if (collector.active) interval.end = performance.now();
  }
}

export function readAskProviderUsage(response: Response): EvalUsageObservation | undefined {
  const value = registry.responses.get(response);
  return value === undefined ? undefined : structuredClone(value);
}

async function readProviderTokens(collector: Collector, result: unknown): Promise<void> {
  try {
    // Raw Ollama callers return Response, while LangChain callers return an
    // AIMessage. Read a bounded clone so the product's original body and JSON
    // parsing remain untouched. No collector means no clone or metadata IO.
    const payload = result instanceof Response ? await rawProviderPayload(result) : result;
    if (!collector.active || !payload || typeof payload !== 'object') return;
    const values = payload as Record<string, unknown>;
    const usage = values.usage_metadata ?? { input_tokens: values.prompt_eval_count, output_tokens: values.eval_count };
    if (!usage || typeof usage !== 'object') return;
    for (const [observed, key] of [[collector.input, 'input_tokens'], [collector.output, 'output_tokens']] as const) {
      let value: unknown;
      try { value = (usage as Record<string, unknown>)[key]; } catch { continue; }
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        && Number.isSafeInteger(observed.total + value)) { observed.total += value; observed.observed++; }
    }
  } catch {
    // Optional metadata can contain getters or malformed provider data. Usage
    // observation must never change a normal response into a product failure.
  }
}
async function rawProviderPayload(response: Response): Promise<unknown> {
  if (!response.ok) return undefined;
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 128 * 1024) { void reader.cancel().catch(() => {}); return undefined; }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return undefined; }
  finally { reader.releaseLock(); }
}
function summarizeTokens(collector: Collector): EvalTokenObservation {
  const calls = collector.calls.generation;
  if (collector.input.observed === calls && collector.output.observed === calls) {
    return { measurement: 'provider', inputTokens: collector.input.total, outputTokens: collector.output.total };
  }
  if (!collector.input.observed && !collector.output.observed) return { measurement: 'unavailable' };
  return { measurement: 'partial', ...(collector.input.observed ? { inputTokens: collector.input.total } : {}),
    ...(collector.output.observed ? { outputTokens: collector.output.total } : {}) };
}
function wallTime(intervals: readonly Interval[], ended: number): number {
  const ordered = intervals.map(interval => ({ start: interval.start, end: Math.min(interval.end ?? ended, ended) }))
    .sort((left, right) => left.start - right.start);
  let total = 0, lastEnd = -Infinity;
  for (const interval of ordered) {
    total += Math.max(0, interval.end - Math.max(interval.start, lastEnd));
    lastEnd = Math.max(lastEnd, interval.end);
  }
  return total;
}
