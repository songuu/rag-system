import { createHash } from 'node:crypto';
import { queryPostgres, type PostgresQueryClient } from '../postgres/client';
import type { RagRetrievalScope, RagTrustLevel } from '../security/retrieval-scope';
import { type GenerationPair } from '../elasticsearch/generation-index';
import { createPublicationViewItem,
  type PublicationViewItem } from './milvus-publication-generation';
import { canonicalJson } from '../rag/eval/canonical-json';

/** Internal server-side view. It must never be accepted from an HTTP payload. */
export interface PublishedDocumentView {
  readonly documentId: string;
  readonly generation: string;
  readonly revision: string;
  readonly assetId: string;
  readonly assetRevision: string;
  readonly contentVersion: string;
  readonly rawDigest: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly sourceKind: string;
  readonly byteSize: number | null;
  readonly createdAt?: string;
  readonly manifestDigest: string;
  readonly embedding: Readonly<{ model: string; revision: string; dimension: number; indexSchema: string }>;
  readonly searchSources: readonly Readonly<{ chunkId: string; source: string }>[];
  readonly sourceChunks: readonly Readonly<{ id: string; chunkIndex: number; contentDigest: string; startOffset?: number; endOffset?: number; page?: number }>[];
  readonly collection: string;
  readonly collectionId: string;
  readonly milvusConfigurationDigest: string;
  readonly milvusEvidenceDigest: string;
  readonly milvusVerifiedAt: string;
  readonly indexName: string;
  readonly indexUuid: string;
  readonly ownerMarker: string;
  readonly elasticsearchConfigurationDigest: string;
  readonly elasticsearchEvidenceDigest: string;
  readonly elasticsearchVerifiedAt: string;
  readonly milvus: PublicationViewItem;
  readonly elasticsearch: GenerationPair;
}
export interface PublicationView {
  readonly tenantId: string;
  readonly corpusId: string;
  readonly allowedTrustLevels: readonly RagTrustLevel[];
  readonly documents: readonly PublishedDocumentView[];
  /** Corpus graph is not asserted ready by this document-level view. */
  readonly graph: { readonly status: 'unavailable' };
  readonly digest: string;
}
const issuedViews = new WeakSet<object>();
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** The caller must derive scope from authenticated request-context, not a client payload. */
export async function readPublicationView(scopeInput: RagRetrievalScope, client: PostgresQueryClient): Promise<PublicationView> {
  const scope = checkedScope(scopeInput);
  const result = await queryPostgres<{ view: unknown }>(client,
    'select public.rag_read_publication_view($1,$2,$3::text[]) as view',
    [scope.tenantId, scope.corpusId, scope.allowedTrustLevels], 'read authorized publication view');
  if (result.rows.length !== 1) throw new Error('Publication view is unavailable.');
  const raw = record(result.rows[0].view);
  if (raw.version !== 1 || raw.tenantId !== scope.tenantId || raw.corpusId !== scope.corpusId
    || !Array.isArray(raw.documents) || raw.documents.length > 128) throw new Error('Invalid publication view.');
  const documents = raw.documents.map(item => parseDocument(scope, record(item)));
  if (new Set(documents.map(item => item.documentId)).size !== documents.length
    || documents.reduce((sum, item) => sum + item.milvus.chunks.length, 0) > 4096) {
    throw new Error('Publication view capacity or identity is invalid.');
  }
  documents.sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0);
  const fields = { tenantId: scope.tenantId, corpusId: scope.corpusId,
    allowedTrustLevels: [...scope.allowedTrustLevels], documents, graph: { status: 'unavailable' as const } };
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
  const view = deepFreeze({ ...fields, digest });
  issuedViews.add(view);
  return view;
}

/** Call immediately before returning evidence or a cache hit. */
export async function assertPublicationViewCurrent(view: PublicationView, scopeInput: RagRetrievalScope,
  client: PostgresQueryClient): Promise<void> {
  if (!view || !issuedViews.has(view)) throw new Error('Publication view was not issued by the server.');
  const scope = checkedScope(scopeInput);
  if (view.tenantId !== scope.tenantId || view.corpusId !== scope.corpusId
    || JSON.stringify(view.allowedTrustLevels) !== JSON.stringify(scope.allowedTrustLevels)) {
    throw new Error('Publication view scope changed.');
  }
  const current = await readPublicationView(scope, client);
  if (current.digest !== view.digest) throw new Error('Publication view changed during retrieval.');
}

/** Read one original only on demand, with authorization checked before and after IO. */
export async function readPublicationSource(view: PublicationView, documentId: string, scopeInput: RagRetrievalScope,
  client: PostgresQueryClient): Promise<{ bytes: Buffer; identityBytes: Buffer; originalName: string; contentType: string }> {
  await assertPublicationViewCurrent(view, scopeInput, client);
  const document = view.documents.find(item => item.documentId === documentId);
  if (!document) throw new Error('Publication source is unavailable.');
  const scope = checkedScope(scopeInput);
  const result = await queryPostgres<{ source_bytes: Buffer; source_identity_bytes: Buffer }>(client,
    'select * from public.rag_read_publication_source($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8::text[],$9)',
    [scope.tenantId, scope.corpusId, document.documentId, document.generation, document.revision,
      document.assetId, document.assetRevision, scope.allowedTrustLevels, document.manifestDigest],
    'read authorized publication source');
  if (result.rows.length !== 1 || !Buffer.isBuffer(result.rows[0]?.source_bytes)
    || !Buffer.isBuffer(result.rows[0]?.source_identity_bytes)
    || result.rows[0].source_bytes.length < 1 || result.rows[0].source_bytes.length > 32 * 1024 * 1024
    || result.rows[0].source_identity_bytes.length < 1 || result.rows[0].source_identity_bytes.length > 32 * 1024 * 1024
    || `sha256:${createHash('sha256').update(result.rows[0].source_bytes).digest('hex')}` !== document.rawDigest
    || `sha256:${createHash('sha256').update(result.rows[0].source_identity_bytes).digest('hex')}` !== document.contentVersion) {
    throw new Error('Publication source does not match its manifest.');
  }
  await assertPublicationViewCurrent(view, scope, client);
  return { bytes: Buffer.from(result.rows[0].source_bytes), identityBytes: Buffer.from(result.rows[0].source_identity_bytes), originalName: document.originalName, contentType: document.contentType };
}

function parseDocument(scope: RagRetrievalScope, value: Record<string, unknown>): PublishedDocumentView {
  const documentId = scalar(value.documentId, 256);
  const generation = scalar(value.generation, 16);
  if (!/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(Number(generation))) {
    throw new Error('Publication generation exceeds supported capacity.');
  }
  const revision = decimal(value.revision);
  const assetId = scalar(value.assetId, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(assetId)) throw new Error('Invalid publication asset identity.');
  const assetRevision = decimal(value.assetRevision);
  const contentVersion = digest(value.contentVersion);
  const manifestDigest = digest(value.manifestDigest);
  const manifestJson = scalar(value.manifestJson, 262144);
  const manifest = record(JSON.parse(manifestJson));
  if (canonicalJson(manifest) !== manifestJson || sha256(manifestJson) !== manifestDigest
    || manifest.profile !== 'rag-publication-asset/v1' || manifest.tenantId !== scope.tenantId
    || manifest.corpusId !== scope.corpusId || manifest.documentId !== documentId || manifest.contentVersion !== contentVersion
    || record(manifest.source).identityDigest !== contentVersion || !Array.isArray(manifest.chunks)
    || manifest.chunks.length < 1 || manifest.chunks.length > 1000 || !Array.isArray(value.descriptors)
    || value.descriptors.length !== manifest.chunks.length) throw new Error('Publication manifest is invalid.');
  const embeddingRecord = record(manifest.embedding);
  const dimension = embeddingRecord.dimension;
  if (!Number.isSafeInteger(dimension) || Number(dimension) < 1 || Number(dimension) > 65536) {
    throw new Error('Invalid publication embedding dimension.');
  }
  const embedding = {
    model: scalar(embeddingRecord.model, 256), revision: scalar(embeddingRecord.revision, 256),
    dimension: Number(dimension), indexSchema: scalar(embeddingRecord.indexSchema, 256),
  };
  const milvusEntries = providerEntries(value.milvusManifestJson, value.milvusManifestDigest);
  const lexicalEntries = providerEntries(value.elasticsearchManifestJson, value.elasticsearchManifestDigest);
  if (milvusEntries.length !== manifest.chunks.length || lexicalEntries.length !== manifest.chunks.length) {
    throw new Error('Publication provider manifest is incomplete.');
  }
  const milvusChunks: PublicationViewItem['chunks'][number][] = [];
  const lexicalChunks: Array<{ chunkId: string; digest: string }> = [];
  const searchSources: Array<{ chunkId: string; source: string }> = [];
  const sourceChunks: Array<{ id: string; chunkIndex: number; contentDigest: string; startOffset?: number; endOffset?: number; page?: number }> = [];
  for (let index = 0; index < manifest.chunks.length; index++) {
    const rootChunk = record(manifest.chunks[index]);
    const descriptorJson = scalar(value.descriptors[index], 262144);
    const descriptor = record(JSON.parse(descriptorJson));
    const milvus = record(milvusEntries[index]);
    const lexical = record(lexicalEntries[index]);
    const descriptorDigest = sha256(descriptorJson);
    if (canonicalJson(descriptor) !== descriptorJson || rootChunk.chunkIndex !== index
      || rootChunk.descriptorDigest !== descriptorDigest || descriptor.chunkIndex !== index
      || milvus.chunkIndex !== index || lexical.chunkIndex !== index
      || milvus.descriptorDigest !== descriptorDigest || lexical.descriptorDigest !== descriptorDigest) {
      throw new Error('Publication provider manifest does not match the root manifest.');
    }
    const trustLevel = scalar(descriptor.trustLevel, 32) as RagTrustLevel;
    if (!scope.allowedTrustLevels.includes(trustLevel)) throw new Error('Publication chunk is outside the trust scope.');
    const payloadDigest = hex(milvus.payloadDigest);
    const contentDigest = hex(milvus.contentDigest);
    const id = scalar(milvus.id, 256);
    if (id !== `pub:${payloadDigest}` || milvus.chunkId !== id || lexical.chunkId !== id
      || milvus.trustLevel !== trustLevel || descriptor.contentDigest !== `sha256:${contentDigest}`) {
      throw new Error('Publication provider chunk identity is inconsistent.');
    }
    milvusChunks.push({ id, payloadDigest, contentDigest, chunkIndex: index, trustLevel });
    lexicalChunks.push({ chunkId: id, digest: hex(lexical.digest) });
    searchSources.push({ chunkId: id, source: descriptor.source == null ? documentId : scalar(descriptor.source, 8000) });
    sourceChunks.push({ id, chunkIndex: index, contentDigest: `sha256:${contentDigest}`,
      ...(Number.isSafeInteger(descriptor.startOffset) && Number(descriptor.startOffset) >= 0 ? { startOffset: Number(descriptor.startOffset) } : {}),
      ...(Number.isSafeInteger(descriptor.endOffset) && Number(descriptor.endOffset) >= 0 ? { endOffset: Number(descriptor.endOffset) } : {}),
      ...(Number.isSafeInteger(descriptor.page) && Number(descriptor.page) >= 0 ? { page: Number(descriptor.page) } : {}) });
  }
  const collection = scalar(value.collection, 255);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(collection)) throw new Error('Invalid publication collection.');
  const collectionId = scalar(value.collectionId, 19);
  if (!/^[1-9][0-9]{0,18}$/.test(collectionId)) throw new Error('Invalid publication collection identity.');
  const indexName = scalar(value.indexName, 255);
  if (!/^codex-generation-seal-[a-f0-9]{32}$/.test(indexName)) throw new Error('Invalid publication index.');
  const indexUuid = scalar(value.indexUuid, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(indexUuid)) throw new Error('Invalid publication index identity.');
  const ownerMarker = scalar(value.ownerMarker, 64);
  if (!/^[a-f0-9]{64}$/.test(ownerMarker)) throw new Error('Invalid publication index owner.');
  const source = record(manifest.source);
  const byteSize=value.byteSize===undefined?null:value.byteSize;
  if(byteSize!==null&&(!Number.isSafeInteger(byteSize)||Number(byteSize)<1||Number(byteSize)>32*1024*1024))throw new Error('Invalid publication source size.');
  return { documentId, generation, revision, assetId, assetRevision, contentVersion, manifestDigest, embedding, searchSources, sourceChunks,
    rawDigest: digest(source.rawDigest), originalName: scalar(source.originalName, 512), contentType: scalar(source.contentType, 256),
    sourceKind:scalar(source.sourceKind,64),byteSize:byteSize as number|null,...(value.createdAt===undefined?{}:{createdAt:timestamp(value.createdAt)}),
    collection, collectionId, indexName, indexUuid, ownerMarker,
    milvusConfigurationDigest: digest(value.milvusConfigurationDigest),
    elasticsearchConfigurationDigest: digest(value.elasticsearchConfigurationDigest),
    milvusEvidenceDigest: digest(value.milvusEvidenceDigest),
    elasticsearchEvidenceDigest: digest(value.elasticsearchEvidenceDigest),
    milvusVerifiedAt: timestamp(value.milvusVerifiedAt),
    elasticsearchVerifiedAt: timestamp(value.elasticsearchVerifiedAt),
    milvus: createPublicationViewItem(scope, { documentId, generation: Number(generation), documentVersion: contentVersion, chunks: milvusChunks }),
    elasticsearch: { documentId, generation, documentVersion: contentVersion, chunks: lexicalChunks } };
}

function checkedScope(input: RagRetrievalScope): RagRetrievalScope {
  if (!input || input.enforceIsolation !== true || !Array.isArray(input.allowedTrustLevels)
    || input.allowedTrustLevels.length < 1 || input.allowedTrustLevels.length > 4
    || input.allowedTrustLevels.some(level => !['trusted','reviewed','external','quarantined'].includes(level))) {
    throw new Error('Publication view requires an isolated authorized scope.');
  }
  return { tenantId: scalar(input.tenantId, 128), corpusId: scalar(input.corpusId, 128), enforceIsolation: true,
    allowedTrustLevels: [...new Set(input.allowedTrustLevels)].sort() };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid publication view payload.');
  return value as Record<string, unknown>;
}
function scalar(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid publication view field.');
  }
  return value;
}
function digest(value: unknown): string { const text = scalar(value, 71); if (!DIGEST.test(text)) throw new Error('Invalid publication digest.'); return text; }
function hex(value: unknown): string { const text = scalar(value, 64); if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('Invalid provider digest.'); return text; }
function sha256(value: string): string { return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`; }
function providerEntries(raw: unknown, expectedDigest: unknown): unknown[] {
  const text = scalar(raw, 4 * 1024 * 1024);
  if (sha256(text) !== digest(expectedDigest)) throw new Error('Publication provider manifest digest mismatch.');
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000
    || `[${value.map(entry => canonicalJson(entry)).join(',')}]` !== text) throw new Error('Invalid canonical provider manifest.');
  return value;
}
function decimal(value: unknown): string { const text = scalar(value, 20); if (!/^[0-9]+$/.test(text)) throw new Error('Invalid publication revision.'); return text; }
function timestamp(value: unknown): string { const text = scalar(value, 64); if (!Number.isFinite(Date.parse(text))) throw new Error('Invalid publication verification time.'); return text; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
