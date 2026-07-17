import {
  RagRequestAbortedError,
  throwIfRagRequestAborted,
} from '../core/cancellation';

export const MAX_RAG_PRE_ROUTE_PROVIDER_TIMEOUT_MS = 10_000;

export class RagPreRouteProviderTimeoutError extends Error {
  readonly code = 'RAG_PRE_ROUTE_PROVIDER_TIMEOUT';

  constructor(operationKey: string, timeoutMs: number) {
    super(`Pre-route provider operation timed out: ${operationKey} after ${timeoutMs}ms.`);
    this.name = 'RagPreRouteProviderTimeoutError';
  }
}

export class RagPreRouteProviderBusyError extends Error {
  readonly code = 'RAG_PRE_ROUTE_PROVIDER_BUSY';

  constructor(operationKey: string) {
    super(`Pre-route provider still has detached work in flight: ${operationKey}.`);
    this.name = 'RagPreRouteProviderBusyError';
  }
}

const DETACHED_PRE_ROUTE_PROVIDER_WORK = new Map<string, Set<Promise<void>>>();

/**
 * Bounds optional provider discovery/read work before retrieval planning. A
 * timed-out or cancelled non-cooperative promise keeps its process-wide
 * admission key until the real operation settles, preventing retry storms from
 * multiplying detached provider work.
 */
export async function invokePreRouteProviderWithDeadline<T>(input: {
  operationKey: string;
  timeoutMs: number;
  signal?: AbortSignal;
  invoke(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  throwIfRagRequestAborted(input.signal);
  const operationKey = input.operationKey.trim();
  if (!operationKey) {
    throw new Error('Pre-route provider operationKey is required.');
  }
  if (
    !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < 1
    || input.timeoutMs > MAX_RAG_PRE_ROUTE_PROVIDER_TIMEOUT_MS
  ) {
    throw new Error(
      `Pre-route provider timeoutMs must be an integer between 1 and ${MAX_RAG_PRE_ROUTE_PROVIDER_TIMEOUT_MS}.`
    );
  }
  if ((DETACHED_PRE_ROUTE_PROVIDER_WORK.get(operationKey)?.size ?? 0) > 0) {
    throw new RagPreRouteProviderBusyError(operationKey);
  }

  const controller = new AbortController();
  let operationSettled = false;
  const operation = Promise.resolve().then(() => input.invoke(controller.signal));
  const settlement = operation
    .then(
      () => { operationSettled = true; },
      () => { operationSettled = true; }
    )
    .finally(() => {
      const pendingWork = DETACHED_PRE_ROUTE_PROVIDER_WORK.get(operationKey);
      pendingWork?.delete(settlement);
      if (pendingWork?.size === 0) {
        DETACHED_PRE_ROUTE_PROVIDER_WORK.delete(operationKey);
      }
    });
  let tracked = false;
  const trackUnsettledOperation = () => {
    if (operationSettled || tracked) return;
    const pendingWork = DETACHED_PRE_ROUTE_PROVIDER_WORK.get(operationKey) ?? new Set();
    pendingWork.add(settlement);
    DETACHED_PRE_ROUTE_PROVIDER_WORK.set(operationKey, pendingWork);
    tracked = true;
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: RagPreRouteProviderTimeoutError | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      if (operationSettled) return;
      const error = new RagPreRouteProviderTimeoutError(operationKey, input.timeoutMs);
      timeoutError = error;
      trackUnsettledOperation();
      controller.abort(error);
      reject(error);
    }, input.timeoutMs);
  });

  let requestAbortError: RagRequestAbortedError | undefined;
  let rejectRequestAbort: ((error: RagRequestAbortedError) => void) | undefined;
  const requestAbort = new Promise<never>((_resolve, reject) => {
    rejectRequestAbort = reject;
  });
  const abortFromRequest = () => {
    if (requestAbortError || timeoutError || operationSettled) return;
    const error = new RagRequestAbortedError();
    requestAbortError = error;
    trackUnsettledOperation();
    controller.abort(error);
    rejectRequestAbort?.(error);
  };
  input.signal?.addEventListener('abort', abortFromRequest, { once: true });
  if (input.signal?.aborted) abortFromRequest();

  try {
    return await Promise.race([operation, timeout, requestAbort]);
  } catch (error) {
    if (requestAbortError) throw requestAbortError;
    if (timeoutError) throw timeoutError;
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', abortFromRequest);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export function isRagPreRouteProviderUnavailableError(
  error: unknown
): error is RagPreRouteProviderTimeoutError | RagPreRouteProviderBusyError {
  return error instanceof RagPreRouteProviderTimeoutError
    || error instanceof RagPreRouteProviderBusyError;
}
