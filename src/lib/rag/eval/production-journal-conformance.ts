import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { boundedProviderCall } from './bounded-provider-call';
import { createJournalEntry, GENESIS_DIGEST, JOURNAL_SCHEMA_VERSION, validateJournalChain,
  type JournalAppendRequest, type JournalBinding, type JournalEntry, type JournalHead,
  type RunJournalStorePort } from './production-run-journal';
import { PROVIDER_CONFORMANCE_REQUIREMENTS, PROVIDER_CONFORMANCE_REQUIREMENTS_HASH } from './production-provider-trust';

export const JOURNAL_CONFORMANCE_SCHEMA = 'kg-isolated-journal-conformance/v1' as const;
export const JOURNAL_CONFORMANCE_PROBES = Object.freeze(['journal-genesis', 'journal-append-readback',
  'journal-exact-retry', 'journal-concurrent-cas', 'journal-head-cas-fields', 'journal-entry-integrity',
  'journal-binding-fields', 'journal-chain-predecessor', 'journal-idempotency-identity',
  'journal-result-correlation', 'journal-pending-terminal', 'journal-fence-advance',
  'journal-stale-and-future-token', 'journal-entry-fence', 'journal-fence-monotonicity',
  'journal-complete-results', 'journal-terminal-seal', 'journal-terminal-immutability'] as const);

/** A separately authorized disposable fixture control, NOT production fencing authority. */
export interface IsolatedJournalFenceControlPort { advanceFence(generation: number): Promise<unknown> }
export interface IsolatedJournalConformancePorts {
  readonly journal: RunJournalStorePort;
  readonly fenceControl: IsolatedJournalFenceControlPort;
}
type Fields = Record<string, unknown>;
type ProbeId = typeof JOURNAL_CONFORMANCE_PROBES[number];
type AdapterCall = (request?: unknown) => Promise<unknown>;
interface ProbeObservation {
  readonly probeId: ProbeId;
  readonly outcome: 'passed' | 'failed' | 'not-run';
  readonly failureCode: string | null;
}
export interface JournalConformanceCore {
  readonly schemaVersion: 'kg-isolated-journal-observations/v1';
  readonly validationLevel: 'isolated-behavioral-observations';
  readonly classification: 'confidential';
  readonly productionAccepted: false;
  readonly requirementVerdict: 'incomplete';
  readonly verdict: 'passed' | 'failed';
  readonly pendingCompletionUnknown: boolean;
  readonly probes: readonly ProbeObservation[];
  readonly configHash: string;
  readonly challengeNonce: string;
  readonly requirementsHash: string;
  readonly unimplementedRequirements: { readonly 'run-journal': readonly string[] };
}
export interface JournalConformanceObservations extends JournalConformanceCore {
  readonly observations: JournalConformanceCore;
  readonly observationsHash: string;
}
class ProbeFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(`[journal conformance] ${code}`); this.code = code; }
}

/**
 * Executes fixed black-box operations on a fresh disposable journal. Caller
 * isolation/profile labels do not authorize an enterprise resource. The external
 * harness must authenticate the resource, permissions and measured adapters,
 * isolate the process, and sign its own evidence. No endpoint/credential path is
 * provided here. Fixture control advances fences and this suite seals the run;
 * NEVER pass a production or shared journal. Durability/IAM are not certified.
 */
export async function runIsolatedJournalConformance(input: unknown, portsInput: unknown): Promise<JournalConformanceObservations> {
  const config = configFor(input);
  const ports = descriptors(portsInput); exact(ports, ['journal', 'fenceControl']);
  const storeData = descriptors(ports.journal);
  if (storeData.executionProfile !== config.executionProfile
    || storeData.productionCapable !== (config.executionProfile === 'enterprise')) throw new ProbeFailure('profile-mismatch');
  // Capture ALL methods before awaiting; requests/readbacks never control the oracle.
  const store = capture(ports.journal, storeData, ['readHead', 'readEntries', 'compareAndAppend']);
  const control = capture(ports.fenceControl, descriptors(ports.fenceControl), ['advanceFence']);
  const binding = config.binding as JournalBinding;
  const challengeNonce = randomBytes(16).toString('hex');
  const initialGeneration = config.initialFencingGeneration as number;
  let generation = initialGeneration; let ordinal = 0; let pendingCompletionUnknown = false;
  let terminal = false; const ledger: JournalEntry[] = [];
  const expectedHead = (): JournalHead => freeze({ schemaVersion: JOURNAL_SCHEMA_VERSION, kind: 'head', binding,
    entryCount: ledger.length, rootDigest: ledger.at(-1)?.digest ?? GENESIS_DIGEST, fencingGeneration: generation, terminal });
  const invoke = async (call: AdapterCall, request?: unknown): Promise<unknown> => {
    const detached = request === undefined ? undefined : freeze(snapshot(request));
    const result = await boundedProviderCall(() => call(detached), config.operationTimeoutMs as number);
    if (result.status === 'timeout' || result.status === 'invalid-return') {
      pendingCompletionUnknown ||= result.pendingCompletionUnknown;
      throw new ProbeFailure(result.status === 'timeout' ? 'operation-timeout' : 'provider-contract-invalid');
    }
    if (result.status === 'rejected') throw new ProbeFailure('provider-rejection');
    // Detach before async return, so a fulfilled payload cannot start adoption.
    return result.value === undefined ? undefined : freeze(snapshot(result.value));
  };
  const observeAll = async (operations: readonly Promise<unknown>[], code: string): Promise<unknown[]> => {
    // Fast rejection must not freeze a false "no pending completion" report
    // while another already-started operation can still mutate the fixture.
    const settled = await Promise.allSettled(operations); const values: unknown[] = [];
    for (const result of settled) {
      if (result.status === 'rejected') throw new ProbeFailure(code); values.push(result.value);
    }
    return values;
  };
  const assertState = async () => {
    // invoke already detached and deeply froze both untrusted payloads before
    // async adoption. Re-copying private snapshots adds no protection.
    const [detachedHead, detachedEntries] = await observeAll([invoke(store.readHead), invoke(store.readEntries)], 'readback-operation-incomplete');
    if (detachedHead === undefined || detachedEntries === undefined) throw new ProbeFailure('invalid-data');
    equal(detachedHead, expectedHead(), 'head-readback-mismatch');
    equal(detachedEntries, ledger, 'chain-readback-mismatch');
    validateJournalChain(detachedEntries, binding, detachedHead);
  };
  const newIntent = (): JournalEntry => createJournalEntry({ schemaVersion: JOURNAL_SCHEMA_VERSION, kind: 'intent', binding,
    seq: ledger.length + 1, prevDigest: expectedHead().rootDigest, fencingGeneration: generation,
    idempotencyKey: `probe-${challengeNonce}-${ordinal++}`, actorId: config.actorId,
    authorizationDigest: config.authorizationDigest, action: 'readback', parametersDigest: canonicalJsonSha256([challengeNonce, ordinal, 'parameters']),
    beforeDigest: canonicalJsonSha256([challengeNonce, ordinal, 'before']), afterDigest: null, intentDigest: null,
    outcome: null, trustedTime: config.observedAt });
  const foreignBindings = (): JournalBinding[] => ['environment', 'tenantId', 'corpusId', 'scopeHash', 'runNonce', 'manifestHash'].map(field => {
    const foreign: Fields = { ...binding, [field]: field === 'runNonce' ? alternate(binding.runNonce, 32)
      : field === 'manifestHash' || field === 'scopeHash' ? alternate(binding[field], 64) : differentId(binding[field as keyof JournalBinding]) };
    if (['environment', 'tenantId', 'corpusId'].includes(field)) foreign.scopeHash = canonicalJsonSha256({
      environment: foreign.environment, tenantId: foreign.tenantId, corpusId: foreign.corpusId });
    return foreign as unknown as JournalBinding;
  });
  const requestFor = (entry: JournalEntry): JournalAppendRequest => freeze({ expectedHead: expectedHead(), entry, fencingGeneration: generation });
  const response = (input: unknown): Fields => {
    const value = record(snapshot(input)); exact(value, ['status', 'head']);
    if (!['appended', 'already-applied', 'conflict', 'stale-fence', 'terminal'].includes(value.status as string)) throw new ProbeFailure('invalid-status');
    return value;
  };
  const exactRetry = async (entry: JournalEntry) => {
    const value = response(await invoke(store.compareAndAppend, requestFor(entry)));
    if (value.status !== 'already-applied') throw new ProbeFailure('exact-retry-status');
    equal(value.head, expectedHead(), 'retry-head-mismatch'); await assertState();
  };
  const append = async (entry: JournalEntry) => {
    const value = response(await invoke(store.compareAndAppend, requestFor(entry)));
    if (value.status !== 'appended') throw new ProbeFailure('legal-append-rejected');
    ledger.push(entry); terminal = entry.kind === 'terminal';
    equal(value.head, expectedHead(), 'append-head-mismatch'); await assertState();
  };
  const rejectAppend = async (request: unknown, allowedStatus: 'conflict' | 'stale-fence' | 'terminal' = 'conflict') => {
    let value: unknown;
    try { value = await invoke(store.compareAndAppend, request); }
    catch (error) {
      if (!(error instanceof ProbeFailure) || error.code !== 'provider-rejection') throw error;
      await assertState(); return;
    }
    const result = response(value);
    if (result.status !== allowedStatus) throw new ProbeFailure('invalid-append-accepted');
    equal(result.head, expectedHead(), 'rejection-head-mismatch'); await assertState();
  };
  const rejectThenLegal = async (entry: JournalEntry, rejectedRequest: unknown) => {
    await rejectAppend(rejectedRequest);
    // Full readback alone misses an ID consumed by a mutate-then-throw adapter.
    await append(entry);
  };
  const rejectFence = async (value: number) => {
    try { await invoke(control.advanceFence, value); }
    catch (error) {
      if (!(error instanceof ProbeFailure) || error.code !== 'provider-rejection') throw error;
      await assertState(); return;
    }
    throw new ProbeFailure('invalid-fence-accepted');
  };
  const advanceFence = async () => {
    const value = snapshot(await invoke(control.advanceFence, generation + 1)); generation++;
    equal(value, expectedHead(), 'fence-head-mismatch'); await assertState();
  };
  const resultFor = (intent: JournalEntry): JournalEntry => createJournalEntry({ ...bodyOf(intent), kind: 'result',
    seq: ledger.length + 1, prevDigest: expectedHead().rootDigest, fencingGeneration: generation,
    afterDigest: canonicalJsonSha256([challengeNonce, intent.digest, 'after']), intentDigest: intent.digest, outcome: 'completed' });
  const seal = (): JournalEntry => createJournalEntry({ ...bodyOf(newIntent()), kind: 'terminal', action: 'seal-run',
    beforeDigest: expectedHead().rootDigest, afterDigest: canonicalJsonSha256([challengeNonce, 'sealed']), outcome: 'passed' });
  let first: JournalEntry; let firstRequest: JournalAppendRequest; let finalEntry: JournalEntry; let finalRequest: JournalAppendRequest;
  let deferredTerminalKey: string | null = null;
  const plans: Record<ProbeId, () => Promise<void>> = {
    async 'journal-genesis'() { await assertState(); },
    async 'journal-append-readback'() { first = newIntent(); firstRequest = requestFor(first); await append(first); },
    async 'journal-exact-retry'() {
      for (const expected of [firstRequest.expectedHead, expectedHead()]) {
        const value = response(await invoke(store.compareAndAppend, { ...firstRequest, expectedHead: expected }));
        if (value.status !== 'already-applied') throw new ProbeFailure('exact-retry-status');
        equal(value.head, expectedHead(), 'retry-head-mismatch'); await assertState();
      }
      for (const foreign of foreignBindings()) await rejectAppend({ ...requestFor(first), expectedHead: { ...expectedHead(), binding: foreign } });
      for (const changed of [{ schemaVersion: 'kg-other-journal/v1' }, { kind: 'other' }, { entryCount: -1 },
        { rootDigest: 'invalid' }, { fencingGeneration: 0 }, { terminal: 'true' }]) {
        await rejectAppend({ ...requestFor(first), expectedHead: { ...expectedHead(), ...changed } });
      }
      await exactRetry(first);
    },
    async 'journal-concurrent-cas'() {
      const a = newIntent(); const b = newIntent(); const head = expectedHead();
      const results = await observeAll([a, b].map(entry => invoke(store.compareAndAppend,
        { expectedHead: head, entry, fencingGeneration: generation })), 'concurrent-operation-incomplete');
      const parsed = results.map(response);
      if (parsed.filter(value => value.status === 'appended').length !== 1
        || parsed.filter(value => value.status === 'conflict').length !== 1) throw new ProbeFailure('concurrent-cas-violation');
      const winner = parsed[0].status === 'appended' ? a : b;
      const loser = parsed[0].status === 'appended' ? b : a;
      ledger.push(winner);
      for (const value of parsed) equal(value.head, expectedHead(), 'concurrent-head-mismatch');
      await assertState();
      // Conflict must not consume the loser's ID. Only its sequence/predecessor
      // change when retrying the same operation against the now-current head.
      await append(createJournalEntry({ ...bodyOf(loser), seq: ledger.length + 1, prevDigest: expectedHead().rootDigest }));
    },
    async 'journal-head-cas-fields'() {
      const changes = { schemaVersion: 'kg-other-journal/v1', kind: 'other', entryCount: ledger.length + 1,
        rootDigest: canonicalJsonSha256('journal-wrong-root'), fencingGeneration: generation + 1, terminal: true };
      for (const [field, value] of Object.entries(changes)) {
        const entry = newIntent(); await rejectThenLegal(entry, { ...requestFor(entry), expectedHead: { ...expectedHead(), [field]: value } });
      }
      for (const foreign of foreignBindings()) {
        const entry = newIntent(); await rejectThenLegal(entry, { ...requestFor(entry), expectedHead: { ...expectedHead(), binding: foreign } });
      }
    },
    async 'journal-entry-integrity'() {
      for (const mutation of [(entry: JournalEntry) => ({ ...entry, digest: alternate(entry.digest, 64) }),
        (entry: JournalEntry) => ({ ...entry, parametersDigest: alternate(entry.parametersDigest, 64) }),
        (entry: JournalEntry) => changedEntry(entry, { extra: 'forbidden' }),
        (entry: JournalEntry) => changedEntry(entry, { schemaVersion: 'kg-other-journal/v1' }),
        (entry: JournalEntry) => changedEntry(entry, { action: 'run-shell' })]) {
        const entry = newIntent(); await rejectThenLegal(entry, { ...requestFor(entry), entry: mutation(entry) });
      }
    },
    async 'journal-binding-fields'() {
      for (const foreign of foreignBindings()) {
        const entry = newIntent(); await rejectThenLegal(entry, { ...requestFor(entry), entry: changedEntry(entry, { binding: foreign }) });
      }
    },
    async 'journal-chain-predecessor'() {
      for (const field of ['seq-before', 'seq-after', 'prevDigest', 'trustedTime']) {
        const entry = newIntent(); const changed = field === 'prevDigest' ? { prevDigest: alternate(entry.prevDigest, 64) }
          : field === 'trustedTime' ? { trustedTime: new Date(Date.parse(config.observedAt as string) - 1).toISOString() }
            : { seq: entry.seq + (field === 'seq-before' ? -1 : 1) };
        await rejectThenLegal(entry, { ...requestFor(entry), entry: changedEntry(entry, changed) });
      }
    },
    async 'journal-idempotency-identity'() {
      for (const changes of [{}, { actorId: differentId(first.actorId) }, { authorizationDigest: alternate(first.authorizationDigest, 64) },
        { parametersDigest: alternate(first.parametersDigest, 64) }, { beforeDigest: alternate(first.beforeDigest, 64) },
        { action: 'activate' }, { trustedTime: new Date(Date.parse(config.observedAt as string) + 1).toISOString() },
        ...foreignBindings().map(binding => ({ binding }))]) {
        const legal = newIntent(); const entry = changedEntry(legal, { ...changes, idempotencyKey: first.idempotencyKey });
        await rejectThenLegal(legal, { ...requestFor(legal), entry });
      }
    },
    async 'journal-result-correlation'() {
      for (const field of ['intentDigest', 'idempotencyKey', 'action', 'parametersDigest', 'beforeDigest'] as const) {
        const intent = newIntent(); await append(intent); const result = resultFor(intent);
        const replacement = field === 'action' ? 'activate' : field === 'idempotencyKey' ? `other-${challengeNonce}`
          : alternate(result[field] as string, 64);
        await rejectThenLegal(result, { ...requestFor(result), entry: changedEntry(result, { [field]: replacement }) });
        for (const changes of [{}, { afterDigest: alternate(result.afterDigest as string, 64) }, { outcome: 'failed' }, { outcome: 'aborted' },
          { actorId: differentId(result.actorId) }, { authorizationDigest: alternate(result.authorizationDigest, 64) },
          { trustedTime: new Date(Date.parse(config.observedAt as string) + 1).toISOString() }]) {
          await rejectAppend(requestFor(changedEntry(result, { ...changes, seq: ledger.length + 1, prevDigest: expectedHead().rootDigest })));
        }
        await exactRetry(result);
      }
    },
    async 'journal-pending-terminal'() {
      const rejected = seal(); await rejectAppend(requestFor(rejected));
      await append(createJournalEntry({ ...bodyOf(newIntent()), idempotencyKey: rejected.idempotencyKey }));
      const deferred = seal(); await rejectAppend(requestFor(deferred)); deferredTerminalKey = deferred.idempotencyKey;
    },
    async 'journal-fence-advance'() {
      await advanceFence();
      const retry = response(await invoke(store.compareAndAppend, { ...firstRequest, expectedHead: expectedHead(), fencingGeneration: generation }));
      if (retry.status !== 'already-applied') throw new ProbeFailure('current-owner-retry-status');
      equal(retry.head, expectedHead(), 'current-owner-retry-head'); await assertState(); await append(newIntent());
    },
    async 'journal-stale-and-future-token'() {
      await rejectAppend(firstRequest, 'stale-fence');
      for (const token of [initialGeneration, generation + 1, 0]) {
        const entry = newIntent(); await rejectAppend({ ...requestFor(entry), fencingGeneration: token }, 'stale-fence'); await append(entry);
      }
    },
    async 'journal-entry-fence'() {
      for (const value of [initialGeneration, generation + 1, 0]) {
        const entry = newIntent(); await rejectThenLegal(entry, { ...requestFor(entry), entry: changedEntry(entry, { fencingGeneration: value }) });
      }
    },
    async 'journal-fence-monotonicity'() {
      for (const value of [generation, initialGeneration, 0]) {
        await rejectFence(value);
        // A rejected control operation must not consume/poison the next generation.
        await advanceFence(); await append(newIntent());
      }
    },
    async 'journal-complete-results'() {
      const resolved = new Set(ledger.filter(entry => entry.kind === 'result').map(entry => entry.idempotencyKey));
      for (const intent of ledger.filter(entry => entry.kind === 'intent' && !resolved.has(entry.idempotencyKey))) await append(resultFor(intent));
      const completed = ledger.find(entry => entry.kind === 'result');
      if (!completed) throw new ProbeFailure('missing-result-sample');
      for (const entry of [changedEntry(completed, { seq: ledger.length + 1, prevDigest: expectedHead().rootDigest,
        fencingGeneration: generation, afterDigest: alternate(completed.afterDigest as string, 64), outcome: 'failed' }),
        changedEntry(newIntent(), { idempotencyKey: completed.idempotencyKey }), changedEntry(seal(), { idempotencyKey: completed.idempotencyKey })]) {
        await rejectAppend(requestFor(entry)); await exactRetry(completed);
      }
    },
    async 'journal-terminal-seal'() {
      if (!deferredTerminalKey) throw new ProbeFailure('missing-deferred-terminal-id');
      finalEntry = changedEntry(seal(), { idempotencyKey: deferredTerminalKey }); finalRequest = requestFor(finalEntry); await append(finalEntry);
    },
    async 'journal-terminal-immutability'() {
      const retry = response(await invoke(store.compareAndAppend, finalRequest));
      if (retry.status !== 'already-applied') throw new ProbeFailure('terminal-retry-status');
      equal(retry.head, expectedHead(), 'terminal-retry-head'); await assertState();
      const oldResult = ledger.find(entry => entry.kind === 'result');
      if (!oldResult) throw new ProbeFailure('missing-result-sample');
      for (const entry of [first, oldResult, finalEntry]) {
        const existing = response(await invoke(store.compareAndAppend, requestFor(entry)));
        if (existing.status !== 'already-applied') throw new ProbeFailure('terminal-history-retry-status');
        equal(existing.head, expectedHead(), 'terminal-history-retry-head'); await assertState();
      }
      for (const entry of [newIntent(), resultFor(first), seal()]) await rejectAppend(requestFor(entry), 'terminal');
      await rejectAppend({ ...finalRequest, fencingGeneration: initialGeneration }, 'stale-fence');
      await rejectFence(generation + 1); await assertState();
    },
  };
  const probes: ProbeObservation[] = []; let stopped = false;
  for (const probeId of JOURNAL_CONFORMANCE_PROBES) {
    if (stopped) { probes.push({ probeId, outcome: 'not-run', failureCode: null }); continue; }
    try { await plans[probeId](); probes.push({ probeId, outcome: 'passed', failureCode: null }); }
    catch (error) {
      probes.push({ probeId, outcome: 'failed', failureCode: error instanceof ProbeFailure ? error.code : 'invalid-response' }); stopped = true;
    }
  }
  const observations: JournalConformanceCore = freeze({ schemaVersion: 'kg-isolated-journal-observations/v1',
    validationLevel: 'isolated-behavioral-observations', classification: 'confidential', productionAccepted: false,
    requirementVerdict: 'incomplete', verdict: stopped ? 'failed' : 'passed', pendingCompletionUnknown, probes,
    configHash: canonicalJsonSha256(config), challengeNonce, requirementsHash: PROVIDER_CONFORMANCE_REQUIREMENTS_HASH,
    unimplementedRequirements: { 'run-journal': [...PROVIDER_CONFORMANCE_REQUIREMENTS['run-journal']] } });
  return freeze({ ...observations, observations, observationsHash: canonicalJsonSha256(observations) });
}

function configFor(input: unknown): Fields {
  const config = record(snapshot(input)); exact(config, ['schemaVersion', 'isolation', 'executionProfile', 'binding',
    'initialFencingGeneration', 'actorId', 'authorizationDigest', 'observedAt', 'operationTimeoutMs']);
  if (config.schemaVersion !== JOURNAL_CONFORMANCE_SCHEMA || config.isolation !== 'disposable-test-scope'
    || !['local-reference', 'enterprise'].includes(config.executionProfile as string)) throw new ProbeFailure('invalid-config');
  const generation = config.initialFencingGeneration;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1
    || generation > Number.MAX_SAFE_INTEGER - 5) throw new ProbeFailure('invalid-config');
  if (typeof config.operationTimeoutMs !== 'number' || !Number.isSafeInteger(config.operationTimeoutMs)
    || config.operationTimeoutMs < 1 || config.operationTimeoutMs > 30000) throw new ProbeFailure('invalid-config');
  try {
    validateJournalChain([], config.binding, { schemaVersion: JOURNAL_SCHEMA_VERSION, kind: 'head', binding: config.binding,
      entryCount: 0, rootDigest: GENESIS_DIGEST, fencingGeneration: generation, terminal: false });
    createJournalEntry({ schemaVersion: JOURNAL_SCHEMA_VERSION, kind: 'intent', binding: config.binding,
      seq: 1, prevDigest: GENESIS_DIGEST, fencingGeneration: generation, idempotencyKey: 'probe-validation',
      actorId: config.actorId, authorizationDigest: config.authorizationDigest, action: 'readback',
      parametersDigest: GENESIS_DIGEST, beforeDigest: GENESIS_DIGEST, afterDigest: null, intentDigest: null,
      outcome: null, trustedTime: config.observedAt });
  } catch { throw new ProbeFailure('invalid-config'); }
  return freeze(config);
}
function descriptors(input: unknown): Fields {
  if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)) throw new ProbeFailure('invalid-adapter');
  // Adapter property names are untrusted; __proto__ must remain ordinary data.
  const data: Fields = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') throw new ProbeFailure('invalid-adapter');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new ProbeFailure('invalid-adapter'); data[key] = descriptor.value;
  }
  return data;
}
function capture(input: unknown, data: Fields, methods: readonly string[]): Record<string, AdapterCall> {
  const captured: Record<string, AdapterCall> = Object.create(null);
  for (const method of methods) {
    const fn = data[method]; if (typeof fn !== 'function' || types.isProxy(fn)) throw new ProbeFailure('invalid-adapter');
    captured[method] = request => Reflect.apply(fn, input, request === undefined ? [] : [request]);
  }
  return Object.freeze(captured);
}
function snapshot(input: unknown): unknown {
  try { return JSON.parse(canonicalJson(input)); } catch { throw new ProbeFailure('invalid-data'); }
}
function record(input: unknown): Fields {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProbeFailure('invalid-data'); return input as Fields;
}
function exact(input: Fields, fields: readonly string[]): void {
  if (fields.some(field => !Object.hasOwn(input, field)) || Object.keys(input).some(field => !fields.includes(field))) throw new ProbeFailure('invalid-data');
}
function bodyOf(entry: JournalEntry): Fields { return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'digest')); }
function changedEntry(entry: JournalEntry, changes: Fields): JournalEntry {
  // Deliberately do NOT validate adversarial bodies before exercising the port.
  const body = { ...bodyOf(entry), ...changes }; return freeze({ ...body, digest: canonicalJsonSha256(body) }) as unknown as JournalEntry;
}
function alternate(value: string, length: number): string { return value === '0'.repeat(length) ? '1'.repeat(length) : '0'.repeat(length); }
function differentId(value: string): string { return value === 'conformance-other' ? 'conformance-other-2' : 'conformance-other'; }
function equal(actual: unknown, expected: unknown, code: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new ProbeFailure(code);
}
function freeze<T>(input: T): T {
  if (input && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input;
}
