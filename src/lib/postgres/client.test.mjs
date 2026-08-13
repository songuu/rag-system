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
  PostgresQueryError,
  buildPostgresPoolConfig,
  createPostgresQueryClient,
  queryPostgres,
} = await import('./client.ts');

const BASE_CONFIG = {
  databaseUrl: 'postgresql://rag:secret@db.internal:5432/rag',
  defaultTenantId: 'tenant-a',
  defaultCorpusId: 'corpus-a',
  sslMode: 'disable',
  maxConnections: 7,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
  persistenceBackend: 'postgres',
  vectorBackend: 'milvus',
};

test('pool config applies bounded connection settings and explicit SSL policy', () => {
  const disabled = buildPostgresPoolConfig(BASE_CONFIG);
  assert.equal(disabled.connectionString, BASE_CONFIG.databaseUrl);
  assert.equal(disabled.max, 7);
  assert.equal(disabled.ssl, false);

  const required = buildPostgresPoolConfig({ ...BASE_CONFIG, sslMode: 'require' });
  assert.deepEqual(required.ssl, { rejectUnauthorized: false });

  const verified = buildPostgresPoolConfig({ ...BASE_CONFIG, sslMode: 'verify-full' });
  assert.deepEqual(verified.ssl, { rejectUnauthorized: true });
});

test('query client delegates parameterized SQL without rewriting values', async () => {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ value: 1 }], rowCount: 1 };
    },
    async end() {},
  };
  const client = createPostgresQueryClient(BASE_CONFIG, () => pool);

  const result = await client.query('select $1::int as value', [1]);
  assert.deepEqual(result, { rows: [{ value: 1 }], rowCount: 1 });
  assert.deepEqual(calls, [{ text: 'select $1::int as value', values: [1] }]);
});

test('query errors add operation context without exposing SQL parameters', async () => {
  const secret = 'do-not-leak';
  const client = {
    async query() {
      const error = new Error(`connection rejected for ${secret}`);
      error.code = 'ECONNREFUSED';
      throw error;
    },
  };

  await assert.rejects(
    () => queryPostgres(client, 'select * from api_tokens where token_hash = $1', [secret], 'authenticate API token'),
    (error) => {
      assert.ok(error instanceof PostgresQueryError);
      assert.equal(error.operation, 'authenticate API token');
      assert.equal(error.code, 'ECONNREFUSED');
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('api_tokens'), false);
      return true;
    }
  );
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
