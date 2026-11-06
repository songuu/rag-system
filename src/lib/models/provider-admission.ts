import { observeAskStage } from '../rag/core/provider-usage-observer';

/** Process-local admission for transports sharing a provider instance. This is
 * not a distributed GPU scheduler; separate processes need a common gateway. */
export interface ProviderAdmissionPolicy {
  concurrency: number;
  maxQueue: number;
  waitTimeoutMs: number;
}
export type ProviderPriority = 'interactive' | 'background';
export interface ProviderAdmissionOptions {
  provider: string;
  /** Trusted server configuration, never an arbitrary request body value. */
  baseUrl: string;
  priority?: ProviderPriority;
  policy?: ProviderAdmissionPolicy;
}
export class ProviderAdmissionError extends Error {
  readonly status = 503;
  readonly retryAfterSeconds = 3;
  readonly code: 'PROVIDER_QUEUE_FULL' | 'PROVIDER_QUEUE_TIMEOUT';
  constructor(code: 'PROVIDER_QUEUE_FULL' | 'PROVIDER_QUEUE_TIMEOUT') {
    super(code === 'PROVIDER_QUEUE_FULL' ? 'Model capacity is busy; retry later.' : 'Model capacity wait timed out.');
    this.name = 'ProviderAdmissionError';
    this.code = code;
  }
}
type Release = () => void;
interface Waiter {
  priority: ProviderPriority;
  resolve(release: Release): void;
  reject(error: unknown): void;
  cleanup(): void;
}
interface Pool { active: number; interactiveBurst: number; policy: ProviderAdmissionPolicy; queue: Waiter[] }
const registryGlobal = globalThis as typeof globalThis & { __ragProviderAdmissionV1?: {
  pools: Map<string, Pool>;
  wrappers: WeakMap<typeof fetch, string>;
} };
const registry = registryGlobal.__ragProviderAdmissionV1 ??= { pools: new Map(), wrappers: new WeakMap() };

export function resolveProviderAdmissionPolicy(provider: string,
  env: Record<string, string | undefined> = process.env): ProviderAdmissionPolicy {
  return {
    concurrency: bounded(env[provider === 'ollama' ? 'PROVIDER_ADMISSION_OLLAMA_CONCURRENCY' : 'PROVIDER_ADMISSION_CONCURRENCY'],
      provider === 'ollama' ? 1 : 4, 1, 16),
    maxQueue: bounded(env.PROVIDER_ADMISSION_MAX_QUEUE, 16, 0, 128),
    waitTimeoutMs: bounded(env.PROVIDER_ADMISSION_WAIT_MS, 30_000, 1, 60_000),
  };
}

export function createProviderAdmissionFetch(baseFetch: typeof fetch, options: ProviderAdmissionOptions): typeof fetch {
  const endpoint = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Invalid model admission endpoint.');
  if (options.provider === 'ollama' && endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
  // Credentials are deliberately absent from both the capacity identity and errors.
  const key = `${options.provider}:${endpoint.origin}${endpoint.pathname.replace(/\/+$/u, '')}`;
  const existing = registry.wrappers.get(baseFetch);
  if (existing) {
    if (existing !== key) throw new Error('Nested model admission with different endpoints is unsupported.');
    return baseFetch;
  }
  const policy = options.policy ?? resolveProviderAdmissionPolicy(options.provider);
  validatePolicy(policy);
  const priority = options.priority ?? 'interactive';
  const wrapped: typeof fetch = async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const release = await observeAskStage('queue', () => acquire(key, policy, priority, signal ?? undefined));
    try {
      signal?.throwIfAborted();
      const response = await baseFetch(input, init);
      const requestUrl = input instanceof Request ? input.url : String(input);
      const ollamaStream = options.provider === 'ollama'
        && /\/api\/(?:chat|generate)(?:\?|$)/u.test(requestUrl)
        && /(?:json|ndjson)/iu.test(response.headers.get('content-type') || '');
      return holdResponseBody(response, release, signal ?? undefined, ollamaStream);
    } catch (error) {
      // An abort notification alone is not completion. A non-cooperative fetch
      // keeps this permit until its promise settles, preventing oversubscription.
      release();
      throw error;
    }
  };
  registry.wrappers.set(wrapped, key);
  return wrapped;
}

async function acquire(key: string, policy: ProviderAdmissionPolicy, priority: ProviderPriority,
  signal?: AbortSignal): Promise<Release> {
  signal?.throwIfAborted();
  let pool = registry.pools.get(key);
  if (!pool) {
    pool = { active: 0, interactiveBurst: 0, policy: { ...policy }, queue: [] };
    registry.pools.set(key, pool);
  } else if (!pool.active && !pool.queue.length) {
    pool.policy = { ...policy };
  }
  if (pool.active < pool.policy.concurrency && !pool.queue.length) return grant(pool);
  if (pool.queue.length >= pool.policy.maxQueue) throw new ProviderAdmissionError('PROVIDER_QUEUE_FULL');
  const target = pool;
  return new Promise((resolve, reject) => {
    const remove = (error: unknown) => {
      const index = target.queue.indexOf(waiter);
      if (index < 0) return;
      target.queue.splice(index, 1);
      waiter.cleanup();
      reject(error);
    };
    const abort = () => remove(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => remove(new ProviderAdmissionError('PROVIDER_QUEUE_TIMEOUT')), target.policy.waitTimeoutMs);
    const waiter: Waiter = { priority, resolve, reject, cleanup() {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    } };
    target.queue.push(waiter);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function grant(pool: Pool): Release {
  pool.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pool.active--;
    while (pool.active < pool.policy.concurrency && pool.queue.length) {
      const background = pool.queue.findIndex(item => item.priority === 'background');
      const interactive = pool.queue.findIndex(item => item.priority === 'interactive');
      // At most three interactive dispatches can overtake a queued batch job.
      const index = background >= 0 && (interactive < 0 || pool.interactiveBurst >= 3)
        ? background : interactive >= 0 ? interactive : 0;
      const waiter = pool.queue.splice(index, 1)[0];
      pool.interactiveBurst = waiter.priority === 'interactive' ? pool.interactiveBurst + 1 : 0;
      waiter.cleanup();
      waiter.resolve(grant(pool));
    }
    if (!pool.queue.length) pool.interactiveBurst = 0;
  };
}

function holdResponseBody(response: Response, release: Release, signal?: AbortSignal, ollamaStream = false): Response {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  let finished = false;
  let cancellation: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let bodyClosed = false;
  const decoder = ollamaStream ? new TextDecoder() : undefined;
  let frame = '';
  const hasTerminalFrame = (chunk: Uint8Array): boolean => {
    if (!decoder) return false;
    frame += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = frame.indexOf('\n')) >= 0) {
      const line = frame.slice(0, newline).trim(); frame = frame.slice(newline + 1);
      try { if (line && JSON.parse(line)?.done === true) return true; } catch { /* SDK owns invalid-frame errors. */ }
    }
    // Streamed terminal frames are small; bound observation without retaining model output.
    if (frame.length > 64 * 1024) frame = '';
    return false;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener('abort', abort);
    release();
  };
  const cancel = (reason: unknown) => {
    if (!cancellation) {
      // reader.cancel can wake pending reads before the transport's underlying
      // cancel finishes. Only this promise, not that early EOF, releases capacity.
      cancellation = Promise.resolve().then(() => reader.cancel(reason));
      void cancellation.then(finish, finish);
    }
    return cancellation;
  };
  const abort = () => {
    if (finished) return;
    void cancel(signal?.reason).catch(() => undefined);
    controller.error(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    bodyClosed = true;
  };
  const closeBody = () => {
    if (cancellation || bodyClosed) return;
    bodyClosed = true;
    finish();
    controller.close();
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull(target) {
      try {
        const result = await (pendingRead ?? reader.read());
        pendingRead = undefined;
        if (cancellation) return;
        if (result.done) closeBody();
        else {
          target.enqueue(result.value);
          if (hasTerminalFrame(result.value)) {
            // Ollama's protocol declares completion before HTTP EOF. Some SDKs
            // stop here; explicitly settle cancellation of the remaining body.
            void cancel('Ollama stream completed').then(() => {
              if (!bodyClosed) { bodyClosed = true; controller.close(); }
            }, error => {
              if (!bodyClosed) { bodyClosed = true; controller.error(error); }
            });
            return;
          }
          // Read at most one chunk ahead after consumption starts. Network streams
          // need a read to observe EOF after an SDK stops on its terminal frame.
          pendingRead = reader.read();
          void pendingRead.then(next => { if (next.done) closeBody(); }, error => {
            if (cancellation || bodyClosed) return;
            bodyClosed = true; finish(); controller.error(error);
          });
        }
      } catch (error) {
        if (cancellation || bodyClosed) return;
        bodyClosed = true; finish(); target.error(error);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  // Some streaming SDKs stop after their terminal JSON frame without asking
  // for one more read. The original reader's closed promise still proves EOF.
  void reader.closed.then(() => { if (!cancellation) finish(); }, () => { if (!cancellation) finish(); });
  const tracked = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const name of ['url', 'redirected', 'type'] as const) {
    Object.defineProperty(tracked, name, { value: response[name] });
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return tracked;
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid provider admission policy.');
  return value;
}
function validatePolicy(policy: ProviderAdmissionPolicy): void {
  bounded(String(policy.concurrency), 1, 1, 16);
  bounded(String(policy.maxQueue), 16, 0, 128);
  bounded(String(policy.waitTimeoutMs), 30_000, 1, 60_000);
}
