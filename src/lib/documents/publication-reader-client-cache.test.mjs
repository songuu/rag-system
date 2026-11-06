import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicationReaderClientCache } from './publication-reader-client-cache.ts';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

test('shares a connection while each acquisition owns an independent lease', async () => {
  let created = 0, closed = 0;
  const cache = createPublicationReaderClientCache({ maxEntries: 2, idleTimeoutMs: 1000 });
  const create = () => ({ value: { id: ++created }, close: async () => { closed++; } });
  const a = await cache.acquire('same', create), b = await cache.acquire('same', create);
  assert.equal(a.value, b.value);
  a.release(); a.release();
  assert.equal(closed, 0);
  a.invalidate();
  assert.equal(closed, 0, 'a released lease cannot close another active reader');
  b.release();
  await cache.close();
  assert.equal(created, 1); assert.equal(closed, 1);
});

test('retired clients are not reused or closed while an existing operation is in flight', async () => {
  const closed = [], cache = createPublicationReaderClientCache({ maxEntries: 2, idleTimeoutMs: 1000 });
  const a = await cache.acquire('old', () => ({ value: 'old', close: async () => { closed.push('old'); } }));
  a.invalidate();
  const b = await cache.acquire('new', () => ({ value: 'new', close: async () => { closed.push('new'); } }));
  assert.deepEqual(closed, []);
  a.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closed, ['old']);
  b.release(); await cache.close();
  assert.deepEqual(closed, ['old', 'new']);
});

test('capacity includes active retired clients and fails without constructing an extra client', async () => {
  let created = 0;
  const cache = createPublicationReaderClientCache({ maxEntries: 1, idleTimeoutMs: 1000 });
  const make = () => ({ value: ++created, close: async () => {} });
  const a = await cache.acquire('a', make); a.invalidate();
  await assert.rejects(cache.acquire('b', make), /capacity/i);
  assert.equal(created, 1);
  a.release(); await cache.close();
});

test('idle eviction waits for actual close and cancellation cannot start a late construction', async () => {
  const closure = deferred(); let created = 0;
  const cache = createPublicationReaderClientCache({ maxEntries: 1, idleTimeoutMs: 1000 });
  const a = await cache.acquire('a', () => ({ value: ++created, close: () => closure.promise })); a.release();
  const controller = new AbortController();
  const pending = cache.acquire('b', () => ({ value: ++created, close: async () => {} }), controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(created, 1);
  closure.resolve(); await cache.close();
  assert.equal(created, 1);
});

test('idle leases expire and shutdown waits for active leases', async () => {
  let closed = 0;
  const cache = createPublicationReaderClientCache({ maxEntries: 2, idleTimeoutMs: 10 });
  const make = () => ({ value: {}, close: async () => { closed++; } });
  const a = await cache.acquire('a', make); a.release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, 1);
  const b = await cache.acquire('b', make);
  let done = false; const shutdown = cache.close().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  b.release(); await shutdown;
  assert.equal(closed, 2);
});

test('pre-cancelled acquisition does not create resources and invalid limits are rejected', async () => {
  const cache = createPublicationReaderClientCache({ maxEntries: 1, idleTimeoutMs: 10 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cache.acquire('a', () => { throw new Error('must not create'); }, controller.signal),
    error => error.name === 'AbortError');
  assert.throws(() => createPublicationReaderClientCache({ maxEntries: 0, idleTimeoutMs: 10 }), /configuration/i);
  assert.throws(() => createPublicationReaderClientCache({ maxEntries: 1, idleTimeoutMs: 0 }), /configuration/i);
  await cache.close();
});

test('a full idle cache closes an old transport before admitting its replacement', async () => {
  const events = [], cache = createPublicationReaderClientCache({ maxEntries: 1, idleTimeoutMs: 1000 });
  const a = await cache.acquire('a', () => ({ value: 'a', close: async () => { events.push('close-a'); } }));
  a.release();
  const b = await cache.acquire('b', () => { events.push('create-b'); return { value: 'b', close: async () => {} }; });
  assert.deepEqual(events, ['close-a', 'create-b']);
  b.release(); await cache.close();
});

test('failed closure remains quarantined and counted until an explicit retry succeeds', async () => {
  const observed = [], cache = createPublicationReaderClientCache({ maxEntries: 1, idleTimeoutMs: 1000,
    onCloseError: error => { observed.push(error); } });
  const failure = new Error('fixture cleanup failure');
  await assert.rejects(cache.acquire('a', () => { throw failure; }), error => error === failure);
  let allowClose = false, live = 0, attempts = 0;
  const a = await cache.acquire('a', () => { live++; return { value: 'a', close: async () => {
    attempts++; if (!allowClose) throw failure; live--;
  } }; });
  a.release(); await assert.rejects(cache.close(), /cleanup failed/i);
  assert.deepEqual(observed, [failure]);
  await assert.rejects(cache.acquire('b', () => { live++; return { value: 'b', close: async () => { live--; } }; }), /capacity/i);
  assert.equal(live, 1);
  await assert.rejects(cache.close(), /cleanup failed/i);
  assert.equal(attempts, 1, 'ordinary cleanup cannot silently retry quarantined resources');
  await assert.rejects(cache.retryFailedClosures(), /cleanup failed/i);
  assert.equal(attempts, 2); assert.equal(live, 1);
  await assert.rejects(cache.acquire('b', () => { throw new Error('must not construct'); }), /capacity/i);
  allowClose = true; await cache.retryFailedClosures();
  assert.equal(attempts, 3); assert.equal(live, 0);
  const b = await cache.acquire('b', () => { live++; return { value: 'b', close: async () => { live--; } }; });
  b.release(); await cache.close();
  assert.equal(live, 0);
});
