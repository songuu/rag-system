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
  PostgresTraceStore,
  enqueueTraceMirror,
  mirrorTraceToPostgres,
} = await import('./postgres-trace-store.ts');

const CONFIG = {
  databaseUrl: 'postgresql://rag:secret@db/rag',
  defaultTenantId: 'tenant-a',
  defaultCorpusId: 'corpus-a',
  sslMode: 'disable',
  maxConnections: 5,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
  persistenceBackend: 'postgres',
  vectorBackend: 'milvus',
};

test('trace graph upsert is one parameterized PostgreSQL statement', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new PostgresTraceStore(CONFIG, client);
  await store.upsertTrace({
    id: 'trace-1',
    userId: 'external-user',
    name: 'query',
    input: { question: 'safe' },
    output: { answer: 'ok' },
    status: 'SUCCESS',
    startTime: '2026-08-13T00:00:00.000Z',
    endTime: '2026-08-13T00:00:01.000Z',
    observations: [{
      id: 'observation-1',
      traceId: 'trace-1',
      type: 'SPAN',
      name: 'retrieve',
      startTime: '2026-08-13T00:00:00.000Z',
      endTime: '2026-08-13T00:00:00.500Z',
    }],
    scores: [{
      id: 'score-1',
      traceId: 'trace-1',
      name: 'quality',
      value: 1,
      source: 'SYSTEM',
      timestamp: '2026-08-13T00:00:01.000Z',
    }],
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /with upserted_trace/i);
  assert.match(calls[0].text, /insert into observations/i);
  assert.match(calls[0].text, /insert into trace_scores/i);
  assert.equal(calls[0].values[1], 'tenant-a');
  assert.equal(calls[0].values[2], 'external-user');
  assert.equal(calls[0].text.includes('trace-1'), false);
  assert.equal(JSON.parse(calls[0].values[12])[0].trace_id, 'trace-1');
  assert.equal(JSON.parse(calls[0].values[13])[0].trace_id, 'trace-1');
  assert.match(calls[0].text, /select\s+\(item->>'id'\)::uuid,\s*upserted_trace\.id/i);
});

test('trace list and clear always bind the configured tenant scope', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (/select id, tenant_id/i.test(text)) {
        return {
          rows: [{
            id: 'trace-1',
            tenant_id: 'tenant-a',
            user_id: null,
            session_id: null,
            name: 'query',
            input: {},
            output: {},
            metadata: {},
            tags: [],
            status: 'SUCCESS',
            started_at: '2026-08-13T00:00:00.000Z',
            ended_at: '2026-08-13T00:00:01.000Z',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new PostgresTraceStore(CONFIG, client);

  const listed = await store.listTraces();
  await store.clear();

  assert.equal(listed.traces.length, 1);
  assert.equal(listed.stats.totalTraces, 1);
  assert.deepEqual(calls.map((call) => call.values), [['tenant-a'], ['tenant-a']]);
  assert.match(calls[1].text, /delete from traces where tenant_id = \$1/i);
});

test('feedback fails closed when its trace is outside the tenant scope', async () => {
  const store = new PostgresTraceStore(CONFIG, {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  });

  await assert.rejects(
    () => store.addScore({
      traceId: 'other-tenant-trace',
      name: 'user_feedback',
      value: 1,
      source: 'USER',
    }),
    /outside the configured tenant scope/
  );
});

test('trace mirror serializes updates for the same trace in callback order', async () => {
  const statuses = [];
  let releaseFirst;
  const firstBarrier = new Promise((resolve) => { releaseFirst = resolve; });
  const store = {
    async upsertTrace(trace) {
      statuses.push(trace.status);
      if (trace.status === 'PENDING') await firstBarrier;
    },
  };

  const first = enqueueTraceMirror(store, { id: 'trace-ordered', status: 'PENDING' });
  const second = enqueueTraceMirror(store, { id: 'trace-ordered', status: 'SUCCESS' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(statuses, ['PENDING']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(statuses, ['PENDING', 'SUCCESS']);
});

test('trace mirror exposes the queued PostgreSQL write failure to its terminal caller', async () => {
  const persistenceFailure = new Error('postgres unavailable');
  const store = {
    async upsertTrace() {
      throw persistenceFailure;
    },
  };

  await assert.rejects(
    enqueueTraceMirror(store, { id: 'trace-failed', status: 'ERROR' }),
    (error) => error === persistenceFailure
  );
});

test('postgres trace mirror fails closed when required runtime scope is missing', () => {
  const names = [
    'NODE_ENV',
    'RAG_PERSISTENCE_BACKEND',
    'POSTGRES_URL',
    'DATABASE_URL',
    'RAG_DEFAULT_TENANT_ID',
    'POSTGRES_DEFAULT_TENANT_ID',
    'RAG_DEFAULT_CORPUS_ID',
    'POSTGRES_DEFAULT_CORPUS_ID',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.RAG_PERSISTENCE_BACKEND = 'postgres';
    for (const name of names.slice(2)) delete process.env[name];

    assert.throws(
      () => mirrorTraceToPostgres({ id: 'trace-misconfigured', status: 'ERROR' }),
      /PostgreSQL persistence requires DATABASE_URL, RAG_DEFAULT_TENANT_ID, RAG_DEFAULT_CORPUS_ID/
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
