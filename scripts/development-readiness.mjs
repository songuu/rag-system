import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const COMPILATION_TIMEOUT_MS = 180_000;
const LISTENER_TIMEOUT_MS = 180_000;

function durationLabel(milliseconds) {
  return milliseconds >= 1_000 ? `${milliseconds / 1_000} 秒` : `${milliseconds} 毫秒`;
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function isListening(url, signal) {
  return new Promise(resolve => {
    const socket = createConnection({
      host: url.hostname, port: Number(url.port),
      signal: requestSignal(signal, 500),
    });
    const finish = ready => { socket.destroy(); resolve(ready); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function waitForDevelopmentListener(baseUrl, {
  signal, probe = isListening, listenerTimeoutMs = LISTENER_TIMEOUT_MS, retryIntervalMs = 250,
  progressIntervalMs = 15_000, log = () => {},
} = {}) {
  const url = new URL(baseUrl);
  const started = Date.now();
  let nextProgressAt = started + progressIntervalMs;
  const deadlineSignal = requestSignal(signal, listenerTimeoutMs);
  try {
    while (true) {
      deadlineSignal.throwIfAborted();
      const listening = await probe(url, deadlineSignal);
      deadlineSignal.throwIfAborted();
      if (listening) return;
      const now = Date.now();
      if (now >= nextProgressAt) {
        log(`Next.js ${url.host} 尚未监听；已等待 ${durationLabel(now - started)}，最多等待 ${durationLabel(listenerTimeoutMs)}。进程仍在初始化，请保留上方 Next.js 启动日志。`);
        nextProgressAt = now + progressIntervalMs;
      }
      await sleep(retryIntervalMs, undefined, { signal: deadlineSignal });
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`Next.js ${url.host} 未开始监听（超过 ${durationLabel(listenerTimeoutMs)}），请检查上方进程启动日志。`, { cause: error });
  }
}

async function compileRoute(baseUrl, route, method, fetchRoute, { signal, compilationTimeoutMs }) {
  const compilationSignal = requestSignal(signal, compilationTimeoutMs);
  try {
    signal?.throwIfAborted();
    const response = await fetchRoute(`${baseUrl}/api/${route}`, {
      method, signal: compilationSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    if (route === 'health/live') {
      const health = await response.json();
      if (health.success !== true || health.status !== 'live') throw new Error('健康响应格式无效');
    } else {
      await response.body?.cancel();
    }
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    const timedOut = compilationSignal.reason?.name === 'TimeoutError' || error.name === 'TimeoutError';
    const reason = timedOut
      ? `超过 ${durationLabel(compilationTimeoutMs)}，请检查可用内存和磁盘负载`
      : error.message;
    throw new Error(`问答入口预编译失败：${route}（${reason}）`, { cause: error });
  }
}

export async function warmDevelopmentRoutes(baseUrl, fetchRoute = fetch, {
  signal, compilationTimeoutMs = COMPILATION_TIMEOUT_MS, log = () => {},
} = {}) {
  // Cold compilers compete for the same memory and Windows disk cache.
  for (const route of ['ask', 'model-selection', 'model-warmup']) {
    log(`正在预编译 /api/${route}，单次最多等待 ${durationLabel(compilationTimeoutMs)}…`);
    await compileRoute(baseUrl, route, 'OPTIONS', fetchRoute, { signal, compilationTimeoutMs });
  }
}

export async function prepareDevelopmentServer(baseUrl, {
  signal, probe, listenerTimeoutMs = LISTENER_TIMEOUT_MS, retryIntervalMs, progressIntervalMs,
  compilationTimeoutMs = COMPILATION_TIMEOUT_MS, fetchRoute = fetch,
  log = console.log, warn = console.warn,
} = {}) {
  log(`等待 Next.js 监听 ${baseUrl}，首次加载框架与配置最多等待 ${durationLabel(listenerTimeoutMs)}…`);
  await waitForDevelopmentListener(baseUrl, { signal, probe, listenerTimeoutMs, retryIntervalMs, progressIntervalMs, log });
  log(`Next.js 已监听 ${baseUrl}；正在编译 /api/health/live，最多等待 ${durationLabel(compilationTimeoutMs)}…`);
  try {
    // One request owns the cold compilation budget. A two-second liveness
    // poll repeatedly cancels this work and cannot measure compiler readiness.
    await compileRoute(baseUrl, 'health/live', 'GET', fetchRoute, { signal, compilationTimeoutMs });
    await warmDevelopmentRoutes(baseUrl, fetchRoute, { signal, compilationTimeoutMs, log });
    log('问答入口预编译完成，可以开始提问。');
    return { ready: true };
  } catch (error) {
    signal?.throwIfAborted();
    // Development must remain available for fixing compile errors. A failed
    // prewarm is not evidence that the already listening process has crashed.
    warn(`${error.message}。开发服务继续运行，问答入口尚未就绪；请查看 Next.js 编译日志，完成后可重新访问。`);
    return { ready: false };
  }
}
