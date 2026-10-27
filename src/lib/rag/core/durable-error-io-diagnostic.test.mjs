import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { safeDurableErrorDiagnostic } from './durable-error-diagnostic.ts';

const diagnoseIo = input => safeDurableErrorDiagnostic(input, true);

test('opt-in IO diagnostic adds only a frozen closed operation to the legacy record', () => {
  const error = { code: 'EPERM', syscall: 'rename', path: 'SYNTHETIC_PRIVATE_PATH' };
  const legacy = safeDurableErrorDiagnostic(error);
  const diagnostic = diagnoseIo(error);
  assert.deepEqual(diagnostic, { ...legacy, systemCall: 'rename' });
  assert.deepEqual(Object.keys(legacy).sort(), ['causeDepth', 'chainTermination', 'codeChain']);
  assert.ok(Object.isFrozen(diagnostic));
  assert.ok(Object.isFrozen(diagnostic.codeChain));
  assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC_PRIVATE_PATH|path/);
});

test('native filesystem errors retain the operation without their private paths or message', async (t) => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rag-io-diagnostic-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('rag-io-diagnostic-'));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    assert.equal(path.relative(root, await fs.realpath(root)), '');
    // The failed read creates nothing; non-recursive removal cannot erase unrelated content.
    await fs.rmdir(root);
  });
  let failure;
  try { await fs.readFile(path.join(root, 'SYNTHETIC_PRIVATE_FILE')); }
  catch (error) { failure = error; }
  assert.equal(failure.code, 'ENOENT');
  const diagnostic = diagnoseIo(failure);
  assert.equal(diagnostic.systemCall, 'open');
  assert.deepEqual(diagnostic.codeChain, ['ENOENT']);
  assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC_PRIVATE_FILE|rag-io-diagnostic|message|path/);
});

test('unknown operation values and non-filesystem codes never become metadata or execute hooks', () => {
  let hooks = 0;
  const coercible = { toString() { hooks++; return 'rename'; }, [Symbol.toPrimitive]() { hooks++; return 'rename'; } };
  const proxy = new Proxy({}, { get() { hooks++; throw new Error('SYNTHETIC_PRIVATE_DETAIL'); } });
  for (const syscall of ['rename SYNTHETIC_PRIVATE_DETAIL', 'RENAME', '', null, undefined, 1, true, Symbol('private'), coercible, proxy, ['rename']]) {
    assert.equal(diagnoseIo({ code: 'EPERM', syscall }).systemCall, null);
  }
  assert.equal(diagnoseIo({ code: 'DURABLE_ASK_RESULT_INTEGRITY', syscall: 'rename' }).systemCall, null);
  const getter = Object.defineProperty({ code: 'EPERM' }, 'syscall', { get() { hooks++; return 'rename'; } });
  assert.equal(diagnoseIo(getter).systemCall, null);
  const inherited = Object.create({ syscall: 'rename' }); inherited.code = 'EPERM';
  assert.equal(diagnoseIo(inherited).systemCall, null);
  assert.equal(hooks, 0);
});

test('the nearest eligible filesystem cause supplies the operation without changing the code chain', () => {
  const error = { code: 'DURABLE_WORKFLOW_STEP_FAILED', syscall: 'open', cause: {
    code: 'EPERM', syscall: 'link', cause: { code: 'EIO', syscall: 'write' },
  } };
  assert.deepEqual(diagnoseIo(error), { ...safeDurableErrorDiagnostic(error), systemCall: 'link' });
  assert.equal(diagnoseIo({ code: 'EPERM', syscall: 'SYNTHETIC_PRIVATE', cause: { code: 'EIO', syscall: 'fsync' } }).systemCall, 'fsync');
});

test('IO diagnostics preserve the eight-level, cycle, Proxy and accessor fences', () => {
  let hooks = 0;
  const nodes = Array.from({ length: 8 }, () => ({ code: 'DURABLE_WORKFLOW_STEP_FAILED' }));
  nodes.slice(0, -1).forEach((node, index) => { node.cause = nodes[index + 1]; });
  nodes[7].cause = Object.defineProperty({}, 'syscall', { get() { hooks++; return 'open'; } });
  assert.deepEqual(diagnoseIo(nodes[0]), { ...safeDurableErrorDiagnostic(nodes[0]), systemCall: null });
  const cycle = { code: 'EIO', syscall: 'write' }; cycle.cause = cycle;
  assert.deepEqual(diagnoseIo(cycle), { ...safeDurableErrorDiagnostic(cycle), systemCall: 'write' });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const input of [revoked.proxy, new Proxy(function () {}, { getOwnPropertyDescriptor() { hooks++; throw new Error('private'); } })]) {
    assert.deepEqual(diagnoseIo(input), { ...safeDurableErrorDiagnostic(input), systemCall: null });
  }
  const causeGetter = Object.defineProperty({ code: 'EPERM', syscall: 'rename' }, 'cause', { get() { hooks++; throw new Error('private'); } });
  assert.deepEqual(diagnoseIo(causeGetter), { ...safeDurableErrorDiagnostic(causeGetter), systemCall: 'rename' });
  assert.equal(hooks, 0);
});

test('only literal true opts in and no diagnostic input is mutated', () => {
  const input = Object.freeze({ code: 'EPERM', syscall: 'open' });
  assert.equal(diagnoseIo(input).systemCall, 'open');
  const before = Object.getOwnPropertyDescriptors(input);
  for (const option of [undefined, false, 'true', 1, {}, new Proxy({}, { get() { throw new Error('private'); } })]) {
    assert.deepEqual(safeDurableErrorDiagnostic(input, option), safeDurableErrorDiagnostic(input));
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
});
