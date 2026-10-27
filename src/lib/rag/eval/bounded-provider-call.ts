import { performance } from 'node:perf_hooks';
import { types } from 'node:util';

export type BoundedProviderObservation =
  | { readonly status: 'fulfilled'; readonly value: unknown }
  | { readonly status: 'rejected' }
  | { readonly status: 'invalid-return'; readonly pendingCompletionUnknown: boolean }
  | { readonly status: 'timeout'; readonly pendingCompletionUnknown: boolean };

export type BoundedProviderRejectionObservation = Exclude<BoundedProviderObservation, { readonly status: 'rejected' | 'timeout' }>
  | { readonly status: 'rejected'; readonly reason: unknown }
  | { readonly status: 'timeout'; readonly pendingCompletionUnknown: boolean; readonly reason?: unknown };
type InternalObservation = BoundedProviderObservation | BoundedProviderRejectionObservation;

const nativePromisePrototype = Promise.prototype;
const nativePromiseThen = Promise.prototype.then;
const nativePromiseConstructor = Promise;
const intrinsicApply = Reflect.apply;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const isProxy = types.isProxy;
const isPromise = types.isPromise;
const freezeObservation = Object.freeze;
const scheduleTimeout = setTimeout;
const cancelTimeout = clearTimeout;
const scheduleMicrotask = queueMicrotask;
const constructorDescriptor = ownDescriptor(nativePromisePrototype, 'constructor');
const speciesDescriptor = ownDescriptor(nativePromiseConstructor, Symbol.species);
// Independent reference-resource ceiling, cross-checked against the actual
// client allowance in tests. Do not auto-widen it when an application budget
// changes or introduce a relative import into this hook-free leaf module.
const ASK_REQUEST_RESOURCE_CEILING_MS = 285000;
const matchesDescriptor = (actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined): boolean => {
  if (actual === undefined || expected === undefined) return false;
  const matchesField = (field: keyof PropertyDescriptor): boolean => {
    const present = hasOwn(actual, field);
    return present === hasOwn(expected, field) && (!present || actual[field] === expected[field]);
  };
  // No mutable prototype method or inherited descriptor property after a call.
  return matchesField('value') && matchesField('get') && matchesField('set')
    && matchesField('writable') && matchesField('enumerable') && matchesField('configurable');
};

/** Observe a captured local callback; this grants no permission or cancellation.
 * Timers cannot preempt synchronous JS, so also measure dispatch and settlement.
 * Accepted promises are drained after timeout. Malformed native carriers with
 * constructor/species hooks cannot be safely drained without executing those
 * hooks: reject them as a contract violation with completion UNKNOWN. External
 * enterprise harnesses still require process isolation for malicious adapters. */
export function boundedProviderCall(operation: () => unknown, timeoutMs: number): Promise<BoundedProviderObservation> {
  return observeProviderCall(operation, timeoutMs, false);
}

/** Opt-in for a consumer's private, conservative failure classifier only.
 * A rejection reference is not authenticated and may contain secrets/hooks:
 * never log, stringify, enumerate or adopt it. The default API still drops it. */
export function boundedProviderCallWithRejection(operation: () => unknown, timeoutMs: number): Promise<BoundedProviderRejectionObservation> {
  return observeProviderCall(operation, timeoutMs, true);
}

/** Explicit whole-Ask allowance, not an authorization or network client.
 * The ordinary provider contract stays capped at 60s. A cold local model may
 * legitimately need the existing client allowance; do not shorten it to the
 * artifact writer's 30s or expose arbitrary provider-selected timeout limits.
 * Reuse the same intrinsic Promise firewall and redacted UNKNOWN semantics. */
export function boundedAskRequestCall(
  operation: () => unknown, timeoutMs: number, ...extraInputs: unknown[]
): Promise<BoundedProviderObservation> {
  if (extraInputs.length !== 0) return invalidProviderCall();
  return observeProviderCall(operation, timeoutMs, false, 'ask-request');
}

/** An already-created return cannot wait behind a dispatch deadline: its
 * rejection could become unhandled before any queued observer runs. Attach
 * discard handlers synchronously through the SAME intrinsic/species fence.
 * Attachment proves neither settlement nor cancellation; malformed native
 * carriers remain UNKNOWN and require external process isolation. */
export function attachProviderPromiseDrain(input: unknown, ...extras: unknown[]): {
  readonly status: 'attached' | 'invalid-return'; readonly pendingCompletionUnknown: true;
} {
  if (extras.length || !safeNativePromise(input)) return freezeObservation({ status: 'invalid-return', pendingCompletionUnknown: true });
  try {
    intrinsicApply(nativePromiseThen, input, [() => undefined, () => undefined]);
    return freezeObservation({ status: 'attached', pendingCompletionUnknown: true });
  } catch { return freezeObservation({ status: 'invalid-return', pendingCompletionUnknown: true }); }
}

function safeNativePromise(input: unknown): boolean {
  return !isProxy(input) && isPromise(input) && prototypeOf(input) === nativePromisePrototype && !hasOwn(input, 'constructor')
    && matchesDescriptor(ownDescriptor(nativePromisePrototype, 'constructor'), constructorDescriptor)
    && matchesDescriptor(ownDescriptor(nativePromiseConstructor, Symbol.species), speciesDescriptor);
}

function invalidProviderCall(): Promise<never> {
  return new nativePromiseConstructor((_, reject) => reject(new TypeError('[bounded provider call] invalid operation or deadline')));
}

function observeProviderCall(operation: () => unknown, timeoutMs: number, retainRejection: false, profile?: 'provider' | 'ask-request'): Promise<BoundedProviderObservation>;
function observeProviderCall(operation: () => unknown, timeoutMs: number, retainRejection: true, profile?: 'provider' | 'ask-request'): Promise<BoundedProviderRejectionObservation>;
function observeProviderCall(operation: () => unknown, timeoutMs: number, retainRejection: boolean, profile: 'provider' | 'ask-request' = 'provider'): Promise<InternalObservation> {
  const maximumTimeoutMs = profile === 'ask-request' ? ASK_REQUEST_RESOURCE_CEILING_MS : 60000;
  if (typeof operation !== 'function' || isProxy(operation) || typeof timeoutMs !== 'number'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumTimeoutMs) {
    return invalidProviderCall();
  }
  const startedAt = performance.now();
  // No outer async adoption: it would consult mutated Promise metadata again.
  return new nativePromiseConstructor(resolve => {
    let finished = false;
    const finish = (result: InternalObservation): void => {
      if (finished) return; finished = true; cancelTimeout(timer); resolve(freezeObservation(result));
    };
    const settle = (result: InternalObservation): void => {
      // An outer deadline cannot disprove concealed work reported by an inner
      // owned failure. Retain its reference only for opt-in conservative merge.
      const rejection = retainRejection && result.status === 'rejected' && hasOwn(result, 'reason')
        ? { reason: (result as { readonly reason: unknown }).reason } : {};
      finish(performance.now() - startedAt >= timeoutMs
        ? { status: 'timeout', pendingCompletionUnknown: false, ...rejection } : result);
    };
    const rejected = (reason: unknown): void => {
      settle(retainRejection ? { status: 'rejected', reason } : { status: 'rejected' });
    };
    const timer = scheduleTimeout(() => finish({ status: 'timeout', pendingCompletionUnknown: true }), timeoutMs);
    scheduleMicrotask(() => {
      // Do not start a mutation after a dispatch deadline already elapsed.
      if (finished) return;
      if (performance.now() - startedAt >= timeoutMs) { finish({ status: 'timeout', pendingCompletionUnknown: false }); return; }
      let pending: unknown;
      try { pending = intrinsicApply(operation, undefined, []); }
      catch (reason) { rejected(reason); return; }
      if (!safeNativePromise(pending)) {
        // A broken return contract may conceal already-started background work.
        finish({ status: 'invalid-return', pendingCompletionUnknown: true }); return;
      }
      // Intrinsic then avoids an own `then` getter, but still consults species.
      // Inspect descriptors, never invoke a constructor getter or subclass hook.
      try {
        intrinsicApply(nativePromiseThen, pending, [
          (value: unknown) => { settle({ status: 'fulfilled', value }); },
          rejected,
        ]);
      } catch { finish({ status: 'invalid-return', pendingCompletionUnknown: true }); }
    });
  });
}
