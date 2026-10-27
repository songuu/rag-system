import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import * as subject from './bounded-provider-call.ts';
import { RAG_CLIENT_REQUEST_TIMEOUT_MS } from '../core/request-budgets.ts';
const { boundedProviderCall } = subject;

const deferred = () => { let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
test('fulfilled values are observed without becoming an authorization decision', async () => {
  const value = { productionAuthorized: false }; const result = await boundedProviderCall(() => Promise.resolve(value), 1000);
  assert.deepEqual(result, { status: 'fulfilled', value }); assert.equal(Object.isFrozen(result), true);
});
test('invalid budgets and callable Proxies fail without invoking user traps', async () => {
  let calls = 0; const operation = () => { calls++; return Promise.resolve(); };
  for (const budget of [0, -1, NaN, Infinity, 1.5, 60001, '20', null]) await assert.rejects(boundedProviderCall(operation, budget));
  await assert.rejects(boundedProviderCall(new Proxy(operation, { apply() { calls++; }, get() { calls++; } }), 20));
  assert.equal(calls, 0);
});
test('thenables and Proxy promises cannot execute assimilation getters', async () => {
  let traps = 0; const trap = () => { traps++; throw Error('secret-then'); };
  for (const value of [Object.defineProperty({}, 'then', { get: trap }), new Proxy(Promise.resolve(), { get: trap })]) {
    assert.deepEqual(await boundedProviderCall(() => value, 1000), { status: 'invalid-return', pendingCompletionUnknown: true });
  }
  assert.equal(traps, 0);
});
test('a native Promise own then getter is ignored by the captured intrinsic', async () => {
  let traps = 0; const promise = Promise.resolve('ok');
  Object.defineProperty(promise, 'then', { get() { traps++; throw Error('own-then-secret'); } });
  assert.deepEqual(await boundedProviderCall(() => promise, 1000), { status: 'fulfilled', value: 'ok' }); assert.equal(traps, 0);
});
test('the observation wrapper never adopts a then added to an already fulfilled payload', async () => {
  let traps = 0; const value = {};
  const carrier = new Promise(resolve => { resolve(value);
    Object.defineProperty(value, 'then', { get() { traps++; throw Error('payload-then-secret'); } });
  });
  const result = await boundedProviderCall(() => carrier, 1000);
  assert.equal(result.status, 'fulfilled'); assert.equal(result.value, value); assert.equal(traps, 0);
});
test('native Promise constructor accessors and subclasses cannot execute species hooks', async () => {
  let traps = 0; const promise = Promise.resolve();
  Object.defineProperty(promise, 'constructor', { get() { traps++; throw Error('constructor-secret'); } });
  class HostilePromise extends Promise { static get [Symbol.species]() { traps++; throw Error('species-secret'); } }
  for (const value of [promise, new HostilePromise(resolve => resolve())]) {
    assert.deepEqual(await boundedProviderCall(() => value, 1000), { status: 'invalid-return', pendingCompletionUnknown: true });
  }
  assert.equal(traps, 0);
});
for (const target of ['prototype-constructor', 'species']) test(`inherited Promise ${target} drift cannot execute a provider hook`, async () => {
  let traps = 0; const value = Promise.resolve('ok'); const owner = target === 'species' ? Promise : Promise.prototype;
  const key = target === 'species' ? Symbol.species : 'constructor'; const original = Object.getOwnPropertyDescriptor(owner, key);
  let result;
  try {
    result = await boundedProviderCall(() => {
      Object.defineProperty(owner, key, { configurable: true, get() { traps++; return Promise; } }); return value;
    }, 1000);
  } finally { Object.defineProperty(owner, key, original); }
  assert.deepEqual(result, { status: 'invalid-return', pendingCompletionUnknown: true }); assert.equal(traps, 0);
});
test('descriptor checks do not rely on mutable Array prototype methods', async () => {
  let traps = 0; const value = Promise.resolve('ok'); const originalEvery = Array.prototype.every;
  const originalConstructor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor'); let result;
  try {
    result = await boundedProviderCall(() => {
      Array.prototype.every = () => true;
      Object.defineProperty(Promise.prototype, 'constructor', { configurable: true, get() { traps++; return Promise; } });
      return value;
    }, 1000);
  } finally { Array.prototype.every = originalEvery; Object.defineProperty(Promise.prototype, 'constructor', originalConstructor); }
  assert.deepEqual(result, { status: 'invalid-return', pendingCompletionUnknown: true }); assert.equal(traps, 0);
});
test('synchronous throws remain redacted without reading the error', async () => {
  let traps = 0; const thrown = new Proxy({}, { get() { traps++; throw Error('raw-secret'); } });
  assert.deepEqual(await boundedProviderCall(() => { throw thrown; }, 1000), { status: 'rejected' }); assert.equal(traps, 0);
});
test('an invalid carrier cannot claim the provider has no concealed pending work', async () => {
  const barrier = deferred(); let committed = false; let late;
  const result = await boundedProviderCall(() => { late = barrier.promise.then(() => { committed = true; }); return undefined; }, 1000);
  assert.deepEqual(result, { status: 'invalid-return', pendingCompletionUnknown: true }); assert.equal(committed, false);
  barrier.resolve(); await late; assert.equal(committed, true); assert.equal(result.pendingCompletionUnknown, true);
});
test('dispatch already past its deadline does not invoke the provider', async t => {
  let calls = 0; let timeCalls = 0; t.mock.method(performance, 'now', () => timeCalls++ === 0 ? 0 : 20);
  const result = await boundedProviderCall(() => { calls++; return Promise.resolve(); }, 10);
  assert.deepEqual(result, { status: 'timeout', pendingCompletionUnknown: false }); assert.equal(calls, 0);
});
for (const rejects of [false, true]) test(`settled ${rejects ? 'rejection' : 'fulfillment'} at the exact deadline cannot beat its timer`, async t => {
  let observedTime = 0; t.mock.method(performance, 'now', () => observedTime);
  const result = await boundedProviderCall(() => { observedTime = 10;
    return rejects ? Promise.reject(Error('late-secret')) : Promise.resolve('late');
  }, 10);
  assert.deepEqual(result, { status: 'timeout', pendingCompletionUnknown: false });
});
test('a real synchronous block is timed out even when its native Promise settles before timers', async () => {
  const result = await boundedProviderCall(() => { const deadline = performance.now() + 40;
    while (performance.now() < deadline) { /* Demonstrate the non-preemptible provider boundary. */ }
    return Promise.resolve('late');
  }, 10);
  assert.deepEqual(result, { status: 'timeout', pendingCompletionUnknown: false });
});
for (const rejects of [false, true]) test(`pending timeout observes late ${rejects ? 'rejection' : 'commit'} without claiming cancellation`, async t => {
  // Separate timer/pending semantics from elapsed starvation; real elapsed is tested independently.
  t.mock.method(performance, 'now', () => 0); const barrier = deferred(); let entered = false; let committed = false;
  const late = barrier.promise.then(() => { committed = true; if (rejects) throw Error('late-secret'); return 'late'; });
  const result = await boundedProviderCall(() => { entered = true; return late; }, 20);
  assert.equal(entered, true); assert.equal(committed, false);
  assert.deepEqual(result, { status: 'timeout', pendingCompletionUnknown: true });
  barrier.resolve(); await tick(); assert.equal(committed, true); assert.equal(result.pendingCompletionUnknown, true);
});

test('opt-in rejection observation exists without changing the default redacted contract', () => {
  assert.equal(typeof subject.boundedProviderCallWithRejection, 'function');
});
for (const synchronous of [false, true]) test(`opt-in ${synchronous ? 'throw' : 'rejection'} retains only a raw reference without executing its hooks`, async () => {
  let hooks = 0; const hook = () => { hooks++; throw Error('secret-token'); };
  const reasons = [undefined, 'secret-token', Object.defineProperties({}, {
    then: { get: hook }, message: { get: hook }, code: { get: hook }, pendingCompletionUnknown: { get: hook },
  }), new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook })];
  for (const reason of reasons) {
    const operation = synchronous ? () => { throw reason; } : () => Promise.reject(reason);
    const result = await subject.boundedProviderCallWithRejection(operation, 1000);
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, reason); assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Object.keys(result), ['status', 'reason']);
    assert.deepEqual(await boundedProviderCall(operation, 1000), { status: 'rejected' });
  }
  assert.equal(hooks, 0);
});
test('opt-in fulfillment wrapper also avoids raw payload adoption', async () => {
  let hooks = 0; const value = {}; const carrier = new Promise(resolve => {
    resolve(value); Object.defineProperty(value, 'then', { get() { hooks++; throw Error('secret-token'); } });
  });
  const result = await subject.boundedProviderCallWithRejection(() => carrier, 1000);
  assert.equal(result.status, 'fulfilled'); assert.equal(result.value, value); assert.equal(hooks, 0);
});
test('opt-in settled rejection at the deadline retains a reference for conservative UNKNOWN merging', async t => {
  let observedTime = 0; t.mock.method(performance, 'now', () => observedTime);
  const result = await subject.boundedProviderCallWithRejection(() => { observedTime = 10; return Promise.reject('secret-token'); }, 10);
  assert.deepEqual(result, { status: 'timeout', pendingCompletionUnknown: false, reason: 'secret-token' });
  assert.deepEqual(await boundedProviderCall(() => Promise.reject('secret-token'), 10), { status: 'rejected' });
});
test('opt-in pending timeout drains late rejection without retaining a reason or claiming cancellation', async t => {
  t.mock.method(performance, 'now', () => 0); const barrier = deferred(); let entered = false;
  const result = await subject.boundedProviderCallWithRejection(() => { entered = true; return barrier.promise; }, 20);
  assert.equal(entered, true); assert.deepEqual(result, { status: 'timeout', pendingCompletionUnknown: true });
  barrier.reject('secret-token'); await tick(); assert.equal(Object.hasOwn(result, 'reason'), false);
});

test('the generic provider helper remains loadable in an isolated Node process without repository resolution hooks', () => {
  const program = 'import(' + JSON.stringify(new URL('./bounded-provider-call.ts', import.meta.url).href)
    + ').then(()=>console.log(JSON.stringify({loaded:true})),error=>{console.log(JSON.stringify({loaded:false,moduleMissing:error.code===\"ERR_MODULE_NOT_FOUND\"}));process.exitCode=1;});';
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env,
  });
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.moduleMissing, undefined);
  assert.equal(observed.loaded, true);
  assert.equal(child.status, 0);
});

test('explicit Ask observation accepts the original full request allowance without widening provider budgets', async () => {
  assert.equal(typeof subject.boundedAskRequestCall, 'function');
  assert.equal(RAG_CLIENT_REQUEST_TIMEOUT_MS, 285000);
  for (const budget of [60001, 90000, 240000, RAG_CLIENT_REQUEST_TIMEOUT_MS]) {
    const value = { budget, productionAuthorized: false };
    const observed = await subject.boundedAskRequestCall(() => Promise.resolve(value), budget);
    assert.equal(observed.status, 'fulfilled'); assert.equal(observed.value, value);
    assert.equal(Object.isFrozen(observed), true);
    await assert.rejects(boundedProviderCall(() => Promise.resolve(), budget));
    await assert.rejects(subject.boundedProviderCallWithRejection(() => Promise.resolve(), budget));
  }
});

test('Ask invalid budgets, extra inputs and callable proxies dispatch nothing and expose no carrier hooks', async () => {
  let calls = 0, hooks = 0;
  const operation = () => { calls++; return Promise.resolve(); };
  const trap = () => { hooks++; throw Error('PRIVATE_SENTINEL'); };
  const carrier = Object.defineProperty({}, 'valueOf', { get: trap });
  for (const budget of [0, -1, NaN, Infinity, 1.5, RAG_CLIENT_REQUEST_TIMEOUT_MS + 1, '60001', null, carrier]) {
    await assert.rejects(subject.boundedAskRequestCall(operation, budget));
  }
  await assert.rejects(subject.boundedAskRequestCall(operation, 1000, carrier));
  await assert.rejects(subject.boundedAskRequestCall(new Proxy(operation, { apply: trap, get: trap }), 1000));
  assert.equal(calls, 0); assert.equal(hooks, 0);
});

for (const reject of [false, true]) test(`Ask full-budget exact-deadline ${reject ? 'rejection' : 'fulfillment'} remains redacted timeout`, async t => {
  let observedTime = 0;
  t.mock.method(performance, 'now', () => observedTime);
  const observed = await subject.boundedAskRequestCall(() => {
    observedTime = RAG_CLIENT_REQUEST_TIMEOUT_MS;
    return reject ? Promise.reject(Error('PRIVATE_SENTINEL')) : Promise.resolve('private-body');
  }, RAG_CLIENT_REQUEST_TIMEOUT_MS);
  assert.deepEqual(observed, { status: 'timeout', pendingCompletionUnknown: false });
});

test('Ask dispatch past the whole deadline is fenced before any callback', async t => {
  let nowCalls = 0, calls = 0;
  t.mock.method(performance, 'now', () => nowCalls++ === 0 ? 0 : RAG_CLIENT_REQUEST_TIMEOUT_MS);
  const observed = await subject.boundedAskRequestCall(() => { calls++; return Promise.resolve(); }, RAG_CLIENT_REQUEST_TIMEOUT_MS);
  assert.deepEqual(observed, { status: 'timeout', pendingCompletionUnknown: false });
  assert.equal(calls, 0);
});

test('Ask observation uses the same intrinsic Promise firewall without adopting returned private payloads', async () => {
  let hooks = 0;
  const trap = () => { hooks++; throw Error('PRIVATE_SENTINEL'); };
  for (const value of [Object.defineProperty({}, 'then', { get: trap }), new Proxy(Promise.resolve(), { get: trap })]) {
    assert.deepEqual(await subject.boundedAskRequestCall(() => value, RAG_CLIENT_REQUEST_TIMEOUT_MS),
      { status: 'invalid-return', pendingCompletionUnknown: true });
  }
  const carrier = Promise.resolve('private-body'); Object.defineProperty(carrier, 'then', { get: trap });
  assert.deepEqual(await subject.boundedAskRequestCall(() => carrier, RAG_CLIENT_REQUEST_TIMEOUT_MS),
    { status: 'fulfilled', value: 'private-body' });
  const value = {}, resolved = new Promise(resolve => {
    resolve(value); Object.defineProperty(value, 'then', { get: trap });
  });
  const observed = await subject.boundedAskRequestCall(() => resolved, RAG_CLIENT_REQUEST_TIMEOUT_MS);
  assert.equal(observed.value, value); assert.equal(hooks, 0);
});

test('Ask unsafe native constructor and species carriers remain UNKNOWN without executing hooks', async () => {
  let hooks = 0;
  const promise = Promise.resolve(); Object.defineProperty(promise, 'constructor', { get() { hooks++; throw Error('PRIVATE_SENTINEL'); } });
  class UnsafePromise extends Promise { static get [Symbol.species]() { hooks++; throw Error('PRIVATE_SENTINEL'); } }
  for (const value of [promise, new UnsafePromise(resolve => resolve())]) {
    assert.deepEqual(await subject.boundedAskRequestCall(() => value, RAG_CLIENT_REQUEST_TIMEOUT_MS),
      { status: 'invalid-return', pendingCompletionUnknown: true });
  }
  assert.equal(hooks, 0);
});

test('Ask pending timeout drains late rejection and never claims request cancellation', async t => {
  t.mock.method(performance, 'now', () => 0);
  const barrier = deferred(); let calls = 0;
  const observed = await subject.boundedAskRequestCall(() => { calls++; return barrier.promise; }, 20);
  assert.deepEqual(observed, { status: 'timeout', pendingCompletionUnknown: true });
  assert.equal(calls, 1);
  barrier.reject(Error('PRIVATE_SENTINEL')); await tick();
  assert.equal(Object.hasOwn(observed, 'reason'), false);
});

test('sync drain attaches to an already rejected native Promise before any delayed dispatch', async () => {
  assert.equal(typeof subject.attachProviderPromiseDrain, 'function'); let hooks = 0;
  const returned = Promise.reject(Error('PRIVATE_SENTINEL'));
  Object.defineProperty(returned, 'then', { get() { hooks++; throw Error('PRIVATE_SENTINEL'); } });
  const result = subject.attachProviderPromiseDrain(returned);
  assert.deepEqual(result, { status: 'attached', pendingCompletionUnknown: true }); assert.equal(Object.isFrozen(result), true);
  const until = performance.now() + 10; while (performance.now() < until) { /* Attachment must already have happened. */ }
  await tick(); assert.equal(hooks, 0);
});

test('sync drain rejects unsafe carriers without adopting getters constructor or species hooks', () => {
  assert.equal(typeof subject.attachProviderPromiseDrain, 'function'); let hooks = 0;
  const trap = () => { hooks++; throw Error('PRIVATE_SENTINEL'); };
  const altered = Promise.resolve(); Object.defineProperty(altered, 'constructor', { get: trap });
  class UnsafePromise extends Promise { static get [Symbol.species]() { hooks++; throw Error('PRIVATE_SENTINEL'); } }
  for (const value of [Object.defineProperty({}, 'then', { get: trap }), new Proxy(Promise.resolve(), { get: trap }),
    altered, new UnsafePromise(resolve => resolve()), undefined]) {
    assert.deepEqual(subject.attachProviderPromiseDrain(value), { status: 'invalid-return', pendingCompletionUnknown: true });
  }
  assert.deepEqual(subject.attachProviderPromiseDrain(Promise.resolve(), {}), { status: 'invalid-return', pendingCompletionUnknown: true });
  assert.equal(hooks, 0);
});
