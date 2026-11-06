import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.')) return next(`${s}.ts`, c); throw e;
} } });
const { PublicationGrantRecoveryWorker } = await import('./publication-grant-recovery-worker.ts');
test('repeated cycles scan events from zero and report unknown without mutation', async () => {
  const controller = new AbortController();
  const cursors = []; const unknown = []; let observations = 0;
  const journal = { async listAll() { return [{ operationId: 'one' }]; },
    async listEvents(id, cursor) { cursors.push([id, cursor]); return [{ id: '7', phase: 'unknown' }]; } };
  const worker = new PublicationGrantRecoveryWorker({ journal, signal: controller.signal,
    operationDelayMs: 100, cycleDelayMs: 1000, maxPages: 5, onUnknown: async id => unknown.push(id),
    onEvent: async () => { if (++observations === 2) controller.abort(); },
    onError: async (_id, error) => { throw error; } });
  await worker.run();
  assert.deepEqual(cursors, [['one', '0'], ['one', '0']]);
  assert.deepEqual(unknown, ['one']);
});

test('long event histories resume next cycle and restart only after reaching the end', async () => {
  const controller = new AbortController(); const cursors = [];
  const journal = { async listAll() { return [{ operationId: 'one' }]; }, async listEvents(_id, cursor) {
    cursors.push(cursor);
    if (cursors.length === 4) { controller.abort(); return []; }
    if (cursor === '200') return [{ id: '201', phase: 'unknown' }];
    const start = Number(cursor);
    return Array.from({ length: 100 }, (_, i) => ({ id: String(start + i + 1), phase: 'unknown' }));
  } };
  const worker = new PublicationGrantRecoveryWorker({ journal, signal: controller.signal,
    operationDelayMs: 100, cycleDelayMs: 1000, maxPages: 1,
    onEvent: async () => {}, onUnknown: async () => {}, onError: async (_id, error) => { throw error; } });
  await worker.run();
  assert.deepEqual(cursors, ['0', '100', '200', '0']);
});

test('abort during a pending read prevents any subsequent callbacks', async () => {
  const controller = new AbortController(); let release;
  const entered = new Promise(resolve => { release = resolve; });
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  let callbacks = 0;
  const journal = { async listAll() { release(); return pending; }, async listEvents() { callbacks++; return []; } };
  const worker = new PublicationGrantRecoveryWorker({ journal, signal: controller.signal, operationDelayMs: 100,
    cycleDelayMs: 1000, maxPages: 1, onEvent: async () => { callbacks++; }, onUnknown: async () => { callbacks++; },
    onError: async () => { callbacks++; } });
  const run = worker.run(); await entered; controller.abort(); await run; finish([{ operationId: 'one' }]);
  assert.equal(callbacks, 0);
});

test('an indefinitely stalled read times out and stops without retrying', async () => {
  let reads = 0;
  const journal = { async listAll() { reads++; return new Promise(() => {}); }, async listEvents() { throw new Error('unexpected'); } };
  const worker = new PublicationGrantRecoveryWorker({ journal, signal: new AbortController().signal,
    operationDelayMs: 100, cycleDelayMs: 1000, operationTimeoutMs: 20, maxPages: 1,
    onEvent: async () => {}, onUnknown: async () => {}, onError: async () => {} });
  await assert.rejects(worker.run(), /timed out.*stopped/i);
  await assert.rejects(worker.run(), /permanently stopped/i);
  assert.equal(reads, 1);
});

test('an indefinitely stalled callback can be cancelled', async () => {
  const controller = new AbortController(); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const journal = { async listAll() { return [{ operationId: 'one' }]; },
    async listEvents() { return [{ id: '1', phase: 'unknown' }]; } };
  const worker = new PublicationGrantRecoveryWorker({ journal, signal: controller.signal, operationDelayMs: 100,
    cycleDelayMs: 1000, maxPages: 1, onEvent: async () => { entered(); return new Promise(() => {}); },
    onUnknown: async () => { throw new Error('unexpected'); }, onError: async () => { throw new Error('unexpected'); } });
  const run = worker.run(); await ready; controller.abort(); await run;
});
