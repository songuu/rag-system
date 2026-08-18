import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;

class PublicPostgresVerificationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PublicPostgresVerificationError';
  }
}

class PlaintextAcceptedError extends Error {}
class RestrictedRoleAcceptedError extends Error {}

function isExpectedPlaintextRejection(error) {
  return error instanceof Error && error.code === '28000';
}

function requireExact(env, key, expected) {
  const value = env[key];
  if (value !== expected) {
    throw new PublicPostgresVerificationError(`${key} must be ${expected}.`);
  }
  return value;
}

function requireSafeValue(env, key, maxLength = 512) {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PublicPostgresVerificationError(`${key} is required.`);
  }
  if (value.length > maxLength || /[\0\r\n]/u.test(value)) {
    throw new PublicPostgresVerificationError(`${key} is invalid.`);
  }
  return value;
}

function loadCaCertificate(env) {
  const caFile = requireSafeValue(env, 'PGSSLROOTCERT', 4096);
  if (!path.isAbsolute(caFile)) {
    throw new PublicPostgresVerificationError('PGSSLROOTCERT must be an absolute path.');
  }

  let metadata;
  try {
    metadata = lstatSync(caFile);
  } catch {
    throw new PublicPostgresVerificationError('PGSSLROOTCERT is not readable.');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 64 * 1024) {
    throw new PublicPostgresVerificationError('PGSSLROOTCERT must be a bounded regular file.');
  }

  try {
    return readFileSync(caFile, 'utf8');
  } catch {
    throw new PublicPostgresVerificationError('PGSSLROOTCERT is not readable.');
  }
}

function resolveConfig(env) {
  const verificationPhase = env.POSTGRES_PUBLIC_VERIFY_PHASE || 'full';
  if (verificationPhase !== 'network' && verificationPhase !== 'full') {
    throw new PublicPostgresVerificationError(
      'POSTGRES_PUBLIC_VERIFY_PHASE must be network or full.'
    );
  }
  const expectedHost = requireSafeValue(env, 'POSTGRES_PUBLIC_EXPECTED_HOST', 253);
  const host = requireSafeValue(env, 'PGHOST', 253);
  if (host !== expectedHost) {
    throw new PublicPostgresVerificationError('PGHOST must match POSTGRES_PUBLIC_EXPECTED_HOST.');
  }

  requireExact(env, 'PGPORT', '25432');
  requireExact(env, 'PGDATABASE', 'rag_system');
  requireExact(env, 'PGUSER', 'rag_app');
  requireExact(env, 'PGSSLMODE', 'verify-full');
  const password = requireSafeValue(env, 'PGPASSWORD');
  const ca = loadCaCertificate(env);

  return {
    verificationPhase,
    clientConfig: {
      host,
      port: 25432,
      database: 'rag_system',
      user: 'rag_app',
      password,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      application_name: 'rag-public-postgres-verifier',
      ssl: {
        ca,
        rejectUnauthorized: true,
        checkServerIdentity(_servername, certificate) {
          return checkServerIdentity(expectedHost, certificate);
        },
      },
    },
  };
}

function assertTlsResult(result, verificationPhase) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
    throw new Error('unexpected verification row count');
  }
  const row = result.rows[0];
  if (row.current_user !== 'rag_app'
    || row.current_database !== 'rag_system'
    || row.ssl !== true
    || row.tls_version !== 'TLSv1.3'
    || !Number.isInteger(row.server_version_num)
    || row.server_version_num < 170_000
    || row.server_version_num >= 180_000
    || row.restricted_role !== true
    || row.no_role_memberships !== true
    || (verificationPhase === 'full' && (
      row.operational_dml !== true || row.parent_write_denied !== true
    ))) {
    throw new Error('public PostgreSQL contract mismatch');
  }
}

function buildVerificationQuery(verificationPhase) {
  const fullSchemaFields = verificationPhase === 'full'
    ? `,
        has_table_privilege(current_user, 'public.object_blobs', 'SELECT')
          AND has_table_privilege(current_user, 'public.object_blobs', 'INSERT')
          AND has_table_privilege(current_user, 'public.object_blobs', 'UPDATE')
          AND has_table_privilege(current_user, 'public.object_blobs', 'DELETE')
          AND has_table_privilege(current_user, 'public.document_assets', 'SELECT')
          AND has_table_privilege(current_user, 'public.document_assets', 'INSERT')
          AND has_table_privilege(current_user, 'public.document_assets', 'UPDATE')
          AND has_table_privilege(current_user, 'public.document_assets', 'DELETE')
          AS operational_dml,
        NOT has_table_privilege(current_user, 'public.tenants', 'UPDATE,DELETE')
          AND NOT has_table_privilege(current_user, 'public.corpora', 'UPDATE,DELETE')
          AS parent_write_denied`
    : '';
  return `
      SELECT
        current_user,
        current_database(),
        current_setting('server_version_num')::integer AS server_version_num,
        ssl,
        version AS tls_version,
        rolcanlogin
          AND NOT rolsuper
          AND NOT rolcreatedb
          AND NOT rolcreaterole
          AND NOT rolreplication
          AND NOT rolbypassrls
          AS restricted_role,
        NOT EXISTS (
          SELECT 1
          FROM pg_auth_members membership
          WHERE membership.member = pg_roles.oid
        ) AS no_role_memberships
        ${fullSchemaFields}
      FROM pg_stat_ssl
      JOIN pg_roles ON rolname = current_user
      WHERE pid = pg_backend_pid()
    `;
}

async function closeClient(client) {
  try {
    await client.end();
  } catch {
    // Verification already has a definitive result; cleanup must not leak details.
  }
}

async function assertRestrictedRoleRejected(createClient, config, role) {
  const client = createClient({
    ...config,
    user: role,
    password: randomBytes(32).toString('hex'),
    application_name: `rag-public-${role}-rejection-verifier`,
  });
  try {
    await client.connect();
    throw new RestrictedRoleAcceptedError();
  } catch (error) {
    if (error instanceof RestrictedRoleAcceptedError) {
      throw new PublicPostgresVerificationError(
        'Public PostgreSQL unexpectedly allowed a restricted role through its network policy.'
      );
    }
    if (!isExpectedPlaintextRejection(error)) {
      throw new PublicPostgresVerificationError(
        'Public PostgreSQL restricted-role rejection verification was inconclusive.'
      );
    }
  } finally {
    await closeClient(client);
  }
}

export async function verifyPublicPostgres(env = process.env, dependencies = {}) {
  const createClient = dependencies.createClient ?? (config => new Client(config));
  const writeOutput = dependencies.writeOutput ?? (value => process.stdout.write(`${value}\n`));
  const { clientConfig, verificationPhase } = resolveConfig(env);

  const tlsClient = createClient(clientConfig);
  try {
    await tlsClient.connect();
    const result = await tlsClient.query(buildVerificationQuery(verificationPhase));
    assertTlsResult(result, verificationPhase);
  } catch (error) {
    throw new PublicPostgresVerificationError(
      'Public PostgreSQL TLS verification failed.',
      { cause: error }
    );
  } finally {
    await closeClient(tlsClient);
  }

  const plaintextClient = createClient({ ...clientConfig, ssl: false });
  try {
    await plaintextClient.connect();
    await plaintextClient.query('SELECT 1');
    throw new PlaintextAcceptedError();
  } catch (error) {
    if (error instanceof PlaintextAcceptedError) {
      throw new PublicPostgresVerificationError(
        'Public PostgreSQL unexpectedly accepted a plaintext connection.'
      );
    }
    if (!isExpectedPlaintextRejection(error)) {
      throw new PublicPostgresVerificationError(
        'Public PostgreSQL plaintext-rejection verification was inconclusive.'
      );
    }
    // SQLSTATE 28000 proves PostgreSQL itself rejected the non-TLS connection.
  } finally {
    await closeClient(plaintextClient);
  }

  await assertRestrictedRoleRejected(createClient, clientConfig, 'rag_owner');
  await assertRestrictedRoleRejected(createClient, clientConfig, 'postgres');

  writeOutput(
    `Public PostgreSQL ${verificationPhase} TLS, plaintext rejection, and role isolation verification passed.`
  );
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  verifyPublicPostgres().catch(error => {
    const message = error instanceof PublicPostgresVerificationError
      ? error.message
      : 'Public PostgreSQL verification failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
