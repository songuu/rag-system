import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canonicalJsonSha256 } from './canonical-json.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
        && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const journal = await import('./production-run-journal.ts');
const hash = canonicalJsonSha256;
const scope = { environment: 'production-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
const binding = { ...scope, scopeHash: hash(scope),
  runNonce: '0123456789abcdef0123456789abcdef', manifestHash: hash('stage-manifest') };
const clone = value => structuredClone(value);

function body(overrides = {}) {
  return { schemaVersion: 'kg-gate-run-journal/v1', kind: 'intent', binding: clone(binding),
    seq: 1, prevDigest: journal.GENESIS_DIGEST, fencingGeneration: 1,
    idempotencyKey: 'action-1', actorId: 'executor', authorizationDigest: hash('execution-envelope'),
    action: 'readback', parametersDigest: hash('parameters'), beforeDigest: hash('before-state'),
    afterDigest: null, intentDigest: null, outcome: null, trustedTime: '2026-10-09T03:00:00.000Z',
    ...overrides };
}

function chain() {
  const intent = journal.createJournalEntry(body());
  const result = journal.createJournalEntry(body({ kind: 'result', seq: 2, prevDigest: intent.digest,
    intentDigest: intent.digest, afterDigest: hash('after-state'), outcome: 'completed',
    trustedTime: '2026-10-09T03:00:01.000Z' }));
  const terminal = journal.createJournalEntry(body({ kind: 'terminal', seq: 3, prevDigest: result.digest,
    idempotencyKey: 'terminal-1', action: 'seal-run', beforeDigest: result.digest,
    afterDigest: hash('final-readback'), outcome: 'passed', trustedTime: '2026-10-09T03:00:02.000Z' }));
  return [intent, result, terminal];
}

function head(entries, generation = 1) {
  return { schemaVersion: 'kg-gate-run-journal/v1', kind: 'head', binding: clone(binding),
    entryCount: entries.length, rootDigest: entries.at(-1)?.digest ?? journal.GENESIS_DIGEST,
    fencingGeneration: generation, terminal: entries.at(-1)?.kind === 'terminal' };
}

function store() {
  return journal.createReferenceJournalStore({ binding, initialFencingGeneration: 1,
    executionProfile: 'local-reference' });
}

test('journal entries are versioned canonical immutable objects without raw payloads', () => {
  assert.equal(journal.JOURNAL_SCHEMA_VERSION, 'kg-gate-run-journal/v1');
  assert.equal(journal.GENESIS_DIGEST, '0'.repeat(64));
  const input = body(); const entry = journal.createJournalEntry(input);
  assert.equal(entry.digest, hash(input));
  assert.equal(Object.isFrozen(entry.binding), true);
  input.binding.corpusId = 'changed';
  assert.equal(entry.binding.corpusId, 'corpus-a');
  assert.throws(() => journal.createJournalEntry(body({ parameters: { query: 'raw-question' } })), /journal/);
  assert.throws(() => journal.createJournalEntry(body({ action: 'run-shell' })), /journal/);
});

test('complete intent/result/terminal chains require the exact authoritative head', () => {
  const entries = chain();
  const validated = journal.validateJournalChain(entries, binding, head(entries));
  assert.equal(validated.terminal, true);
  assert.equal(validated.entryCount, 3);
  assert.equal(validated.rootDigest, entries[2].digest);
  assert.equal(validated.validationLevel, 'structural-only');
  assert.equal(validated.productionAccepted, false);
  assert.equal(Object.isFrozen(validated), true);
});

test('a terminal head freezes its exact final fencing generation, while an open head may advance', () => {
  const entries = chain();
  assert.throws(() => journal.validateJournalChain(entries, binding, head(entries, 2)), /journal.*fenc|journal.*head/i);
  const open = entries.slice(0, 2);
  assert.equal(journal.validateJournalChain(open, binding, head(open, 2)).terminal, false);
});

test('chain array proxies, getters, holes and extra properties fail without caller code execution', () => {
  const entries = chain(); let calls = 0; const secret = 'secret-array-trap';
  const trap = () => { calls += 1; throw new Error(secret); };
  const proxy = new Proxy(entries, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  const accessor = Object.defineProperty([], '0', { enumerable: true, get: trap });
  const sparse = Array(1); const extra = Object.assign(clone(entries), { extra: true });
  for (const input of [proxy, accessor, sparse, extra]) {
    assert.throws(() => journal.validateJournalChain(input, binding, head(entries)), error => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /journal|canonical JSON/);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('bounded chains can exceed one canonical object limit without weakening entry validation', () => {
  const entries = []; let previous = journal.GENESIS_DIGEST;
  for (let seq = 1; seq <= 350; seq += 1) {
    const entry = journal.createJournalEntry(body({ seq, prevDigest: previous, idempotencyKey: `action-${seq}` }));
    entries.push(entry); previous = entry.digest;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(entries)) > 256 * 1024);
  const validated = journal.validateJournalChain(entries, binding, head(entries));
  assert.equal(validated.entryCount, 350);
  assert.equal(validated.terminal, false);
});

test('modification, tail truncation, reorder, duplicate, fork and foreign bindings fail closed', () => {
  const original = chain(); const expectedHead = head(original);
  const variants = [
    () => { const values = clone(original); values[0].parametersDigest = hash('modified'); return values; },
    () => original.slice(0, 2),
    () => [original[1], original[0], original[2]],
    () => [original[0], original[0], original[2]],
    () => { const values = clone(original); values[1].prevDigest = hash('fork'); return values; },
    () => { const values = clone(original); values[1].binding.tenantId = 'other'; return values; },
  ];
  for (const variant of variants) {
    assert.throws(() => journal.validateJournalChain(variant(), binding, expectedHead), /journal/);
  }
  const substituted = { ...expectedHead, rootDigest: hash('other-root') };
  assert.throws(() => journal.validateJournalChain(original, binding, substituted), /journal/);
});

test('recomputed entry hashes cannot bypass sequence, intent/result or monotonic fence rules', () => {
  const intent = journal.createJournalEntry(body());
  for (const change of [
    { seq: 3 }, { intentDigest: hash('unrecorded-intent') }, { idempotencyKey: 'other-action' },
    { action: 'activate' }, { parametersDigest: hash('other-parameters') },
    { beforeDigest: hash('other-before') }, { fencingGeneration: 0 },
    { trustedTime: '2026-10-09T02:59:59.000Z' },
  ]) {
    const attempt = () => {
      const result = journal.createJournalEntry(body({ kind: 'result', seq: 2,
        prevDigest: intent.digest, intentDigest: intent.digest, afterDigest: hash('after'),
        outcome: 'completed', trustedTime: '2026-10-09T03:00:01.000Z', ...change }));
      journal.validateJournalChain([intent, result], binding, head([intent, result]));
    };
    assert.throws(attempt, /journal/);
  }
  const next = journal.createJournalEntry(body({ seq: 2, prevDigest: intent.digest,
    fencingGeneration: 2, idempotencyKey: 'action-2' }));
  const stale = journal.createJournalEntry(body({ seq: 3, prevDigest: next.digest,
    fencingGeneration: 1, idempotencyKey: 'action-3' }));
  assert.throws(() => journal.validateJournalChain([intent, next, stale], binding,
    head([intent, next, stale], 2)), /journal/);
});

test('pending intents and records after terminal cannot be sealed as success', () => {
  const intent = journal.createJournalEntry(body());
  const terminal = journal.createJournalEntry(body({ kind: 'terminal', seq: 2, prevDigest: intent.digest,
    idempotencyKey: 'terminal', action: 'seal-run', beforeDigest: intent.digest,
    afterDigest: hash('final'), outcome: 'passed' }));
  assert.throws(() => journal.validateJournalChain([intent, terminal], binding, head([intent, terminal])), /journal/);
  const entries = chain(); const after = journal.createJournalEntry(body({ seq: 4,
    prevDigest: entries[2].digest, idempotencyKey: 'after-terminal' }));
  assert.throws(() => journal.validateJournalChain([...entries, after], binding, head([...entries, after])), /journal/);
});

test('reference compare-and-append serializes races and exact retries without production capability', async () => {
  const local = store(); const prior = await local.readHead();
  assert.equal(local.executionProfile, 'local-reference');
  assert.equal(local.productionCapable, false);
  const entry = journal.createJournalEntry(body());
  const other = journal.createJournalEntry(body({ idempotencyKey: 'other-1' }));
  const results = await Promise.all([
    local.compareAndAppend({ expectedHead: prior, entry, fencingGeneration: 1 }),
    local.compareAndAppend({ expectedHead: prior, entry: other, fencingGeneration: 1 }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['appended', 'conflict']);
  assert.equal((await local.readHead()).entryCount, 1);
  assert.equal((await local.compareAndAppend({ expectedHead: prior, entry, fencingGeneration: 1 })).status, 'already-applied');
  assert.equal((await local.readHead()).entryCount, 1);
  assert.throws(() => journal.createReferenceJournalStore({ binding, initialFencingGeneration: 1,
    executionProfile: 'production' }), /reference|production|profile/i);
});

test('new generations fence every append and stale tokens cannot even replay an old acknowledgement', async () => {
  const local = store(); const prior = await local.readHead(); const entry = journal.createJournalEntry(body());
  await local.compareAndAppend({ expectedHead: prior, entry, fencingGeneration: 1 });
  const renewed = await local.advanceFence(2);
  assert.equal(renewed.fencingGeneration, 2);
  assert.equal((await local.compareAndAppend({ expectedHead: prior, entry, fencingGeneration: 1 })).status, 'stale-fence');
  assert.equal((await local.readHead()).entryCount, 1);
  await assert.rejects(() => local.advanceFence(1), /fenc|generation/i);
  const result = journal.createJournalEntry(body({ kind: 'result', seq: 2, prevDigest: entry.digest,
    fencingGeneration: 2, actorId: 'rescue-operator', authorizationDigest: hash('recovery-envelope'),
    intentDigest: entry.digest, afterDigest: hash('recovery-readback'), outcome: 'completed' }));
  assert.equal((await local.compareAndAppend({ expectedHead: renewed, entry: result, fencingGeneration: 2 })).status, 'appended');
});

test('store readbacks are detached and frozen and rejected appends leave the head unchanged', async () => {
  const local = store(); const prior = await local.readHead();
  const entry = journal.createJournalEntry(body());
  const bad = clone(entry); bad.digest = hash('tampered');
  await assert.rejects(() => local.compareAndAppend({ expectedHead: prior, entry: bad, fencingGeneration: 1 }), /journal/);
  assert.deepEqual(await local.readHead(), prior);
  await local.compareAndAppend({ expectedHead: prior, entry, fencingGeneration: 1 });
  const readback = await local.readEntries();
  assert.equal(Object.isFrozen(readback), true);
  assert.equal(Object.isFrozen(readback[0].binding), true);
  assert.throws(() => { readback[0].binding.corpusId = 'other'; }, TypeError);
});

test('reference journal and conformance reuse admitted immutable readbacks without re-encoding', () => {
  // Count work, not elapsed time: host load must not decide this regression.
  // The isolated loader only adds a counter to the real canonical encoder.
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    let encodes = 0; let emptyArrayEncodes = 0;
    globalThis.__journalReadbackEncode = value => {
      encodes++;
      if (Array.isArray(value) && value.length === 0) emptyArrayEncodes++;
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try { return nextResolve(specifier, context); } catch (error) {
          if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))
            && !/\\.[cm]?[jt]s$/.test(specifier)) return nextResolve(specifier + '.ts', context);
          throw error;
        }
      },
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (!url.endsWith('/canonical-json.ts')) return loaded;
        const source = Buffer.isBuffer(loaded.source) ? loaded.source.toString('utf8') : String(loaded.source);
        const marker = 'export function canonicalJson(value: unknown): string {';
        assert.equal(source.split(marker).length, 2);
        return { ...loaded, source: source.replace(marker, marker + '\\n globalThis.__journalReadbackEncode(value);') };
      }
    });
    const journal = await import(${JSON.stringify(new URL('./production-run-journal.ts', import.meta.url).href)});
    const binding = ${JSON.stringify(binding)};
    const local = journal.createReferenceJournalStore({ binding, initialFencingGeneration: 1, executionProfile: 'local-reference' });
    const prior = await local.readHead();
    const empty = await local.readEntries();
    const input = ${JSON.stringify(body())};
    const entry = journal.createJournalEntry(input);
    const request = { expectedHead: prior, entry: structuredClone(entry), fencingGeneration: 1 };
    await local.compareAndAppend(request);
    assert.ok(encodes > 0, 'untrusted admission must still use canonical validation');
    request.entry.binding.corpusId = 'caller-mutation';
    encodes = 0;
    const admittedHead = await local.readHead();
    const first = await local.readEntries();
    const second = await local.readEntries();
    assert.equal(encodes, 0, 'immutable reference readbacks must not re-encode admitted state');
    assert.notEqual(first, second, 'the journal array itself must not alias mutable private storage');
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first[0]), true);
    assert.equal(Object.isFrozen(first[0].binding), true);
    assert.equal(first[0].binding.corpusId, binding.corpusId);
    assert.throws(() => { first[0].binding.corpusId = 'readback-mutation'; }, TypeError);
    assert.throws(() => first.push(entry), TypeError);
    await local.advanceFence(2);
    assert.equal(admittedHead.fencingGeneration, 1, 'old heads remain immutable point-in-time snapshots');
    assert.equal((await local.readHead()).fencingGeneration, 2);
    assert.equal(prior.entryCount, 0);
    assert.deepEqual(empty, []);
    const corrupted = Object.freeze({ ...entry, digest: 'f'.repeat(64) });
    const current = await local.readHead();
    await assert.rejects(() => local.compareAndAppend({ expectedHead: current, entry: corrupted, fencingGeneration: 2 }), /journal/);
    assert.ok(encodes > 0, 'a frozen caller object is not trusted private state');
    assert.equal((await local.readEntries()).length, 1);
    const suite = await import(${JSON.stringify(new URL('./production-journal-conformance.ts', import.meta.url).href)});
    const isolated = journal.createReferenceJournalStore({ binding, initialFencingGeneration: 1, executionProfile: 'local-reference' });
    emptyArrayEncodes = 0;
    const observed = await suite.runIsolatedJournalConformance({
      schemaVersion: 'kg-isolated-journal-conformance/v1', isolation: 'disposable-test-scope',
      executionProfile: 'local-reference', binding, initialFencingGeneration: 1, actorId: 'lab-executor',
      authorizationDigest: ${JSON.stringify(hash('lab-authorization'))},
      observedAt: '2026-10-09T08:00:00.000Z', operationTimeoutMs: 1000,
    }, { journal: isolated, fenceControl: { advanceFence: generation => isolated.advanceFence(generation) } });
    assert.equal(observed.verdict, 'passed');
    assert.equal(observed.productionAccepted, false);
    // One inbound detach and two independent equality encodes are necessary.
    assert.equal(emptyArrayEncodes, 3, 'the oracle must not detach its own frozen invoke snapshot again');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('hostile objects and arbitrary extra fields never execute code or leak diagnostic values', () => {
  let called = false;
  const secret = 'secret-journal-label';
  const hostile = Object.defineProperty({}, 'kind', { enumerable: true,
    get() { called = true; throw new Error(secret); } });
  assert.throws(() => journal.createJournalEntry(hostile), /canonical JSON|journal/);
  assert.equal(called, false);
  assert.throws(() => journal.createJournalEntry(body({ [secret]: 'secret-value' })), error => {
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('secret-value'), false);
    return true;
  });
});
