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
  checkPostgresReadiness,
  createPostgresQueryClient,
  queryPostgres,
  withPostgresTransaction,
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
  const listeners = [];
  const pool = {
    on(event, listener) { listeners.push({ event, listener }); },
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
  assert.equal(listeners[0]?.event, 'error');
});

test('query errors add operation context without exposing SQL parameters', async () => {
  const secret = 'do-not-leak';
  const client = {
    async query() {
      const error = new Error(`connection rejected for ${secret}`);
      error.code = 'ECONNREFUSED';
      error.constraint = 'api_tokens_token_hash_key';
      throw error;
    },
  };

  await assert.rejects(
    () => queryPostgres(client, 'select * from api_tokens where token_hash = $1', [secret], 'authenticate API token'),
    (error) => {
      assert.ok(error instanceof PostgresQueryError);
      assert.equal(error.operation, 'authenticate API token');
      assert.equal(error.code, 'ECONNREFUSED');
      assert.equal(error.constraint, 'api_tokens_token_hash_key');
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('api_tokens'), false);
      return true;
    }
  );
});

test('transaction commits successful work and always releases the connection', async () => {
  const calls = [];
  let released = false;
  const connection = {
    async query(text, values = []) {
      calls.push({ text, values });
      return { rows: [{ ok: true }], rowCount: 1 };
    },
    release() { released = true; },
  };
  const pool = { async connect() { return connection; } };

  const result = await withPostgresTransaction(pool, 'save trace', async client => {
    await client.query('insert into traces(id) values ($1)', ['trace-a']);
    return 'saved';
  });

  assert.equal(result, 'saved');
  assert.deepEqual(calls.map(call => call.text), [
    'begin',
    'insert into traces(id) values ($1)',
    'commit',
  ]);
  assert.equal(released, true);
});

test('transaction rolls back failed work, wraps context, and releases the connection', async () => {
  const calls = [];
  let released = false;
  const connection = {
    async query(text) {
      calls.push(text);
      return { rows: [], rowCount: 0 };
    },
    release() { released = true; },
  };
  const pool = { async connect() { return connection; } };

  await assert.rejects(
    () => withPostgresTransaction(pool, 'save trace', async () => {
      throw Object.assign(new Error('secret database detail'), { code: '23505' });
    }),
    error => {
      assert.ok(error instanceof PostgresQueryError);
      assert.equal(error.operation, 'save trace');
      assert.equal(error.code, '23505');
      assert.equal(error.message.includes('secret database detail'), false);
      return true;
    }
  );
  assert.deepEqual(calls, ['begin', 'rollback']);
  assert.equal(released, true);
});

test('readiness requires the current migration ledger entry and every runtime table', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ connected: true, schema_ready: true }], rowCount: 1 };
    },
  };

  assert.deepEqual(await checkPostgresReadiness(BASE_CONFIG, client), {
    connected: true,
    schemaReady: true,
  });
  assert.equal(calls[0].values[0], '0004');
  assert.match(calls[0].values[1], /^[0-9a-f]{64}$/);
  assert.deepEqual(calls[0].values.slice(2), ['tenant-a', 'corpus-a']);
  for (const relation of [
    'rag_schema_migrations',
    'tenants',
    'corpora',
    'document_assets',
    'object_blobs',
    'index_jobs',
    'traces',
    'observations',
    'trace_scores',
    'maic_courses',
    'maic_classroom_sessions',
    'prompt_optimizer_model_profiles',
    'prompt_optimizer_workspaces',
    'prompt_optimizer_versions',
  ]) {
    assert.match(calls[0].text, new RegExp(`public\\.${relation}`));
  }
  assert.match(calls[0].text, /checksum\s*=\s*\$2/i);
  assert.match(calls[0].text, /tenant\.id\s*=\s*\$3\s+and\s+corpus\.id\s*=\s*\$4/i);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
