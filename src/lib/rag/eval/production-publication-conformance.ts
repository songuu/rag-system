import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { boundedProviderCall, boundedProviderCallWithRejection } from './bounded-provider-call';
import { PROVIDER_CONFORMANCE_REQUIREMENTS, PROVIDER_CONFORMANCE_REQUIREMENTS_HASH } from './production-provider-trust';
import { createReferencePublicationReadback, PublicationIdentityError } from '../../knowledge-graph/publication-identity';
import type { PublicationReadbackDecision } from '../../knowledge-graph/publication-identity';
import { createIsolatedPublicationStateObserver, PublicationStateObserverError } from './production-publication-state-observer';
import type { PublicationObservedRow, PublicationStateProjection } from './production-publication-state-observer';

export const PUBLICATION_CONFORMANCE_SCHEMA = 'kg-isolated-publication-conformance/v1' as const;
export const PUBLICATION_CONFORMANCE_PROBES = Object.freeze(['matching-active', 'extra-version', 'missing-chunk',
  'empty-active-view', 'deactivated-active-view', 'read-only-state'] as const);
type Scenario = 'matching-active' | 'extra-version' | 'missing-chunk' | 'empty' | 'deactivated';
type ProbeId = typeof PUBLICATION_CONFORMANCE_PROBES[number];
type Fields = Record<string, unknown>;
type Call = (request: unknown) => unknown;
const monotonicNow = performance.now.bind(performance);
interface CapturedPort { readonly receiver: object; readonly methods: Readonly<Record<string, Call>> }
interface Configuration {
  readonly schemaVersion: typeof PUBLICATION_CONFORMANCE_SCHEMA; readonly isolation: 'disposable-test-scope';
  readonly readerOptions: Readonly<Fields>; readonly operationTimeoutMs: number;
}
/** This control only selects a fixture scenario. It supplies no expected
 * identity, precomputed decision, assurance or caller-selected verdict. */
export interface IsolatedPublicationScenarioControlPort {
  selectScenario(scenario: Scenario): Promise<void>;
}
interface ProbeObservation {
  readonly probeId: ProbeId; readonly outcome: 'passed' | 'failed' | 'not-run'; readonly failureCode: string | null;
  readonly notRunReason: 'prior-probe-failed' | 'mutation-observer-not-implemented' | null;
  readonly decisionHashes: readonly string[];
  readonly witnessHashes: readonly string[];
}
type StateObserver = ReturnType<typeof createIsolatedPublicationStateObserver>;
type ObservedState = Awaited<ReturnType<StateObserver['observeActualState']>>;
export interface PublicationConformanceCore {
  readonly schemaVersion: 'kg-isolated-publication-observations/v1'; readonly validationLevel: 'isolated-behavioral-observations';
  readonly classification: 'confidential'; readonly productionAccepted: false; readonly requirementVerdict: 'incomplete';
  readonly verdict: 'passed' | 'failed'; readonly pendingCompletionUnknown: boolean;
  readonly configHash: string; readonly challengeNonce: string; readonly requirementsHash: string;
  readonly unimplementedRequirements: readonly string[]; readonly probes: readonly ProbeObservation[];
}
export interface PublicationConformanceObservations extends PublicationConformanceCore {
  readonly observations: PublicationConformanceCore; readonly observationsHash: string;
}
class ProbeFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(`[publication conformance] ${code}`); this.code = code; }
}

/** Fixed black-box ACTIVE-view probes on explicitly disposable resources.
 * NEVER supply production/shared controls. The external harness owns physical
 * isolation and cleanup; labels cannot prove IAM, origin, read-only identity,
 * cancellation or the complete frozen conformance requirements. Empty and
 * deactivated views are rejection controls, not positive baseline contracts. */
export async function runIsolatedPublicationConformance(input: unknown, portsInput: unknown): Promise<PublicationConformanceObservations> {
  let config: Configuration; let control: CapturedPort; let readerPorts: Fields; let sources: CapturedPort; let clock: CapturedPort;
  let observer: StateObserver; let challengeNonce: string;
  try {
    const value = object(snapshot(input)); exact(value, ['schemaVersion', 'isolation', 'readerOptions', 'operationTimeoutMs']);
    if (value.schemaVersion !== PUBLICATION_CONFORMANCE_SCHEMA || value.isolation !== 'disposable-test-scope'
      || !Number.isSafeInteger(value.operationTimeoutMs) || (value.operationTimeoutMs as number) < 1
      || (value.operationTimeoutMs as number) > 30000) throw new Error();
    const options = object(value.readerOptions);
    // Each probe gets our own reader. Caller factories/decisions are not ports;
    // the full existing constructor validates all options before control IO.
    if (options.executionProfile !== 'local-reference' || options.maxVerifications !== 1) throw new Error();
    config = freeze(value) as unknown as Configuration;
    const ports = descriptors(portsInput, ['sources', 'clock', 'control']); exact(ports, ['sources', 'clock', 'control']);
    sources = capture(ports.sources, ['readPostgres', 'readNeo4j', 'readMilvusPage'], true, ['setAvailability']);
    clock = capture(ports.clock, ['readTime'], true, ['advanceTo', 'setAvailability']);
    control = capture(ports.control, ['selectScenario'], false);
    readerPorts = { sources: forwarding(sources, ['readPostgres', 'readNeo4j', 'readMilvusPage']), clock: forwarding(clock, ['readTime']) };
    createReferencePublicationReadback(config.readerOptions, readerPorts);
    challengeNonce = randomBytes(16).toString('hex');
    observer = createIsolatedPublicationStateObserver({ readerOptions: config.readerOptions, challengeNonce,
      maxObservations: 32, operationTimeoutMs: config.operationTimeoutMs }, readerPorts);
  } catch { throw new ProbeFailure('invalid-config'); }
  let pendingCompletionUnknown = false; let baseline: ObservedState | null = null;
  const seenDecisions = new Set<string>(); const observations: ProbeObservation[] = [];
  let stopped = false;
  const select = async (scenario: Scenario): Promise<void> => {
    const result = await boundedProviderCall(() => Reflect.apply(control.methods.selectScenario, control.receiver, [scenario]), config.operationTimeoutMs);
    if (result.status !== 'fulfilled' || result.value !== undefined) {
      // A failed mutation callback cannot prove the disposable fixture's final
      // state. Do not reset it automatically or begin another business read.
      pendingCompletionUnknown = true; throw new ProbeFailure('control-completion-unknown');
    }
  };
  const observe = async (hashes: string[]): Promise<ObservedState> => {
    const result = await boundedProviderCallWithRejection(() => observer.observeActualState(Object.freeze({})), config.operationTimeoutMs);
    if (result.status === 'timeout' || result.status === 'invalid-return') {
      observer.close(); const reason = result.status === 'timeout' && Object.hasOwn(result, 'reason') ? result.reason : undefined;
      pendingCompletionUnknown ||= result.pendingCompletionUnknown || observerUnknown(reason);
      throw new ProbeFailure(pendingCompletionUnknown ? 'reader-completion-unknown' : 'reader-operation-timeout');
    }
    if (result.status === 'rejected') {
      observer.close(); pendingCompletionUnknown ||= observerUnknown(result.reason);
      throw new ProbeFailure(pendingCompletionUnknown ? 'reader-completion-unknown' : 'unexpected-reader-failure');
    }
    const state = result.value as ObservedState; hashes.push(state.stateHash); return state;
  };
  const readTarget = async (mismatch: boolean, hashes: string[]): Promise<PublicationReadbackDecision | null> => {
    const lifecycle = { closed: false, deadline: monotonicNow() + config.operationTimeoutMs };
    const assertOpen = () => {
      // Timer callbacks can be starved. Also fence this particular reader after
      // its outer observation, so late completion cannot start further IO.
      if (lifecycle.closed || monotonicNow() >= lifecycle.deadline) throw new PublicationIdentityError('halted', 'preflight');
    };
    try {
    const scopedPorts = { sources: forwarding(sources, ['readPostgres', 'readNeo4j', 'readMilvusPage'], assertOpen),
      clock: forwarding(clock, ['readTime'], assertOpen) };
    const reader = createReferencePublicationReadback(config.readerOptions, scopedPorts);
    const result = await boundedProviderCallWithRejection(() => reader.readPublication(Object.freeze({})), config.operationTimeoutMs);
    if (result.status === 'timeout' || result.status === 'invalid-return') {
      const failure = result.status === 'timeout' && Object.hasOwn(result, 'reason') ? publicationFailure(result.reason) : null;
      pendingCompletionUnknown ||= result.pendingCompletionUnknown || failure?.pending === true;
      throw new ProbeFailure(pendingCompletionUnknown ? 'reader-completion-unknown' : 'reader-operation-timeout');
    }
    if (result.status === 'rejected') {
      const failure = publicationFailure(result.reason);
      if (failure?.pending) { pendingCompletionUnknown = true; throw new ProbeFailure('reader-completion-unknown'); }
      if (mismatch && failure?.code === 'identity-mismatch' && ['postgres', 'neo4j', 'milvus', 'final-validation'].includes(failure.phase)) return null;
      throw new ProbeFailure('unexpected-reader-failure');
    }
    if (mismatch) throw new ProbeFailure('counterexample-accepted');
    // The reader is locally constructed, never supplied by a caller. Record
    // its complete decision, not a made-up expected proof or a verdict marker.
    const decision = result.value as PublicationReadbackDecision;
    const { observationHash, ...body } = decision;
    if (observationHash !== canonicalJsonSha256(body) || seenDecisions.has(observationHash)) throw new ProbeFailure('invalid-decision');
    seenDecisions.add(observationHash); hashes.push(observationHash); return decision;
    } finally { lifecycle.closed = true; }
  };
  const read = async (scenario: Scenario, hashes: string[], witnessHashes: string[]): Promise<void> => {
    const before = await observe(witnessHashes);
    if (baseline && !scenarioMatches(scenario, baseline.projection, before.projection)) throw new ProbeFailure('scenario-witness-mismatch');
    const mismatch = scenario !== 'matching-active'; const decision = await readTarget(mismatch, hashes);
    const after = await observe(witnessHashes);
    if (before.stateHash !== after.stateHash) throw new ProbeFailure('scenario-witness-mismatch');
    if (!mismatch) {
      if (!decision || decision.identityHash !== canonicalJsonSha256(config.readerOptions.expectedIdentity)
        || canonicalJson(decision.identityRef) !== canonicalJson(config.readerOptions.expectedIdentityRef)
        || decision.rowCount !== before.rowCount || decision.rowsManifestHash !== before.rowsManifestHash) throw new ProbeFailure('scenario-witness-mismatch');
      if (before.projection.milvus.rows.length < 2) throw new ProbeFailure('counterexample-fixture-too-small');
      if (!baseline) baseline = before;
    }
  };
  for (const probeId of PUBLICATION_CONFORMANCE_PROBES) {
    if (stopped || probeId === 'read-only-state') {
      observations.push({ probeId, outcome: 'not-run', failureCode: null,
        notRunReason: stopped ? 'prior-probe-failed' : 'mutation-observer-not-implemented', decisionHashes: [], witnessHashes: [] }); continue;
    }
    const hashes: string[] = []; const witnessHashes: string[] = [];
    try {
      const scenario: Scenario = probeId === 'empty-active-view' ? 'empty' : probeId === 'deactivated-active-view' ? 'deactivated' : probeId;
      await select(scenario); await read(scenario, hashes, witnessHashes);
      // Refusal alone could conceal a broken/unavailable backend. Restore the
      // SAME disposable ports and prove a fresh legal complete read afterward.
      if (probeId !== 'matching-active') { await select('matching-active'); await read('matching-active', hashes, witnessHashes); }
      observations.push({ probeId, outcome: 'passed', failureCode: null, notRunReason: null, decisionHashes: hashes, witnessHashes });
    } catch (error) {
      observer.close(); stopped = true; observations.push({ probeId, outcome: 'failed', failureCode: error instanceof ProbeFailure ? error.code : 'invalid-provider-data',
        notRunReason: null, decisionHashes: hashes, witnessHashes });
    }
  }
  observer.close();
  const core: PublicationConformanceCore = freeze({ schemaVersion: 'kg-isolated-publication-observations/v1',
    validationLevel: 'isolated-behavioral-observations', classification: 'confidential', productionAccepted: false,
    requirementVerdict: 'incomplete', verdict: stopped ? 'failed' : 'passed', pendingCompletionUnknown,
    configHash: canonicalJsonSha256(config), challengeNonce, requirementsHash: PROVIDER_CONFORMANCE_REQUIREMENTS_HASH,
    unimplementedRequirements: PROVIDER_CONFORMANCE_REQUIREMENTS['publication-readback'], probes: observations });
  return freeze({ ...core, observations: core, observationsHash: canonicalJsonSha256(core) });
}

function publicationFailure(reason: unknown): { code: string; phase: string; pending: boolean } | null {
  if (reason === null || typeof reason !== 'object' || types.isProxy(reason) || Object.getPrototypeOf(reason) !== PublicationIdentityError.prototype) return null;
  const code = Object.getOwnPropertyDescriptor(reason, 'code')?.value;
  const phase = Object.getOwnPropertyDescriptor(reason, 'phase')?.value;
  const pending = Object.getOwnPropertyDescriptor(reason, 'pendingCompletionUnknown')?.value;
  if (typeof code !== 'string' || typeof phase !== 'string' || typeof pending !== 'boolean') return null;
  return { code, phase, pending };
}
function observerUnknown(reason: unknown): boolean {
  return reason !== null && typeof reason === 'object' && !types.isProxy(reason)
    && Object.getPrototypeOf(reason) === PublicationStateObserverError.prototype
    && Object.getOwnPropertyDescriptor(reason, 'pendingCompletionUnknown')?.value === true;
}
function scenarioMatches(scenario: Scenario, baseline: PublicationStateProjection, actual: PublicationStateProjection): boolean {
  const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
  const rows = (values: readonly PublicationObservedRow[]) => values.map(value => canonicalJson(value));
  const sameRows = (left: readonly PublicationObservedRow[], right: readonly PublicationObservedRow[]) =>
    left.length === right.length && multisetSubset(rows(left), rows(right));
  const { rows: beforeRows, ...beforeMeta } = baseline.milvus;
  const { rows: afterRows, ...afterMeta } = actual.milvus;
  if (!same(baseline.postgres, actual.postgres) || !same(beforeMeta, afterMeta)) return false;
  if (scenario === 'deactivated') {
    const { snapshot: beforeSnapshot, ...beforeGraph } = baseline.neo4j;
    const { snapshot: afterSnapshot, ...afterGraph } = actual.neo4j;
    const { status: beforeStatus, ...beforeBody } = beforeSnapshot;
    const { status: afterStatus, ...afterBody } = afterSnapshot;
    return beforeStatus === 'active' && afterStatus === 'inactive' && same(beforeGraph, afterGraph) && same(beforeBody, afterBody) && sameRows(beforeRows, afterRows);
  }
  if (!same(baseline.neo4j, actual.neo4j)) return false;
  if (scenario === 'matching-active') return sameRows(beforeRows, afterRows);
  if (scenario === 'empty') return afterRows.length === 0;
  if (scenario === 'missing-chunk') return afterRows.length > 0 && afterRows.length < beforeRows.length && multisetSubset(rows(afterRows), rows(beforeRows));
  if (afterRows.length <= beforeRows.length || !multisetSubset(rows(beforeRows), rows(afterRows))) return false;
  const remaining = new Map<string, number>();
  for (const key of rows(beforeRows)) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  const extras: PublicationObservedRow[] = [];
  for (const value of afterRows) { const key = canonicalJson(value); const count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1); else extras.push(value); }
  // A true version superset preserves every baseline field, and new versions
  // must form complete chunk groups rather than arbitrary replacement rows.
  const knownDocuments = new Set(beforeRows.map(value => value.documentId));
  const knownVersions = new Set(beforeRows.map(value => canonicalJson([value.documentId, value.documentVersion])));
  const groups = new Map<string, PublicationObservedRow[]>(); const ids = new Set(beforeRows.map(value => value.chunkId));
  for (const value of extras) {
    const key = canonicalJson([value.documentId, value.documentVersion]);
    if (!knownDocuments.has(value.documentId) || knownVersions.has(key) || ids.has(value.chunkId)) return false;
    ids.add(value.chunkId); const group = groups.get(key) ?? []; group.push(value); groups.set(key, group);
  }
  return groups.size > 0 && [...groups.values()].every(group => group.every(value => value.totalChunks === group.length && value.trustLevel === group[0].trustLevel)
    && new Set(group.map(value => value.chunkIndex)).size === group.length && group.every(value => value.chunkIndex >= 0 && value.chunkIndex < group.length));
}
function multisetSubset(left: readonly string[], right: readonly string[]): boolean {
  const available = new Map<string, number>(); for (const key of right) available.set(key, (available.get(key) ?? 0) + 1);
  for (const key of left) { const count = available.get(key) ?? 0; if (count === 0) return false; available.set(key, count - 1); } return true;
}
function forwarding(port: CapturedPort, methods: readonly string[], assertOpen: () => void = () => undefined): Fields {
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    ...Object.fromEntries(methods.map(method => [method, (request: unknown) => { assertOpen(); return Reflect.apply(port.methods[method], port.receiver, [request]); }])) });
}
function capture(input: unknown, methods: readonly string[], profiled: boolean, optional: readonly string[] = []): CapturedPort {
  const flags = profiled ? ['executionProfile', 'productionCapable'] : [];
  const value = descriptors(input, [...flags, ...methods, ...optional]); exact(value, [...flags, ...methods, ...optional.filter(field => Object.hasOwn(value, field))]);
  if (profiled && (value.executionProfile !== 'local-reference' || value.productionCapable !== false)) throw new Error();
  const captured: Record<string, Call> = Object.create(null);
  for (const method of methods) { if (typeof value[method] !== 'function' || types.isProxy(value[method])) throw new Error(); captured[method] = value[method] as Call; }
  return Object.freeze({ receiver: input as object, methods: Object.freeze(captured) });
}
function descriptors(input: unknown, allowed: readonly string[]): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) throw new Error();
  const result: Fields = Object.create(null); const own = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(own)) { if (typeof key !== 'string' || !allowed.includes(key)) throw new Error();
    const descriptor = own[key]; if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(); result[key] = descriptor.value; }
  return result;
}
function snapshot(input: unknown): unknown { return JSON.parse(canonicalJson(input)); }
function object(input: unknown): Fields { if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(value: Fields, fields: readonly string[]): void { if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error(); }
function freeze<T>(input: T): T { if (input !== null && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input; }
