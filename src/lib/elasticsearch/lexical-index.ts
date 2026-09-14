import type { RagEvidence } from '../rag/core/types';
import type {
  RagRetrievalScope,
  RagTrustLevel,
} from '../security/retrieval-scope';
import type { ElasticsearchClientPort } from './client';

export const ELASTICSEARCH_LEXICAL_MAPPING_VERSION = 'elasticsearch-lexical/v1' as const;

export interface ElasticsearchLexicalDocument {
  chunk_id: string;
  tenant_id: string;
  corpus_id: string;
  document_id: string;
  document_version: string;
  trust_level: RagTrustLevel;
  content: string;
  source?: string;
  page?: number;
  start_offset?: number;
  end_offset?: number;
  metadata: Record<string, unknown>;
}

export class ElasticsearchIntegrityError extends Error {
  readonly code = 'ELASTICSEARCH_INTEGRITY_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'ElasticsearchIntegrityError';
  }
}

export function buildElasticsearchLexicalMapping() {
  return {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
    },
    mappings: {
      dynamic: 'strict',
      properties: {
        chunk_id: { type: 'keyword' },
        tenant_id: { type: 'keyword' },
        corpus_id: { type: 'keyword' },
        document_id: { type: 'keyword' },
        document_version: { type: 'keyword' },
        trust_level: { type: 'keyword' },
        content: { type: 'text', analyzer: 'cjk', search_analyzer: 'cjk' },
        source: {
          type: 'text',
          analyzer: 'cjk',
          fields: { keyword: { type: 'keyword', ignore_above: 1024 } },
        },
        page: { type: 'integer' },
        start_offset: { type: 'integer' },
        end_offset: { type: 'integer' },
        indexed_at: { type: 'date' },
        // Metadata is returned for evidence provenance but cannot create dynamic fields.
        metadata: { type: 'object', enabled: false },
      },
    },
  } as const;
}

export async function ensureElasticsearchLexicalIndex(input: {
  client: ElasticsearchClientPort;
  indexName: string;
}): Promise<'existing' | 'created'> {
  if (await input.client.indices.exists({ index: input.indexName })) return 'existing';
  try {
    await input.client.indices.create({
      index: input.indexName,
      ...buildElasticsearchLexicalMapping(),
    });
    return 'created';
  } catch (error) {
    if (readErrorType(error) === 'resource_already_exists_exception') return 'existing';
    throw error;
  }
}

export async function searchElasticsearchLexical(input: {
  client: Pick<ElasticsearchClientPort, 'search'>;
  indexName: string;
  query: string;
  topK: number;
  laneId: string;
  scope: RagRetrievalScope;
  signal?: AbortSignal;
}): Promise<RagEvidence[]> {
  const query = requiredScalar(input.query, 'query', 8_000);
  const topK = boundedTopK(input.topK);
  const response = await input.client.search({
    index: input.indexName,
    size: topK,
    track_total_hits: false,
    _source: [
      'chunk_id', 'tenant_id', 'corpus_id', 'document_id', 'document_version',
      'trust_level', 'content', 'source', 'page', 'start_offset', 'end_offset', 'metadata',
    ],
    query: {
      bool: {
        must: [{
          multi_match: {
            query,
            fields: ['content', 'source^0.2'],
            type: 'best_fields',
          },
        }],
        filter: [
          { term: { tenant_id: input.scope.tenantId } },
          { term: { corpus_id: input.scope.corpusId } },
          { terms: { trust_level: [...input.scope.allowedTrustLevels] } },
        ],
      },
    },
  }, { signal: input.signal });

  const hits = readHits(response);
  const ids = new Set<string>();
  return hits.map((hit, index) => {
    const source = readSource(hit, index);
    const id = requiredScalar(source.chunk_id, `hits[${index}].chunk_id`, 256);
    if (requiredScalar(hit._id, `hits[${index}]._id`, 256) !== id) {
      throw new ElasticsearchIntegrityError('Elasticsearch hit ID does not match chunk provenance.');
    }
    if (ids.has(id)) {
      throw new ElasticsearchIntegrityError('Elasticsearch returned a duplicate chunk ID.');
    }
    ids.add(id);
    assertHitWithinScope(source, input.scope);
    const score = Number(hit._score);
    if (!Number.isFinite(score) || score < 0) {
      throw new ElasticsearchIntegrityError('Elasticsearch returned an invalid BM25 score.');
    }
    const content = requiredContent(source.content, `hits[${index}].content`, 65_000);
    const trustLevel = source.trust_level as RagTrustLevel;
    const metadata = isRecord(source.metadata) ? { ...source.metadata } : {};
    return {
      id,
      tenantId: source.tenant_id,
      corpusId: source.corpus_id,
      documentId: requiredScalar(source.document_id, `hits[${index}].document_id`, 256),
      documentVersion: requiredScalar(
        source.document_version,
        `hits[${index}].document_version`,
        256
      ),
      content,
      ...(typeof source.source === 'string' && source.source.trim()
        ? { source: source.source.trim() }
        : {}),
      ...(safeInteger(source.page) === undefined ? {} : { page: safeInteger(source.page) }),
      ...(safeInteger(source.start_offset) === undefined
        ? {}
        : { startOffset: safeInteger(source.start_offset) }),
      ...(safeInteger(source.end_offset) === undefined
        ? {}
        : { endOffset: safeInteger(source.end_offset) }),
      retrievalScore: score,
      trustLevel,
      laneId: input.laneId,
      metadata: {
        ...metadata,
        tenantId: source.tenant_id,
        corpusId: source.corpus_id,
        documentId: source.document_id,
        documentVersion: source.document_version,
        trustLevel,
        lexicalMatch: true,
        elasticsearchScore: score,
        retriever: 'elasticsearch-bm25-v1',
      },
    } satisfies RagEvidence;
  });
}

export async function bulkIndexElasticsearchDocuments(input: {
  client: Pick<ElasticsearchClientPort, 'bulk'>;
  indexName: string;
  documents: ElasticsearchLexicalDocument[];
  signal?: AbortSignal;
}): Promise<number> {
  if (input.documents.length === 0) return 0;
  const operations: Record<string, unknown>[] = [];
  for (const document of input.documents) {
    validateLexicalDocument(document);
    operations.push({ index: { _index: input.indexName, _id: document.chunk_id } });
    operations.push({ ...document, indexed_at: new Date().toISOString() });
  }
  const response = await input.client.bulk({ operations, refresh: false }, { signal: input.signal });
  const value = unwrapBody(response);
  if (!isRecord(value) || value.errors !== false) {
    throw new Error('Elasticsearch bulk projection reported one or more failed items.');
  }
  return input.documents.length;
}

export async function bulkDeleteElasticsearchDocuments(input: {
  client: Pick<ElasticsearchClientPort, 'bulk'>;
  indexName: string;
  chunkIds: string[];
  signal?: AbortSignal;
}): Promise<number> {
  if (input.chunkIds.length === 0) return 0;
  const unique = [...new Set(input.chunkIds.map((id, index) =>
    requiredScalar(id, `chunkIds[${index}]`, 256)))];
  const operations = unique.map(id => ({ delete: { _index: input.indexName, _id: id } }));
  const response = await input.client.bulk({ operations, refresh: false }, { signal: input.signal });
  const value = unwrapBody(response);
  if (!isRecord(value) || value.errors !== false) {
    throw new Error('Elasticsearch bulk deletion reported one or more failed items.');
  }
  return unique.length;
}

export async function replaceElasticsearchDocument(input: {
  client: Pick<ElasticsearchClientPort, 'deleteByQuery' | 'bulk'>;
  indexName: string;
  identity: { tenantId: string; corpusId: string; documentId: string };
  documents: ElasticsearchLexicalDocument[];
  signal?: AbortSignal;
}): Promise<number> {
  const tenantId = requiredScalar(input.identity.tenantId, 'tenantId', 128);
  const corpusId = requiredScalar(input.identity.corpusId, 'corpusId', 128);
  const documentId = requiredScalar(input.identity.documentId, 'documentId', 256);
  for (const document of input.documents) {
    if (
      document.tenant_id !== tenantId
      || document.corpus_id !== corpusId
      || document.document_id !== documentId
    ) {
      throw new ElasticsearchIntegrityError(
        'Elasticsearch replacement documents cross the claimed document scope.'
      );
    }
  }
  const deletion = unwrapBody(await input.client.deleteByQuery({
    index: input.indexName,
    conflicts: 'abort',
    refresh: false,
    query: {
      bool: {
        filter: [
          { term: { tenant_id: tenantId } },
          { term: { corpus_id: corpusId } },
          { term: { document_id: documentId } },
        ],
      },
    },
  }, { signal: input.signal }));
  if (isRecord(deletion) && Array.isArray(deletion.failures) && deletion.failures.length > 0) {
    throw new Error('Elasticsearch document replacement deletion failed.');
  }
  return bulkIndexElasticsearchDocuments({
    client: input.client,
    indexName: input.indexName,
    documents: input.documents,
    signal: input.signal,
  });
}

function assertHitWithinScope(source: ElasticsearchLexicalDocument, scope: RagRetrievalScope): void {
  const trustLevel = source.trust_level;
  if (
    source.tenant_id !== scope.tenantId
    || source.corpus_id !== scope.corpusId
    || !scope.allowedTrustLevels.includes(trustLevel)
  ) {
    throw new ElasticsearchIntegrityError('Elasticsearch returned evidence outside the retrieval scope.');
  }
}

function validateLexicalDocument(document: ElasticsearchLexicalDocument): void {
  requiredScalar(document.chunk_id, 'chunk_id', 256);
  requiredScalar(document.tenant_id, 'tenant_id', 128);
  requiredScalar(document.corpus_id, 'corpus_id', 128);
  requiredScalar(document.document_id, 'document_id', 256);
  requiredScalar(document.document_version, 'document_version', 256);
  requiredContent(document.content, 'content', 65_000);
  if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(document.trust_level)) {
    throw new ElasticsearchIntegrityError('Elasticsearch document trust level is invalid.');
  }
}

function readHits(value: unknown): Array<Record<string, unknown>> {
  const body = unwrapBody(value);
  if (!isRecord(body) || !isRecord(body.hits) || !Array.isArray(body.hits.hits)) {
    throw new ElasticsearchIntegrityError('Elasticsearch returned a malformed search response.');
  }
  return body.hits.hits.map((hit, index) => {
    if (!isRecord(hit)) {
      throw new ElasticsearchIntegrityError(`Elasticsearch hit ${index} is malformed.`);
    }
    return hit;
  });
}

function readSource(hit: Record<string, unknown>, index: number): ElasticsearchLexicalDocument {
  if (!isRecord(hit._source)) {
    throw new ElasticsearchIntegrityError(`Elasticsearch hit ${index} has no source.`);
  }
  return hit._source as unknown as ElasticsearchLexicalDocument;
}

function unwrapBody(value: unknown): unknown {
  return isRecord(value) && 'body' in value ? value.body : value;
}

function readErrorType(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const meta = isRecord(error.meta) ? error.meta : undefined;
  const body = meta && isRecord(meta.body) ? meta.body : undefined;
  const detail = body && isRecord(body.error) ? body.error : undefined;
  return typeof detail?.type === 'string' ? detail.type : undefined;
}

function requiredScalar(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ElasticsearchIntegrityError(`Elasticsearch ${field} is invalid.`);
  }
  return value.trim();
}

function requiredContent(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > maxLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new ElasticsearchIntegrityError(`Elasticsearch ${field} is invalid.`);
  }
  return value;
}

function boundedTopK(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error('Elasticsearch topK must be between 1 and 1000.');
  }
  return value;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
