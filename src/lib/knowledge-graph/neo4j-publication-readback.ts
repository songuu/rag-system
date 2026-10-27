import { types } from 'node:util';
import { performance } from 'node:perf_hooks';
import { Integer, ManagedTransaction, Record as Neo4jRecord, Result, Transaction } from 'neo4j-driver';
import type { Neo4jClient } from '../neo4j/driver';
import { boundedProviderCall } from '../rag/eval/bounded-provider-call';
import type { BoundedProviderObservation } from '../rag/eval/bounded-provider-call';
import { canonicalJson } from '../rag/eval/canonical-json';
import { createBuildPublicationManifest } from './build-publication-manifest';
import type { KnowledgeGraphDocumentIdentity } from './contracts';

// Group by actual nodes, not projected property maps: duplicate pointer or
// snapshot nodes must remain separate rows. No LIMIT/DISTINCT or document
// scope/status/trust filter may hide a missing, duplicate or wrong-scope edge.
const READ_PUBLICATION_CYPHER = `
OPTIONAL MATCH (pointer:GraphPointer {tenantId: $tenantId, corpusId: $corpusId})
OPTIONAL MATCH (snapshot:GraphSnapshot {tenantId: $tenantId, corpusId: $corpusId, graphVersion: pointer.activeGraphVersion})
OPTIONAL MATCH (snapshot)-[:CONTAINS]->(document:DocumentVersion)
WITH pointer, snapshot, collect(CASE WHEN document IS NULL THEN null ELSE {
  tenantId: document.tenantId, corpusId: document.corpusId, graphVersion: document.graphVersion,
  documentId: document.documentId, documentVersion: document.documentVersion,
  trustLevel: document.trustLevel, status: document.status
} END) AS documents
RETURN CASE WHEN pointer IS NULL THEN null ELSE {
  tenantId: pointer.tenantId, corpusId: pointer.corpusId,
  graphVersion: pointer.activeGraphVersion, revision: pointer.revision
} END AS pointer,
CASE WHEN snapshot IS NULL THEN null ELSE {
  tenantId: snapshot.tenantId, corpusId: snapshot.corpusId, graphVersion: snapshot.graphVersion,
  status: snapshot.status, artifactDigest: snapshot.artifactDigest,
  documentCount: snapshot.documentCount, documents: documents
} END AS snapshot`;

type Code = 'invalid-config' | 'invalid-request' | 'invalid-readback' | 'query-failed' | 'query-timeout'
  | 'provider-contract-invalid' | 'automatic-retry-refused' | 'halted' | 'busy' | 'read-limit';
export class Neo4jPublicationReadbackError extends Error {
  readonly productionAuthorized = false;
  readonly automaticRetryAllowed = false;
  readonly code: Code;
  readonly pendingCompletionUnknown: boolean;
  constructor(code: Code, pendingCompletionUnknown = false) {
    super(`[neo4j publication readback] ${code}`); this.name = 'Neo4jPublicationReadbackError';
    this.code = code; this.pendingCompletionUnknown = pendingCompletionUnknown; Object.freeze(this);
  }
}
type Fields = Record<string, unknown>;
type Scope = { readonly environment: string; readonly tenantId: string; readonly corpusId: string };
type Pointer = { readonly tenantId: string; readonly corpusId: string; readonly graphVersion: string; readonly revision: number };
export interface Neo4jPublicationData {
  readonly scope: Scope;
  readonly pointer: Pointer;
  readonly snapshot: { readonly tenantId: string; readonly corpusId: string; readonly graphVersion: string; readonly status: 'active';
    readonly artifactDigest: string; readonly documents: readonly Readonly<KnowledgeGraphDocumentIdentity>[] };
}
const integerPrototype = Integer.prototype;
const recordPrototype = Neo4jRecord.prototype;
const recordGet = Neo4jRecord.prototype.get;
const managedRun = ManagedTransaction.prototype.run;
const transactionRun = Transaction.prototype.run;
const resultPrototype = Result.prototype;
const resultThen = Result.prototype.then;
const nativePromise = Promise;
const nativePromisePrototype = Promise.prototype;
const descriptorKeys = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'] as const;
function sameDescriptor(actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined): boolean {
  return actual !== undefined && expected !== undefined && descriptorKeys.every(key => Object.hasOwn(actual, key) === Object.hasOwn(expected, key)
    && (!Object.hasOwn(actual, key) || actual[key] === expected[key]));
}
const integerBehavior = Reflect.ownKeys(integerPrototype).map(key => [key, Object.getOwnPropertyDescriptor(integerPrototype, key)] as const);
const resultBehavior = [resultPrototype, Object.getPrototypeOf(resultPrototype) as object].map(prototype => ({
  prototype, parent: Object.getPrototypeOf(prototype) as object | null,
  descriptors: Reflect.ownKeys(prototype).map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const),
}));
const promiseDescriptors = ['constructor', 'then'].map(key => [key, Object.getOwnPropertyDescriptor(nativePromisePrototype, key)] as const);
const promiseSpecies = Object.getOwnPropertyDescriptor(nativePromise, Symbol.species);
const promiseControlSymbols = new Set<symbol>(Reflect.ownKeys(Symbol).flatMap(key => {
  const value: unknown = Object.getOwnPropertyDescriptor(Symbol, key)?.value; return typeof value === 'symbol' ? [value] : [];
}));
// Installed-SDK structure closes receiver control overrides. It is not an
// unforgeable brand or attestation of client/driver artifact provenance.
const resultFields = ['_stack', '_streamObserverPromise', '_p', '_query', '_parameters', '_connectionHolder', '_keys', '_summary', '_error', '_mapper',
  '_watermarks', '_retry', '_ownedObservers', '_retriedError'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function detached(value: unknown): unknown { return freeze(JSON.parse(canonicalJson(value))); }
function exact(value: Fields, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error();
}
// Never read application-controlled accessors or Proxy traps, even when the
// trusted SDK envelope contains ordinary maps that need integer conversion.
function fields(value: unknown, prototype: object | null = Object.prototype): Fields {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) throw new Error();
  const actual = Object.getPrototypeOf(value); if (actual !== prototype && !(prototype === Object.prototype && actual === null)) throw new Error();
  const result: Fields = Object.create(null) as Fields;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(); const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error();
    result[key] = descriptor.value;
  }
  return result;
}
function array(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < minimum || length.value > maximum) throw new Error();
  if (Reflect.ownKeys(value).length !== length.value + 1) throw new Error();
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error(); result.push(descriptor.value);
  }
  return result;
}
function identifier(value: unknown, maximum = 128): string {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error(); return value;
}
function integer(value: unknown, maximum: number): number {
  let number = value;
  if (typeof value !== 'number') {
    if (Object.getOwnPropertyDescriptor(integerPrototype, 'constructor')?.value !== Integer) throw new Error();
    const bits = fields(value, integerPrototype); exact(bits, ['low', 'high']);
    for (const bit of [bits.low, bits.high]) if (typeof bit !== 'number' || !Number.isInteger(bit) || bit < -2147483648 || bit > 2147483647) throw new Error();
    // SDK integers are signed high/low words. Validate and convert data directly
    // rather than executing marker-only or mutable toNumber/inSafeRange hooks.
    number = (bits.high as number) * 4294967296 + ((bits.low as number) >>> 0);
  }
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(); return number;
}
function same(value: unknown, expected: unknown): void { if (canonicalJson(value) !== canonicalJson(expected)) throw new Error(); }
function readRecord(value: unknown): { pointer: unknown; snapshot: unknown } {
  if (Object.getOwnPropertyDescriptor(recordPrototype, 'constructor')?.value !== Neo4jRecord) throw new Error();
  const row = fields(value, recordPrototype); exact(row, ['keys', 'length', '_fields', '_fieldLookup']);
  same(detached(row.keys), ['pointer', 'snapshot']); if (row.length !== 2) throw new Error();
  same(detached(row._fieldLookup), { pointer: 0, snapshot: 1 }); array(row._fields, 2, 2);
  return { pointer: Reflect.apply(recordGet, value, ['pointer']), snapshot: Reflect.apply(recordGet, value, ['snapshot']) };
}
function captureRun(transaction: unknown): (query: string, parameters: Fields) => unknown {
  if (!transaction || typeof transaction !== 'object' || types.isProxy(transaction)) throw new Error();
  const own = Object.getOwnPropertyDescriptor(transaction, 'run');
  let run: unknown;
  if (own) { if (!Object.hasOwn(own, 'value')) throw new Error(); run = own.value; }
  else {
    const prototype = Object.getPrototypeOf(transaction);
    if (prototype === ManagedTransaction.prototype) run = managedRun;
    else if (prototype === Transaction.prototype) run = transactionRun;
    else throw new Error();
  }
  if (typeof run !== 'function' || types.isProxy(run)) throw new Error();
  return (query, parameters) => Reflect.apply(run, transaction, [query, parameters]);
}
function safeStreamPromiseMetadata(stream: object): boolean {
  // AsyncHooks adds numeric data symbols to native promises. They do not take
  // part in Promise dispatch; names are not authentication or an allowlist.
  for (const key of Reflect.ownKeys(stream)) {
    if (typeof key !== 'symbol' || promiseControlSymbols.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(stream, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'number'
      || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return false;
  }
  return true;
}
function captureMethod(receiver: unknown, name: string, required = true): ((...args: unknown[]) => unknown) | undefined {
  if (!receiver || typeof receiver !== 'object' || types.isProxy(receiver)) throw new Error();
  let prototype: object | null = receiver; let depth = 0;
  while (prototype !== null) {
    if (types.isProxy(prototype) || ++depth > 8) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) throw new Error();
      const method = descriptor.value; return (...args) => Reflect.apply(method, receiver, args);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  if (required) throw new Error(); return undefined;
}
function assertNonThenPayload(value: unknown): void {
  if (value === null || typeof value !== 'object') { if (typeof value === 'function') throw new Error(); return; }
  let prototype: object | null = value; let depth = 0;
  while (prototype !== null) {
    if (types.isProxy(prototype) || ++depth > 8 || Object.getOwnPropertyDescriptor(prototype, 'then')) throw new Error();
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
}
function sdkCompletionMetadata(value: unknown): Fields {
  let nodes = 0; const visited = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 32) throw new Error();
    if (item === null || item === undefined || typeof item === 'boolean') return item;
    if (typeof item === 'string') { if (item.length > 65536) throw new Error(); return item; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error(); return item; }
    if (typeof item !== 'object' || types.isProxy(item) || visited.has(item)) throw new Error(); visited.add(item);
    try {
      if (Object.getPrototypeOf(item) === integerPrototype) {
        if (Reflect.ownKeys(integerPrototype).length !== integerBehavior.length
          || integerBehavior.some(([key, descriptor]) => !sameDescriptor(Object.getOwnPropertyDescriptor(integerPrototype, key), descriptor))) throw new Error();
        const bits = fields(item, integerPrototype); exact(bits, ['low', 'high']);
        for (const bit of [bits.low, bits.high]) if (typeof bit !== 'number' || !Number.isInteger(bit) || bit < -2147483648 || bit > 2147483647) throw new Error();
        const number = (bits.high as number) * 4294967296 + ((bits.low as number) >>> 0);
        if (!Number.isSafeInteger(number)) throw new Error();
        // SDK Summary accepts numbers. Normalize data words without exposing
        // mutable Integer methods across its asynchronous connection release.
        return number;
      }
      if (Array.isArray(item)) return Object.freeze(array(item, 0, 4096).map(element => copy(element, depth + 1)));
      const data = fields(item); const result: Fields = Object.create(null) as Fields;
      for (const [key, element] of Object.entries(data)) {
        if (['then', 'constructor', 'prototype', '__proto__', '__isInteger__', 'toNumber', 'toString', 'valueOf'].includes(key)) throw new Error();
        result[key] = copy(element, depth + 1);
      }
      return Object.freeze(result);
    } finally { visited.delete(item); }
  };
  fields(value); return copy(value, 0) as Fields;
}
function freshSdkResult(carrier: object, parameters: Fields): boolean {
  try {
    if (Object.getPrototypeOf(carrier) !== resultPrototype || resultBehavior.some(({ prototype, parent, descriptors }) =>
      Object.getPrototypeOf(prototype) !== parent || Reflect.ownKeys(prototype).length !== descriptors.length
      || descriptors.some(([key, descriptor]) => !sameDescriptor(Object.getOwnPropertyDescriptor(prototype, key), descriptor)))) return false;
    const keys = Reflect.ownKeys(carrier);
    if (keys.length !== resultFields.length + 1 || !keys.includes(Symbol.toStringTag) || resultFields.some(key => !keys.includes(key))) return false;
    const data: Fields = Object.create(null) as Fields;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(carrier, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
      if (key === Symbol.toStringTag) { if (descriptor.value !== 'Result') return false; }
      else { if (typeof key !== 'string') return false; data[key] = descriptor.value; }
    }
    // Fresh run() results must not have cached/overridden promise or mapper
    // state. A prototype marker alone does not close indirect SDK dispatch.
    if (['_p', '_keys', '_summary', '_error', '_mapper'].some(key => data[key] !== null)
      || data._retry !== undefined || data._retriedError !== undefined || array(data._ownedObservers, 0, 0).length !== 0
      || (typeof data._stack !== 'string' && data._stack !== null) || data._query !== READ_PUBLICATION_CYPHER) return false;
    same(detached(data._parameters), parameters);
    const watermarks = fields(data._watermarks); exact(watermarks, ['high', 'low']);
    if (typeof watermarks.high !== 'number' || typeof watermarks.low !== 'number' || !Number.isFinite(watermarks.high)
      || !Number.isFinite(watermarks.low) || watermarks.low < 0 || watermarks.high < watermarks.low) return false;
    if (!data._connectionHolder || typeof data._connectionHolder !== 'object' || Array.isArray(data._connectionHolder) || types.isProxy(data._connectionHolder)) return false;
    // SDK _subscribe calls the stream promise's .then directly. Inspect its
    // control surface before invoking SDK methods, not only the outer carrier.
    const stream = data._streamObserverPromise;
    if (types.isProxy(stream) || !types.isPromise(stream) || Object.getPrototypeOf(stream) !== nativePromisePrototype
      || !safeStreamPromiseMetadata(stream) || !sameDescriptor(Object.getOwnPropertyDescriptor(nativePromise, Symbol.species), promiseSpecies)
      || promiseDescriptors.some(([key, descriptor]) => !sameDescriptor(Object.getOwnPropertyDescriptor(nativePromisePrototype, key), descriptor))) return false;
    return true;
  } catch { return false; }
}
async function observeQuery(carrier: unknown, deadline: number, parameters: Fields, active: () => boolean): Promise<BoundedProviderObservation> {
  const remaining = () => Math.ceil(deadline - performance.now());
  const observe = async (operation: () => unknown): Promise<BoundedProviderObservation> => {
    const timeout = remaining();
    if (!active() || timeout < 1) return { status: 'timeout', pendingCompletionUnknown: true };
    return boundedProviderCall(operation, Math.min(timeout, 30000));
  };
  if (types.isProxy(carrier)) return { status: 'invalid-return', pendingCompletionUnknown: true };
  if (types.isPromise(carrier)) return observe(() => carrier);
  // The official driver returns Result, not a native Promise. Do not adopt an
  // arbitrary thenable/getter; capture the known SDK method for this one class.
  if (!carrier || typeof carrier !== 'object' || !freshSdkResult(carrier, parameters)) return { status: 'invalid-return', pendingCompletionUnknown: true };
  let indirectFailure: BoundedProviderObservation | undefined;
  let ownedHolder: object | undefined; let ownedStream: Promise<object> | undefined;
  let rejectSdkBridge: ((reason: unknown) => void) | undefined; let sdkCallbacksClosed = false;
  let controlProfile: ReadonlyMap<PropertyKey, PropertyDescriptor> | undefined;
  const mutableSdkState = new Set<PropertyKey>(['_p', '_keys', '_summary', '_error', '_ownedObservers', '_retriedError']);
  const refuseSdkCallbacks = (): void => {
    sdkCallbacksClosed = true; indirectFailure = { status: 'invalid-return', pendingCompletionUnknown: true };
    rejectSdkBridge?.(new Error('[neo4j publication readback] invalid SDK callback state'));
  };
  const validCallbackState = (): boolean => {
    try {
      if (!controlProfile || Object.getPrototypeOf(carrier) !== resultPrototype
        || resultBehavior.some(({ prototype, parent, descriptors }) => Object.getPrototypeOf(prototype) !== parent
          || Reflect.ownKeys(prototype).length !== descriptors.length
          || descriptors.some(([key, descriptor]) => !sameDescriptor(Object.getOwnPropertyDescriptor(prototype, key), descriptor)))
        || Reflect.ownKeys(carrier).length !== controlProfile.size) return false;
      for (const [key, expected] of controlProfile) {
        const actual = Object.getOwnPropertyDescriptor(carrier, key);
        if (!actual || !Object.hasOwn(actual, 'value') || types.isProxy(actual.value)) return false;
        if (!sameDescriptor(mutableSdkState.has(key) ? { ...actual, value: expected.value } : actual, expected)) return false;
      }
      const state = (key: string): unknown => Object.getOwnPropertyDescriptor(carrier, key)?.value;
      const pending = state('_p');
      if (pending !== null && (!types.isPromise(pending) || Object.getPrototypeOf(pending) !== nativePromisePrototype || !safeStreamPromiseMetadata(pending))) return false;
      const keys = state('_keys'); if (keys !== null && array(keys, 0, 512).some(key => typeof key !== 'string')) return false;
      array(state('_ownedObservers'), 0, 128);
      return true;
    } catch { return false; }
  };
  const invalid = (): never => {
    indirectFailure = { status: 'invalid-return', pendingCompletionUnknown: true }; throw new Error('[neo4j publication readback] invalid SDK receiver');
  };
  const unwrap = (observation: BoundedProviderObservation): unknown => {
    if (observation.status === 'fulfilled') return observation.value;
    if (observation.status !== 'rejected') indirectFailure = observation;
    throw new Error('[neo4j publication readback] SDK operation failed');
  };
  try {
    const holderDescriptor = Object.getOwnPropertyDescriptor(carrier, '_connectionHolder');
    const streamDescriptor = Object.getOwnPropertyDescriptor(carrier, '_streamObserverPromise');
    if (!holderDescriptor?.writable || !streamDescriptor?.writable) return { status: 'invalid-return', pendingCompletionUnknown: true };
    const getConnection = captureMethod(holderDescriptor.value, 'getConnection');
    const releaseConnection = captureMethod(holderDescriptor.value, 'releaseConnection');
    const stream = await observe(() => streamDescriptor.value);
    if (stream.status !== 'fulfilled') return stream;
    // Await opens a mutation window. Recheck all captured SDK control fields
    // and identities before indirect dispatch, without freezing global SDKs.
    if (!freshSdkResult(carrier, parameters)
      || Object.getOwnPropertyDescriptor(carrier, '_connectionHolder')?.value !== holderDescriptor.value
      || Object.getOwnPropertyDescriptor(carrier, '_streamObserverPromise')?.value !== streamDescriptor.value) return invalid();
    const observer = stream.value;
    const subscribe = captureMethod(observer, 'subscribe');
    const observerFacade: Record<string, (...args: unknown[]) => unknown> = Object.create(null) as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ['cancel', 'pause', 'resume', 'unsubscribeAll']) {
      const method = captureMethod(observer, name, false); if (method) observerFacade[name] = (...args) => method(...args);
    }
    observerFacade.subscribe = (...args) => {
      if (!active() || remaining() < 1) { indirectFailure = { status: 'timeout', pendingCompletionUnknown: true }; throw new Error('[neo4j publication readback] closed SDK subscription'); }
      const handler = args[0]; const completed = captureMethod(handler, 'onCompleted'); const onError = captureMethod(handler, 'onError');
      const handlerFacade: Record<string, (...args: unknown[]) => unknown> = Object.create(null) as Record<string, (...args: unknown[]) => unknown>;
      const open = () => {
        if (sdkCallbacksClosed) return false;
        if (active() && remaining() > 0) {
          if (validCallbackState()) return true;
          refuseSdkCallbacks(); return false;
        }
        indirectFailure = { status: 'timeout', pendingCompletionUnknown: true }; return false;
      };
      const onNext = captureMethod(handler, 'onNext', false);
      if (onNext) handlerFacade.onNext = (...event) => open() ? onNext(...event) : undefined;
      const onKeys = captureMethod(handler, 'onKeys', false);
      if (onKeys) handlerFacade.onKeys = keys => {
        if (!open()) return;
        try {
          const copied = array(keys, 0, 512); if (copied.some(key => typeof key !== 'string')) throw new Error();
          return onKeys(Object.freeze(copied));
        } catch { refuseSdkCallbacks(); }
      };
      // Summary eagerly reads completion metadata before business validation.
      // Capture ordinary data first; never hand a raw Proxy/accessor to it.
      handlerFacade.onCompleted = metadata => {
        if (!open()) return;
        try { return completed?.(sdkCompletionMetadata(metadata)); }
        catch { refuseSdkCallbacks(); }
      };
      // Publication errors expose no raw stream details. A self-owned Error
      // also avoids SDK reads of untrusted code/diagnosticRecord accessors.
      handlerFacade.onError = () => open() ? onError?.(new Error('[neo4j publication readback] SDK stream failed')) : undefined;
      try { return subscribe?.(Object.freeze(handlerFacade), ...args.slice(1)); }
      catch { throw new Error('[neo4j publication readback] SDK subscription failed'); }
    };
    const holderFacade = Object.freeze({
      async getConnection(): Promise<unknown> {
        const connection = unwrap(await observe(() => getConnection?.()));
        if (connection === null || connection === undefined) return null;
        try {
          const getProtocolVersion = captureMethod(connection, 'getProtocolVersion');
          return Object.freeze({ getProtocolVersion() {
            try { const value = getProtocolVersion?.(); assertNonThenPayload(value); return value; } catch { return invalid(); }
          } });
        } catch { return invalid(); }
      },
      async releaseConnection(): Promise<void> { unwrap(await observe(() => releaseConnection?.())); }
    });
    // Keep the original SDK Result lifecycle/state; only replace indirect
    // receiver surfaces with captured, self-owned facades. Async payloads are
    // observed inside safe envelopes before SDK then/subscribe can read them.
    ownedHolder = holderFacade; ownedStream = nativePromise.resolve(Object.freeze(observerFacade));
    // SDK needs mutable result state (_p/keys/summary), not replacement of
    // these owned receiver surfaces after subscription has started.
    Object.defineProperty(carrier, '_connectionHolder', { ...holderDescriptor, value: ownedHolder, writable: false, configurable: false });
    Object.defineProperty(carrier, '_streamObserverPromise', { ...streamDescriptor, value: ownedStream, writable: false, configurable: false });
    const readonlyCopies: Fields = { _parameters: detached(parameters), _watermarks: Object.freeze(fields(Object.getOwnPropertyDescriptor(carrier, '_watermarks')?.value)) };
    for (const key of Reflect.ownKeys(carrier)) {
      const descriptor = Object.getOwnPropertyDescriptor(carrier, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalid();
      const value = typeof key === 'string' && Object.hasOwn(readonlyCopies, key) ? readonlyCopies[key] : descriptor.value;
      Object.defineProperty(carrier, key, { ...descriptor, value, writable: mutableSdkState.has(key), configurable: false });
    }
    // The installed SDK assigns only existing state slots during consumption.
    // Prevent late own-method shadows without freezing those writable slots.
    Object.preventExtensions(carrier);
    controlProfile = new Map(Reflect.ownKeys(carrier).map(key => [key, Object.getOwnPropertyDescriptor(carrier, key)!]));
  } catch { return indirectFailure ?? { status: 'invalid-return', pendingCompletionUnknown: true }; }
  const observed = await observe(() => new nativePromise((resolve, reject) => {
    rejectSdkBridge = reject;
    // boundedProviderCall dispatches in a microtask; recheck at that actual
    // boundary as well, since preparing the facade is not a lock on the SDK.
    if (!freshSdkResult(carrier, parameters)
      || Object.getOwnPropertyDescriptor(carrier, '_connectionHolder')?.value !== ownedHolder
      || Object.getOwnPropertyDescriptor(carrier, '_streamObserverPromise')?.value !== ownedStream) return invalid();
    // Wrap the payload so Promise resolution never adopts payload.then before
    // the business maps have been inspected without executing accessors.
    Reflect.apply(resultThen, carrier, [(value: unknown) => resolve({ value }), reject]);
  }));
  if (indirectFailure) return indirectFailure;
  return observed.status === 'fulfilled' ? { status: 'fulfilled', value: (observed.value as { value: unknown }).value } : observed;
}

/** Native Neo4j business-data adapter, not a PublicationSource proof issuer.
 * Environment is only a frozen local label; enterprise origin/IAM and runner
 * binding remain separate gates. Full query application bounds do not establish
 * transport limits or an atomic cross-database snapshot. The managed driver may
 * retry its own I/O; this adapter refuses a second business callback/Cypher. */
export class Neo4jKnowledgeGraphPublicationReadback {
  readonly executionProfile = 'local-reference' as const;
  readonly productionCapable = false;
  #scope: Scope;
  #executeRead: (operation: string, work: (transaction: unknown) => Promise<unknown>) => unknown;
  #timeout: number;
  #maxReads: number;
  #reads = 0;
  #busy = false;
  #halted = false;

  constructor(client: Pick<Neo4jClient, 'executeRead'>, options: unknown) {
    try {
      const cfg = fields(detached(options)); exact(cfg, ['executionProfile', 'scope', 'operationTimeoutMs', 'maxReads']);
      if (cfg.executionProfile !== 'local-reference') throw new Error(); const scope = fields(cfg.scope); exact(scope, ['environment', 'tenantId', 'corpusId']);
      Object.values(scope).forEach(value => identifier(value)); this.#scope = freeze(scope) as Scope;
      this.#timeout = integer(cfg.operationTimeoutMs, 30000); this.#maxReads = integer(cfg.maxReads, 128);
      if (!client || typeof client !== 'object' || types.isProxy(client)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(client, 'executeRead');
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) throw new Error();
      const executeRead = descriptor.value; this.#executeRead = (operation, work) => Reflect.apply(executeRead, client, [operation, work]); Object.freeze(this);
    } catch { throw new Neo4jPublicationReadbackError('invalid-config'); }
  }

  async readPublication(request: unknown): Promise<Neo4jPublicationData> {
    if (this.#halted) throw new Neo4jPublicationReadbackError('halted'); if (this.#busy) throw new Neo4jPublicationReadbackError('busy');
    try { exact(fields(detached(request)), []); } catch { throw new Neo4jPublicationReadbackError('invalid-request'); }
    if (this.#reads >= this.#maxReads) throw new Neo4jPublicationReadbackError('read-limit'); this.#reads++; this.#busy = true;
    let entries = 0; let completed = false; let callbackSettled = false; let callbackClosed = false;
    let businessResult: unknown; let queryFailure: Neo4jPublicationReadbackError | undefined;
    const completedToken = Object.freeze({});
    const deadline = performance.now() + this.#timeout;
    try {
      const work = async (transaction: unknown): Promise<unknown> => {
        entries++; if (callbackClosed || entries !== 1 || this.#halted) throw new Neo4jPublicationReadbackError('automatic-retry-refused');
        try {
          const run = captureRun(transaction);
          const parameters = Object.freeze({ tenantId: this.#scope.tenantId, corpusId: this.#scope.corpusId });
          if (performance.now() >= deadline) {
            this.#halted = true; queryFailure = new Neo4jPublicationReadbackError('query-timeout'); throw queryFailure;
          }
          const query = await observeQuery(run(READ_PUBLICATION_CYPHER, parameters), deadline, parameters, () => !callbackClosed && !this.#halted);
          if (query.status === 'timeout' || query.status === 'invalid-return') {
            this.#halted = true;
            queryFailure = new Neo4jPublicationReadbackError(query.status === 'timeout' ? 'query-timeout' : 'provider-contract-invalid', query.pendingCompletionUnknown);
            throw queryFailure;
          }
          if (query.status === 'rejected') throw new Neo4jPublicationReadbackError('query-failed');
          businessResult = query.value; completed = true; return completedToken;
        } finally {
          // A provider may reject before this callback settles. Success alone
          // cannot distinguish an observed business rejection from pending I/O.
          callbackSettled = true;
        }
      };
      const observed = await boundedProviderCall(() => this.#executeRead('read knowledge graph publication', work), this.#timeout);
      if (observed.status === 'timeout' || observed.status === 'invalid-return') {
        this.#halted = true;
        throw new Neo4jPublicationReadbackError(observed.status === 'timeout' ? 'query-timeout' : 'provider-contract-invalid',
          observed.pendingCompletionUnknown || (entries > 0 && !callbackSettled));
      }
      if (entries > 1) { this.#halted = true; throw new Neo4jPublicationReadbackError('automatic-retry-refused', !callbackSettled); }
      if (queryFailure) throw queryFailure;
      if (observed.status === 'rejected') {
        const unknown = entries > 0 && !callbackSettled; if (unknown) this.#halted = true;
        throw new Neo4jPublicationReadbackError('query-failed', unknown);
      }
      if (entries !== 1 || !completed || observed.value !== completedToken) {
        this.#halted = true; throw new Neo4jPublicationReadbackError('provider-contract-invalid', !callbackSettled);
      }
      try {
        const result = fields(businessResult); exact(result, ['records', 'summary']);
        const row = readRecord(array(result.records, 1, 1)[0]);
        const pointer = fields(row.pointer); exact(pointer, ['tenantId', 'corpusId', 'graphVersion', 'revision']);
        identifier(pointer.graphVersion, 512); pointer.revision = integer(pointer.revision, Number.MAX_SAFE_INTEGER);
        same({ tenantId: pointer.tenantId, corpusId: pointer.corpusId }, { tenantId: this.#scope.tenantId, corpusId: this.#scope.corpusId });
        const snapshot = fields(row.snapshot); exact(snapshot, ['tenantId', 'corpusId', 'graphVersion', 'status', 'artifactDigest', 'documentCount', 'documents']);
        same({ tenantId: snapshot.tenantId, corpusId: snapshot.corpusId, graphVersion: snapshot.graphVersion },
          { tenantId: pointer.tenantId, corpusId: pointer.corpusId, graphVersion: pointer.graphVersion });
        if (snapshot.status !== 'active') throw new Error(); const count = integer(snapshot.documentCount, 512);
        const documents = array(snapshot.documents, 1, 512).map(value => {
          const document = fields(value); exact(document, ['tenantId', 'corpusId', 'graphVersion', 'documentId', 'documentVersion', 'trustLevel', 'status']);
          same({ tenantId: document.tenantId, corpusId: document.corpusId, graphVersion: document.graphVersion },
            { tenantId: snapshot.tenantId, corpusId: snapshot.corpusId, graphVersion: snapshot.graphVersion });
          if (document.status !== 'staging') throw new Error();
          return { documentId: document.documentId, documentVersion: document.documentVersion, trustLevel: document.trustLevel };
        });
        if (count !== documents.length) throw new Error();
        const manifest = createBuildPublicationManifest({ tenantId: snapshot.tenantId, corpusId: snapshot.corpusId, graphVersion: snapshot.graphVersion,
          artifactDigest: snapshot.artifactDigest, documents });
        return detached({ scope: this.#scope, pointer, snapshot: { tenantId: manifest.tenantId, corpusId: manifest.corpusId,
          graphVersion: manifest.graphVersion, status: 'active', artifactDigest: manifest.artifactDigest, documents: manifest.documents } }) as Neo4jPublicationData;
      } catch { throw new Neo4jPublicationReadbackError('invalid-readback'); }
    } finally { callbackClosed = true; this.#busy = false; }
  }
}
