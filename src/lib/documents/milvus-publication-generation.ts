import { createHash } from 'node:crypto';
import { ConsistencyLevelEnum, DataType, type MilvusClient, type SearchSimpleReq } from '@zilliz/milvus2-sdk-node';
import type { RagRetrievalScope, RagTrustLevel } from '../security/retrieval-scope';

/** Experimental building block; neither an authorization service nor a verified publication. */
export const MILVUS_PUBLICATION_MAX_VIEW_DOCUMENTS = 256;
const MAX_TEXT_BYTES = 65_000;
const MAX_INSERT_BYTES = 8 * 1024 * 1024;
const MAX_VIEW_CHUNKS = 4096;
const MAX_FILTER_BYTES = 256 * 1024;

export interface PublicationChunkInput {
  documentId: string;
  generation: number;
  documentVersion: string;
  trustLevel: RagTrustLevel;
  chunkIndex: number;
  content: string;
  embedding: number[];
}
export interface PublicationManifestEntry {
  id: string;
  payloadDigest: string;
  contentDigest: string;
  chunkIndex: number;
  trustLevel: RagTrustLevel;
}
export interface PublicationViewItem {
  documentId: string;
  generation: number;
  documentVersion: string;
  chunks: readonly PublicationManifestEntry[];
  manifestDigest: string;
}

function boundedText(value: string, field: string, bytes: number): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value, 'utf8') > bytes) {
    throw new Error(`Invalid publication ${field}.`);
  }
  return value;
}
function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid publication generation.');
  return value;
}
function returnedIndex(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function checkedScope(scope: RagRetrievalScope): RagRetrievalScope {
  if (!scope || scope.enforceIsolation !== true) throw new Error('Publication requires an isolated scope.');
  const tenantId = boundedText(scope.tenantId, 'tenantId', 128);
  const corpusId = boundedText(scope.corpusId, 'corpusId', 128);
  const trust = scope.allowedTrustLevels;
  if (!Array.isArray(trust) || trust.length === 0 || trust.some(item => !['trusted', 'reviewed', 'external', 'quarantined'].includes(item))) {
    throw new Error('Invalid publication trust scope.');
  }
  return { tenantId, corpusId, enforceIsolation: true, allowedTrustLevels: [...new Set(trust)] };
}
function checkedVector(input: number[], dimension: number): number[] {
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 65536
    || !Array.isArray(input) || input.length !== dimension) throw new Error('Invalid publication vector dimension.');
  const result: number[] = [];
  for (let index = 0; index < dimension; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid publication vector value.');
    const value = descriptor.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
      throw new Error('Invalid publication vector value.');
    }
    const normalized = Math.fround(value);
    result.push(Object.is(normalized, -0) ? 0 : normalized);
  }
  return result;
}

/** Identical keys have identical immutable payloads; this does not provide PK uniqueness. */
export function createPublicationChunk(scopeInput: RagRetrievalScope, input: PublicationChunkInput, dimension: number) {
  const scope = checkedScope(scopeInput);
  const documentId = boundedText(input.documentId, 'documentId', 256);
  const documentVersion = boundedText(input.documentVersion, 'documentVersion', 256);
  const currentGeneration = generation(input.generation);
  if (!scope.allowedTrustLevels.includes(input.trustLevel)) throw new Error('Publication trust level is outside scope.');
  if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) throw new Error('Invalid publication chunkIndex.');
  if (typeof input.content !== 'string' || !input.content.trim() || Buffer.byteLength(input.content, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error('Invalid publication content.');
  }
  const embedding = checkedVector(input.embedding, dimension);
  const payload = [scope.tenantId, scope.corpusId, documentId, currentGeneration, documentVersion,
    input.trustLevel, input.chunkIndex, input.content, embedding];
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return {
    id: `pub:${digest}`, tenant_id: scope.tenantId, corpus_id: scope.corpusId,
    document_id: documentId, publication_generation: currentGeneration, document_version: documentVersion,
    trust_level: input.trustLevel, chunk_index: input.chunkIndex, content: input.content, embedding,
    payload_digest: digest,
  };
}

/** Use only when constructing the trusted manifest BEFORE writing to Milvus. */
export function publicationManifestEntry(row: ReturnType<typeof createPublicationChunk>): PublicationManifestEntry {
  return { id: row.id, payloadDigest: row.payload_digest,
    contentDigest: createHash('sha256').update(row.content, 'utf8').digest('hex'),
    chunkIndex: row.chunk_index, trustLevel: row.trust_level };
}

/** This computes a digest, not authorization or proof of an independently published manifest. */
export function createPublicationViewItem(scopeInput: RagRetrievalScope,
  input: Omit<PublicationViewItem, 'manifestDigest'>): PublicationViewItem {
  const scope = checkedScope(scopeInput);
  const documentId = boundedText(input.documentId, 'documentId', 256);
  const documentVersion = boundedText(input.documentVersion, 'documentVersion', 256);
  const currentGeneration = generation(input.generation);
  if (!Array.isArray(input.chunks) || input.chunks.length < 1 || input.chunks.length > MAX_VIEW_CHUNKS) {
    throw new Error('Publication manifest capacity exceeded.');
  }
  const chunks = input.chunks.map(entry => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.payloadDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.payloadDigest) || entry.id !== `pub:${entry.payloadDigest}`
      || typeof entry.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.contentDigest)
      || !Number.isSafeInteger(entry.chunkIndex) || entry.chunkIndex < 0
      || !scope.allowedTrustLevels.includes(entry.trustLevel)) throw new Error('Invalid publication manifest entry.');
    return { id: entry.id, payloadDigest: entry.payloadDigest, contentDigest: entry.contentDigest,
      chunkIndex: entry.chunkIndex, trustLevel: entry.trustLevel };
  }).sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (new Set(chunks.map(item => item.id)).size !== chunks.length
    || new Set(chunks.map(item => item.chunkIndex)).size !== chunks.length) {
    throw new Error('Duplicate publication manifest entry.');
  }
  const manifestDigest = createHash('sha256').update(JSON.stringify([scope.tenantId, scope.corpusId,
    documentId, currentGeneration, documentVersion, chunks])).digest('hex');
  return { documentId, generation: currentGeneration, documentVersion, chunks, manifestDigest };
}

/** Returns a request for a NEW, dedicated collection; does not create or modify a collection. */
export function buildPublicationCollectionSchema(collection: string, dimension: number) {
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 65536) throw new Error('Invalid publication vector dimension.');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(collection)) throw new Error('Invalid publication collection.');
  return { collection_name: collection, enable_dynamic_field: false, fields: [
    { name: 'id', data_type: DataType.VarChar, is_primary_key: true, autoID: false, max_length: 256 },
    { name: 'tenant_id', data_type: DataType.VarChar, max_length: 128 },
    { name: 'corpus_id', data_type: DataType.VarChar, max_length: 128 },
    { name: 'document_id', data_type: DataType.VarChar, max_length: 256 },
    { name: 'publication_generation', data_type: DataType.Int64 },
    { name: 'document_version', data_type: DataType.VarChar, max_length: 256 },
    { name: 'trust_level', data_type: DataType.VarChar, max_length: 32 },
    { name: 'chunk_index', data_type: DataType.Int64 },
    { name: 'content', data_type: DataType.VarChar, max_length: 65535 },
    { name: 'embedding', data_type: DataType.FloatVector, dim: dimension },
    { name: 'payload_digest', data_type: DataType.VarChar, max_length: 64 },
  ] };
}

export class MilvusPublicationGenerationAdapter {
  readonly productionCapable = false;
  private readonly client: Pick<MilvusClient, 'insert' | 'search'>;
  private readonly collection: string;
  private readonly dimension: number;
  constructor(client: Pick<MilvusClient, 'insert' | 'search'>, collection: string, dimension: number) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(collection)) throw new Error('Invalid publication collection.');
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 65536) throw new Error('Invalid publication vector dimension.');
    this.client = client;
    this.collection = collection;
    this.dimension = dimension;
  }

  async insert(scope: RagRetrievalScope, chunks: readonly PublicationChunkInput[]) {
    if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > 1000) throw new Error('Publication insert capacity exceeded.');
    let bytes = 0;
    const ids = new Set<string>();
    const versions = new Map<string, string>();
    const data = chunks.map(chunk => {
      const row = createPublicationChunk(scope, chunk, this.dimension);
      const versionKey = JSON.stringify([row.document_id, row.publication_generation]);
      const version = versions.get(versionKey);
      if (version !== undefined && version !== row.document_version) throw new Error('Mixed publication document versions.');
      versions.set(versionKey, row.document_version);
      bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (bytes > MAX_INSERT_BYTES) throw new Error('Publication insert capacity exceeded.');
      if (ids.has(row.id)) throw new Error('Duplicate publication chunk in insert.');
      ids.add(row.id);
      return row;
    });
    const response = await this.client.insert({ collection_name: this.collection, data });
    if (response.status?.error_code !== 'Success' || Number(response.insert_cnt) !== data.length) {
      throw new Error('Milvus publication insert failed.');
    }
    // insert permits duplicate primary keys; write acknowledgement proves neither uniqueness nor readback.
    return { ids: data.map(row => row.id), verified: false as const };
  }

  async search(scopeInput: RagRetrievalScope, viewInput: readonly PublicationViewItem[], vector: number[], topK: number) {
    const scope = checkedScope(scopeInput);
    const query = checkedVector(vector, this.dimension);
    if (!Number.isSafeInteger(topK) || topK < 1 || topK > 1000) throw new Error('Invalid publication search limit.');
    if (!Array.isArray(viewInput) || viewInput.length > MILVUS_PUBLICATION_MAX_VIEW_DOCUMENTS) {
      throw new Error('Publication view capacity exceeded.');
    }
    if (viewInput.length === 0) return [];
    let totalChunks = 0;
    const view = viewInput.map(item => {
      const canonical = createPublicationViewItem(scope, item);
      if (canonical.manifestDigest !== item.manifestDigest) throw new Error('Publication manifest digest mismatch.');
      totalChunks += canonical.chunks.length;
      if (totalChunks > MAX_VIEW_CHUNKS) throw new Error('Publication manifest capacity exceeded.');
      return canonical;
    });
    if (new Set(view.map(item => item.documentId)).size !== view.length) throw new Error('Duplicate publication document in view.');
    const exprValues: Record<string, string | number | string[]> = { tenantId: scope.tenantId, corpusId: scope.corpusId,
      allowedTrustLevels: [...scope.allowedTrustLevels] };
    const pairs = view.map((item, index) => {
      exprValues[`document${index}`] = item.documentId;
      exprValues[`generation${index}`] = item.generation;
      exprValues[`version${index}`] = item.documentVersion;
      exprValues[`chunkIds${index}`] = item.chunks.map(chunk => chunk.id);
      return `(document_id == {document${index}} && publication_generation == {generation${index}} && document_version == {version${index}} && id in {chunkIds${index}})`;
    });
    const filter = `tenant_id == {tenantId} && corpus_id == {corpusId} && trust_level in {allowedTrustLevels} && (${pairs.join(' || ')})`;
    if (Buffer.byteLength(JSON.stringify({ filter, exprValues }), 'utf8') > MAX_FILTER_BYTES) {
      throw new Error('Publication filter capacity exceeded.');
    }
    const response = await this.client.search({ collection_name: this.collection, data: [query], anns_field: 'embedding', limit: topK,
      consistency_level: ConsistencyLevelEnum.Strong, output_fields: ['id', 'tenant_id', 'corpus_id', 'document_id', 'publication_generation', 'document_version',
        'trust_level', 'chunk_index', 'content', 'payload_digest'],
      filter,
      exprValues,
    } as SearchSimpleReq);
    if (response.status?.error_code !== 'Success' || !Array.isArray(response.results)) throw new Error('Milvus publication search failed.');
    const hits = response.results.length === 1 && Array.isArray(response.results[0]) ? response.results[0] : response.results;
    if (hits.length > topK) throw new Error('Milvus publication search exceeded limit.');
    const selected = new Map(view.map(item => [item.documentId, item]));
    const manifests = new Map(view.map(item => [item.documentId, new Map(item.chunks.map(chunk => [chunk.id, chunk]))]));
    const seenIds = new Set<string>();
    const seenSlots = new Set<string>();
    for (const hit of hits) {
      if (!hit || typeof hit !== 'object' || hit.tenant_id !== scope.tenantId || hit.corpus_id !== scope.corpusId
        || !scope.allowedTrustLevels.includes(hit.trust_level as RagTrustLevel)
        || selected.get(String(hit.document_id))?.generation !== returnedIndex(hit.publication_generation)) {
        throw new Error('Milvus returned publication outside the requested view.');
      }
      if (typeof hit.id !== 'string' || typeof hit.payload_digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(hit.payload_digest) || hit.id !== `pub:${hit.payload_digest}`
        || typeof hit.document_version !== 'string' || !hit.document_version
        || returnedIndex(hit.chunk_index) === null) {
        throw new Error('Milvus returned malformed publication evidence.');
      }
      const expectedView = selected.get(String(hit.document_id));
      const expected = manifests.get(String(hit.document_id))?.get(hit.id);
      if (!expectedView || !expected || hit.document_version !== expectedView.documentVersion
        || hit.payload_digest !== expected.payloadDigest || Number(hit.chunk_index) !== expected.chunkIndex
        || hit.trust_level !== expected.trustLevel || typeof hit.content !== 'string'
        || createHash('sha256').update(hit.content, 'utf8').digest('hex') !== expected.contentDigest) {
        throw new Error('Milvus evidence does not match the trusted publication manifest.');
      }
      const slot = JSON.stringify([hit.document_id, Number(hit.publication_generation), Number(hit.chunk_index)]);
      if (seenIds.has(hit.id) || seenSlots.has(slot)) throw new Error('Milvus returned duplicate publication evidence.');
      seenIds.add(hit.id);
      seenSlots.add(slot);
    }
    return hits;
  }
}
