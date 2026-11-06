import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { createRuntimePublisherPorts } = await import('./publication-runtime-publisher-adapters.ts');
const { publishRuntimeGeneration } = await import('./publication-runtime-publisher.ts');

test('a forged verifier and mutable Milvus config cannot authorize a seal or begin', async () => {
  let begins = 0;
  let verifierCalls = 0;
  const client = { config: { maxRetries: 1 }, isGlobal: true, channelOptions: {}, channelPool: {} };
  // Mutating public SDK settings cannot change interceptor constructor state.
  client.config.maxRetries = 0;
  client.isGlobal = false;
  client.channelOptions['grpc.enable_retries'] = 0;
  const ports = createRuntimePublisherPorts({
    scope: { tenantId: 'tenant', corpusId: 'corpus', enforceIsolation: true },
    control: { async begin() { begins++; } }, assets: {}, operations: {}, publisherDb: {}, esSealer: {}, esWriter: {},
    milvus: client, timeoutMs: 100,
    async verifyIsolation() { verifierCalls++; return { configurationDigest: `sha256:${'a'.repeat(64)}` }; },
  });
  const asset = { tenantId: 'tenant', corpusId: 'corpus', documentId: 'doc',
    contentVersion: `sha256:${'b'.repeat(64)}`, manifestDigest: `sha256:${'c'.repeat(64)}` };
  await assert.rejects(publishRuntimeGeneration(asset, ports, { timeoutMs: 100 }), error => error.disposition === 'not-started');
  await assert.rejects(ports.recordSeal({}, {}), /capability is unavailable/);
  await assert.rejects(ports.publish({}), /capability is unavailable/);
  assert.equal(begins, 0);
  assert.equal(verifierCalls, 0);
});

test('durable intent precedes begin and uses the same externally known operation identity', async () => {
  const calls = [];
  const operationIdentity = { operationId: 'c80bdc54-ccbe-4610-9594-20931b083430', physicalCollection: `rag_publication_${'d'.repeat(32)}` };
  const asset = { tenantId: 'tenant', corpusId: 'corpus', documentId: 'doc',
    contentVersion: `sha256:${'b'.repeat(64)}`, manifestDigest: `sha256:${'c'.repeat(64)}` };
  const ports = createRuntimePublisherPorts({ scope: { tenantId: 'tenant', corpusId: 'corpus', enforceIsolation: true },
    control: { async begin(value) { calls.push(['begin', value]); return {}; } }, assets: {}, operations: {},
    publisherDb: { async query(sql, values) { calls.push(['intent', values]); return { rows: [{}], rowCount: 1 }; } },
    esSealer: {}, esWriter: {}, milvus: {}, verifyIsolation: async () => ({}), timeoutMs: 100, operationIdentity });
  await ports.begin(asset);
  assert.deepEqual(calls.map(call => call[0]), ['intent', 'begin']);
  assert.equal(calls[0][1][0], operationIdentity.operationId);
  assert.equal(calls[1][1].idempotencyKey, operationIdentity.operationId);
  assert.equal(calls[1][1].physicalCollection, operationIdentity.physicalCollection);
});
