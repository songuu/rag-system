import { createHash } from 'node:crypto';
import { canonicalJson } from '../rag/eval/canonical-json';
import { queryPostgres, type PostgresQueryClient } from '../postgres/client';
import type { RagTrustLevel } from '../security/retrieval-scope';
import type { PublicationAttempt, PublicationScope } from './publication-control-cas';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_VECTOR_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MAX_CHUNKS = 1000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TRUST = new Set<RagTrustLevel>(['trusted', 'reviewed', 'external', 'quarantined']);

export interface PublicationAssetInput extends PublicationScope {
  /** Exact original uploaded bytes, retained independently of parsed text. */
  sourceBytes: Uint8Array;
  /** The exact bytes hashed by the document pipeline for its content version. */
  sourceIdentityBytes: Uint8Array;
  originalName: string;
  contentType: string;
  sourceKind: string;
  embedding: { model: string; revision: string; dimension: number; indexSchema: string };
  splitter: { name: string; revision: string; chunkSize: number; chunkOverlap: number };
  chunks: readonly { chunkIndex: number; content: string; trustLevel: RagTrustLevel;
    source?: string; page?: number; metadata?: Record<string, unknown>;
    startOffset?: number; endOffset?: number; embedding: readonly number[] }[];
}

export interface PreparedPublicationAsset extends PublicationScope {
  contentVersion: string;
  manifestDigest: string;
  manifestJson: string;
  chunksJson: string;
  sourceBytes: Buffer;
  sourceIdentityBytes: Buffer;
}
export interface PublicationAssetIdentity extends PublicationScope { manifestDigest: string }

/**
 * Construct before allocating a generation. The manifest intentionally excludes
 * the generation; the database binds this digest to the immutable attempt.
 */
export function preparePublicationAsset(input: PublicationAssetInput): PreparedPublicationAsset {
  const scope = validateScope(input);
  const sourceBytes = copiedBytes(input.sourceBytes, 'source');
  const sourceIdentityBytes = copiedBytes(input.sourceIdentityBytes, 'source identity');
  const originalName = text(input.originalName, 'original name', 512);
  const contentType = text(input.contentType, 'content type', 256);
  const sourceKind = text(input.sourceKind, 'source kind', 64);
  const embedding = {
    model: text(input.embedding?.model, 'embedding model', 512),
    revision: text(input.embedding?.revision, 'embedding revision', 256),
    dimension: integer(input.embedding?.dimension, 'embedding dimension', 1, 65536),
    indexSchema: text(input.embedding?.indexSchema, 'index schema', 256),
  };
  const splitter = {
    name: text(input.splitter?.name, 'splitter name', 256),
    revision: text(input.splitter?.revision, 'splitter revision', 256),
    chunkSize: integer(input.splitter?.chunkSize, 'chunk size', 1, 1000000),
    chunkOverlap: integer(input.splitter?.chunkOverlap, 'chunk overlap', 0, 999999),
  };
  if (splitter.chunkOverlap >= splitter.chunkSize) throw new Error('Invalid publication chunk overlap.');
  if (!Array.isArray(input.chunks) || input.chunks.length < 1 || input.chunks.length > MAX_CHUNKS
    || input.chunks.length * embedding.dimension * 4 > MAX_VECTOR_BYTES) {
    throw new Error('Publication manifest capacity exceeded.');
  }
  let payloadBytes = 2;
  const chunks = input.chunks.map(chunk => {
    const chunkIndex = integer(chunk?.chunkIndex, 'chunk index', 0, MAX_CHUNKS - 1);
    if (typeof chunk.content !== 'string' || !chunk.content.trim() || Buffer.byteLength(chunk.content, 'utf8') > 65000) {
      throw new Error('Invalid publication chunk content.');
    }
    if (!TRUST.has(chunk.trustLevel)) throw new Error('Invalid publication chunk trust level.');
    const offsets = validateOffsets(chunk.startOffset, chunk.endOffset);
    const source = chunk.source === undefined ? null : text(chunk.source, 'chunk source', 8000);
    const page = chunk.page === undefined ? null : integer(chunk.page, 'chunk page', 0, Number.MAX_SAFE_INTEGER);
    const metadata = chunk.metadata ?? {};
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw new Error('Invalid publication chunk metadata.');
    const metadataJson = canonicalJson(metadata);
    const vector = checkedFloat32Bytes(chunk.embedding, embedding.dimension);
    const descriptorJson = canonicalJson({ chunkIndex, trustLevel: chunk.trustLevel, source, page, ...offsets,
      contentDigest: sha256(Buffer.from(chunk.content, 'utf8')), embeddingDigest: sha256(vector),
      metadataDigest: sha256(Buffer.from(metadataJson, 'utf8')) });
    let payloadJson: string;
    try {
      payloadJson = canonicalJson({ chunkIndex, content: chunk.content, embeddingBase64: vector.toString('base64'),
        metadataJson, descriptorJson });
    } catch (cause) {
      throw new Error('Publication chunk exceeds its canonical JSON byte budget.', { cause });
    }
    payloadBytes += Buffer.byteLength(payloadJson, 'utf8') + 1;
    if (payloadBytes > MAX_CHUNK_PAYLOAD_BYTES + 1) throw new Error('Publication chunk payload capacity exceeded.');
    return { manifest: { chunkIndex, descriptorDigest: sha256(Buffer.from(descriptorJson, 'utf8')) }, payloadJson };
  }).sort((a, b) => a.manifest.chunkIndex - b.manifest.chunkIndex);
  if (chunks.some((chunk, index) => chunk.manifest.chunkIndex !== index)) throw new Error('Publication chunk indexes must be contiguous.');
  // Each entry was already validated by canonicalJson; joining those entries
  // keeps the root manifest compact even when the full source content is large.
  const chunksJson = `[${chunks.map(chunk => chunk.payloadJson).join(',')}]`;
  const contentVersion = sha256(sourceIdentityBytes);
  const manifestJson = canonicalJson({ profile: 'rag-publication-asset/v1', ...scope, contentVersion,
    source: { originalName, contentType, sourceKind, rawDigest: sha256(sourceBytes),
      identityDigest: contentVersion }, embedding, splitter, chunks: chunks.map(chunk => chunk.manifest) });
  return { ...scope, contentVersion, manifestJson, manifestDigest: sha256(Buffer.from(manifestJson, 'utf8')),
    chunksJson, sourceBytes, sourceIdentityBytes };
}

/**
 * Stages an immutable original and manifest; it never publishes a generation.
 * The database checks the active attempt and lease under the publication head lock.
 */
export class PostgresPublicationAssetStore {
  private readonly client: PostgresQueryClient;
  constructor(client: PostgresQueryClient) { this.client = client; }

  async stage(attempt: PublicationAttempt, asset: PreparedPublicationAsset): Promise<void> {
    const scope = validatePublicationAsset(attempt, asset);
    const sourceBytes = Buffer.from(asset.sourceBytes);
    const identityBytes = Buffer.from(asset.sourceIdentityBytes);
    const result = await queryPostgres<{ stored: boolean }>(this.client,
      'select public.rag_stage_publication_asset($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9,$10::bytea,$11::bytea,$12::jsonb) as stored',
      [scope.tenantId, scope.corpusId, scope.documentId, attempt.generation, attempt.revision, attempt.leaseToken,
        attempt.physicalCollection, asset.contentVersion, asset.manifestJson, sourceBytes, identityBytes, asset.chunksJson],
      'stage versioned publication asset');
    if (result.rows.length !== 1 || result.rows[0]?.stored !== true) throw new Error('Publication asset was not staged.');
  }

  /** Only the current claimed attempt may reconstruct source and chunk data. */
  async readStaged(attempt: PublicationAttempt): Promise<PreparedPublicationAsset> {
    const scope = validateScope(attempt);
    const result = await queryPostgres<{ content_version: string; manifest_digest: string; manifest_json: string;
      source_bytes: Buffer; source_identity_bytes: Buffer; chunks_json: unknown }>(this.client,
      'select * from public.rag_read_staged_publication_asset($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7)',
      [scope.tenantId, scope.corpusId, scope.documentId, attempt.generation, attempt.revision, attempt.leaseToken,
        attempt.physicalCollection], 'read staged publication asset');
    if (result.rows.length !== 1) throw new Error('Staged publication asset is unavailable.');
    const row = result.rows[0];
    const asset = { ...scope, contentVersion: row.content_version, manifestDigest: row.manifest_digest,
      manifestJson: row.manifest_json, sourceBytes: row.source_bytes, sourceIdentityBytes: row.source_identity_bytes,
      chunksJson: JSON.stringify(row.chunks_json) };
    validatePublicationAsset(attempt, asset);
    return { ...asset, sourceBytes: Buffer.from(asset.sourceBytes), sourceIdentityBytes: Buffer.from(asset.sourceIdentityBytes) };
  }
}

export function validatePublicationAsset(identity: PublicationAssetIdentity, asset: PreparedPublicationAsset): PublicationScope {
  const scope = validateScope(asset);
  if (identity.tenantId !== scope.tenantId || identity.corpusId !== scope.corpusId || identity.documentId !== scope.documentId
    || identity.manifestDigest !== asset.manifestDigest || !DIGEST.test(asset.manifestDigest)
    || !DIGEST.test(asset.contentVersion) || sha256(Buffer.from(asset.manifestJson, 'utf8')) !== asset.manifestDigest) {
    throw new Error('Publication asset does not match its attempt.');
  }
  const sourceBytes = copiedBytes(asset.sourceBytes, 'source');
  const identityBytes = copiedBytes(asset.sourceIdentityBytes, 'source identity');
  const manifest = JSON.parse(asset.manifestJson) as { tenantId?: unknown; corpusId?: unknown; documentId?: unknown;
    contentVersion?: unknown; source?: { rawDigest?: unknown; identityDigest?: unknown };
    embedding?: { dimension?: unknown }; chunks?: Array<Record<string, unknown>> };
  if (canonicalJson(manifest) !== asset.manifestJson || manifest.tenantId !== scope.tenantId
    || manifest.corpusId !== scope.corpusId || manifest.documentId !== scope.documentId
    || manifest.contentVersion !== asset.contentVersion || manifest.source?.rawDigest !== sha256(sourceBytes)
    || manifest.source?.identityDigest !== sha256(identityBytes) || asset.contentVersion !== sha256(identityBytes)) {
    throw new Error('Publication asset content no longer matches its manifest.');
  }
  if (typeof asset.chunksJson !== 'string' || Buffer.byteLength(asset.chunksJson, 'utf8') > MAX_CHUNK_PAYLOAD_BYTES) {
    throw new Error('Publication chunk payload capacity exceeded.');
  }
  const chunks = JSON.parse(asset.chunksJson) as Array<Record<string, unknown>>;
  const dimension = integer(manifest.embedding?.dimension, 'embedding dimension', 1, 65536);
  if (!Array.isArray(chunks) || !Array.isArray(manifest.chunks) || chunks.length < 1 || chunks.length > MAX_CHUNKS
    || chunks.length !== manifest.chunks.length || chunks.length * dimension * 4 > MAX_VECTOR_BYTES) {
    throw new Error('Invalid publication chunk payload.');
  }
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const expected = manifest.chunks[index];
    if (!chunk || !expected || chunk.chunkIndex !== index || expected.chunkIndex !== index
      || typeof chunk.content !== 'string' || !chunk.content.trim() || Buffer.byteLength(chunk.content, 'utf8') > 65000
      || typeof chunk.embeddingBase64 !== 'string' || typeof chunk.metadataJson !== 'string' || typeof chunk.descriptorJson !== 'string'
      || Object.keys(chunk).sort().join(',') !== 'chunkIndex,content,descriptorJson,embeddingBase64,metadataJson') {
      throw new Error('Invalid publication chunk payload.');
    }
    const descriptor = JSON.parse(chunk.descriptorJson) as Record<string, unknown>;
    if (canonicalJson(descriptor) !== chunk.descriptorJson || descriptor.chunkIndex !== index
      || expected.descriptorDigest !== sha256(Buffer.from(chunk.descriptorJson, 'utf8'))) {
      throw new Error('Publication chunk descriptor does not match its manifest.');
    }
    const vector = Buffer.from(chunk.embeddingBase64, 'base64');
    if (vector.length !== dimension * 4 || vector.toString('base64') !== chunk.embeddingBase64) {
      throw new Error('Invalid publication vector payload.');
    }
    for (let coordinate = 0; coordinate < dimension; coordinate++) {
      if (!Number.isFinite(vector.readFloatLE(coordinate * 4))) throw new Error('Invalid publication vector payload.');
    }
    const metadata = JSON.parse(chunk.metadataJson) as unknown;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || canonicalJson(metadata) !== chunk.metadataJson
      || descriptor.contentDigest !== sha256(Buffer.from(chunk.content, 'utf8')) || descriptor.embeddingDigest !== sha256(vector)
      || descriptor.metadataDigest !== sha256(Buffer.from(chunk.metadataJson, 'utf8'))) {
      throw new Error('Publication chunk payload does not match its manifest.');
    }
  }
  return scope;
}

function validateScope(scope: PublicationScope): PublicationScope {
  return { tenantId: text(scope?.tenantId, 'tenant ID', 128), corpusId: text(scope?.corpusId, 'corpus ID', 128),
    documentId: text(scope?.documentId, 'document ID', 256) };
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || Buffer.byteLength(value, 'utf8') > max
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid publication ${field}.`);
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid publication ${field}.`);
  return Number(value);
}
function copiedBytes(value: Uint8Array, field: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`Invalid publication ${field} bytes.`);
  }
  return Buffer.from(value);
}
function checkedFloat32Bytes(value: readonly number[], dimension: number): Buffer {
  if (!Array.isArray(value) || value.length !== dimension) throw new Error('Invalid publication vector dimension.');
  const bytes = Buffer.allocUnsafe(dimension * 4);
  for (let index = 0; index < dimension; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'number'
      || !Number.isFinite(descriptor.value) || !Number.isFinite(Math.fround(descriptor.value))) {
      throw new Error('Invalid publication vector value.');
    }
    const normalized = Math.fround(descriptor.value);
    bytes.writeFloatLE(Object.is(normalized, -0) ? 0 : normalized, index * 4);
  }
  return bytes;
}
function validateOffsets(start: number | undefined, end: number | undefined): { startOffset?: number; endOffset?: number } {
  if (start === undefined && end === undefined) return {};
  const startOffset = integer(start, 'start offset', 0, Number.MAX_SAFE_INTEGER);
  const endOffset = integer(end, 'end offset', 0, Number.MAX_SAFE_INTEGER);
  if (endOffset < startOffset) throw new Error('Invalid publication chunk offsets.');
  return { startOffset, endOffset };
}
function sha256(value: Uint8Array): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
