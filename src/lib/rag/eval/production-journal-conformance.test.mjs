import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { canonicalJsonSha256 } from './canonical-json.ts';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))
      && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const journal = await import('./production-run-journal.ts');
const suite = await import('./production-journal-conformance.ts');
const trust = await import('./production-provider-trust.ts');
const hash = canonicalJsonSha256;
const clone = value => structuredClone(value);
const scope = { environment: 'isolated-lab', tenantId: 'lab-tenant', corpusId: 'lab-corpus' };
const binding = { ...scope, scopeHash: hash(scope), runNonce: '0123456789abcdef0123456789abcdef', manifestHash: hash('lab-manifest') };
const options = () => ({ schemaVersion: 'kg-isolated-journal-conformance/v1', isolation: 'disposable-test-scope',
  executionProfile: 'local-reference', binding: clone(binding), initialFencingGeneration: 1,
  actorId: 'lab-executor', authorizationDigest: hash('lab-authorization'), observedAt: '2026-10-09T08:00:00.000Z', operationTimeoutMs: 1000 });
function fixture(profile = 'local-reference', testBinding = binding, initialFencingGeneration = 1) {
  const local = journal.createReferenceJournalStore({ binding: testBinding, executionProfile: 'local-reference', initialFencingGeneration });
  const counts = { readHead: 0, readEntries: 0, append: 0, fence: 0 };
  const store = { executionProfile: profile, productionCapable: profile === 'enterprise',
    async readHead() { counts.readHead++; return local.readHead(); },
    async readEntries() { counts.readEntries++; return local.readEntries(); },
    async compareAndAppend(request) { counts.append++; return local.compareAndAppend(request); } };
  const fenceControl = { async advanceFence(generation) { counts.fence++; return local.advanceFence(generation); } };
  return { local, counts, store, fenceControl, ports: { journal: store, fenceControl } };
}
async function run(f, changes = {}) { return suite.runIsolatedJournalConformance({ ...options(), ...changes }, f.ports); }
for (const variant of ['getter', 'nonsettling-callable']) test(`resolved payload then ${variant} is never adopted by the async journal consumer`, { timeout: 1000 }, async () => {
  const f = fixture(); const original = f.store.readHead; let traps = 0;
  f.store.readHead = () => new Promise(resolve => {
    original().then(head => { const value = { ...head }; resolve(value);
      Object.defineProperty(value, 'then', variant === 'getter'
        ? { enumerable: true, get() { traps++; throw Error('payload-then-secret'); } }
        : { enumerable: true, value() { traps++; } });
    });
  });
  failed(await run(f), 'journal-genesis'); assert.equal(traps, 0);
});
test('synchronous provider starvation cannot pass journal conformance', async () => {
  const f = fixture(); const original = f.store.readHead; let first = true;
  f.store.readHead = () => {
    if (first) { first = false; const deadline = performance.now() + 40;
      while (performance.now() < deadline) { /* A timer cannot interrupt provider JavaScript. */ }
    }
    return original();
  };
  const result = await run(f, { operationTimeoutMs: 10 });
  failed(result, 'journal-genesis'); assert.equal(result.pendingCompletionUnknown, false);
  assert.equal(result.probes[0].failureCode, 'readback-operation-incomplete'); assert.equal(f.counts.append, 0);
});
test('thenable getter is not executed by journal conformance', async () => {
  const f = fixture(); let traps = 0;
  f.store.readHead = () => Object.defineProperty({}, 'then', { get() { traps++; throw Error('thenable-secret'); } });
  failed(await run(f), 'journal-genesis'); assert.equal(traps, 0);
});
test('contract-invalid negative append is not mistaken for an authorized rejection', async () => {
  const f = fixture(); const original = f.store.compareAndAppend; let traps = 0;
  f.store.compareAndAppend = request => request.expectedHead.rootDigest === hash('journal-wrong-root')
    ? Object.defineProperty({}, 'then', { get() { traps++; throw Error('negative-then-secret'); } }) : original(request);
  const result = await run(f); failed(result, 'journal-head-cas-fields');
  assert.equal(result.probes.find(value => value.outcome === 'failed').failureCode, 'provider-contract-invalid');
  assert.equal(result.pendingCompletionUnknown, true); assert.equal(traps, 0); assert.equal(f.counts.fence, 0);
});
function failed(result, id) {
  assert.equal(result.verdict, 'failed');
  assert.equal(result.productionAccepted, false);
  assert.equal(result.requirementVerdict, 'incomplete');
  const first = result.probes.findIndex(probe => probe.outcome === 'failed');
  assert.ok(first >= 0);
  if (id) assert.equal(result.probes[first].probeId, id);
  assert.ok(result.probes.slice(first + 1).every(probe => probe.outcome === 'not-run'));
}

test('the fixed journal suite observes actual operations but never certifies production', async () => {
  const f = fixture(); const result = await run(f);
  assert.equal(result.verdict, 'passed');
  assert.equal(result.productionAccepted, false);
  assert.equal(result.validationLevel, 'isolated-behavioral-observations');
  assert.equal(result.classification, 'confidential');
  assert.equal(result.requirementVerdict, 'incomplete');
  assert.equal(result.pendingCompletionUnknown, false);
  assert.deepEqual(result.probes.map(p => p.probeId), suite.JOURNAL_CONFORMANCE_PROBES);
  assert.equal(result.probes.length, 18);
  assert.ok(result.probes.every(p => p.outcome === 'passed' && p.failureCode === null));
  const { observations, observationsHash, ...core } = result;
  assert.equal(observationsHash, hash(observations));
  assert.deepEqual(core, observations);
  assert.equal(result.requirementsHash, trust.PROVIDER_CONFORMANCE_REQUIREMENTS_HASH);
  assert.deepEqual(result.unimplementedRequirements['run-journal'], trust.PROVIDER_CONFORMANCE_REQUIREMENTS['run-journal']);
  assert.equal(Object.isFrozen(result.observations.probes), true);
  assert.equal((await f.local.readHead()).terminal, true);
  assert.ok(f.counts.append > 40 && f.counts.fence >= 4);
  assert.match(result.challengeNonce, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(result).includes('lab-authorization'), false);
});
test('enterprise-profile laboratory wrappers use the same oracle without claiming enterprise identity', async () => {
  const result = await run(fixture('enterprise'), { executionProfile: 'enterprise' });
  assert.equal(result.verdict, 'passed'); assert.equal(result.productionAccepted, false);
});
test('invalid contracts fail before any adapter call', async () => {
  for (const changes of [{ isolation: 'production' }, { executionProfile: 'production' }, { unexpected: true },
    { initialFencingGeneration: 0 }, { initialFencingGeneration: Number.MAX_SAFE_INTEGER }, { operationTimeoutMs: 0 },
    { actorId: '../secret' }, { authorizationDigest: 'bad' }, { observedAt: '2026-02-31T08:00:00.000Z' },
    { binding: { ...binding, scopeHash: hash('wrong') } }]) {
    const f = fixture(); await assert.rejects(() => run(f, changes), /journal conformance/);
    assert.deepEqual(f.counts, { readHead: 0, readEntries: 0, append: 0, fence: 0 });
  }
});
test('configuration and adapter accessors or Proxies never execute caller traps', async () => {
  let traps = 0; const trap = () => { traps++; throw new Error('secret-trap'); };
  for (const input of [new Proxy(options(), { get: trap, ownKeys: trap }),
    Object.defineProperty(options(), 'observedAt', { enumerable: true, get: trap })]) {
    await assert.rejects(() => suite.runIsolatedJournalConformance(input, fixture().ports), /journal conformance/);
  }
  for (const bad of [new Proxy(fixture().store, { get: trap, ownKeys: trap }),
    Object.defineProperty(fixture().store, 'readHead', { get: trap })]) {
    await assert.rejects(() => suite.runIsolatedJournalConformance(options(), { journal: bad, fenceControl: fixture().fenceControl }), /journal conformance/);
  }
  assert.equal(traps, 0);
});
test('method Proxy and metadata getters are not called', async () => {
  let traps = 0; const f = fixture();
  f.store.readHead = new Proxy(async () => {}, { apply() { traps++; }, get() { traps++; } });
  await assert.rejects(() => run(f), /journal conformance/); assert.equal(traps, 0);
  const g = fixture(); const original = g.store.readHead;
  for (const field of ['bind', 'name', 'length']) Object.defineProperty(original, field, { get() { traps++; throw new Error('secret-method'); } });
  assert.equal((await run(g)).verdict, 'passed'); assert.equal(traps, 0);
});
test('profile mismatches reject before operations', async () => {
  const f = fixture(); f.store.productionCapable = true;
  await assert.rejects(() => run(f), /journal conformance/); assert.equal(f.counts.readHead, 0);
});
test('a non-empty or substituted journal is not accepted as a fresh test resource', async () => {
  const f = fixture(); const original = f.store.readHead;
  f.store.readHead = async () => ({ ...await original(), binding: { ...binding, runNonce: 'f'.repeat(32) } });
  failed(await run(f), 'journal-genesis'); assert.equal(f.counts.append, 0);
});
test('a declared append without actual readback is detected', async () => {
  const f = fixture(); f.store.compareAndAppend = async request => ({ status: 'appended',
    head: { ...request.expectedHead, entryCount: 1, rootDigest: request.entry.digest } });
  failed(await run(f), 'journal-append-readback');
});
for (const method of ['readHead', 'readEntries']) test(`undefined ${method} readback remains invalid-data`, async () => {
  const f = fixture(); f.store[method] = async () => undefined;
  const result = await run(f); failed(result, 'journal-genesis');
  assert.equal(result.probes[0].failureCode, 'invalid-data');
  assert.equal(result.pendingCompletionUnknown, false);
  assert.equal(f.counts.append, 0);
});
test('an append result cannot substitute the authoritative head', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => { const value = await original(request); return { ...value, head: { ...value.head, rootDigest: hash('other') } }; };
  failed(await run(f), 'journal-append-readback');
});
test('exact retry must report already-applied and preserve the full chain', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => { const value = await original(request); return value.status === 'already-applied' ? { ...value, status: 'appended' } : value; };
  failed(await run(f), 'journal-exact-retry');
});
test('both racing contenders cannot report appended', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => { const value = await original(request); return value.status === 'conflict' ? { ...value, status: 'appended' } : value; };
  failed(await run(f), 'journal-concurrent-cas');
});
test('head CAS may not silently refresh a stale or altered expected head', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    if (request.expectedHead.entryCount >= 2) return original({ ...request, expectedHead: await f.local.readHead() });
    return original(request);
  };
  failed(await run(f), 'journal-head-cas-fields');
});
test('entry digests must not be repaired on behalf of a caller', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    const body = Object.fromEntries(Object.entries(request.entry).filter(([key]) => key !== 'digest'));
    return original({ ...request, entry: journal.createJournalEntry(body) });
  };
  failed(await run(f), 'journal-entry-integrity');
});
test('cross-run and cross-scope entries cannot be normalized into the current binding', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    const { digest, ...body } = request.entry;
    if (digest !== hash(body) || hash(body.binding) === hash(binding)) return original(request);
    return original({ ...request, entry: journal.createJournalEntry({ ...body, binding }) });
  };
  failed(await run(f), 'journal-binding-fields');
});
test('negative append that mutates then throws is caught by independent full readback', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    if (request.entry.digest !== hash(Object.fromEntries(Object.entries(request.entry).filter(([k]) => k !== 'digest')))) {
      const body = Object.fromEntries(Object.entries(request.entry).filter(([key]) => key !== 'digest'));
      await original({ ...request, entry: journal.createJournalEntry(body) });
      throw new Error('secret-provider-error');
    }
    return original(request);
  };
  failed(await run(f), 'journal-entry-integrity');
});
test('old owner cannot even obtain an idempotent acknowledgement after fencing advances', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    if (request.fencingGeneration < (await f.local.readHead()).fencingGeneration)
      return { status: 'already-applied', head: await f.local.readHead() };
    return original(request);
  };
  failed(await run(f), 'journal-stale-and-future-token');
});
test('fence control returning a fabricated head without advancing fails actual readback', async () => {
  const f = fixture(); f.fenceControl.advanceFence = async generation => ({ ...await f.local.readHead(), fencingGeneration: generation });
  failed(await run(f), 'journal-fence-advance');
});
test('same or regressing fence must reject rather than acknowledge current state', async () => {
  const f = fixture(); const original = f.fenceControl.advanceFence;
  f.fenceControl.advanceFence = async generation => generation <= (await f.local.readHead()).fencingGeneration ? f.local.readHead() : original(generation);
  failed(await run(f), 'journal-fence-monotonicity');
});
test('timeout is unknown completion, never a successful rejection, and stops later mutations', async () => {
  const f = fixture(); let release;
  f.store.compareAndAppend = () => new Promise(resolve => { release = resolve; });
  const result = await run(f, { operationTimeoutMs: 5 });
  failed(result, 'journal-append-readback'); assert.equal(result.pendingCompletionUnknown, true); assert.equal(f.counts.fence, 0);
  release({ status: 'appended', head: await f.local.readHead() });
});
test('negative-operation timeout is not counted as rejection', async () => {
  const f = fixture(); const original = f.store.compareAndAppend; let release;
  f.store.compareAndAppend = request => request.expectedHead.entryCount > 1 && request.expectedHead.rootDigest === hash('journal-wrong-root')
    ? new Promise(resolve => { release = resolve; }) : original(request);
  const result = await run(f, { operationTimeoutMs: 10 });
  failed(result, 'journal-head-cas-fields'); assert.equal(result.pendingCompletionUnknown, true); assert.equal(f.counts.fence, 0);
  release({ status: 'conflict', head: await f.local.readHead() });
});
test('provider errors and getter readbacks remain redacted', async () => {
  const f = fixture(); f.store.readHead = async () => { throw new Error('secret-provider-exception'); };
  const result = await run(f); failed(result, 'journal-genesis'); assert.equal(JSON.stringify(result).includes('secret-provider-exception'), false);
  let calls = 0; const g = fixture(); const original = g.store.readHead;
  g.store.readHead = async () => Object.defineProperty(clone(await original()), 'rootDigest', { enumerable: true, get() { calls++; throw new Error('secret-getter'); } });
  const output = await run(g); failed(output, 'journal-genesis'); assert.equal(calls, 0); assert.equal(JSON.stringify(output).includes('secret-getter'), false);
});
test('method capture and frozen requests prevent rewriting the oracle during execution', async () => {
  const f = fixture(); const original = f.store.compareAndAppend; let frozen = 0;
  f.store.compareAndAppend = async request => {
    assert.equal(Object.isFrozen(request.entry.binding), true); frozen++;
    f.store.readHead = async () => { throw new Error('replaced-after-capture'); };
    return original(request);
  };
  assert.equal((await run(f)).verdict, 'passed'); assert.ok(frozen > 40);
});
test('a rejected fence operation must not poison the next legal generation', async () => {
  const f = fixture(); const original = f.fenceControl.advanceFence; let advanced = false;
  f.fenceControl.advanceFence = async generation => {
    if (advanced) throw new Error('poisoned-fence-control');
    const result = await original(generation); advanced = true; return result;
  };
  failed(await run(f), 'journal-fence-monotonicity');
});
for (const kind of ['result', 'terminal']) test(`a terminal journal rejects a new ${kind}, not only new intents`, async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => request.expectedHead.terminal && request.entry.kind === kind
    && request.entry.digest !== request.expectedHead.rootDigest
    ? { status: 'appended', head: request.expectedHead } : original(request);
  failed(await run(f), 'journal-terminal-immutability');
});
test('scope perturbations remain distinct when legitimate IDs equal the default adversarial label', async () => {
  const testScope = { environment: 'conformance-other', tenantId: 'conformance-other', corpusId: 'conformance-other' };
  const testBinding = { ...binding, ...testScope, scopeHash: hash(testScope) };
  assert.equal((await run(fixture('local-reference', testBinding), { binding: testBinding })).verdict, 'passed');
});
test('the entire suite reserves safe fence headroom at the maximum supported initial generation', async () => {
  const initialFencingGeneration = Number.MAX_SAFE_INTEGER - 5;
  const f = fixture('local-reference', binding, initialFencingGeneration);
  assert.equal((await run(f, { initialFencingGeneration })).verdict, 'passed');
  assert.equal((await f.local.readHead()).fencingGeneration, Number.MAX_SAFE_INTEGER - 1);
  await assert.rejects(() => run(fixture(), { initialFencingGeneration: Number.MAX_SAFE_INTEGER - 4 }), /journal conformance/);
});
test('one rejected concurrent append cannot hide another pending mutation', async () => {
  const f = fixture(); const original = f.store.compareAndAppend; let contender = 0; let complete;
  f.store.compareAndAppend = request => {
    if (request.expectedHead.entryCount === 1 && request.entry.seq === 2) {
      if (++contender === 1) throw new Error('first-contender-rejected');
      return new Promise(resolve => { complete = async () => resolve(await original(request)); });
    }
    return original(request);
  };
  try {
    const result = await run(f, { operationTimeoutMs: 20 }); failed(result, 'journal-concurrent-cas');
    assert.equal(result.pendingCompletionUnknown, true); assert.equal(f.counts.fence, 0);
  } finally { await complete?.(); }
});
test('one failed readback does not claim the other readback completed', async () => {
  const f = fixture(); let release;
  f.store.readHead = async () => { throw new Error('read-head-rejected'); };
  f.store.readEntries = () => new Promise(resolve => { release = resolve; });
  try {
    const result = await run(f, { operationTimeoutMs: 20 }); failed(result, 'journal-genesis');
    assert.equal(result.pendingCompletionUnknown, true); assert.equal(f.counts.append, 0);
  } finally { release?.([]); }
});
for (const field of ['environment', 'tenantId', 'corpusId', 'scopeHash', 'manifestHash']) {
  test(`CAS requires exact expected head binding ${field}`, async () => {
    const f = fixture(); const original = f.store.compareAndAppend;
    f.store.compareAndAppend = async request => request.expectedHead.binding[field] !== binding[field]
      && !(await f.local.readEntries()).some(entry => entry.digest === request.entry.digest)
      ? original({ ...request, expectedHead: { ...request.expectedHead, binding } }) : original(request);
    failed(await run(f), 'journal-head-cas-fields');
  });
}
test('the losing CAS contender must not consume its idempotency identity', async () => {
  const f = fixture(); const original = f.store.compareAndAppend; const consumed = new Set();
  f.store.compareAndAppend = async request => {
    if (consumed.has(request.entry.idempotencyKey)) throw new Error('conflict-consumed-id');
    const result = await original(request);
    if (request.expectedHead.entryCount === 1 && request.entry.seq === 2 && result.status === 'conflict') consumed.add(request.entry.idempotencyKey);
    return result;
  };
  failed(await run(f), 'journal-concurrent-cas');
});
test('premature terminal rejection must not consume the rejected idempotency identity', async () => {
  const f = fixture(); const original = f.store.compareAndAppend; const consumed = new Set();
  f.store.compareAndAppend = async request => {
    if (consumed.has(request.entry.idempotencyKey)) throw new Error('terminal-rejection-consumed-id');
    try { return await original(request); } catch (error) {
      if (request.entry.kind === 'terminal' && !request.expectedHead.terminal) consumed.add(request.entry.idempotencyKey);
      throw error;
    }
  };
  failed(await run(f), 'journal-pending-terminal');
});
for (const kind of ['intent', 'result']) test(`terminal exact retry preserves an already registered ${kind} at the current fence`, async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    const head = await f.local.readHead(); const entries = await f.local.readEntries();
    return head.terminal && request.fencingGeneration === head.fencingGeneration && request.entry.kind === kind
      && entries.some(entry => entry.digest === request.entry.digest)
      ? { status: 'terminal', head } : original(request);
  };
  failed(await run(f), 'journal-terminal-immutability');
});
test('a prematurely rejected terminal ID remains available for an eventual legal terminal', async () => {
  const f = fixture(); const original = f.store.compareAndAppend; const consumed = new Set();
  f.store.compareAndAppend = async request => {
    if (request.entry.kind === 'terminal' && consumed.has(request.entry.idempotencyKey)) throw new Error('terminal-kind-id-consumed');
    try { return await original(request); } catch (error) {
      if (request.entry.kind === 'terminal' && !request.expectedHead.terminal) consumed.add(request.entry.idempotencyKey);
      throw error;
    }
  };
  failed(await run(f), 'journal-terminal-seal');
});
test('a changed action cannot be acknowledged as an existing low-risk intent', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    const prior = (await f.local.readEntries()).find(entry => entry.kind === 'intent' && entry.idempotencyKey === request.entry.idempotencyKey);
    return prior && request.entry.kind === 'intent' && prior.action !== request.entry.action
      ? { status: 'already-applied', head: await f.local.readHead() } : original(request);
  };
  failed(await run(f), 'journal-idempotency-identity');
});
test('a changed timestamp is not an exact idempotent intent retry', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    const prior = (await f.local.readEntries()).find(entry => entry.kind === 'intent' && entry.idempotencyKey === request.entry.idempotencyKey);
    return prior && request.entry.kind === 'intent' && prior.trustedTime !== request.entry.trustedTime
      ? { status: 'already-applied', head: await f.local.readHead() } : original(request);
  };
  failed(await run(f), 'journal-idempotency-identity');
});
test('a completed result cannot falsely acknowledge a different result after/outcome', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    const prior = (await f.local.readEntries()).find(entry => entry.kind === 'result' && entry.idempotencyKey === request.entry.idempotencyKey);
    return prior && request.entry.kind === 'result' && (prior.afterDigest !== request.entry.afterDigest || prior.outcome !== request.entry.outcome)
      ? { status: 'already-applied', head: await f.local.readHead() } : original(request);
  };
  failed(await run(f), 'journal-result-correlation');
});
for (const kind of ['intent', 'terminal']) test(`resolved operation IDs cannot be recycled into a new ${kind}`, async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    const entries = await f.local.readEntries();
    const prior = entries.find(entry => entry.kind === 'result' && entry.idempotencyKey === request.entry.idempotencyKey);
    const pending = entries.filter(entry => entry.kind === 'intent' && !entries.some(result => result.kind === 'result' && result.idempotencyKey === entry.idempotencyKey));
    return !request.expectedHead.terminal && !pending.length && prior && request.entry.kind === kind
      ? { status: 'appended', head: request.expectedHead } : original(request);
  };
  failed(await run(f), 'journal-complete-results');
});
test('an existing digest does not bypass foreign expected-head binding validation', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    const head = await f.local.readHead();
    return request.fencingGeneration === head.fencingGeneration && (await f.local.readEntries()).some(entry => entry.digest === request.entry.digest)
      ? { status: 'already-applied', head } : original(request);
  };
  failed(await run(f), 'journal-exact-retry');
});
test('an existing intent key cannot bypass entry scope and run binding', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  f.store.compareAndAppend = async request => {
    const entries = await f.local.readEntries();
    return entries.some(entry => entry.idempotencyKey === request.entry.idempotencyKey) && request.entry.binding.runNonce !== binding.runNonce
      ? { status: 'already-applied', head: await f.local.readHead() } : original(request);
  };
  failed(await run(f), 'journal-idempotency-identity');
});
test('a logically identical result at a new sequence is not an exact digest retry', async () => {
  const f = fixture(); const original = f.store.compareAndAppend;
  const logical = entry => hash(Object.fromEntries(Object.entries(entry).filter(([key]) => !['seq', 'prevDigest', 'digest'].includes(key))));
  f.store.compareAndAppend = async request => {
    const prior = (await f.local.readEntries()).find(entry => entry.kind === 'result' && entry.idempotencyKey === request.entry.idempotencyKey);
    return !request.expectedHead.terminal && prior && request.entry.kind === 'result' && logical(prior) === logical(request.entry) && prior.digest !== request.entry.digest
      ? { status: 'already-applied', head: await f.local.readHead() } : original(request);
  };
  failed(await run(f), 'journal-result-correlation');
});
test('descriptor maps cannot inherit methods from an own __proto__ value', async () => {
  const f = fixture(); let calls = 0; delete f.store.readHead;
  const inherited = Object.defineProperty({}, 'readHead', { get() { calls++; throw new Error('descriptor-prototype-secret'); } });
  Object.defineProperty(f.store, '__proto__', { enumerable: true, value: inherited });
  await assert.rejects(() => run(f), error => { assert.equal(error.message.includes('descriptor-prototype-secret'), false); return true; });
  assert.equal(calls, 0); assert.equal(f.counts.append, 0);
});
