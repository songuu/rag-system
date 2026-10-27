import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
const { DurableWorkflowStepError } = await import('./durable-workflow.ts');
const { DurableAskResultStoreError } = await import('./durable-result-artifact-store.ts');
let subject;
try { subject = await import('./durable-error-diagnostic.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const diagnose = input => subject.safeDurableErrorDiagnostic(input);
const expected = (codeChain, causeDepth, chainTermination) => ({ codeChain, causeDepth, chainTermination });

test('diagnostic exposes only the fixed frozen metadata API', () => {
  assert.equal(typeof subject.safeDurableErrorDiagnostic, 'function');
  assert.deepEqual(Object.keys(subject), ['safeDurableErrorDiagnostic']);
  const result = diagnose({ code: 'ASK_INTERNAL_ERROR' });
  assert.deepEqual(result, expected(['ASK_INTERNAL_ERROR'], 1, 'end'));
  assert.deepEqual(Object.keys(result).sort(), ['causeDepth', 'chainTermination', 'codeChain']);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.codeChain));
  assert.throws(() => { result.codeChain.push('secret-token'); }, TypeError);
});

test('exact existing durable, RequestValidation and filesystem codes are the private closed whitelist', () => {
  for (const code of ['DURABLE_CHECKPOINT_CONFLICT', 'DURABLE_WORKFLOW_NOT_FOUND', 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED',
    'DURABLE_WORKFLOW_LEASE_MANAGEMENT_REJECTED', 'DURABLE_WORKFLOW_BUSY', 'DURABLE_WORKFLOW_STEP_FAILED', 'DURABLE_WORKFLOW_CANCELLED',
    'DURABLE_WORKFLOW_TERMINAL_STEP_FAILURE', 'DURABLE_WORKFLOW_FAILED', 'WORKFLOW_VERSION_MISMATCH', 'SCOPE_MISMATCH',
    'DOCUMENT_ID_MISMATCH', 'DOCUMENT_VERSION_MISMATCH', 'IDEMPOTENCY_KEY_MISMATCH', 'JOB_FINGERPRINT_MISMATCH',
    'DURABLE_ASK_RESULT_CAPACITY', 'DURABLE_ASK_RESULT_CONFLICT', 'DURABLE_ASK_RESULT_INTEGRITY', 'DURABLE_CHECKPOINT_INTEGRITY',
    'DURABLE_CHECKPOINT_SCAN_LIMIT', 'DURABLE_WORKFLOW_CONFIGURATION_INVALID', 'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED',
    'DURABLE_ASK_RESULT_UNAVAILABLE', 'DURABLE_ASK_IDEMPOTENCY_KEY_INVALID', 'DURABLE_ASK_DISABLED', 'DURABLE_WORKFLOW_PAUSED',
    'ASK_INTERNAL_ERROR', 'DURABLE_ASK_INTERNAL_ERROR', 'AGENTIC_QUERY_FAILED', 'RAG_AGENT_PROVIDER_FAILED',
    'ENOENT', 'EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EIO']) {
    assert.deepEqual(diagnose({ code }), expected([code], 1, 'end'));
  }
});

test('real workflow and result-store Error causes retain exact static codes without inspecting native nonenumerable payloads', () => {
  const filesystem = Object.assign(new Error('secret-token C:/private/path https://private.example'), { code: 'ENOENT' });
  const store = new DurableAskResultStoreError('DURABLE_ASK_RESULT_INTEGRITY', 'secret-token store payload', filesystem);
  const workflow = new DurableWorkflowStepError('secret-step', store);
  assert.equal(Object.getOwnPropertyDescriptor(store, 'cause').enumerable, false);
  const result = diagnose(workflow);
  assert.deepEqual(result, expected(['DURABLE_WORKFLOW_STEP_FAILED', 'DURABLE_ASK_RESULT_INTEGRITY', 'ENOENT'], 3, 'end'));
  assert.doesNotMatch(JSON.stringify(result), /secret-token|secret-step|private|https|store payload/);
});

test('unknown code values are UNCLASSIFIED per level without prefix matches, patterns or coercion', () => {
  let coercions = 0;
  const coercible = { toString() { coercions++; return 'ENOENT'; }, [Symbol.toPrimitive]() { coercions++; return 'ENOENT'; } };
  for (const code of ['secret-token', 'ENOENT secret-token', 'DURABLE_ASK_RESULT_INTEGRITY_SECRET', 'AGENTIC_QUERY_FAILED:secret',
    'enoent', '', null, undefined, 123, true, Symbol('secret-token'), coercible, () => 'ENOENT', ['ENOENT']]) {
    assert.deepEqual(diagnose({ code, cause: { code: 'EIO' } }), expected(['UNCLASSIFIED', 'EIO'], 2, 'end'));
  }
  assert.equal(coercions, 0);
});

test('primitive sensitive inputs are one safe unclassified result and are never coerced', () => {
  for (const input of ['secret-token https://private.example', undefined, null, 123, true, Symbol('secret-token'), BigInt(8)]) {
    const result = diagnose(input); assert.deepEqual(result, expected(['UNCLASSIFIED'], 0, 'non-object'));
    assert.doesNotMatch(JSON.stringify(result), /secret-token|private/);
  }
});

test('code and cause accessors terminate explicitly with zero hooks', () => {
  let hooks = 0;
  const codeGetter = Object.defineProperty({ cause: { code: 'ENOENT' } }, 'code', { get() { hooks++; throw new Error('secret-token'); } });
  assert.deepEqual(diagnose(codeGetter), expected(['UNCLASSIFIED'], 1, 'accessor'));
  const causeGetter = Object.defineProperty({ code: 'DURABLE_ASK_RESULT_CAPACITY' }, 'cause', { get() { hooks++; throw new Error('secret-token'); } });
  assert.deepEqual(diagnose(causeGetter), expected(['DURABLE_ASK_RESULT_CAPACITY'], 1, 'accessor'));
  const both = Object.defineProperties({}, { code: { get() { hooks++; return 'ENOENT'; } }, cause: { get() { hooks++; return both; } } });
  assert.deepEqual(diagnose(both), expected(['UNCLASSIFIED'], 1, 'accessor')); assert.equal(hooks, 0);
});

test('name, message, stack, URL, prototype getters and inherited cause/code are never read', () => {
  let hooks = 0;
  const prototype = Object.defineProperties({}, { code: { get() { hooks++; return 'ENOENT'; } }, cause: { get() { hooks++; return { code: 'EIO' }; } } });
  const input = Object.create(prototype);
  for (const name of ['name', 'message', 'stack', 'url']) Object.defineProperty(input, name, { get() { hooks++; throw new Error('secret-token'); } });
  assert.deepEqual(diagnose(input), expected(['UNCLASSIFIED'], 1, 'end')); assert.equal(hooks, 0);
  Object.defineProperty(input, 'code', { value: 'EPERM' });
  assert.deepEqual(diagnose(input), expected(['EPERM'], 1, 'end')); assert.equal(hooks, 0);
});

test('object, function and revoked Proxy inputs terminate before every reflective hook', () => {
  let hooks = 0; const traps = { get() { hooks++; throw new Error('secret-token'); }, ownKeys() { hooks++; throw new Error('secret-token'); },
    getOwnPropertyDescriptor() { hooks++; throw new Error('secret-token'); }, getPrototypeOf() { hooks++; throw new Error('secret-token'); } };
  const revoked = Proxy.revocable({}, traps); revoked.revoke();
  for (const input of [new Proxy({}, traps), new Proxy(function () {}, traps), revoked.proxy]) {
    assert.deepEqual(diagnose(input), expected(['UNCLASSIFIED'], 0, 'proxy'));
    assert.deepEqual(diagnose({ code: 'EIO', cause: input }), expected(['EIO', 'UNCLASSIFIED'], 1, 'proxy'));
  }
  assert.equal(hooks, 0);
});

test('repeated codes are retained, but repeated object identity terminates a cycle', () => {
  const third = { code: 'EIO' }; const second = { code: 'EIO', cause: third }; const first = { code: 'EIO', cause: second };
  assert.deepEqual(diagnose(first), expected(['EIO', 'EIO', 'EIO'], 3, 'end'));
  third.cause = first; assert.deepEqual(diagnose(first), expected(['EIO', 'EIO', 'EIO'], 3, 'cycle'));
  const self = { code: 'ENOENT' }; self.cause = self;
  assert.deepEqual(diagnose(self), expected(['ENOENT'], 1, 'cycle'));
});

test('exactly eight observed object levels can end; deeper chains are refused without visiting the ninth level', () => {
  const nodes = Array.from({ length: 8 }, () => ({ code: 'DURABLE_WORKFLOW_STEP_FAILED' }));
  nodes.slice(0, -1).forEach((node, index) => { node.cause = nodes[index + 1]; });
  assert.deepEqual(diagnose(nodes[0]), expected(Array(8).fill('DURABLE_WORKFLOW_STEP_FAILED'), 8, 'end'));
  let hooks = 0; nodes[7].cause = Object.defineProperty({}, 'code', { get() { hooks++; throw new Error('secret-token'); } });
  assert.deepEqual(diagnose(nodes[0]), expected(Array(8).fill('DURABLE_WORKFLOW_STEP_FAILED'), 8, 'depth-limit')); assert.equal(hooks, 0);
});

test('null or undefined data cause ends, while a non-object cause remains explicitly unclassified', () => {
  for (const cause of [null, undefined]) assert.deepEqual(diagnose({ code: 'EACCES', cause }), expected(['EACCES'], 1, 'end'));
  assert.deepEqual(diagnose({ code: 'EACCES', cause: 'secret-token' }), expected(['EACCES', 'UNCLASSIFIED'], 1, 'non-object'));
  assert.deepEqual(diagnose(Object.assign(function () {}, { code: 'EBUSY' })), expected(['EBUSY'], 1, 'end'));
});

test('nonenumerable own data descriptors work and original objects stay untouched', () => {
  const leaf = Object.freeze(Object.create(null, { code: { value: 'ENOSPC' } }));
  const input = Object.freeze(Object.create(null, { code: { value: 'DURABLE_ASK_RESULT_CAPACITY' }, cause: { value: leaf } }));
  const before = Object.getOwnPropertyDescriptors(input);
  assert.deepEqual(diagnose(input), expected(['DURABLE_ASK_RESULT_CAPACITY', 'ENOSPC'], 2, 'end'));
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
});
