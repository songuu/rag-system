import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  Neo4jOperationError,
  checkNeo4jHealth,
  closeNeo4jDriver,
  createNeo4jClient,
  getNeo4jClient,
} = await import('./driver.ts');

const BASE_CONFIG = {
  uri: 'neo4j://graph.internal:7687',
  username: 'neo4j',
  password: 'secret',
  database: 'neo4j',
  connectionTimeoutMs: 5_000,
  queryTimeoutMs: 3_000,
  writeTimeoutMs: 120_000,
  maxTransactionRetryTimeMs: 1_000,
  maxConnectionPoolSize: 25,
};

function createFakeDriver() {
  const state = {
    verifyCalls: 0,
    closeCalls: 0,
    sessions: [],
  };
  const driver = {
    async verifyConnectivity() { state.verifyCalls += 1; },
    session(config) {
      const sessionState = { config, closeCalls: 0, readConfig: null, writeConfig: null };
      state.sessions.push(sessionState);
      return {
        async executeRead(work, txConfig) {
          sessionState.readConfig = txConfig;
          return work({ run: async () => ({ records: [] }) });
        },
        async executeWrite(work, txConfig) {
          sessionState.writeConfig = txConfig;
          return work({ run: async () => ({ records: [] }) });
        },
        async close() { sessionState.closeCalls += 1; },
      };
    },
    async close() { state.closeCalls += 1; },
  };
  return { driver, state };
}

test('client verifies connectivity and uses one short-lived session per operation', async () => {
  const { driver, state } = createFakeDriver();
  const client = createNeo4jClient(BASE_CONFIG, () => driver);

  await client.verifyConnectivity();
  const readResult = await client.executeRead('load entity', async tx => {
    await tx.run('MATCH (n:Entity {entityKey: $entityKey}) RETURN n', { entityKey: 'entity-a' });
    return 'read';
  });
  const writeResult = await client.executeWrite('save entity', async tx => {
    await tx.run('MERGE (n:Entity {entityKey: $entityKey})', { entityKey: 'entity-a' });
    return 'written';
  });

  assert.equal(state.verifyCalls, 1);
  assert.equal(readResult, 'read');
  assert.equal(writeResult, 'written');
  assert.equal(state.sessions.length, 2);
  assert.equal(state.sessions[0].config.database, 'neo4j');
  assert.equal(state.sessions[0].closeCalls, 1);
  assert.equal(state.sessions[1].closeCalls, 1);
  assert.equal(state.sessions[0].readConfig.timeout, 3_000);
  assert.equal(state.sessions[1].writeConfig.timeout, 120_000);
});

test('operation errors retain safe codes and context without leaking driver details', async () => {
  const secret = 'do-not-leak';
  const { driver } = createFakeDriver();
  driver.session = () => ({
    async executeRead() {
      throw Object.assign(new Error(`authentication failed for ${secret}`), {
        code: 'Neo.ClientError.Security.Unauthorized',
      });
    },
    async close() {},
  });
  const client = createNeo4jClient(BASE_CONFIG, () => driver);

  await assert.rejects(
    () => client.executeRead('load graph snapshot', async () => null),
    error => {
      assert.ok(error instanceof Neo4jOperationError);
      assert.equal(error.operation, 'load graph snapshot');
      assert.equal(error.code, 'Neo.ClientError.Security.Unauthorized');
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
});

test('health check reports connectivity without exposing connection secrets', async () => {
  const { driver } = createFakeDriver();
  const client = createNeo4jClient(BASE_CONFIG, () => driver);

  assert.deepEqual(await checkNeo4jHealth(BASE_CONFIG, client), {
    configured: true,
    connected: true,
    database: 'neo4j',
  });

  driver.verifyConnectivity = async () => {
    throw Object.assign(new Error('secret connection detail'), { code: 'ServiceUnavailable' });
  };
  assert.deepEqual(await checkNeo4jHealth(BASE_CONFIG, client), {
    configured: true,
    connected: false,
    database: 'neo4j',
    errorCode: 'ServiceUnavailable',
  });
});

test('singleton client reuses matching config and closes a replaced driver', async () => {
  await closeNeo4jDriver();
  const first = createFakeDriver();
  const second = createFakeDriver();
  let factoryCalls = 0;
  const factory = () => (++factoryCalls === 1 ? first.driver : second.driver);

  const clientA = getNeo4jClient(BASE_CONFIG, factory);
  const clientB = getNeo4jClient(BASE_CONFIG, factory);
  assert.equal(clientA, clientB);
  assert.equal(factoryCalls, 1);

  const clientC = getNeo4jClient({ ...BASE_CONFIG, database: 'knowledge' }, factory);
  assert.notEqual(clientA, clientC);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.state.closeCalls, 1);

  await closeNeo4jDriver();
  assert.equal(second.state.closeCalls, 1);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
