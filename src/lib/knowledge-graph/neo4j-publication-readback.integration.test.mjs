import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import neo4j from 'neo4j-driver';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
let subject;
try { subject = await import('./neo4j-publication-readback.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
if (process.env.RAG_NEO4J_PUBLICATION_LOCAL_TEST !== '1' || !process.env.TEST_NEO4J_PASSWORD) throw new Error('Explicit isolated local Neo4j test configuration is required.');
if (process.env.TEST_NEO4J_URI !== 'bolt://127.0.0.1:7687' || process.env.TEST_NEO4J_USERNAME !== 'neo4j') throw new Error('Publication integration only targets the verified local RAG Neo4j port.');

// No schema initialization, global claims, commits or shared-node cleanup.
// Each fixture lives in a random-scope transaction that is always rolled back.
// Passing the same real transaction into executeRead is a local integration
// seam, not evidence of independent IAM or an atomic cross-database snapshot.
async function isolated(work) {
  assert.equal(typeof subject.Neo4jKnowledgeGraphPublicationReadback, 'function');
  const suffix = randomUUID().replaceAll('-', '');
  const scope = { environment: 'isolated-local', tenantId: `neopub-${suffix}`, corpusId: `neocorpus-${suffix}` };
  const graphVersion = `neograph-${suffix}`;
  const driver = neo4j.driver(process.env.TEST_NEO4J_URI, neo4j.auth.basic(process.env.TEST_NEO4J_USERNAME, process.env.TEST_NEO4J_PASSWORD),
    { connectionTimeout: 5000, maxTransactionRetryTime: 0 });
  const session = driver.session({ database: 'neo4j' }); let tx;
  try {
    // Await the public SDK TransactionPromise to obtain its real own-bound
    // transaction API. Do not fabricate a run shim or depend on private classes.
    tx = await session.beginTransaction({ timeout: 5000 });
    const client = { async executeRead(_operation, callback) { return callback(tx); } };
    const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(client,
      { executionProfile: 'local-reference', scope, operationTimeoutMs: 2000, maxReads: 32 });
    await work({ tx, reader, scope, graphVersion });
  } finally {
    try {
      if (tx) {
        await tx.rollback();
        const r = await session.run('MATCH (node {tenantId: $tenantId}) RETURN count(node) AS remaining', { tenantId: scope.tenantId });
        assert.equal(r.records[0].get('remaining').toNumber(), 0);
      }
    } finally { try { await session.close(); } finally { await driver.close(); } }
  }
}
async function seed({ tx, scope, graphVersion }) {
  const documents = [{ documentId: '课程甲', documentVersion: '版本/一', trustLevel: 'trusted' },
    { documentId: 'doc/a', documentVersion: 'v1', trustLevel: 'reviewed' }];
  await tx.run(`CREATE (pointer:GraphPointer {tenantId: $tenantId, corpusId: $corpusId, activeGraphVersion: $graphVersion, revision: 7})
    CREATE (snapshot:GraphSnapshot {tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      status: 'active', artifactDigest: $digest, documentCount: 2})
    WITH snapshot UNWIND $documents AS identity
    CREATE (document:DocumentVersion {tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      documentId: identity.documentId, documentVersion: identity.documentVersion, trustLevel: identity.trustLevel, status: 'staging'})
    CREATE (snapshot)-[:CONTAINS]->(document)`,
  { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion, digest: `sha256:${'a'.repeat(64)}`, documents });
  return documents;
}
const reject = error => error instanceof subject.Neo4jPublicationReadbackError && error.code === 'invalid-readback' && error.productionAuthorized === false;

test('native Bolt reads actual pointer integers and complete opaque inventory, including staging documents', async () => isolated(async f => {
  await assert.rejects(f.reader.readPublication({}), reject);
  const documents = await seed(f); const result = await f.reader.readPublication({});
  assert.deepEqual(result.scope, f.scope); assert.equal(result.pointer.graphVersion, f.graphVersion); assert.equal(result.pointer.revision, 7);
  assert.equal(result.snapshot.status, 'active'); assert.equal(result.snapshot.artifactDigest, `sha256:${'a'.repeat(64)}`);
  assert.deepEqual([...result.snapshot.documents].sort((a, b) => a.documentId < b.documentId ? -1 : 1),
    [...documents].sort((a, b) => a.documentId < b.documentId ? -1 : 1));
  assert.ok(Object.isFrozen(result.snapshot.documents)); assert.equal(f.reader.productionCapable, false);
  assert.ok(!Object.hasOwn(result, 'productionAuthorized')); assert.ok(!Object.hasOwn(result, 'consistencyVerified'));
}));
test('native Bolt exposes duplicate CONTAINS edges and wrong-scope documents rather than filtering them out', async () => isolated(async f => {
  await seed(f);
  await f.tx.run(`MATCH (snapshot:GraphSnapshot {tenantId: $tenantId, corpusId: $corpusId})-[:CONTAINS]->(document:DocumentVersion)
    WHERE document.documentId = $documentId CREATE (snapshot)-[:CONTAINS]->(document)`, { tenantId: f.scope.tenantId, corpusId: f.scope.corpusId, documentId: 'doc/a' });
  await assert.rejects(f.reader.readPublication({}), reject);
  await f.tx.run(`MATCH (snapshot:GraphSnapshot {tenantId: $tenantId, corpusId: $corpusId})-[edge:CONTAINS]->(document:DocumentVersion)
    WHERE document.documentId = $documentId WITH edge ORDER BY elementId(edge) DESC LIMIT 1 DELETE edge`,
  { tenantId: f.scope.tenantId, corpusId: f.scope.corpusId, documentId: 'doc/a' });
  await f.reader.readPublication({});
  await f.tx.run(`MATCH (document:DocumentVersion {tenantId: $tenantId, corpusId: $corpusId, documentId: $documentId})
    SET document.corpusId = $wrongCorpus`, { tenantId: f.scope.tenantId, corpusId: f.scope.corpusId, documentId: 'doc/a', wrongCorpus: `${f.scope.corpusId}-wrong` });
  await assert.rejects(f.reader.readPublication({}), reject);
}));
test('native Bolt rejects inconsistent actual snapshot state, counts, revision types and graph identities', async () => isolated(async f => {
  await seed(f);
  const parameters = { tenantId: f.scope.tenantId, corpusId: f.scope.corpusId };
  for (const [property, invalid, restored] of [['status', 'staging', 'active'], ['documentCount', 1, 2]]) {
    await f.tx.run(`MATCH (snapshot:GraphSnapshot {tenantId: $tenantId, corpusId: $corpusId}) SET snapshot.${property} = $value`, { ...parameters, value: invalid });
    await assert.rejects(f.reader.readPublication({}), reject);
    await f.tx.run(`MATCH (snapshot:GraphSnapshot {tenantId: $tenantId, corpusId: $corpusId}) SET snapshot.${property} = $value`, { ...parameters, value: restored });
  }
  await f.tx.run('MATCH (pointer:GraphPointer {tenantId: $tenantId, corpusId: $corpusId}) SET pointer.revision = $value', { ...parameters, value: '7' });
  await assert.rejects(f.reader.readPublication({}), reject);
  await f.tx.run('MATCH (pointer:GraphPointer {tenantId: $tenantId, corpusId: $corpusId}) SET pointer.revision = 7', parameters);
  await f.tx.run('MATCH (document:DocumentVersion {tenantId: $tenantId, corpusId: $corpusId, documentId: $documentId}) SET document.graphVersion = $value',
    { ...parameters, documentId: 'doc/a', value: `${f.graphVersion}-wrong` });
  await assert.rejects(f.reader.readPublication({}), reject);
}));
test('the real managed executeRead API reads missing random scope without masking the SDK transaction type', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const driver = neo4j.driver(process.env.TEST_NEO4J_URI, neo4j.auth.basic(process.env.TEST_NEO4J_USERNAME, process.env.TEST_NEO4J_PASSWORD),
    { connectionTimeout: 5000, maxTransactionRetryTime: 0 });
  const session = driver.session({ database: 'neo4j' });
  try {
    const client = { async executeRead(_operation, callback) { return session.executeRead(callback, { timeout: 5000 }); } };
    const reader = new subject.Neo4jKnowledgeGraphPublicationReadback(client, { executionProfile: 'local-reference',
      scope: { environment: 'isolated-local', tenantId: `neopub-${suffix}`, corpusId: `neocorpus-${suffix}` }, operationTimeoutMs: 2000, maxReads: 1 });
    await assert.rejects(reader.readPublication({}), reject);
  } finally { try { await session.close(); } finally { await driver.close(); } }
});
