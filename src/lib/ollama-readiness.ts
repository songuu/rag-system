export interface OllamaRuntimeSettings { numCtx: number; keepAlive: string }
export function resolveOllamaRuntimeSettings(env: Record<string, string | undefined> = process.env): OllamaRuntimeSettings {
  const context = Number(env.OLLAMA_NUM_CTX);
  const minutes = /^(\d+)m$/u.exec(env.OLLAMA_KEEP_ALIVE || '');
  return {
    numCtx: Number.isSafeInteger(context) && context >= 2048 && context <= 32768 ? context : 8192,
    keepAlive: minutes && Number(minutes[1]) >= 1 && Number(minutes[1]) <= 60 ? `${Number(minutes[1])}m` : '15m',
  };
}

export interface ModelReadiness { model: string; phase: 'loading' | 'ready' | 'failed'; detail?: string; loadDurationMs?: number }
const readinessGlobal = globalThis as typeof globalThis & { __ragOllamaReadinessV1?: {
  pendingLoads: Map<string, Promise<ModelReadiness>>; warmupStates: Map<string, ModelReadiness>;
} };
// Next may load different route chunks or replace them during hot reload.
// Polling and admission must observe the same bounded process-local jobs.
const { pendingLoads, warmupStates } = readinessGlobal.__ragOllamaReadinessV1 ??= {
  pendingLoads: new Map(), warmupStates: new Map(),
};
interface ModelWarmupIdentity { baseUrl?: string; settings?: OllamaRuntimeSettings; preparationKey?: string }
function warmupKey(model: string, options: ModelWarmupIdentity = {}): string {
  return JSON.stringify([(options.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/u, ''), model,
    options.settings || resolveOllamaRuntimeSettings(), options.preparationKey ?? null]);
}

export function getOllamaModelReadiness(model: string, options: ModelWarmupIdentity = {}): ModelReadiness | null {
  return warmupStates.get(warmupKey(model, options)) || null;
}

export function beginOllamaModelWarmup(model: string, options: NonNullable<Parameters<typeof warmOllamaModel>[1]> & { prepare?: () => Promise<void>; preparationKey?: string } = {}): ModelReadiness {
  const key = warmupKey(model, options);
  const existing = warmupStates.get(key);
  if (existing?.phase === 'loading') return existing;
  if (pendingLoads.size >= 4 || [...warmupStates.values()].filter(state => state.phase === 'loading').length >= 4) throw new Error('MODEL_PRELOAD_BUSY');
  if (warmupStates.size >= 64) {
    const removable = [...warmupStates].find(([, state]) => state.phase !== 'loading');
    if (removable) warmupStates.delete(removable[0]);
  }
  const loading: ModelReadiness = { model, phase: 'loading' };
  warmupStates.set(key, loading);
  // Loading weights from a mechanical disk must not hold a browser request open.
  // The finite provider job is observed by authenticated status polling.
  void (async () => {
    if (options.prepare) await options.prepare();
    return warmOllamaModel(model, { ...options, timeoutMs: options.timeoutMs || 600_000 });
  })()
    .then(ready => warmupStates.set(key, ready))
    .catch(error => warmupStates.set(key, { model, phase: 'failed', detail: error instanceof Error && error.name === 'TimeoutError'
      ? '模型加载超过 10 分钟，请检查磁盘、可用内存和 Ollama 加载超时设置。'
      : '模型加载失败，请检查 Ollama 日志、可用内存和模型文件后重试。' }));
  return loading;
}

export async function warmOllamaModel(model: string, options: {
  fetch?: typeof fetch; baseUrl?: string; settings?: OllamaRuntimeSettings; timeoutMs?: number;
} = {}): Promise<ModelReadiness> {
  const baseUrl = (options.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/u, '');
  const settings = options.settings || resolveOllamaRuntimeSettings();
  const key = JSON.stringify([baseUrl, model, settings]);
  const pending = pendingLoads.get(key);
  if (pending) return pending;
  if (pendingLoads.size >= 4) throw new Error('MODEL_PRELOAD_BUSY');
  const load = (async (): Promise<ModelReadiness> => {
    const response = await (options.fetch || fetch)(`${baseUrl}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(Math.max(1000, Math.min(600_000, options.timeoutMs || 240_000))),
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: settings.keepAlive, options: { num_ctx: settings.numCtx } }),
    });
    if (!response.ok) throw new Error('MODEL_PRELOAD_FAILED');
    const body = await response.json();
    if (body.error || body.done !== true) throw new Error('MODEL_PRELOAD_FAILED');
    return { model, phase: 'ready', ...(typeof body.load_duration === 'number' && Number.isFinite(body.load_duration)
      ? { loadDurationMs: Math.max(0, Math.round(body.load_duration / 1_000_000)) } : {}) };
  })();
  pendingLoads.set(key, load);
  try { return await load; }
  finally { pendingLoads.delete(key); }
}
import { RAG_EMBEDDING_WARMUP_BUDGET_MS } from './rag/core/request-budgets';

export const OLLAMA_EMBEDDING_NUM_CTX = 8192;
export const OLLAMA_EMBEDDING_WARMUP_TIMEOUT_MS = RAG_EMBEDDING_WARMUP_BUDGET_MS;


export class OllamaEmbeddingWarmupError extends Error {
  readonly code: 'EMBEDDING_PRELOAD_FAILED' | 'EMBEDDING_PRELOAD_TIMEOUT';

  constructor(code: OllamaEmbeddingWarmupError['code'], cause?: unknown) {
    super(code === 'EMBEDDING_PRELOAD_TIMEOUT'
      ? 'Embedding model preparation exceeded its cold-start deadline.'
      : 'Embedding model preparation failed.', { cause });
    this.name = 'OllamaEmbeddingWarmupError';
    this.code = code;
  }
}

/** Probe the provider on every use: process-local ready state cannot detect eviction. */
export async function warmOllamaEmbeddingModel(model: string, options: {
  fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<ModelReadiness> {
  options.signal?.throwIfAborted();
  const baseUrl = (options.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/u, '');
  const keepAlive = resolveOllamaRuntimeSettings().keepAlive;
  const key = JSON.stringify(['embedding', baseUrl, model, OLLAMA_EMBEDDING_NUM_CTX, keepAlive]);
  let load = pendingLoads.get(key);
  if (!load) {
    if (pendingLoads.size >= 4) throw new Error('MODEL_PRELOAD_BUSY');
    load = (async (): Promise<ModelReadiness> => {
      try {
        const response = await (options.fetch || fetch)(`${baseUrl}/api/embed`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(Math.max(1000, Math.min(
            OLLAMA_EMBEDDING_WARMUP_TIMEOUT_MS, options.timeoutMs || OLLAMA_EMBEDDING_WARMUP_TIMEOUT_MS
          ))),
          body: JSON.stringify({ model, input: [], keep_alive: keepAlive, options: { num_ctx: OLLAMA_EMBEDDING_NUM_CTX } }),
        });
        if (!response.ok) throw new OllamaEmbeddingWarmupError('EMBEDDING_PRELOAD_FAILED');
        const body = await response.json();
        if (body.error || !Array.isArray(body.embeddings) || body.embeddings.length !== 0) {
          throw new OllamaEmbeddingWarmupError('EMBEDDING_PRELOAD_FAILED');
        }
        return { model, phase: 'ready', ...(typeof body.load_duration === 'number' && Number.isFinite(body.load_duration)
          ? { loadDurationMs: Math.max(0, Math.round(body.load_duration / 1_000_000)) } : {}) };
      } catch (error) {
        if (error instanceof OllamaEmbeddingWarmupError) throw error;
        throw new OllamaEmbeddingWarmupError(error instanceof Error && error.name === 'TimeoutError'
          ? 'EMBEDDING_PRELOAD_TIMEOUT' : 'EMBEDDING_PRELOAD_FAILED', error);
      }
    })().finally(() => pendingLoads.delete(key));
    pendingLoads.set(key, load);
  }
  return waitForSharedEmbeddingLoad(load, options.signal);
}

function waitForSharedEmbeddingLoad(load: Promise<ModelReadiness>, signal?: AbortSignal): Promise<ModelReadiness> {
  if (!signal) return load;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    // Cancelling one HTTP request must not interrupt another waiter or a UI preload.
    signal.addEventListener('abort', abort, { once: true });
    load.then(result => { cleanup(); resolve(result); }, error => { cleanup(); reject(error); });
  });
}
