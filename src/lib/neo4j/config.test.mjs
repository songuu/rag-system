import assert from 'node:assert/strict';
import test from 'node:test';

const {
  assertNeo4jConfigured,
  getNeo4jConfigSummary,
  getNeo4jRuntimeConfig,
  isNeo4jConfigured,
} = await import('./config.ts');

test('Neo4j config has bounded, local-safe defaults without enabling the backend', () => {
  const config = getNeo4jRuntimeConfig({});

  assert.equal(config.uri, '');
  assert.equal(config.database, 'neo4j');
  assert.equal(config.connectionTimeoutMs, 5_000);
  assert.equal(config.queryTimeoutMs, 3_000);
  assert.equal(config.writeTimeoutMs, 120_000);
  assert.equal(config.maxTransactionRetryTimeMs, 1_000);
  assert.equal(config.maxConnectionPoolSize, 25);
  assert.equal(isNeo4jConfigured(config), false);
});

test('Neo4j config accepts supported routing and encrypted URI schemes', () => {
  for (const uri of [
    'neo4j://graph.internal:7687',
    'neo4j+s://graph.internal',
    'neo4j+ssc://graph.internal',
    'bolt://127.0.0.1:7687',
    'bolt+s://graph.internal',
    'bolt+ssc://graph.internal',
  ]) {
    const config = getNeo4jRuntimeConfig({
      NEO4J_URI: uri,
      NEO4J_USERNAME: 'neo4j',
      NEO4J_PASSWORD: 'secret',
      NEO4J_DATABASE: 'knowledge-graph',
      NEO4J_CONNECTION_TIMEOUT_MS: '6000',
      RAG_GRAPH_QUERY_TIMEOUT_MS: '2500',
      RAG_GRAPH_WRITE_TIMEOUT_MS: '90000',
      NEO4J_MAX_TRANSACTION_RETRY_MS: '750',
      NEO4J_MAX_CONNECTION_POOL_SIZE: '12',
    });

    assert.equal(config.uri, uri);
    assert.equal(config.database, 'knowledge-graph');
    assert.equal(config.connectionTimeoutMs, 6_000);
    assert.equal(config.queryTimeoutMs, 2_500);
    assert.equal(config.writeTimeoutMs, 90_000);
    assert.equal(config.maxTransactionRetryTimeMs, 750);
    assert.equal(config.maxConnectionPoolSize, 12);
    assert.equal(isNeo4jConfigured(config), true);
    assert.doesNotThrow(() => assertNeo4jConfigured(config));
  }
});

test('Neo4j production mode fails closed for plaintext and self-signed schemes', () => {
  for (const uri of [
    'neo4j://graph.internal:7687',
    'bolt://graph.internal:7687',
    'neo4j+ssc://graph.internal:7687',
    'bolt+ssc://graph.internal:7687',
  ]) {
    assert.throws(
      () => getNeo4jRuntimeConfig({ NODE_ENV: 'production', NEO4J_URI: uri }),
      /requires neo4j\+s:\/\/ or bolt\+s:\/\//i
    );
  }
});

test('Neo4j production mode accepts verified TLS and requires an explicit exception', () => {
  assert.equal(getNeo4jRuntimeConfig({
    NODE_ENV: 'production',
    NEO4J_URI: 'neo4j+s://graph.internal:7687',
  }).uri, 'neo4j+s://graph.internal:7687');
  assert.equal(getNeo4jRuntimeConfig({
    NODE_ENV: 'production',
    NEO4J_URI: 'neo4j://graph.internal:7687',
    NEO4J_ALLOW_INSECURE: 'true',
  }).uri, 'neo4j://graph.internal:7687');
  assert.throws(
    () => getNeo4jRuntimeConfig({ NEO4J_ALLOW_INSECURE: 'yes' }),
    /NEO4J_ALLOW_INSECURE must be true or false/
  );
});

test('Neo4j development mode keeps loopback plaintext available', () => {
  assert.equal(getNeo4jRuntimeConfig({
    NODE_ENV: 'development',
    NEO4J_URI: 'neo4j://127.0.0.1:7687',
  }).uri, 'neo4j://127.0.0.1:7687');
});

test('Neo4j config fails closed for partial credentials and unsafe URIs', () => {
  const partial = getNeo4jRuntimeConfig({
    NEO4J_URI: 'neo4j://graph.internal:7687',
    NEO4J_USERNAME: 'neo4j',
  });
  assert.throws(() => assertNeo4jConfigured(partial), /NEO4J_PASSWORD/);

  for (const uri of [
    'http://graph.internal:7474',
    'neo4j://neo4j:secret@graph.internal:7687',
    'neo4j://graph.internal:7687?password=secret',
    'neo4j://graph.internal:7687/#fragment',
  ]) {
    assert.throws(
      () => getNeo4jRuntimeConfig({ NEO4J_URI: uri }),
      /NEO4J_URI/
    );
  }
});

test('Neo4j config validates database and bounded numeric settings', () => {
  assert.throws(
    () => getNeo4jRuntimeConfig({ NEO4J_DATABASE: 'db with spaces' }),
    /NEO4J_DATABASE/
  );
  for (const [name, value] of [
    ['NEO4J_CONNECTION_TIMEOUT_MS', '99'],
    ['RAG_GRAPH_QUERY_TIMEOUT_MS', '0'],
    ['RAG_GRAPH_WRITE_TIMEOUT_MS', '999'],
    ['RAG_GRAPH_WRITE_TIMEOUT_MS', '600001'],
    ['NEO4J_MAX_TRANSACTION_RETRY_MS', '30001'],
    ['NEO4J_MAX_CONNECTION_POOL_SIZE', '501'],
  ]) {
    assert.throws(
      () => getNeo4jRuntimeConfig({ [name]: value }),
      new RegExp(name)
    );
  }
});

test('Neo4j config summary never exposes URI credentials or passwords', () => {
  const config = getNeo4jRuntimeConfig({
    NEO4J_URI: 'neo4j+s://graph.internal:7687',
    NEO4J_USERNAME: 'neo4j',
    NEO4J_PASSWORD: 'do-not-leak',
  });

  const summary = getNeo4jConfigSummary(config);
  const serialized = JSON.stringify(summary);
  assert.equal(summary.configured, true);
  assert.equal(summary.hasPassword, true);
  assert.equal(serialized.includes('do-not-leak'), false);
  assert.equal('password' in summary, false);
  assert.equal('uri' in summary, false);
  assert.equal(summary.writeTimeoutMs, 120_000);
});
