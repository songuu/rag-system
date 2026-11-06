import assert from 'node:assert/strict';
import test from 'node:test';
import { settlePublicationReads } from './publication-parallel-reads.ts';

test('preserves result positions after parallel reads settle', async () => {
  assert.deepEqual(await settlePublicationReads([async () => 'first', () => 2]), ['first', 2]);
});

test('a synchronous SDK throw cannot detach another started RPC', async () => {
  const failure = new Error('fixture synchronous SDK failure');
  let release, started = false, settled = false;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = settlePublicationReads([
    () => { throw failure; },
    async () => { started = true; await gate; return 'late'; },
  ]);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, true); assert.equal(settled, false);
    release(); await assert.rejects(pending, error => error === failure);
  } finally { release(); await pending.catch(() => {}); }
});
