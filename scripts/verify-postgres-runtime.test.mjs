import assert from 'node:assert/strict';
import test from 'node:test';

const {
  RuntimePostgresVerificationError,
  formatRuntimeVerificationError,
  resolveRuntimeVerificationConfig,
  verifyPostgresRuntime,
} = await import('./verify-postgres-runtime.mjs');

const APP_DATABASE_URL = 'postgresql://rag_app:runtime-secret@127.0.0.1:25432/rag_system';
const PROBE_ID = '11111111-2222-4333-8444-555555555555';

function runtimeEnv(overrides = {}) {
  return {
    POSTGRES_URL: APP_DATABASE_URL,
    POSTGRES_APP_ROLE: 'rag_app',
    POSTGRES_SSL_MODE: 'disable',
    RAG_DEFAULT_TENANT_ID: 'songuu-production',
    RAG_DEFAULT_CORPUS_ID: 'default',
    ...overrides,
  };
}

test('runtime verifier selects only the application URL aliases', () => {
  const config = resolveRuntimeVerificationConfig(runtimeEnv({
    POSTGRES_MIGRATION_URL: 'postgresql://rag_owner:owner-secret@127.0.0.1:25432/rag_system',
  }));

  assert.equal(config.databaseUrl, APP_DATABASE_URL);
  assert.equal(config.expectedRole, 'rag_app');
  assert.equal(config.tenantId, 'songuu-production');
  assert.equal(config.corpusId, 'default');
  assert.equal(config.ssl, false);

  assert.throws(
    () => resolveRuntimeVerificationConfig({
      POSTGRES_MIGRATION_URL: 'postgresql://rag_owner:owner-secret@db/rag_system',
      POSTGRES_APP_ROLE: 'rag_app',
      RAG_DEFAULT_TENANT_ID: 'tenant',
      RAG_DEFAULT_CORPUS_ID: 'corpus',
    }),
    /POSTGRES_URL or DATABASE_URL is required for runtime verification/i
  );
});

test('runtime verifier rejects conflicting URL aliases and connection-string TLS policy', () => {
  assert.throws(
    () => resolveRuntimeVerificationConfig(runtimeEnv({
      DATABASE_URL: 'postgresql://rag_app:runtime-secret@other-db/rag_system',
    })),
    /DATABASE_URL and POSTGRES_URL.*must match/i
  );

  for (const parameter of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    assert.throws(
      () => resolveRuntimeVerificationConfig(runtimeEnv({
        POSTGRES_URL: `${APP_DATABASE_URL}?${parameter}=require`,
      })),
      new RegExp(`POSTGRES_URL.*must not contain ${parameter}.*POSTGRES_SSL_MODE`, 'i')
    );
  }
});

test('runtime verifier requires an explicit matching LOGIN application role and valid scope', () => {
  assert.throws(
    () => resolveRuntimeVerificationConfig(runtimeEnv({ POSTGRES_APP_ROLE: '' })),
    /POSTGRES_APP_ROLE is required/i
  );
  assert.throws(
    () => resolveRuntimeVerificationConfig(runtimeEnv({ POSTGRES_APP_ROLE: 'rag-owner;drop' })),
    /POSTGRES_APP_ROLE must be a valid PostgreSQL identifier/i
  );
  assert.throws(
    () => resolveRuntimeVerificationConfig(runtimeEnv({ POSTGRES_APP_ROLE: 'another_role' })),
    /POSTGRES_URL must authenticate as POSTGRES_APP_ROLE/i
  );
  assert.throws(
    () => resolveRuntimeVerificationConfig(runtimeEnv({ RAG_DEFAULT_CORPUS_ID: '../other' })),
    /RAG_DEFAULT_CORPUS_ID must be a valid scope identifier/i
  );
});

test('runtime verifier maps the explicit TLS mode without accepting URL overrides', () => {
  assert.deepEqual(
    resolveRuntimeVerificationConfig(runtimeEnv({ POSTGRES_SSL_MODE: 'require' })).ssl,
    { rejectUnauthorized: false }
  );
  assert.deepEqual(
    resolveRuntimeVerificationConfig(runtimeEnv({ POSTGRES_SSL_MODE: 'verify-full' })).ssl,
    { rejectUnauthorized: true }
  );
  assert.throws(
    () => resolveRuntimeVerificationConfig(runtimeEnv({ POSTGRES_SSL_MODE: 'prefer' })),
    /POSTGRES_SSL_MODE must be disable, require, or verify-full/i
  );
});

test('runtime verifier proves app-role PG17 scope and rollback-only DML on every persistence table', async () => {
  const calls = [];
  const client = fakeRuntimeClient(async (text, values) => {
    calls.push({ text, values });
    return successfulProbeResult(text, values);
  });

  const result = await verifyPostgresRuntime(client, {
    ...resolveRuntimeVerificationConfig(runtimeEnv()),
    probeId: PROBE_ID,
  });

  assert.deepEqual(result, {
    role: 'rag_app',
    postgresMajor: 17,
    scopeVerified: true,
    transactionalDmlVerified: true,
  });
  assert.match(calls[0].text, /^begin\b/i);
  const rollbackIndex = calls.findIndex(({ text }) => /^rollback$/i.test(text));
  assert.ok(rollbackIndex > -1);
  assert.ok(calls.slice(rollbackIndex + 1).some(({ text }) => /as blob_count/i.test(text)));
  assert.equal(calls.some(({ text }) => /^commit$/i.test(text)), false);

  for (const table of [
    'object_blobs',
    'document_assets',
    'maic_courses',
    'maic_classroom_sessions',
  ]) {
    for (const operation of ['insert into', 'select', 'update', 'delete from']) {
      assert.ok(
        calls.some(({ text }) => new RegExp(`${operation}[\\s\\S]*public\\.${table}`, 'i').test(text)),
        `${operation} ${table} was not exercised`
      );
    }
  }
});

test('runtime verifier fails if the post-rollback readback finds probe residue', async () => {
  const client = fakeRuntimeClient(async (text, values) => {
    if (/as blob_count/i.test(text)) {
      return { rows: [{ blob_count: 1, asset_count: 0 }], rowCount: 1 };
    }
    return successfulProbeResult(text, values);
  });

  await assert.rejects(
    () => verifyPostgresRuntime(client, {
      ...resolveRuntimeVerificationConfig(runtimeEnv()),
      probeId: PROBE_ID,
    }),
    /PostgreSQL runtime probe left rows after rollback/i
  );
});

test('runtime verifier fails closed on identity, version, or default-scope drift', async () => {
  const cases = [
    {
      label: 'identity',
      result: { rows: [{ current_user: 'rag_owner', server_version_num: 170006, can_login: true }], rowCount: 1 },
      message: /connected PostgreSQL role does not match POSTGRES_APP_ROLE/i,
    },
    {
      label: 'version',
      result: { rows: [{ current_user: 'rag_app', server_version_num: 160010, can_login: true }], rowCount: 1 },
      message: /PostgreSQL 17 is required/i,
    },
    {
      label: 'login',
      result: { rows: [{ current_user: 'rag_app', server_version_num: 170006, can_login: false }], rowCount: 1 },
      message: /POSTGRES_APP_ROLE must be a LOGIN role/i,
    },
  ];

  for (const scenario of cases) {
    const client = fakeRuntimeClient(async (text, values) => {
      if (/pg_catalog\.pg_roles/i.test(text)) return scenario.result;
      return successfulProbeResult(text, values);
    });
    await assert.rejects(
      () => verifyPostgresRuntime(client, {
        ...resolveRuntimeVerificationConfig(runtimeEnv()),
        probeId: PROBE_ID,
      }),
      scenario.message,
      scenario.label
    );
    assert.match(client.calls.at(-1).text, /^rollback$/i);
  }

  const missingScope = fakeRuntimeClient(async (text, values) => {
    if (/from public\.tenants/i.test(text)) return { rows: [], rowCount: 0 };
    return successfulProbeResult(text, values);
  });
  await assert.rejects(
    () => verifyPostgresRuntime(missingScope, {
      ...resolveRuntimeVerificationConfig(runtimeEnv()),
      probeId: PROBE_ID,
    }),
    /default tenant and corpus are not available/i
  );
  assert.match(missingScope.calls.at(-1).text, /^rollback$/i);
});

test('runtime verifier rolls back and never exposes driver details or DSNs', async () => {
  const client = fakeRuntimeClient(async (text, values) => {
    if (/update public\.document_assets/i.test(text)) {
      throw new Error(`password authentication failed for ${APP_DATABASE_URL}`);
    }
    return successfulProbeResult(text, values);
  });

  let failure;
  try {
    await verifyPostgresRuntime(client, {
      ...resolveRuntimeVerificationConfig(runtimeEnv()),
      probeId: PROBE_ID,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof RuntimePostgresVerificationError);
  assert.equal(formatRuntimeVerificationError(failure), 'PostgreSQL runtime DML verification failed.');
  assert.doesNotMatch(failure.message, /runtime-secret|postgresql:\/\//i);
  assert.doesNotMatch(formatRuntimeVerificationError(new Error(APP_DATABASE_URL)), /runtime-secret|postgresql:\/\//i);
  assert.match(client.calls.at(-1).text, /^rollback$/i);
});

function fakeRuntimeClient(handler) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      return await handler(text, values);
    },
  };
}

function successfulProbeResult(text, values) {
  if (/as blob_count/i.test(text)) {
    return {
      rows: [{
        blob_count: 0,
        asset_count: 0,
        maic_course_count: 0,
        maic_session_count: 0,
      }],
      rowCount: 1,
    };
  }
  if (/pg_catalog\.pg_roles/i.test(text)) {
    return {
      rows: [{ current_user: 'rag_app', server_version_num: 170006, can_login: true }],
      rowCount: 1,
    };
  }
  if (/from public\.tenants/i.test(text)) {
    return {
      rows: [{
        tenant_id: 'songuu-production',
        corpus_id: 'default',
        corpus_tenant_id: 'songuu-production',
      }],
      rowCount: 1,
    };
  }
  if (/insert into public\.object_blobs/i.test(text)) {
    return {
      rows: [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        filename: values[2],
        kind: 'artifact',
        content_type: 'application/octet-stream',
        byte_size: values[3].length,
        metadata: JSON.parse(values[5]),
      }],
      rowCount: 1,
    };
  }
  if (/select[\s\S]+from public\.object_blobs/i.test(text)) {
    return {
      rows: [{
        filename: values[2],
        kind: 'artifact',
        data: Buffer.from(`runtime-postgres-verification:${PROBE_ID}`, 'utf8'),
        content_type: /verified_content_type/i.test(text)
          ? 'application/x-rag-runtime-probe'
          : 'application/octet-stream',
        byte_size: Buffer.byteLength(`runtime-postgres-verification:${PROBE_ID}`),
        metadata: { runtime_verification: { probe_id: PROBE_ID, state: 'inserted' } },
      }],
      rowCount: 1,
    };
  }
  if (/insert into public\.document_assets/i.test(text)) {
    return {
      rows: [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        external_document_id: values[2],
        original_name: values[3],
        content_type: values[4],
        byte_size: values[5],
        source_hash: values[6],
        raw_blob_filename: values[7],
        metadata: JSON.parse(values[8]),
      }],
      rowCount: 1,
    };
  }
  if (/select[\s\S]+from public\.document_assets/i.test(text)) {
    return {
      rows: [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        external_document_id: values[2],
        original_name: `runtime-probe-${PROBE_ID}.bin`,
        content_type: 'application/octet-stream',
        byte_size: Buffer.byteLength(`runtime-postgres-verification:${PROBE_ID}`),
        source_hash: `runtime-probe:${PROBE_ID}`,
        raw_blob_filename: `runtime-probe-${PROBE_ID}.bin`,
        metadata: { runtime_verification: { probe_id: PROBE_ID, state: 'inserted' } },
      }],
      rowCount: 1,
    };
  }
  if (/update public\.object_blobs/i.test(text)) {
    return {
      rows: [{
        filename: values[2],
        content_type: 'application/x-rag-runtime-probe',
        metadata: JSON.parse(values[3]),
      }],
      rowCount: 1,
    };
  }
  if (/update public\.document_assets/i.test(text)) {
    return {
      rows: [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        original_name: values[3],
        metadata: JSON.parse(values[4]),
      }],
      rowCount: 1,
    };
  }
  if (/delete from public\.document_assets/i.test(text)) {
    return { rows: [{ id: values[2] }], rowCount: 1 };
  }
  if (/delete from public\.object_blobs/i.test(text)) {
    return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 };
  }
  if (/insert into public\.maic_courses/i.test(text)) {
    return {
      rows: [{ course_id: values[2], status: 'uploaded', version: 1 }],
      rowCount: 1,
    };
  }
  if (/select[\s\S]+from public\.maic_courses/i.test(text)) {
    return {
      rows: [{ course_id: values[2], status: 'uploaded', version: 1 }],
      rowCount: 1,
    };
  }
  if (/update public\.maic_courses/i.test(text)) {
    return {
      rows: [{ course_id: values[2], status: 'preparing', version: 2 }],
      rowCount: 1,
    };
  }
  if (/insert into public\.maic_classroom_sessions/i.test(text)) {
    return {
      rows: [{ session_id: values[3], status: 'idle', version: 1 }],
      rowCount: 1,
    };
  }
  if (/select[\s\S]+from public\.maic_classroom_sessions/i.test(text)) {
    return {
      rows: [{ session_id: values[2], status: 'idle', version: 1 }],
      rowCount: 1,
    };
  }
  if (/update public\.maic_classroom_sessions/i.test(text)) {
    return {
      rows: [{ session_id: values[2], status: 'ended', version: 2 }],
      rowCount: 1,
    };
  }
  if (/delete from public\.maic_classroom_sessions/i.test(text)) {
    return { rows: [{ id: values[2] }], rowCount: 1 };
  }
  if (/delete from public\.maic_courses/i.test(text)) {
    return { rows: [{ id: values[2] }], rowCount: 1 };
  }
  if (/^begin\b|^rollback$|^set local/i.test(text)) {
    return { rows: [], rowCount: 0 };
  }
  throw new Error(`Unexpected SQL in fake client: ${text}`);
}
