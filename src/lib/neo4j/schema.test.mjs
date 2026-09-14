import assert from 'node:assert/strict';
import test from 'node:test';

const {
  NEO4J_SCHEMA_STATEMENTS,
  initializeNeo4jSchema,
} = await import('./schema.ts');

test('schema uses a fixed, idempotent set of constraints and indexes', () => {
  assert.equal(Object.isFrozen(NEO4J_SCHEMA_STATEMENTS), true);
  assert.equal(NEO4J_SCHEMA_STATEMENTS.length >= 10, true);

  const names = new Set();
  for (const statement of NEO4J_SCHEMA_STATEMENTS) {
    assert.match(statement.name, /^kg_[a-z0-9_]+$/);
    assert.equal(names.has(statement.name), false);
    names.add(statement.name);
    assert.match(statement.cypher, new RegExp(`\\b${statement.name}\\b`));
    assert.match(statement.cypher, /IF NOT EXISTS/);
    assert.equal(statement.cypher.includes('${'), false);
    assert.equal(statement.cypher.includes('$tenantId'), false);
    assert.equal(Object.isFrozen(statement), true);
  }

  for (const label of [
    'GraphPointer',
    'GraphSnapshot',
    'DocumentVersion',
    'Passage',
    'Entity',
    'Claim',
    'Community',
  ]) {
    assert.equal(NEO4J_SCHEMA_STATEMENTS.some(item => item.cypher.includes(`:${label}`)), true);
  }

  const graphPointerConstraint = NEO4J_SCHEMA_STATEMENTS.find(
    item => item.name === 'kg_graph_pointer_identity'
  );
  assert.match(
    graphPointerConstraint.cypher,
    /REQUIRE \(node\.tenantId, node\.corpusId\) IS UNIQUE/
  );

  for (const name of [
    'kg_document_version_identity',
    'kg_passage_identity',
    'kg_entity_identity',
    'kg_claim_identity',
    'kg_community_identity',
  ]) {
    const statement = NEO4J_SCHEMA_STATEMENTS.find(item => item.name === name);
    assert.match(statement.cypher, /REQUIRE \([^)]*node\.graphVersion/);
  }
});

test('schema initialization executes only the reviewed fixed statements', async () => {
  const calls = [];
  const client = {
    async executeWrite(operation, work) {
      const tx = {
        async run(cypher, parameters) {
          calls.push({ operation, cypher, parameters });
          return { records: [] };
        },
      };
      return work(tx);
    },
  };

  const result = await initializeNeo4jSchema(client);

  assert.deepEqual(result, { applied: NEO4J_SCHEMA_STATEMENTS.length });
  assert.deepEqual(
    calls.map(call => call.cypher),
    NEO4J_SCHEMA_STATEMENTS.map(statement => statement.cypher)
  );
  assert.equal(calls.every(call => Object.keys(call.parameters).length === 0), true);
  assert.equal(calls.every(call => call.operation.startsWith('initialize Neo4j schema: kg_')), true);
});
