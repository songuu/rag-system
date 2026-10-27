import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { boundedProviderCall } from './bounded-provider-call';
import { AUTHORIZATION_NONCE_CLAIM_SCHEMA, validateAuthorityClockReading, validateNonceClaimReadback } from './production-authority-ports';
import type { AuthorityClockPort, AuthorityClockReading, AuthorityClockRequest, AuthorityOperationContext,
  AuthorizationNonceStorePort, AuthorizationNonceClaim, ConsumeAuthorizationNonceRequest } from './production-authority-ports';
import { validateArtifactAad } from './production-controlled-artifacts';
import type { ArtifactRunBinding } from './production-controlled-artifacts';
import type { ArtifactReference } from './production-gate-manifest';
import { PROVIDER_CONFORMANCE_REQUIREMENTS, PROVIDER_CONFORMANCE_REQUIREMENTS_HASH } from './production-provider-trust';

export const AUTHORITY_CONFORMANCE_SCHEMA = 'kg-isolated-authority-conformance/v1' as const;
export const AUTHORITY_CONFORMANCE_PROBES = Object.freeze(['clock-identity', 'clock-context', 'clock-challenge',
  'clock-concurrent-challenge', 'clock-monotonic', 'clock-unavailable', 'nonce-consume-readback', 'nonce-context',
  'nonce-replay-identity', 'nonce-issuer-namespace', 'nonce-concurrent-replay', 'nonce-concurrent-clock',
  'nonce-clock-validity', 'nonce-clock-progress', 'nonce-exact-readback', 'nonce-expired-tombstone', 'nonce-capacity'] as const);

/** Separately authorized disposable controls, not a production time authority. */
export interface IsolatedAuthorityClockControlPort {
  advanceTo(observedAt: string): Promise<unknown>;
  setAvailability(available: boolean): Promise<unknown>;
}
export interface IsolatedAuthorityConformancePorts {
  readonly clock: AuthorityClockPort;
  readonly nonceStore: AuthorizationNonceStorePort;
  readonly clockControl: IsolatedAuthorityClockControlPort;
}
type Fields = Record<string, unknown>;
type ProbeId = typeof AUTHORITY_CONFORMANCE_PROBES[number];
type Call = (request: unknown) => unknown;
interface CapturedPort { readonly receiver: object; readonly methods: Readonly<Record<string, Call>> }
interface ClaimExpectation { readonly request: ConsumeAuthorizationNonceRequest; readonly object: AuthorizationNonceClaim; readonly ref: ArtifactReference }
interface Configuration {
  readonly schemaVersion: typeof AUTHORITY_CONFORMANCE_SCHEMA;
  readonly isolation: 'disposable-test-scope'; readonly executionProfile: 'local-reference' | 'enterprise';
  readonly binding: ArtifactRunBinding; readonly actors: { readonly consumerId: string; readonly readOnlyId: string };
  readonly clockIdentityRef: ArtifactReference; readonly nonceStoreIdentityRef: ArtifactReference;
  readonly initialObservedAt: string; readonly uncertaintyMs: number; readonly maxClockUncertaintyMs: number;
  readonly nonceCapacity: number; readonly operationTimeoutMs: number;
}
export interface AuthorityConformanceCore {
  readonly schemaVersion: 'kg-isolated-authority-observations/v1';
  readonly validationLevel: 'isolated-behavioral-observations'; readonly classification: 'confidential';
  readonly productionAccepted: false; readonly requirementVerdict: 'incomplete'; readonly verdict: 'passed' | 'failed';
  readonly pendingCompletionUnknown: boolean; readonly configHash: string; readonly challengeNonce: string;
  readonly requirementsHash: string;
  readonly unimplementedRequirements: { readonly clock: readonly string[]; readonly approval: readonly string[] };
  readonly probes: readonly { readonly probeId: ProbeId; readonly outcome: 'passed' | 'failed' | 'not-run'; readonly failureCode: string | null }[];
}
export interface AuthorityConformanceObservations extends AuthorityConformanceCore {
  readonly observations: AuthorityConformanceCore; readonly observationsHash: string;
}
class ProbeFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(`[authority conformance] ${code}`); this.code = code; }
}

/** Fixed black-box oracle for fresh disposable clock/nonce resources. It changes
 * fixture time/availability and fills the reserved nonce capacity. NEVER supply
 * production/shared resources. Profile labels do not authorize these operations.
 * The external harness must authenticate/isolate actual resources and sign its
 * own evidence. No signature, IAM, clock authority or durable nonce certification
 * is inferred from well-formed readbacks; all full requirements stay incomplete. */
export async function runIsolatedAuthorityConformance(input: unknown, portsInput: unknown): Promise<AuthorityConformanceObservations> {
  const config = configuration(input); const ports = descriptors(portsInput, ['clock', 'nonceStore', 'clockControl']);
  exact(ports, ['clock', 'nonceStore', 'clockControl']);
  const clock = capture(ports.clock, ['readTime'], ['advanceTo', 'setAvailability'], config.executionProfile);
  const store = capture(ports.nonceStore, ['consumeAuthorizationNonce', 'readExactNonceClaim'], [], config.executionProfile);
  const control = capture(ports.clockControl, ['advanceTo', 'setAvailability'], [], null);
  const challengeNonce = randomBytes(16).toString('hex'); let ordinal = 0; let pendingCompletionUnknown = false;
  let now = time(config.initialObservedAt); let lastSequence = 0;
  const ledger: ClaimExpectation[] = [];
  const identity = (purpose: string): string => canonicalJsonSha256([challengeNonce, purpose, ordinal++]);
  const context = (binding: ArtifactRunBinding = config.binding, actorId = config.actors.consumerId): AuthorityOperationContext =>
    freeze({ executionProfile: config.executionProfile, binding, actorId });
  const invoke = async (port: CapturedPort, method: string, request: unknown): Promise<unknown> => {
    const detached = freeze(snapshot(request));
    const result = await boundedProviderCall(() => Reflect.apply(port.methods[method], port.receiver, [detached]), config.operationTimeoutMs);
    if (result.status === 'timeout' || result.status === 'invalid-return') {
      pendingCompletionUnknown ||= result.pendingCompletionUnknown;
      throw new ProbeFailure(result.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid');
    }
    if (result.status === 'rejected') throw new ProbeFailure('provider-rejection');
    // Fixture controls may return void; object payloads must not be re-adopted.
    return result.value === undefined ? undefined : freeze(snapshot(result.value));
  };
  const reject = async (port: CapturedPort, method: string, request: unknown): Promise<void> => {
    try { await invoke(port, method, request); }
    catch (error) { if (error instanceof ProbeFailure && error.code === 'provider-rejection') return; throw error; }
    throw new ProbeFailure('invalid-operation-accepted');
  };
  const clockRequest = (ctx = context()): AuthorityClockRequest => freeze({ context: ctx, requestNonce: identity('clock').slice(0, 32) });
  const acceptReading = (raw: unknown, request: AuthorityClockRequest): AuthorityClockReading => {
    const reading = validateAuthorityClockReading(raw, { request, sourceIdentityRef: config.clockIdentityRef,
      maxUncertaintyMs: config.maxClockUncertaintyMs, previousReading: null }).reading;
    if (reading.sequence !== lastSequence + 1 || time(reading.observedAt) !== now
      || reading.uncertaintyMs !== config.uncertaintyMs) throw new ProbeFailure('clock-observation-mismatch');
    lastSequence = reading.sequence; return reading;
  };
  const read = async (request = clockRequest()): Promise<AuthorityClockReading> => acceptReading(await invoke(clock, 'readTime', request), request);
  const consumeRequest = async (ctx = context()): Promise<ConsumeAuthorizationNonceRequest> => {
    const clock = await read(clockRequest(ctx)); const margin = config.maxClockUncertaintyMs + 1000;
    return freeze({ context: ctx, issuerId: 'lab-issuer', authorizationNonce: identity('approval').slice(0, 32),
      authorizationId: `probe-${identity('id').slice(0, 32)}`, authorizationKind: 'execution', envelopeDigest: identity('envelope'),
      validFrom: utc(now - margin), expiresAt: utc(now + margin), clockRequestNonce: clock.requestNonce, clockReading: clock });
  };
  const decision = (raw: unknown): Fields => {
    const value = object(snapshot(raw)); exact(value, ['status', 'claimRef']);
    if (!['consumed', 'replayed', 'capacity-exhausted'].includes(value.status as string)) throw new ProbeFailure('invalid-nonce-status');
    if (value.status !== 'consumed' && value.claimRef !== null) throw new ProbeFailure('rejection-leaks-claim'); return value;
  };
  const readClaim = async (expected: ClaimExpectation): Promise<void> => {
    const request = freeze({ context: { ...expected.request.context, actorId: config.actors.readOnlyId }, ref: expected.ref });
    validateNonceClaimReadback(await invoke(store, 'readExactNonceClaim', request), {
      request, storeIdentityRef: config.nonceStoreIdentityRef, expectedClaim: expected.object });
  };
  const acceptClaim = async (raw: unknown, request: ConsumeAuthorizationNonceRequest): Promise<ClaimExpectation> => {
    const result = decision(raw); if (result.status !== 'consumed') throw new ProbeFailure('legal-nonce-rejected');
    const ref = reference(result.claimRef); const object = claimFrom(request);
    if (ref.sha256 !== canonicalJsonSha256(object)) throw new ProbeFailure('claim-digest-mismatch');
    const expected = freeze({ request, object, ref }); await readClaim(expected); ledger.push(expected); return expected;
  };
  const consume = async (request?: ConsumeAuthorizationNonceRequest): Promise<ClaimExpectation> => {
    const approved = request ?? await consumeRequest();
    return acceptClaim(await invoke(store, 'consumeAuthorizationNonce', approved), approved);
  };
  const rejectThenConsume = async (bad: unknown, good: ConsumeAuthorizationNonceRequest): Promise<void> => {
    await reject(store, 'consumeAuthorizationNonce', bad); await consume(good);
  };
  const replay = async (request: ConsumeAuthorizationNonceRequest, stillAvailable?: ConsumeAuthorizationNonceRequest): Promise<void> => {
    if (decision(await invoke(store, 'consumeAuthorizationNonce', request)).status !== 'replayed') throw new ProbeFailure('replay-accepted');
    await readClaim(ledger[0]);
    // A status plus unchanged old claim misses a replay that burns the fresh
    // clock fence. Reuse that exact clock with its independently fresh nonce.
    if (stillAvailable) await consume(stillAvailable);
  };
  const probes: Record<ProbeId, () => Promise<void>> = {
    async 'clock-identity'() { await read(); },
    async 'clock-context'() {
      const good = context();
      const badContexts = [context(config.binding, foreignActor(config.actors.consumerId, config.actors.readOnlyId)),
        { ...good, executionProfile: config.executionProfile === 'enterprise' ? 'local-reference' : 'enterprise' },
        ...['environment', 'tenantId', 'corpusId'].map(field => context({ ...config.binding, [field]: different(config.binding[field as keyof ArtifactRunBinding]) }))];
      for (const bad of badContexts) {
        const legal = clockRequest(); await reject(clock, 'readTime', { ...legal, context: bad }); await read(legal);
      }
      for (const field of ['runNonce', 'manifestHash'] as const) await read(clockRequest(context({ ...config.binding, [field]: alternate(config.binding[field]) })));
    },
    async 'clock-challenge'() {
      const used = clockRequest(); await read(used);
      for (const ctx of [context(), context(config.binding, config.actors.readOnlyId),
        context({ ...config.binding, runNonce: alternate(config.binding.runNonce) })]) await reject(clock, 'readTime', { ...used, context: ctx });
      await read();
    },
    async 'clock-concurrent-challenge'() {
      const request = clockRequest(); const results = await Promise.allSettled([invoke(clock, 'readTime', request), invoke(clock, 'readTime', request)]);
      const winners = results.filter(result => result.status === 'fulfilled'); const losers = results.filter(result => result.status === 'rejected');
      if (winners.length !== 1 || losers.length !== 1 || !(losers[0].reason instanceof ProbeFailure)
        || losers[0].reason.code !== 'provider-rejection') throw new ProbeFailure('clock-exclusive-use-mismatch');
      acceptReading(winners[0].value, request); await read();
    },
    async 'clock-monotonic'() {
      const next = now + 1000; await invoke(control, 'advanceTo', utc(next)); now = next; await read();
      await reject(control, 'advanceTo', utc(now - 1)); await read();
    },
    async 'clock-unavailable'() {
      await invoke(control, 'setAvailability', false); const legal = clockRequest(); await reject(clock, 'readTime', legal);
      await invoke(control, 'setAvailability', true); await read(legal);
    },
    async 'nonce-consume-readback'() { await consume(); },
    async 'nonce-context'() {
      for (const field of ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash'] as const) {
        const legal = await consumeRequest(); const value = field === 'runNonce' || field === 'manifestHash'
          ? alternate(config.binding[field]) : different(config.binding[field]);
        await rejectThenConsume({ ...legal, context: context({ ...config.binding, [field]: value }) }, legal);
      }
      const legal = await consumeRequest(); await rejectThenConsume({ ...legal, context: context(config.binding, config.actors.readOnlyId) }, legal);
      const unknown = await consumeRequest(); await rejectThenConsume({ ...unknown,
        context: context(config.binding, foreignActor(config.actors.consumerId, config.actors.readOnlyId)) }, unknown);
      const next = await consumeRequest(); await rejectThenConsume({ ...next, context: { ...next.context,
        executionProfile: config.executionProfile === 'enterprise' ? 'local-reference' : 'enterprise' } }, next);
    },
    async 'nonce-replay-identity'() {
      const original = ledger[0].request; await replay(original);
      for (const field of ['authorizationId', 'envelopeDigest', 'authorizationKind'] as const) {
        const fresh = await consumeRequest(); await replay({ ...fresh, issuerId: original.issuerId, authorizationNonce: original.authorizationNonce,
          [field]: field === 'authorizationKind' ? 'result' : field === 'envelopeDigest' ? alternate(original.envelopeDigest) : different(original.authorizationId) }, fresh);
      }
      const recovery = await consumeRequest(); await replay({ ...recovery, issuerId: original.issuerId,
        authorizationNonce: original.authorizationNonce, authorizationKind: 'recovery' }, recovery);
      for (const field of ['runNonce', 'manifestHash'] as const) {
        const fresh = await consumeRequest(context({ ...config.binding, [field]: alternate(config.binding[field]) }));
        await replay({ ...fresh, issuerId: original.issuerId, authorizationNonce: original.authorizationNonce }, fresh);
      }
    },
    async 'nonce-issuer-namespace'() {
      const fresh = await consumeRequest(); await consume({ ...fresh, issuerId: different(ledger[0].request.issuerId), authorizationNonce: ledger[0].request.authorizationNonce });
    },
    async 'nonce-concurrent-replay'() {
      const first = await consumeRequest(); const next = await consumeRequest(); const second = freeze({ ...next, issuerId: first.issuerId, authorizationNonce: first.authorizationNonce });
      const results = await Promise.allSettled([invoke(store, 'consumeAuthorizationNonce', first), invoke(store, 'consumeAuthorizationNonce', second)]);
      if (results.some(result => result.status !== 'fulfilled')) throw new ProbeFailure('nonce-race-incomplete');
      const values = results.map(result => decision((result as PromiseFulfilledResult<unknown>).value));
      const winner = values.findIndex(value => value.status === 'consumed');
      if (winner < 0 || values.filter(value => value.status === 'consumed').length !== 1 || values.filter(value => value.status === 'replayed').length !== 1) throw new ProbeFailure('nonce-exclusive-use-mismatch');
      await acceptClaim(values[winner], winner === 0 ? first : second); await replay(first); await replay(second);
      const won = winner === 0 ? first : second; const lost = winner === 0 ? second : first;
      const loserControl = freeze({ ...lost, authorizationNonce: identity('race-loser-control').slice(0, 32),
        authorizationId: `probe-${identity('race-loser-id').slice(0, 32)}` });
      // Conflict must not commit the loser's clock fence. When its sequence is
      // below the winner, it is genuinely stale: reject, then prove its NEW
      // nonce survives by retrying with a fresh clock. Do not assume winner order.
      if (lost.clockReading.sequence > won.clockReading.sequence) await consume(loserControl);
      else {
        await reject(store, 'consumeAuthorizationNonce', loserControl); const reading = await read();
        await consume(freeze({ ...loserControl, clockRequestNonce: reading.requestNonce, clockReading: reading }));
      }
      const fresh = await consumeRequest(); await replay({ ...fresh, issuerId: first.issuerId, authorizationNonce: first.authorizationNonce }, fresh);
    },
    async 'nonce-concurrent-clock'() {
      const first = await consumeRequest(); const second = freeze({ ...first, authorizationNonce: identity('different-nonce').slice(0, 32), authorizationId: different(first.authorizationId) });
      const results = await Promise.allSettled([invoke(store, 'consumeAuthorizationNonce', first), invoke(store, 'consumeAuthorizationNonce', second)]);
      const winner = results.findIndex(result => result.status === 'fulfilled'); const losers = results.filter(result => result.status === 'rejected');
      if (winner < 0 || results.filter(result => result.status === 'fulfilled').length !== 1 || losers.length !== 1
        || !(losers[0].reason instanceof ProbeFailure) || losers[0].reason.code !== 'provider-rejection') throw new ProbeFailure('clock-fence-race-mismatch');
      await acceptClaim((results[winner] as PromiseFulfilledResult<unknown>).value, winner === 0 ? first : second);
      const loser = winner === 0 ? second : first; const clock = await read();
      await consume(freeze({ ...loser, clockRequestNonce: clock.requestNonce, clockReading: clock }));
    },
    async 'nonce-clock-validity'() {
      const edits: ((value: Fields) => void)[] = [
        value => { value.clockRequestNonce = alternate(value.clockRequestNonce as string); },
        value => { (value.clockReading as Fields).readerId = config.actors.readOnlyId; },
        value => { (value.clockReading as Fields).assurance = config.executionProfile === 'enterprise' ? 'local-reference' : 'enterprise'; },
        value => { value.validFrom = utc(now + 1); }, value => { value.expiresAt = utc(now + config.uncertaintyMs); },
        value => { (value.clockReading as Fields).uncertaintyMs = config.maxClockUncertaintyMs + 1; },
        ...['objectId', 'objectVersion', 'sha256'].map(field => (value: Fields) => {
          const source = (value.clockReading as Fields).sourceIdentityRef as Fields;
          source[field] = field === 'sha256' ? alternate(source[field] as string) : different(source[field] as string);
        }),
        ...['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash'].map(field => (value: Fields) => {
          const binding = (value.clockReading as Fields).binding as Fields;
          binding[field] = field === 'runNonce' || field === 'manifestHash' ? alternate(binding[field] as string) : different(binding[field] as string);
        }),
      ];
      if (config.executionProfile === 'local-reference') edits.push(value => { (value.clockReading as Fields).productionTimeAuthenticated = true; });
      for (const edit of edits) { const legal = await consumeRequest(); const bad = object(snapshot(legal)); edit(bad); await rejectThenConsume(bad, legal); }
    },
    async 'nonce-clock-progress'() {
      const reused = freeze({ ...ledger.at(-1)!.request, authorizationNonce: identity('old-clock').slice(0, 32), authorizationId: different(ledger.at(-1)!.request.authorizationId) });
      await reject(store, 'consumeAuthorizationNonce', reused); const clock = await read(); await consume(freeze({ ...reused, clockRequestNonce: clock.requestNonce, clockReading: clock }));
      for (const field of ['sequence', 'observedAt'] as const) {
        const legal = await consumeRequest(); const bad = object(snapshot(legal));
        (bad.clockReading as Fields)[field] = field === 'sequence' ? ledger.at(-1)!.request.clockReading.sequence : utc(now - 1);
        await rejectThenConsume(bad, legal);
      }
    },
    async 'nonce-exact-readback'() {
      const first = ledger[0]; const legal = freeze({ context: context(first.request.context.binding, config.actors.readOnlyId), ref: first.ref });
      for (const field of ['objectId', 'objectVersion', 'sha256'] as const) {
        await reject(store, 'readExactNonceClaim', { ...legal, ref: { ...first.ref, [field]: field === 'sha256' ? alternate(first.ref[field]) : different(first.ref[field]) } }); await readClaim(first);
      }
      for (const field of ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash'] as const) {
        const value = field === 'runNonce' || field === 'manifestHash' ? alternate(config.binding[field]) : different(config.binding[field]);
        await reject(store, 'readExactNonceClaim', { ...legal, context: context({ ...config.binding, [field]: value }, config.actors.readOnlyId) }); await readClaim(first);
      }
      await reject(store, 'readExactNonceClaim', { ...legal, context: context() }); await readClaim(first);
      await reject(store, 'readExactNonceClaim', { ...legal, context: context(config.binding, foreignActor(config.actors.consumerId, config.actors.readOnlyId)) }); await readClaim(first);
      await reject(store, 'readExactNonceClaim', { ...legal, context: { ...legal.context,
        executionProfile: config.executionProfile === 'enterprise' ? 'local-reference' : 'enterprise' } }); await readClaim(first);
    },
    async 'nonce-expired-tombstone'() {
      const first = ledger[0].request; const next = time(first.expiresAt) + config.maxClockUncertaintyMs + 1;
      await invoke(control, 'advanceTo', utc(next)); now = next; await read();
      const fresh = await consumeRequest(); await replay(freeze({ ...fresh, issuerId: first.issuerId, authorizationNonce: first.authorizationNonce }), fresh);
      await consume();
    },
    async 'nonce-capacity'() {
      if (ledger.length >= config.nonceCapacity) throw new ProbeFailure('capacity-fixture-too-small');
      while (ledger.length < config.nonceCapacity) await consume();
      const rejected = await consumeRequest();
      const exhaust = async () => {
        if (decision(await invoke(store, 'consumeAuthorizationNonce', rejected)).status !== 'capacity-exhausted') throw new ProbeFailure('capacity-not-enforced');
      };
      await exhaust(); await exhaust();
      const fresh = await consumeRequest(); await replay(freeze({ ...fresh, issuerId: ledger[0].request.issuerId, authorizationNonce: ledger[0].request.authorizationNonce }));
      // Repeated exact rejection must not consume a nonce or clock fence, even
      // after a separately observed replay while the disposable store is full.
      await exhaust();
      for (const expected of ledger) await readClaim(expected);
    },
  };
  const observations: { probeId: ProbeId; outcome: 'passed' | 'failed' | 'not-run'; failureCode: string | null }[] = [];
  let stopped = false;
  for (const probeId of AUTHORITY_CONFORMANCE_PROBES) {
    if (stopped) { observations.push({ probeId, outcome: 'not-run', failureCode: null }); continue; }
    try { await probes[probeId](); observations.push({ probeId, outcome: 'passed', failureCode: null }); }
    catch (error) { stopped = true; observations.push({ probeId, outcome: 'failed', failureCode: error instanceof ProbeFailure ? error.code : 'invalid-provider-data' }); }
  }
  const core: AuthorityConformanceCore = freeze({ schemaVersion: 'kg-isolated-authority-observations/v1',
    validationLevel: 'isolated-behavioral-observations', classification: 'confidential', productionAccepted: false,
    requirementVerdict: 'incomplete', verdict: stopped ? 'failed' : 'passed', pendingCompletionUnknown,
    configHash: canonicalJsonSha256(config), challengeNonce, requirementsHash: PROVIDER_CONFORMANCE_REQUIREMENTS_HASH,
    unimplementedRequirements: { clock: PROVIDER_CONFORMANCE_REQUIREMENTS.clock, approval: PROVIDER_CONFORMANCE_REQUIREMENTS.approval }, probes: observations });
  return freeze({ ...core, observations: core, observationsHash: canonicalJsonSha256(core) });
}

function claimFrom(request: ConsumeAuthorizationNonceRequest): AuthorizationNonceClaim {
  return freeze({ schemaVersion: AUTHORIZATION_NONCE_CLAIM_SCHEMA, classification: 'confidential', binding: request.context.binding,
    issuerId: request.issuerId, nonceIdentityHash: canonicalJsonSha256([request.issuerId, request.authorizationNonce]),
    authorizationId: request.authorizationId, authorizationKind: request.authorizationKind, envelopeDigest: request.envelopeDigest,
    validFrom: request.validFrom, expiresAt: request.expiresAt, clockReadingHash: canonicalJsonSha256(request.clockReading),
    claimedAt: request.clockReading.observedAt, consumerId: request.context.actorId });
}
function configuration(input: unknown): Configuration {
  try {
    const value = object(snapshot(input)); exact(value, ['schemaVersion', 'isolation', 'executionProfile', 'binding', 'actors',
      'clockIdentityRef', 'nonceStoreIdentityRef', 'initialObservedAt', 'uncertaintyMs', 'maxClockUncertaintyMs', 'nonceCapacity', 'operationTimeoutMs']);
    if (value.schemaVersion !== AUTHORITY_CONFORMANCE_SCHEMA || value.isolation !== 'disposable-test-scope'
      || !['local-reference', 'enterprise'].includes(value.executionProfile as string)) throw new Error();
    const binding = object(value.binding); exact(binding, ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash']);
    validateArtifactAad({ ...binding, artifactType: 'report', artifactId: 'authority-conformance', caseId: null, ordinal: 0, schemaVersion: AUTHORITY_CONFORMANCE_SCHEMA });
    const actors = object(value.actors); exact(actors, ['consumerId', 'readOnlyId']); identifier(actors.consumerId); identifier(actors.readOnlyId);
    if (actors.consumerId === actors.readOnlyId) throw new Error(); reference(value.clockIdentityRef); reference(value.nonceStoreIdentityRef);
    const maximum = integer(value.maxClockUncertaintyMs, 0, 60000); integer(value.uncertaintyMs, 0, maximum);
    integer(value.nonceCapacity, 64, 128); integer(value.operationTimeoutMs, 1, 60000);
    const initial = time(value.initialObservedAt); const margin = maximum + 1000;
    utc(initial - margin); utc(initial + margin * 3 + 2000);
    return freeze(value) as unknown as Configuration;
  } catch { throw new ProbeFailure('invalid-config'); }
}
function capture(input: unknown, methods: readonly string[], controls: readonly string[], profile: Configuration['executionProfile'] | null): CapturedPort {
  const flags = profile === null ? [] : ['executionProfile', 'productionCapable']; const fields = descriptors(input, [...flags, ...methods, ...controls]);
  exact(fields, [...flags, ...methods, ...controls.filter(name => Object.hasOwn(fields, name))]);
  if (profile !== null && (fields.executionProfile !== profile || fields.productionCapable !== (profile === 'enterprise'))) throw new ProbeFailure('profile-mismatch');
  const captured: Record<string, Call> = Object.create(null);
  for (const name of methods) { if (typeof fields[name] !== 'function' || types.isProxy(fields[name])) throw new ProbeFailure('invalid-method'); captured[name] = fields[name] as Call; }
  return Object.freeze({ receiver: input as object, methods: Object.freeze(captured) });
}
function descriptors(input: unknown, allowed: readonly string[]): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)) throw new ProbeFailure('invalid-port');
  const prototype = Object.getPrototypeOf(input); if (prototype !== null && prototype !== Object.prototype) throw new ProbeFailure('invalid-port');
  const fields: Fields = Object.create(null); const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new ProbeFailure('invalid-port'); const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new ProbeFailure('invalid-port'); fields[key] = descriptor.value;
  }
  return fields;
}
function snapshot(input: unknown): unknown { try { return JSON.parse(canonicalJson(input)); } catch { throw new ProbeFailure('invalid-canonical-data'); } }
function object(input: unknown): Fields { if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ProbeFailure('invalid-object'); return input as Fields; }
function exact(input: Fields, expected: readonly string[]): void { if (expected.some(field => !Object.hasOwn(input, field)) || Object.keys(input).some(field => !expected.includes(field))) throw new ProbeFailure('invalid-fields'); }
function reference(input: unknown): ArtifactReference {
  const value = object(input); exact(value, ['objectId', 'objectVersion', 'sha256']); identifier(value.objectId); identifier(value.objectVersion);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new ProbeFailure('invalid-reference'); return freeze(value) as unknown as ArtifactReference;
}
function identifier(input: unknown): string { if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) throw new ProbeFailure('invalid-identifier'); return input; }
function integer(input: unknown, min: number, max: number): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new ProbeFailure('invalid-integer'); return input; }
function time(input: unknown): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw new ProbeFailure('invalid-time'); return Date.parse(input);
}
function utc(input: number): string { const output = new Date(input).toISOString(); time(output); return output; }
function alternate(input: string): string { return `${input[0] === '0' ? '1' : '0'}${input.slice(1)}`; }
function different(input: string): string { return input === 'adversarial' ? 'alternate' : 'adversarial'; }
function foreignActor(...actors: readonly string[]): string { return ['adversarial', 'alternate', 'outsider'].find(value => !actors.includes(value))!; }
function freeze<T>(input: T): T { if (input !== null && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input; }
