import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDatabaseUrlHasNoSslParameters,
  resolveMigrationDatabaseUrl,
} from './migrate-postgres.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class LocalBackfillError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalBackfillError';
  }
}

export async function buildLocalBackfillPlan(sourceRoots) {
  const roots = [...new Set(sourceRoots)].sort();
  const documents = new Map();
  const blobs = new Map();
  const sources = [];

  for (const configuredRoot of roots) {
    const root = await validateSourceRoot(configuredRoot);
    if (!root) continue;
    const manifestPath = path.join(root, 'file-manifest.json');
    const manifestStat = await safeLstat(manifestPath);
    if (!manifestStat) continue;
    assertRegularNonSymlink(manifestStat, 'Local backfill manifest');
    if (manifestStat.size > MAX_BLOB_BYTES) {
      throw new LocalBackfillError('Local backfill manifest exceeds the 10 MB safety limit.');
    }
    const manifestBytes = await readFile(manifestPath);
    const manifestDigest = sha256(manifestBytes);
    const parsed = parseManifest(manifestBytes);
    sources.push({ root, manifestPath, manifestDigest });

    for (const [key, item] of Object.entries(parsed)) {
      const document = validateManifestItem(key, item);
      const itemBlobs = await loadItemBlobs(document, root, manifestDigest);
      mergeDocument(documents, document);
      for (const blob of itemBlobs) mergeBlob(blobs, blob);
    }
  }

  const plan = {
    sources: sources.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath)),
    documents: [...documents.values()].sort((left, right) => left.id.localeCompare(right.id)),
    blobs: [...blobs.values()].sort((left, right) => left.filename.localeCompare(right.filename)),
  };
  return { ...plan, hash: hashPlan(plan) };
}

export async function inspectLocalBackfill(client, plan, scope) {
  assertScope(scope);
  const receipt = await readBackfillReceipt(client, scope);
  if (receipt && !receiptMatches(receipt, plan)) {
    throw new LocalBackfillError('PostgreSQL contains a conflicting local-backfill receipt.');
  }
  const rows = await inspectPlanRows(client, plan, scope);
  if (receipt) return { ...rows, receipt: true };
  if (rows.complete && (plan.documents.length > 0 || plan.blobs.length > 0)) {
    return { ...rows, complete: false, needsReceipt: true };
  }
  return rows;
}

async function inspectPlanRows(client, plan, scope) {
  await assertScopeExists(client, scope);
  let missing = 0;

  for (const blob of plan.blobs) {
    const result = await client.query(
      `select kind, data, content_type
       from public.object_blobs
       where tenant_id = $1 and corpus_id = $2 and filename = $3`,
      [scope.tenantId, scope.corpusId, blob.filename]
    );
    const row = result.rows[0];
    if (!row) {
      missing += 1;
      continue;
    }
    const digest = sha256(Buffer.from(row.data));
    if (row.kind !== blob.kind || row.content_type !== blob.contentType || digest !== blob.sha256) {
      throw new LocalBackfillError('PostgreSQL contains a conflicting local-backfill blob.');
    }
  }

  for (const document of plan.documents) {
    const result = await client.query(
      `select original_name, content_type, byte_size, source_hash,
              raw_blob_filename, parsed_blob_filename, parse_method, metadata
       from public.document_assets
       where tenant_id = $1 and corpus_id = $2 and external_document_id = $3`,
      [scope.tenantId, scope.corpusId, document.id]
    );
    const row = result.rows[0];
    if (!row) {
      missing += 1;
      continue;
    }
    if (!documentMatches(row, document)) {
      throw new LocalBackfillError('PostgreSQL contains a conflicting local-backfill document.');
    }
  }
  return { complete: missing === 0, missing, receipt: false };
}

export async function applyLocalBackfill(client, sourceRoots, scope) {
  const initialPlan = await buildLocalBackfillPlan(sourceRoots);
  await client.query('begin');
  try {
    await client.query(
      "select pg_advisory_xact_lock(hashtext('rag-system'), hashtext('local-postgres-backfill'))"
    );
    const receipt = await readBackfillReceipt(client, scope, true);
    if (receipt && !receiptMatches(receipt, initialPlan)) {
      throw new LocalBackfillError('PostgreSQL contains a conflicting local-backfill receipt.');
    }
    if (!receipt) {
      await insertMissingBlobs(client, initialPlan, scope);
      await insertMissingDocuments(client, initialPlan, scope);
    }

    const stablePlan = await buildLocalBackfillPlan(sourceRoots);
    if (stablePlan.hash !== initialPlan.hash) {
      throw new LocalBackfillError('Local backfill sources changed while the import was running.');
    }
    const verification = await inspectPlanRows(client, initialPlan, scope);
    if (!verification.complete) {
      throw new LocalBackfillError('PostgreSQL local backfill verification was incomplete.');
    }
    if (!receipt) await writeBackfillReceipt(client, initialPlan, scope);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error instanceof LocalBackfillError
      ? error
      : new LocalBackfillError('PostgreSQL local backfill failed.');
  }

  const finalPlan = await buildLocalBackfillPlan(sourceRoots);
  if (finalPlan.hash !== initialPlan.hash) {
    throw new LocalBackfillError('Local backfill sources changed after the import committed.');
  }
  const finalVerification = await inspectLocalBackfill(client, initialPlan, scope);
  if (!finalVerification.complete) {
    throw new LocalBackfillError('PostgreSQL local backfill readback was incomplete.');
  }
  return {
    planHash: initialPlan.hash,
    documents: initialPlan.documents.length,
    blobs: initialPlan.blobs.length,
    bytes: initialPlan.blobs.reduce((sum, blob) => sum + blob.byteLength, 0),
  };
}

export async function resetLocalBackfillReceipt(client, scope) {
  await client.query('begin');
  try {
    await client.query(
      "select pg_advisory_xact_lock(hashtext('rag-system'), hashtext('local-postgres-backfill'))"
    );
    await readBackfillReceipt(client, scope, true);
    const result = await client.query(
      `update public.corpora
       set metadata = metadata - 'local_postgres_backfill'
       where tenant_id = $1 and id = $2`,
      [scope.tenantId, scope.corpusId]
    );
    if (result.rowCount !== 1) {
      throw new LocalBackfillError('PostgreSQL local backfill receipt could not be reset.');
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error instanceof LocalBackfillError
      ? error
      : new LocalBackfillError('PostgreSQL local backfill receipt reset failed.');
  }
}

async function insertMissingBlobs(client, plan, scope) {
  for (const blob of plan.blobs) {
    const existing = await client.query(
      `select kind, data, content_type
       from public.object_blobs
       where tenant_id = $1 and corpus_id = $2 and filename = $3
       for update`,
      [scope.tenantId, scope.corpusId, blob.filename]
    );
    if (existing.rows[0]) {
      const digest = sha256(Buffer.from(existing.rows[0].data));
      if (
        existing.rows[0].kind !== blob.kind
        || existing.rows[0].content_type !== blob.contentType
        || digest !== blob.sha256
      ) {
        throw new LocalBackfillError('PostgreSQL contains a conflicting local-backfill blob.');
      }
      continue;
    }
    await client.query(
      `insert into public.object_blobs (
         tenant_id, corpus_id, kind, filename, data, content_type, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        scope.tenantId,
        scope.corpusId,
        blob.kind,
        blob.filename,
        blob.data,
        blob.contentType,
        JSON.stringify({
          source: 'local-backfill',
          byte_sha256: blob.sha256,
          source_manifest_sha256: blob.manifestDigest,
        }),
      ]
    );
  }
}

async function insertMissingDocuments(client, plan, scope) {
  for (const document of plan.documents) {
    const existing = await client.query(
      `select original_name, content_type, byte_size, source_hash,
              raw_blob_filename, parsed_blob_filename, parse_method, metadata
       from public.document_assets
       where tenant_id = $1 and corpus_id = $2 and external_document_id = $3
       for update`,
      [scope.tenantId, scope.corpusId, document.id]
    );
    if (existing.rows[0]) {
      if (!documentMatches(existing.rows[0], document)) {
        throw new LocalBackfillError('PostgreSQL contains a conflicting local-backfill document.');
      }
      continue;
    }
    await client.query(
      `insert into public.document_assets (
         tenant_id, corpus_id, external_document_id, original_name, content_type,
         byte_size, source_hash, raw_blob_filename, parsed_blob_filename,
         parse_method, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        scope.tenantId,
        scope.corpusId,
        document.id,
        document.originalName,
        document.contentType,
        document.size,
        document.sourceHash,
        document.storedFilename,
        document.parsedFilename || null,
        document.parseMethod,
        JSON.stringify(document.metadata),
      ]
    );
  }
}

async function assertScopeExists(client, scope) {
  assertScope(scope);
  const result = await client.query(
    `select 1
     from public.tenants tenant
     join public.corpora corpus on corpus.tenant_id = tenant.id
     where tenant.id = $1 and corpus.id = $2`,
    [scope.tenantId, scope.corpusId]
  );
  if (result.rows.length !== 1) {
    throw new LocalBackfillError('PostgreSQL default tenant/corpus scope is unavailable.');
  }
}

async function readBackfillReceipt(client, scope, forUpdate = false) {
  assertScope(scope);
  const result = await client.query(
    `select corpus.metadata->'local_postgres_backfill' as receipt
     from public.tenants tenant
     join public.corpora corpus on corpus.tenant_id = tenant.id
     where tenant.id = $1 and corpus.id = $2
     ${forUpdate ? 'for update of corpus' : ''}`,
    [scope.tenantId, scope.corpusId]
  );
  if (result.rows.length !== 1) {
    throw new LocalBackfillError('PostgreSQL default tenant/corpus scope is unavailable.');
  }
  const receipt = result.rows[0].receipt;
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : null;
}

async function writeBackfillReceipt(client, plan, scope) {
  const receipt = receiptForPlan(plan);
  const result = await client.query(
    `update public.corpora
     set metadata = jsonb_set(metadata, '{local_postgres_backfill}', $3::jsonb, true)
     where tenant_id = $1 and id = $2`,
    [scope.tenantId, scope.corpusId, JSON.stringify(receipt)]
  );
  if (result.rowCount !== 1) {
    throw new LocalBackfillError('PostgreSQL local backfill receipt could not be recorded.');
  }
}

function receiptForPlan(plan) {
  return {
    version: 1,
    plan_sha256: plan.hash,
    documents: plan.documents.length,
    blobs: plan.blobs.length,
    bytes: plan.blobs.reduce((sum, blob) => sum + blob.byteLength, 0),
  };
}

function receiptMatches(receipt, plan) {
  return receipt.version === 1
    && receipt.plan_sha256 === plan.hash
    && Number(receipt.documents) === plan.documents.length
    && Number(receipt.blobs) === plan.blobs.length
    && Number(receipt.bytes) === plan.blobs.reduce((sum, blob) => sum + blob.byteLength, 0);
}

async function validateSourceRoot(configuredRoot) {
  if (typeof configuredRoot !== 'string' || !path.isAbsolute(configuredRoot)) {
    throw new LocalBackfillError('Local backfill source roots must be absolute paths.');
  }
  const stat = await safeLstat(configuredRoot);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LocalBackfillError('Local backfill source root must be a non-symlink directory.');
  }
  const physical = await realpath(configuredRoot);
  if (physical !== path.resolve(configuredRoot)) {
    throw new LocalBackfillError('Local backfill source root must not traverse symbolic links.');
  }
  return physical;
}

function parseManifest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new LocalBackfillError('Local backfill manifest is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalBackfillError('Local backfill manifest must be a JSON object.');
  }
  return value;
}

function validateManifestItem(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalBackfillError('Local backfill manifest contains an invalid item.');
  }
  const item = value;
  const id = requiredString(item.id, 'manifest id');
  if (id !== key) throw new LocalBackfillError('Local backfill manifest key and id differ.');
  const storedFilename = safeFilename(item.storedFilename, 'stored filename');
  const parsedFilename = item.parsedFilename
    ? safeFilename(item.parsedFilename, 'parsed filename')
    : '';
  const size = nonnegativeInteger(item.size, 'manifest size');
  const contentLength = nonnegativeInteger(item.contentLength, 'manifest content length');
  if (size > MAX_BLOB_BYTES) throw new LocalBackfillError('Local backfill item exceeds 10 MB.');
  if (item.sourceHash !== undefined && !SHA256.test(item.sourceHash)) {
    throw new LocalBackfillError('Local backfill source hash is invalid.');
  }
  const metadata = {
    manifest_id: id,
    original_extension: requiredString(item.originalExtension, 'original extension'),
    content_length: contentLength,
    uploaded_at: validDate(item.uploadedAt),
    pages: item.pages === undefined ? null : nonnegativeInteger(item.pages, 'page count'),
  };
  if (item.source !== undefined) metadata.source = requiredString(item.source, 'source');
  if (item.sourceHash !== undefined) metadata.source_hash = item.sourceHash;
  return {
    id,
    originalName: requiredString(item.originalName, 'original name'),
    contentType: metadata.original_extension || 'application/octet-stream',
    size,
    contentLength,
    sourceHash: item.sourceHash ?? `${id}:${item.originalName}:${size}:${contentLength}`,
    storedFilename,
    parsedFilename,
    parseMethod: requiredString(item.parseMethod, 'parse method'),
    metadata,
  };
}

async function loadItemBlobs(document, root, manifestDigest) {
  const names = document.storedFilename === document.parsedFilename
    ? [{ filename: document.storedFilename, kind: 'parsed', contentType: 'text/plain' }]
    : [
      { filename: document.storedFilename, kind: 'raw', contentType: 'application/octet-stream' },
      ...(document.parsedFilename
        ? [{ filename: document.parsedFilename, kind: 'parsed', contentType: 'text/plain' }]
        : []),
    ];
  const blobs = [];
  for (const descriptor of names) {
    const filename = path.join(root, descriptor.filename);
    const stat = await safeLstat(filename);
    if (!stat) throw new LocalBackfillError('Local backfill manifest references a missing blob.');
    assertRegularNonSymlink(stat, 'Local backfill blob');
    if (stat.size > MAX_BLOB_BYTES) throw new LocalBackfillError('Local backfill blob exceeds 10 MB.');
    const data = await readFile(filename);
    if (descriptor.filename === document.storedFilename && data.byteLength !== document.size) {
      throw new LocalBackfillError('Local backfill manifest size does not match its stored blob.');
    }
    blobs.push({
      ...descriptor,
      data,
      byteLength: data.byteLength,
      sha256: sha256(data),
      manifestDigest,
    });
  }
  return blobs;
}

function mergeDocument(documents, document) {
  const existing = documents.get(document.id);
  if (existing && canonical(existing) !== canonical(document)) {
    throw new LocalBackfillError('Local backfill sources contain conflicting document ids.');
  }
  documents.set(document.id, document);
}

function mergeBlob(blobs, blob) {
  const existing = blobs.get(blob.filename);
  if (existing && (
    existing.kind !== blob.kind
    || existing.contentType !== blob.contentType
    || existing.sha256 !== blob.sha256
  )) {
    throw new LocalBackfillError('Local backfill sources contain conflicting blob filenames.');
  }
  blobs.set(blob.filename, blob);
}

function documentMatches(row, document) {
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata
    : {};
  return row.original_name === document.originalName
    && row.content_type === document.contentType
    && Number(row.byte_size) === document.size
    && row.source_hash === document.sourceHash
    && row.raw_blob_filename === document.storedFilename
    && (row.parsed_blob_filename ?? '') === document.parsedFilename
    && row.parse_method === document.parseMethod
    && metadata.manifest_id === document.metadata.manifest_id
    && metadata.original_extension === document.metadata.original_extension
    && Number(metadata.content_length) === document.metadata.content_length
    && metadata.uploaded_at === document.metadata.uploaded_at
    && (metadata.pages ?? null) === document.metadata.pages
    && (metadata.source ?? undefined) === (document.metadata.source ?? undefined)
    && (metadata.source_hash ?? undefined) === (document.metadata.source_hash ?? undefined);
}

function hashPlan(plan) {
  return sha256(Buffer.from(canonical({
    sources: plan.sources,
    documents: plan.documents,
    blobs: plan.blobs.map((blob) => ({
      filename: blob.filename,
      kind: blob.kind,
      contentType: blob.contentType,
      byteLength: blob.byteLength,
      sha256: blob.sha256,
      manifestDigest: blob.manifestDigest,
    })),
  })));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LocalBackfillError(`Local backfill ${label} is missing.`);
  }
  return value;
}

function safeFilename(value, label) {
  const filename = requiredString(value, label);
  if (filename !== path.basename(filename) || filename === '.' || filename === '..' || filename.includes('\\')) {
    throw new LocalBackfillError(`Local backfill ${label} is unsafe.`);
  }
  return filename;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalBackfillError(`Local backfill ${label} must be a non-negative integer.`);
  }
  return value;
}

function validDate(value) {
  const text = requiredString(value, 'upload timestamp');
  if (!Number.isFinite(Date.parse(text))) {
    throw new LocalBackfillError('Local backfill upload timestamp is invalid.');
  }
  return text;
}

function assertRegularNonSymlink(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new LocalBackfillError(`${label} must be a regular non-symlink file.`);
  }
}

function assertScope(scope) {
  if (!SAFE_SCOPE.test(scope?.tenantId || '') || !SAFE_SCOPE.test(scope?.corpusId || '')) {
    throw new LocalBackfillError('Local backfill requires valid tenant and corpus scope.');
  }
}

async function safeLstat(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new LocalBackfillError('Local backfill source metadata could not be read.');
  }
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function resolveSsl(env) {
  const mode = env.POSTGRES_SSL_MODE?.trim().toLowerCase() || 'disable';
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  throw new LocalBackfillError('POSTGRES_SSL_MODE must be disable, require, or verify-full.');
}

function parseCli(argv) {
  const mode = argv[0];
  if (mode !== '--check' && mode !== '--apply' && mode !== '--reset-receipt') {
    throw new LocalBackfillError('Usage: backfill-local-postgres.mjs <--check|--apply|--reset-receipt> --source-root <absolute-path> [...]');
  }
  const roots = [];
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] !== '--source-root' || !argv[index + 1]) {
      throw new LocalBackfillError('Local backfill accepts only --source-root <absolute-path>.');
    }
    roots.push(argv[index + 1]);
    index += 1;
  }
  if (roots.length === 0 && mode !== '--reset-receipt') {
    throw new LocalBackfillError('Local backfill requires at least one source root.');
  }
  return { mode, roots };
}

async function main() {
  const { mode, roots } = parseCli(process.argv.slice(2));
  const databaseUrl = resolveMigrationDatabaseUrl(process.env);
  if (!databaseUrl) throw new LocalBackfillError('Local backfill requires a PostgreSQL migration URL.');
  assertDatabaseUrlHasNoSslParameters(databaseUrl);
  const scope = {
    tenantId: process.env.RAG_DEFAULT_TENANT_ID?.trim() || '',
    corpusId: process.env.RAG_DEFAULT_CORPUS_ID?.trim() || '',
  };
  assertScope(scope);
  const pgModule = await import('pg');
  const Client = pgModule.Client ?? pgModule.default?.Client;
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'rag-system-local-backfill',
    ssl: resolveSsl(process.env),
  });
  try {
    await client.connect();
    if (mode === '--reset-receipt') {
      await resetLocalBackfillReceipt(client, scope);
      console.log('[backfill:local-postgres] receipt-reset');
      return;
    }
    if (mode === '--check') {
      const plan = await buildLocalBackfillPlan(roots);
      const status = await inspectLocalBackfill(client, plan, scope);
      if (!status.complete) {
        console.error(`[backfill:local-postgres] import-required documents=${plan.documents.length} blobs=${plan.blobs.length}`);
        process.exitCode = 3;
        return;
      }
      console.log(`[backfill:local-postgres] complete documents=${plan.documents.length} blobs=${plan.blobs.length}`);
      return;
    }
    const summary = await applyLocalBackfill(client, roots, scope);
    console.log(`[backfill:local-postgres] applied documents=${summary.documents} blobs=${summary.blobs} bytes=${summary.bytes}`);
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    const message = error instanceof LocalBackfillError
      ? error.message
      : 'PostgreSQL local backfill failed.';
    console.error(`[backfill:local-postgres] ${message}`);
    process.exitCode = 1;
  });
}
