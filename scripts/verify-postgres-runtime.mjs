import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SAFE_ROLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SAFE_SCOPE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROBE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_17_MINIMUM = 170000;
const POSTGRES_18_MINIMUM = 180000;
const TLS_QUERY_PARAMETERS = new Set([
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
]);

export class RuntimePostgresVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimePostgresVerificationError';
  }
}

export function resolveRuntimeVerificationConfig(env = process.env) {
  const databaseUrlAlias = readEnv(env, 'DATABASE_URL');
  const postgresUrl = readEnv(env, 'POSTGRES_URL');
  if (databaseUrlAlias && postgresUrl && databaseUrlAlias !== postgresUrl) {
    throw new RuntimePostgresVerificationError(
      'DATABASE_URL and POSTGRES_URL must match when both are configured.'
    );
  }

  const databaseUrl = postgresUrl || databaseUrlAlias;
  const variableName = postgresUrl ? 'POSTGRES_URL' : 'DATABASE_URL';
  if (!databaseUrl) {
    throw new RuntimePostgresVerificationError(
      'POSTGRES_URL or DATABASE_URL is required for runtime verification.'
    );
  }
  const parsedDatabaseUrl = parseRuntimeDatabaseUrl(databaseUrl, variableName);

  const expectedRole = readEnv(env, 'POSTGRES_APP_ROLE');
  if (!expectedRole) {
    throw new RuntimePostgresVerificationError(
      'POSTGRES_APP_ROLE is required for runtime verification.'
    );
  }
  if (!SAFE_ROLE_IDENTIFIER.test(expectedRole)) {
    throw new RuntimePostgresVerificationError(
      'POSTGRES_APP_ROLE must be a valid PostgreSQL identifier.'
    );
  }

  let urlRole;
  try {
    urlRole = decodeURIComponent(parsedDatabaseUrl.username);
  } catch {
    throw new RuntimePostgresVerificationError(
      `${variableName} must contain valid application credentials.`
    );
  }
  if (urlRole !== expectedRole) {
    throw new RuntimePostgresVerificationError(
      `${variableName} must authenticate as POSTGRES_APP_ROLE.`
    );
  }

  const tenantId = readRequiredScope(env, 'RAG_DEFAULT_TENANT_ID');
  const corpusId = readRequiredScope(env, 'RAG_DEFAULT_CORPUS_ID');

  return {
    databaseUrl,
    expectedRole,
    tenantId,
    corpusId,
    ssl: resolveSsl(env),
  };
}

export async function verifyPostgresRuntime(client, config) {
  const probeId = config?.probeId || randomUUID();
  if (!SAFE_PROBE_ID.test(probeId)) {
    throw new RuntimePostgresVerificationError('PostgreSQL runtime probe identifier is invalid.');
  }

  let transactionOpen = false;
  try {
    await safeQuery(
      client,
      'begin isolation level read committed read write',
      [],
      'PostgreSQL runtime transaction could not be started.'
    );
    transactionOpen = true;
    await safeQuery(
      client,
      "set local statement_timeout = '15s'",
      [],
      'PostgreSQL runtime transaction limits could not be applied.'
    );
    await safeQuery(
      client,
      "set local lock_timeout = '5s'",
      [],
      'PostgreSQL runtime transaction limits could not be applied.'
    );

    const identity = await safeQuery(
      client,
      `select
         current_user as current_user,
         current_setting('server_version_num')::integer as server_version_num,
         role.rolcanlogin as can_login
       from pg_catalog.pg_roles role
       where role.rolname = current_user`,
      [],
      'PostgreSQL runtime identity could not be verified.'
    );
    assertRuntimeIdentity(identity.rows[0], config.expectedRole);

    const scope = await safeQuery(
      client,
      `select
         tenant.id as tenant_id,
         corpus.id as corpus_id,
         corpus.tenant_id as corpus_tenant_id
       from public.tenants tenant
       join public.corpora corpus
         on corpus.tenant_id = tenant.id
       where tenant.id = $1 and corpus.id = $2`,
      [config.tenantId, config.corpusId],
      'PostgreSQL default tenant and corpus could not be read.'
    );
    assertDefaultScope(scope.rows[0], config);

    await verifyTransactionalDml(client, config, probeId);
    await verifyMaicTransactionalDml(client, config, probeId);

    await safeQuery(
      client,
      'rollback',
      [],
      'PostgreSQL runtime verification transaction could not be rolled back.'
    );
    transactionOpen = false;

    const residue = await safeQuery(
      client,
      `select
         (select count(*)::integer
          from public.object_blobs
          where tenant_id = $1 and corpus_id = $2 and filename = $3) as blob_count,
         (select count(*)::integer
           from public.document_assets
          where tenant_id = $1 and corpus_id = $2 and external_document_id = $4) as asset_count,
         (select count(*)::integer
          from public.maic_courses
          where tenant_id = $1 and corpus_id = $2 and course_id = $5) as maic_course_count,
         (select count(*)::integer
          from public.maic_classroom_sessions
          where tenant_id = $1 and corpus_id = $2 and session_id = $6) as maic_session_count`,
      [
        config.tenantId,
        config.corpusId,
        `runtime-probe-${probeId}.bin`,
        `runtime-probe:${probeId}`,
        `runtime-probe-course:${probeId}`,
        `runtime-probe-session:${probeId}`,
      ],
      'PostgreSQL runtime rollback could not be verified.'
    );
    if (
      Number(residue.rows[0]?.blob_count) !== 0
      || Number(residue.rows[0]?.asset_count) !== 0
      || Number(residue.rows[0]?.maic_course_count) !== 0
      || Number(residue.rows[0]?.maic_session_count) !== 0
    ) {
      throw new RuntimePostgresVerificationError(
        'PostgreSQL runtime probe left rows after rollback.'
      );
    }

    return {
      role: config.expectedRole,
      postgresMajor: 17,
      scopeVerified: true,
      transactionalDmlVerified: true,
    };
  } catch (error) {
    if (transactionOpen) {
      // Never commit probe data. Preserve the first safe error if the connection
      // is already broken and the best-effort rollback also fails.
      await client.query('rollback').catch(() => {});
    }
    if (error instanceof RuntimePostgresVerificationError) throw error;
    throw new RuntimePostgresVerificationError('PostgreSQL runtime verification failed.');
  }
}

async function verifyMaicTransactionalDml(client, config, probeId) {
  const courseId = `runtime-probe-course:${probeId}`;
  const sessionId = `runtime-probe-session:${probeId}`;
  const coursePayload = JSON.stringify({
    course_id: courseId,
    title: 'PostgreSQL runtime verification',
    source_filename: 'runtime-probe.txt',
    source_text: '',
    status: 'uploaded',
  });
  const sessionPayload = JSON.stringify({
    session_id: sessionId,
    course_id: courseId,
    state: {
      P_t: 0,
      H_t: [],
      R: [],
      mode: 'continuous',
      status: 'idle',
      script_cursor: 0,
    },
  });

  const values = [config.tenantId, config.corpusId];
  try {
    const insertedCourse = await safeQuery(
      client,
      `insert into public.maic_courses (
         tenant_id, corpus_id, course_id, payload
       ) values ($1, $2, $3, $4::jsonb)
       returning course_id, payload->>'status' as status, version::integer`,
      [...values, courseId, coursePayload],
      'PostgreSQL MAIC runtime DML verification failed.'
    );
    assertMaicRow(insertedCourse.rows[0], courseId, 'uploaded', 1);

    const selectedCourse = await safeQuery(
      client,
      `select course_id, payload->>'status' as status, version::integer
       from public.maic_courses
       where tenant_id = $1 and corpus_id = $2 and course_id = $3`,
      [...values, courseId],
      'PostgreSQL MAIC runtime DML verification failed.'
    );
    assertMaicRow(selectedCourse.rows[0], courseId, 'uploaded', 1);

    const updatedCourse = await safeQuery(
      client,
      `update public.maic_courses
       set payload = jsonb_set(payload, '{status}', '"preparing"'::jsonb),
           version = version + 1
       where tenant_id = $1 and corpus_id = $2 and course_id = $3
       returning course_id, payload->>'status' as status, version::integer`,
      [...values, courseId],
      'PostgreSQL MAIC runtime DML verification failed.'
    );
    assertMaicRow(updatedCourse.rows[0], courseId, 'preparing', 2);

    const insertedSession = await safeQuery(
      client,
      `insert into public.maic_classroom_sessions (
         tenant_id, corpus_id, course_id, session_id, payload
       ) values ($1, $2, $3, $4, $5::jsonb)
       returning session_id, payload #>> '{state,status}' as status, version::integer`,
      [...values, courseId, sessionId, sessionPayload],
      'PostgreSQL MAIC runtime DML verification failed.'
    );
    assertMaicRow(insertedSession.rows[0], sessionId, 'idle', 1);

    const selectedSession = await safeQuery(
      client,
      `select session_id, payload #>> '{state,status}' as status, version::integer
       from public.maic_classroom_sessions
       where tenant_id = $1 and corpus_id = $2 and session_id = $3`,
      [...values, sessionId],
      'PostgreSQL MAIC runtime DML verification failed.'
    );
    assertMaicRow(selectedSession.rows[0], sessionId, 'idle', 1);

    const updatedSession = await safeQuery(
      client,
      `update public.maic_classroom_sessions
       set payload = jsonb_set(payload, '{state,status}', '"ended"'::jsonb),
           version = version + 1
       where tenant_id = $1 and corpus_id = $2 and session_id = $3
       returning session_id, payload #>> '{state,status}' as status, version::integer`,
      [...values, sessionId],
      'PostgreSQL MAIC runtime DML verification failed.'
    );
    assertMaicRow(updatedSession.rows[0], sessionId, 'ended', 2);

    const deletedSession = await safeQuery(
      client,
      `delete from public.maic_classroom_sessions
       where tenant_id = $1 and corpus_id = $2 and session_id = $3
       returning session_id as id`,
      [...values, sessionId],
      'PostgreSQL MAIC runtime DML verification failed.'
    );
    assertDeletedRow(deletedSession.rows[0], sessionId);

    const deletedCourse = await safeQuery(
      client,
      `delete from public.maic_courses
       where tenant_id = $1 and corpus_id = $2 and course_id = $3
       returning course_id as id`,
      [...values, courseId],
      'PostgreSQL MAIC runtime DML verification failed.'
    );
    assertDeletedRow(deletedCourse.rows[0], courseId);
  } catch (error) {
    if (error instanceof RuntimePostgresVerificationError) throw error;
    throw new RuntimePostgresVerificationError(
      'PostgreSQL MAIC runtime DML verification failed.'
    );
  }
}

function assertMaicRow(row, expectedId, expectedStatus, expectedVersion) {
  const actualId = row?.course_id ?? row?.session_id;
  if (
    actualId !== expectedId
    || row?.status !== expectedStatus
    || Number(row?.version) !== expectedVersion
  ) {
    throw new RuntimePostgresVerificationError(
      'PostgreSQL MAIC runtime DML verification failed.'
    );
  }
}

export function formatRuntimeVerificationError(error) {
  if (error instanceof RuntimePostgresVerificationError) return error.message;
  return 'PostgreSQL runtime verification failed.';
}

async function verifyTransactionalDml(client, config, probeId) {
  const filename = `runtime-probe-${probeId}.bin`;
  const externalDocumentId = `runtime-probe:${probeId}`;
  const sourceHash = `runtime-probe:${probeId}`;
  const payload = Buffer.from(`runtime-postgres-verification:${probeId}`, 'utf8');
  const insertedMetadata = JSON.stringify({
    runtime_verification: { probe_id: probeId, state: 'inserted' },
  });
  const updatedMetadata = JSON.stringify({
    runtime_verification: { probe_id: probeId, state: 'updated' },
  });

  try {
    const insertedBlob = await safeQuery(
      client,
      `insert into public.object_blobs (
         tenant_id, corpus_id, kind, filename, data, content_type, metadata
       ) values ($1, $2, 'artifact', $3, $4, $5, $6::jsonb)
       returning id::text, filename, kind, content_type,
                 octet_length(data)::integer as byte_size, metadata`,
      [
        config.tenantId,
        config.corpusId,
        filename,
        payload,
        'application/octet-stream',
        insertedMetadata,
      ],
      'PostgreSQL runtime DML verification failed.'
    );
    assertInsertedBlob(insertedBlob.rows[0], filename, payload.length, probeId);

    const selectedBlob = await safeQuery(
      client,
      `select filename, kind, data, content_type,
              octet_length(data)::integer as byte_size, metadata
       from public.object_blobs
       where tenant_id = $1 and corpus_id = $2 and filename = $3`,
      [config.tenantId, config.corpusId, filename],
      'PostgreSQL runtime DML verification failed.'
    );
    assertSelectedBlob(selectedBlob.rows[0], filename, payload, probeId);

    const insertedAsset = await safeQuery(
      client,
      `insert into public.document_assets (
         tenant_id, corpus_id, external_document_id, original_name,
         content_type, byte_size, source_hash, raw_blob_filename,
         parse_method, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'runtime-verification', $9::jsonb)
       returning id::text, external_document_id, original_name, content_type,
                 byte_size, source_hash, raw_blob_filename, metadata`,
      [
        config.tenantId,
        config.corpusId,
        externalDocumentId,
        filename,
        'application/octet-stream',
        payload.length,
        sourceHash,
        filename,
        insertedMetadata,
      ],
      'PostgreSQL runtime DML verification failed.'
    );
    const assetId = assertInsertedAsset(
      insertedAsset.rows[0],
      { externalDocumentId, filename, sourceHash, byteSize: payload.length, probeId }
    );

    const selectedAsset = await safeQuery(
      client,
      `select id::text, external_document_id, original_name, content_type,
              byte_size, source_hash, raw_blob_filename, metadata
       from public.document_assets
       where tenant_id = $1 and corpus_id = $2 and external_document_id = $3`,
      [config.tenantId, config.corpusId, externalDocumentId],
      'PostgreSQL runtime DML verification failed.'
    );
    assertSelectedAsset(
      selectedAsset.rows[0],
      { assetId, externalDocumentId, filename, sourceHash, byteSize: payload.length, probeId }
    );

    const updatedBlob = await safeQuery(
      client,
      `update public.object_blobs
       set content_type = 'application/x-rag-runtime-probe', metadata = $4::jsonb
       where tenant_id = $1 and corpus_id = $2 and filename = $3
       returning filename, content_type, metadata`,
      [config.tenantId, config.corpusId, filename, updatedMetadata],
      'PostgreSQL runtime DML verification failed.'
    );
    assertUpdatedBlob(updatedBlob.rows[0], filename, probeId);

    const verifiedName = `runtime-probe-${probeId}.verified.bin`;
    const updatedAsset = await safeQuery(
      client,
      `update public.document_assets
       set original_name = $4, metadata = $5::jsonb
       where tenant_id = $1 and corpus_id = $2 and external_document_id = $3
       returning id::text, original_name, metadata`,
      [config.tenantId, config.corpusId, externalDocumentId, verifiedName, updatedMetadata],
      'PostgreSQL runtime DML verification failed.'
    );
    assertUpdatedAsset(updatedAsset.rows[0], assetId, verifiedName, probeId);

    const deletedAsset = await safeQuery(
      client,
      `delete from public.document_assets
       where tenant_id = $1 and corpus_id = $2 and id = $3::uuid
       returning id::text`,
      [config.tenantId, config.corpusId, assetId],
      'PostgreSQL runtime DML verification failed.'
    );
    assertDeletedRow(deletedAsset.rows[0], assetId);

    const deletedBlob = await safeQuery(
      client,
      `delete from public.object_blobs
       where tenant_id = $1 and corpus_id = $2 and filename = $3
       returning id::text`,
      [config.tenantId, config.corpusId, filename],
      'PostgreSQL runtime DML verification failed.'
    );
    assertDeletedRow(deletedBlob.rows[0]);
  } catch (error) {
    if (error instanceof RuntimePostgresVerificationError) throw error;
    throw new RuntimePostgresVerificationError('PostgreSQL runtime DML verification failed.');
  }
}

function parseRuntimeDatabaseUrl(databaseUrl, variableName) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new RuntimePostgresVerificationError(
      `${variableName} must be a valid PostgreSQL connection URL.`
    );
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
    || !parsed.hostname
    || !parsed.username
    || !parsed.password
    || !parsed.pathname
    || parsed.pathname === '/'
  ) {
    throw new RuntimePostgresVerificationError(
      `${variableName} must contain a PostgreSQL host, database, and application credentials.`
    );
  }

  for (const name of parsed.searchParams.keys()) {
    const normalized = name.toLowerCase();
    if (TLS_QUERY_PARAMETERS.has(normalized)) {
      throw new RuntimePostgresVerificationError(
        `${variableName} must not contain ${normalized}; configure TLS with POSTGRES_SSL_MODE and NODE_EXTRA_CA_CERTS.`
      );
    }
  }
  return parsed;
}

function resolveSsl(env) {
  const mode = readEnv(env, 'POSTGRES_SSL_MODE').toLowerCase();
  if (!mode || mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  throw new RuntimePostgresVerificationError(
    'POSTGRES_SSL_MODE must be disable, require, or verify-full.'
  );
}

function readRequiredScope(env, name) {
  const value = readEnv(env, name);
  if (!value) {
    throw new RuntimePostgresVerificationError(`${name} is required for runtime verification.`);
  }
  if (!SAFE_SCOPE_IDENTIFIER.test(value)) {
    throw new RuntimePostgresVerificationError(`${name} must be a valid scope identifier.`);
  }
  return value;
}

function assertRuntimeIdentity(row, expectedRole) {
  if (row?.current_user !== expectedRole) {
    throw new RuntimePostgresVerificationError(
      'Connected PostgreSQL role does not match POSTGRES_APP_ROLE.'
    );
  }
  if (row?.can_login !== true) {
    throw new RuntimePostgresVerificationError('POSTGRES_APP_ROLE must be a LOGIN role.');
  }
  const serverVersionNumber = Number(row?.server_version_num);
  if (
    !Number.isInteger(serverVersionNumber)
    || serverVersionNumber < POSTGRES_17_MINIMUM
    || serverVersionNumber >= POSTGRES_18_MINIMUM
  ) {
    throw new RuntimePostgresVerificationError('PostgreSQL 17 is required for RAG persistence.');
  }
}

function assertDefaultScope(row, config) {
  if (
    row?.tenant_id !== config.tenantId
    || row?.corpus_id !== config.corpusId
    || row?.corpus_tenant_id !== config.tenantId
  ) {
    throw new RuntimePostgresVerificationError(
      'PostgreSQL default tenant and corpus are not available.'
    );
  }
}

function assertInsertedBlob(row, filename, byteSize, probeId) {
  if (
    !isUuid(row?.id)
    || row?.filename !== filename
    || row?.kind !== 'artifact'
    || row?.content_type !== 'application/octet-stream'
    || Number(row?.byte_size) !== byteSize
    || !hasProbeState(row?.metadata, probeId, 'inserted')
  ) {
    throw new RuntimePostgresVerificationError('PostgreSQL runtime DML verification failed.');
  }
}

function assertSelectedBlob(row, filename, payload, probeId) {
  if (
    row?.filename !== filename
    || row?.kind !== 'artifact'
    || !Buffer.isBuffer(row?.data)
    || !row.data.equals(payload)
    || row?.content_type !== 'application/octet-stream'
    || Number(row?.byte_size) !== payload.length
    || !hasProbeState(row?.metadata, probeId, 'inserted')
  ) {
    throw new RuntimePostgresVerificationError('PostgreSQL runtime DML verification failed.');
  }
}

function assertInsertedAsset(row, expected) {
  if (
    !isUuid(row?.id)
    || row?.external_document_id !== expected.externalDocumentId
    || row?.original_name !== expected.filename
    || row?.content_type !== 'application/octet-stream'
    || Number(row?.byte_size) !== expected.byteSize
    || row?.source_hash !== expected.sourceHash
    || row?.raw_blob_filename !== expected.filename
    || !hasProbeState(row?.metadata, expected.probeId, 'inserted')
  ) {
    throw new RuntimePostgresVerificationError('PostgreSQL runtime DML verification failed.');
  }
  return row.id;
}

function assertSelectedAsset(row, expected) {
  if (
    row?.id !== expected.assetId
    || row?.external_document_id !== expected.externalDocumentId
    || row?.original_name !== expected.filename
    || row?.content_type !== 'application/octet-stream'
    || Number(row?.byte_size) !== expected.byteSize
    || row?.source_hash !== expected.sourceHash
    || row?.raw_blob_filename !== expected.filename
    || !hasProbeState(row?.metadata, expected.probeId, 'inserted')
  ) {
    throw new RuntimePostgresVerificationError('PostgreSQL runtime DML verification failed.');
  }
}

function assertUpdatedBlob(row, filename, probeId) {
  if (
    row?.filename !== filename
    || row?.content_type !== 'application/x-rag-runtime-probe'
    || !hasProbeState(row?.metadata, probeId, 'updated')
  ) {
    throw new RuntimePostgresVerificationError('PostgreSQL runtime DML verification failed.');
  }
}

function assertUpdatedAsset(row, assetId, verifiedName, probeId) {
  if (
    row?.id !== assetId
    || row?.original_name !== verifiedName
    || !hasProbeState(row?.metadata, probeId, 'updated')
  ) {
    throw new RuntimePostgresVerificationError('PostgreSQL runtime DML verification failed.');
  }
}

function assertDeletedRow(row, expectedId) {
  if (!row?.id || (expectedId && row.id !== expectedId)) {
    throw new RuntimePostgresVerificationError('PostgreSQL runtime DML verification failed.');
  }
}

function hasProbeState(metadata, probeId, state) {
  return metadata?.runtime_verification?.probe_id === probeId
    && metadata.runtime_verification.state === state;
}

function isUuid(value) {
  return typeof value === 'string' && SAFE_PROBE_ID.test(value);
}

async function safeQuery(client, text, values, failureMessage) {
  try {
    return await client.query(text, values);
  } catch {
    // PostgreSQL errors can echo connection details or parameter values.
    throw new RuntimePostgresVerificationError(failureMessage);
  }
}

function readEnv(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

async function main() {
  const config = resolveRuntimeVerificationConfig(process.env);
  const pgModule = await import('pg');
  const Client = pgModule.Client ?? pgModule.default?.Client;
  if (!Client) {
    throw new RuntimePostgresVerificationError('PostgreSQL driver is unavailable.');
  }

  const client = new Client({
    connectionString: config.databaseUrl,
    application_name: 'rag-system-runtime-verifier',
    connectionTimeoutMillis: 10_000,
    ssl: config.ssl,
  });
  try {
    await client.connect();
    await verifyPostgresRuntime(client, config);
    console.log(
      '[verify:postgres-runtime] app role, PostgreSQL 17, default scope, and rollback-only persistence/MAIC DML verified'
    );
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`[verify:postgres-runtime] ${formatRuntimeVerificationError(error)}`);
    process.exitCode = 1;
  });
}
