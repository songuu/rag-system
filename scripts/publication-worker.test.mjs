import assert from 'node:assert/strict';
import test from 'node:test';
import { runPublicationOnce, watchPublications } from './publication-worker.mjs';

const id = 'a'.repeat(24);
const config = { path: 'sandbox', credentials: { dbPublisher: 'db', elasticAdmin: 'ea', esWriter: 'ew', esSealer: 'es', milvusAdmin: 'ma', milvusReader: 'mr' },
  ports: { postgres: 5432, elasticsearch: 9200, milvus: 19530 }, ca: Buffer.from('cert') };

test('requires explicit sandbox identity before touching dependencies', async () => {
  let calls = 0;
  for (const invalid of ['', '../other', 'a'.repeat(23), 'A'.repeat(24), undefined]) {
    await assert.rejects(runPublicationOnce(invalid, { loadSandbox() { calls++; } }), /Invalid isolated sandbox ID/);
  }
  assert.equal(calls, 0);
});

test('runs a single publication using only isolated loopback configuration', async () => {
  let calls = 0; let persisted;
  await runPublicationOnce(id, { loadSandbox(value) { assert.equal(value, id); return config; },
    persistOperation(path, operation) { assert.equal(path, 'sandbox'); persisted = operation; },
    reportOperation(operation) { assert.equal(operation, persisted); }, createService(value) {
    assert.equal(value.postgres.host, '127.0.0.1');
    assert.equal(value.milvus.address, '127.0.0.1:19530');
    assert.equal(value.elasticsearch.node, 'https://127.0.0.1:9200');
    return { async publishNext(operation) { assert.equal(operation, persisted); calls++; } };
  } });
  assert.equal(calls, 1);
});

test('unknown claim or failed publication is never retried', async () => {
  let calls = 0;
  await assert.rejects(runPublicationOnce(id, { loadSandbox: () => config, persistOperation() {}, reportOperation() {}, createService: () => ({ async publishNext() {
    calls++; throw new Error('unknown');
  } }) }), /unknown/);
  assert.equal(calls, 1);
});

test('failed durable operation record prevents publisher construction and claim', async () => {
  let constructed = false;
  await assert.rejects(runPublicationOnce(id, { loadSandbox: () => config,
    persistOperation() { throw new Error('disk failure'); }, reportOperation() {},
    createService() { constructed = true; } }), /disk failure/);
  assert.equal(constructed, false);
});

test('watch leaves an empty queue unclaimed and stops on abort', async () => {
  const controller = new AbortController(); let claims = 0; let checks = 0;
  await watchPublications({ hasPending: async () => { checks++; return false; },
    publish: async () => { claims++; }, wait: async () => controller.abort() }, controller.signal);
  assert.equal(checks, 1); assert.equal(claims, 0);
});

test('watch stops at the first uncertain attempt without another observation', async () => {
  const controller = new AbortController(); let claims = 0; let checks = 0; let waits = 0;
  await assert.rejects(watchPublications({ hasPending: async () => { checks++; return true; },
    publish: async () => { claims++; throw new Error('unknown operation'); }, wait: async () => { waits++; } }, controller.signal), /unknown operation/);
  assert.equal(claims, 1); assert.equal(checks, 1); assert.equal(waits, 0);
});

test('abort during pending observation prevents a new claim', async () => {
  const controller = new AbortController(); let claims = 0;
  await assert.rejects(watchPublications({ hasPending: async () => { controller.abort(); return true; },
    publish: async () => { claims++; }, wait: async () => {} }, controller.signal), { name: 'AbortError' });
  assert.equal(claims, 0);
});
