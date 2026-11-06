import type { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { searchGenerationDocuments } from '../elasticsearch/generation-index';
import type { PostgresQueryClient } from '../postgres/client';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import { matchesDocumentSourceFileType, type DocumentFileType } from './document-search-contract';
import { buildPublicationCollectionSchema, createPublicationViewItem, MilvusPublicationGenerationAdapter } from './milvus-publication-generation';
import { assertPublicationViewCurrent, readPublicationView, type PublicationView, type PublishedDocumentView } from './publication-view';
import { settlePublicationReads } from './publication-parallel-reads';

type ElasticsearchSearchClient = Parameters<typeof searchGenerationDocuments>[0]['client'];
type ElasticsearchClient = ElasticsearchSearchClient & {
  indices: { get(request: { index: string | string[]; allow_no_indices: false; ignore_unavailable: false; expand_wildcards: 'none' }): Promise<unknown> };
  msearch?(request: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
};
type MilvusReadClient = Pick<MilvusClient, 'describeCollection' | 'describeIndex' | 'search' | 'insert'>;
type EmbeddingConfig = PublishedDocumentView['embedding'];
type RetrievalInput = {
  scope: RagRetrievalScope;
  query: string;
  topK: number;
  strategy?: 'semantic' | 'keyword' | 'hybrid';
  documentId?: string;
  fileType?: DocumentFileType;
  pg: PostgresQueryClient;
  elasticsearch: ElasticsearchClient;
  milvus: MilvusReadClient;
  embedding(config: EmbeddingConfig, query: string, signal?: AbortSignal): Promise<number[]>;
  signal?: AbortSignal;
};
const MAX_CONCURRENT_DOCUMENTS = 4;
const MAX_FOLLOWUP_SEARCHES = 3;
const MAX_QUERY_BYTES = 8000;
const MAX_FOLLOWUP_QUERY_BYTES = 2048;
const FOLLOWUP_BUDGET_MS = 30_000;
const MAX_SEARCH_HITS = 100;
// Leave room below Elasticsearch's default 4 KiB request-line limit, including
// proxy prefixes. SDKs encode comma-separated index names into the URL path.
const MAX_ES_REQUEST_TARGET_BYTES = 3 * 1024;
const INDEX_TARGET_OPTIONS = { allow_no_indices: false, ignore_unavailable: false, expand_wildcards: 'none' } as const;

/**
 * One-document backend readback. These checks establish resource identities at
 * two observed times; they do not prove exclusive writers or seal an index.
 * Do not expose this as production retrieval until a trusted publisher and
 * deployment capability checks establish those separate guarantees.
 */
export async function retrievePublicationDocument(input: RetrievalInput & { documentId: string }) {
  validateRequest(input);
  if (typeof input.documentId !== 'string' || !input.documentId.trim()
    || input.documentId !== input.documentId.trim()) throw new Error('Invalid publication retrieval request.');
  assertNotAborted(input.signal);
  const view = await readPublicationView(input.scope, input.pg);
  const scope = scopeFromView(view);
  const options = { ...input, scope };
  const document = view.documents.find(item => item.documentId === input.documentId);
  if (!document) throw new Error('Publication document is unavailable.');
  const selected = selectDocument(scope, document, input.fileType);
  const result = selected ? await retrieveOne(options, selected,
    () => input.embedding(selected.embedding, input.query, input.signal))
    : { documentId: document.documentId, generation: document.generation, dense: [], lexical: [] };
  await assertPublicationViewCurrent(view, scope, input.pg);
  assertNotAborted(input.signal);
  return { viewDigest: view.digest, ...result, productionAuthorized: false as const };
}

/**
 * Searches every document in one issued view; failures discard all candidates.
 * Each independent physical index is searched to the same candidate depth.
 * Only comparable cosine scores may be merged across collections.
 */
export async function retrievePublicationCorpus(input: RetrievalInput, onIssuedView?: (view: PublicationView) => void) {
  validateRequest(input);
  assertNotAborted(input.signal);
  const view = await readPublicationView(input.scope, input.pg);
  // Notify trusted server callers of this exact issued view. A caller cannot
  // inject a replacement view or bypass the final freshness check below.
  assertNotAborted(input.signal);
  onIssuedView?.(view);
  return retrieveCorpusWithView({ ...input, scope: scopeFromView(view) }, view);
}

/**
 * Bounded follow-up searches inherit one server-issued view, rather than
 * silently switching publications between the first and subsequent queries.
 */
export async function openPublicationRetriever(input: Omit<RetrievalInput, 'query' | 'topK' | 'signal'>) {
  const deadline = performance.now() + FOLLOWUP_BUDGET_MS;
  const view = await withinDeadline(readPublicationView(input.scope, input.pg), deadline);
  const scope = scopeFromView(view);
  let searches = 0;
  return Object.freeze({ viewDigest: view.digest, async search(request: {
    query: string; topK: number; strategy?: RetrievalInput['strategy']; signal?: AbortSignal;
  }) {
    // Only model-supplied query options cross this boundary. Never spread the
    // request: doing so could replace trusted scope, clients, or embedding.
    const options = { ...input, scope, query: request.query, topK: request.topK,
      strategy: request.strategy ?? input.strategy, signal: request.signal };
    if (typeof request.query !== 'string' || Buffer.byteLength(request.query, 'utf8') > MAX_FOLLOWUP_QUERY_BYTES) {
      throw new Error('Invalid publication retrieval request.');
    }
    validateRequest(options);
    assertNotAborted(options.signal);
    const remaining = Math.floor(deadline - performance.now());
    if (searches >= MAX_FOLLOWUP_SEARCHES || remaining < 1) throw new Error('Publication retrieval budget exhausted.');
    searches++;
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(remaining)]);
    const boundedOptions = { ...options, signal };
    const cancelled = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error('Publication retrieval budget exhausted or cancelled.'));
      else signal.addEventListener('abort', () => reject(new Error('Publication retrieval budget exhausted or cancelled.')), { once: true });
    });
    return withinDeadline(Promise.race([cancelled, (async () => {
      await assertPublicationViewCurrent(view, scope, options.pg);
      assertNotAborted(signal);
      return retrieveCorpusWithView(boundedOptions, view);
    })()]), deadline);
  } });
}

function scopeFromView(view: PublicationView): RagRetrievalScope {
  return { tenantId: view.tenantId, corpusId: view.corpusId, enforceIsolation: true,
    allowedTrustLevels: [...view.allowedTrustLevels] };
}

async function retrieveCorpusWithView(input: RetrievalInput, view: PublicationView) {
  const vectors = new Map<string, Promise<number[]>>();
  const selected = view.documents.filter(document => !input.documentId || document.documentId === input.documentId)
    .map(document => selectDocument(input.scope, document, input.fileType))
    .filter((document): document is PublishedDocumentView => document !== undefined);
  const strategy = input.strategy ?? 'hybrid';
  if (selected.length > 1 && strategy !== 'keyword'
    && selected.some(item => JSON.stringify(item.embedding) !== JSON.stringify(selected[0].embedding))) {
    throw new Error('Publication corpus scores are incomparable across these documents.');
  }
  const sharedElasticsearchFence = selected.length > 1;
  // One outer interval covers every document and the global lexical query.
  // Checks performed inside concurrent workers cannot establish this ordering.
  if (sharedElasticsearchFence) await assertElasticsearchIdentities(input.elasticsearch, selected);
  assertNotAborted(input.signal);
  const results: Array<Awaited<ReturnType<typeof retrieveOne>>> = new Array(selected.length);
  let next = 0;
  const work = async () => {
    while (next < selected.length) {
      const index = next++;
      const document = selected[index];
      assertNotAborted(input.signal);
      results[index] = await retrieveOne(input, document, () => {
        const vectorKey = JSON.stringify(document.embedding);
        let vector = vectors.get(vectorKey);
        if (!vector) { vector = input.embedding(document.embedding, input.query, input.signal); vectors.set(vectorKey, vector); }
        return vector;
      }, selected.length > 1, sharedElasticsearchFence);
    }
  };
  const [, globalLexical] = await (async () => {
    try {
      return await settlePublicationReads([
        () => settlePublicationReads(Array.from({ length: Math.min(MAX_CONCURRENT_DOCUMENTS, selected.length) }, () => work)),
        () => selected.length > 1 && strategy !== 'semantic' ? searchPublicationIndexes(input, selected) : Promise.resolve(undefined),
      ]);
    } finally {
      // allSettled above retains every started RPC, including failures and
      // non-cooperative cancellation, until this final physical check can run.
      if (sharedElasticsearchFence) await assertElasticsearchIdentities(input.elasticsearch, selected);
    }
  })();
  assertNotAborted(input.signal);
  if (globalLexical) for (const result of results) result.lexical = globalLexical.filter(hit =>
    hit.document.document_id === result.documentId && hit.document.publication_generation === result.generation);
  await assertPublicationViewCurrent(view, input.scope, input.pg);
  assertNotAborted(input.signal);
  return { viewDigest: view.digest, candidateDepthPerDocument: input.topK,
    ranking: rankPublicationCandidates(results, input.topK, strategy, globalLexical), documents: results,
    productionAuthorized: false as const };
}

function selectDocument(scope: RagRetrievalScope, document: PublishedDocumentView,
  fileType: DocumentFileType | undefined): PublishedDocumentView | undefined {
  if (!fileType) return document;
  const allowed = new Set(document.searchSources.filter(item => matchesDocumentSourceFileType(item.source, fileType))
    .map(item => item.chunkId));
  if (!allowed.size) return undefined;
  const chunks = document.milvus.chunks.filter(item => allowed.has(item.id));
  const lexical = document.elasticsearch.chunks.filter(item => allowed.has(item.chunkId));
  if (chunks.length !== allowed.size || lexical.length !== allowed.size) throw new Error('Publication source selection is inconsistent.');
  return { ...document, milvus: createPublicationViewItem(scope, { ...document.milvus, chunks }),
    elasticsearch: { ...document.elasticsearch, chunks: lexical } };
}

async function retrieveOne(input: RetrievalInput, document: PublishedDocumentView, getVector: () => Promise<number[]>,
  skipLexical = false, sharedElasticsearchFence = false) {
  await settlePublicationReads([
    () => sharedElasticsearchFence ? Promise.resolve() : assertElasticsearchIdentity(input.elasticsearch, document),
    () => assertMilvusPublicationIdentity(input.milvus, document),
  ]);
  assertNotAborted(input.signal);
  const strategy = input.strategy ?? 'hybrid';
  const retrieveDense = async () => {
    const vector = await getVector();
    assertNotAborted(input.signal);
    const milvusAdapter = new MilvusPublicationGenerationAdapter(input.milvus, document.collection, document.embedding.dimension);
    return milvusAdapter.search(input.scope, [document.milvus], vector, input.topK);
  };
  const [dense, lexical] = await settlePublicationReads([
    () => strategy === 'keyword' ? Promise.resolve([]) : retrieveDense(),
    () => strategy === 'semantic' || skipLexical ? Promise.resolve([]) : searchGenerationDocuments({ client: input.elasticsearch,
      indexName: document.indexName, scope: input.scope, pairs: [document.elasticsearch], query: input.query,
      topK: input.topK, signal: input.signal }),
  ]);
  assertNotAborted(input.signal);
  await settlePublicationReads([
    () => sharedElasticsearchFence ? Promise.resolve() : assertElasticsearchIdentity(input.elasticsearch, document),
    () => assertMilvusPublicationIdentity(input.milvus, document),
  ]);
  assertNotAborted(input.signal);
  return { documentId: document.documentId, generation: document.generation, dense, lexical,
    originalName: document.originalName, sources: document.searchSources };
}

/** Called only inside the corpus-wide ES fences; BM25 uses a common DFS corpus. */
async function searchPublicationIndexes(input: RetrievalInput, documents: PublishedDocumentView[]) {
  const indexForDocument = new Map(documents.map(document => [document.documentId, document.indexName]));
  if (new Set(indexForDocument.values()).size !== documents.length) throw new Error('Publication index identity is ambiguous.');
  assertNotAborted(input.signal);
  const names = documents.map(item => item.indexName);
  const searchOptions = { ...INDEX_TARGET_OPTIONS, search_type: 'dfs_query_then_fetch', allow_partial_search_results: false } as const;
  const client: ElasticsearchSearchClient = { async search(request, options) {
    const originalQuery = request.query;
    const searchBody: Record<string, unknown> = { ...request,
      query: { bool: { must: [originalQuery], filter: [{ bool: { should: documents.map(item => ({ bool: { filter: [
        { term: { _index: item.indexName } }, { term: { document_id: item.documentId } },
        { term: { publication_generation: item.generation } }, { term: { document_version: item.elasticsearch.documentVersion } },
        { terms: { chunk_id: item.elasticsearch.chunks.map(chunk => chunk.chunkId) } },
      ] } })), minimum_should_match: 1 } }] } },
    };
    delete searchBody.index;
    let response: unknown;
    if (indexRequestTargetBytes(names, '/_search', searchOptions) <= MAX_ES_REQUEST_TARGET_BYTES) {
      response = await input.elasticsearch.search({ ...searchBody, index: names, ...searchOptions }, options);
    } else {
      if (!input.elasticsearch.msearch) throw new Error('Publication search requires bounded multi-search transport.');
      // One NDJSON item keeps the exact same global DFS corpus and ranking;
      // splitting searches or searching all indices with a filter would not.
      const multiple = record(body(await input.elasticsearch.msearch({ searches: [
        { index: names, ...searchOptions }, searchBody,
      ] }, options)));
      if (!Array.isArray(multiple.responses) || multiple.responses.length !== 1) {
        throw new Error('Malformed publication multi-search response.');
      }
      const item = record(multiple.responses[0]);
      if (Object.hasOwn(item, 'error') || (item.status !== undefined
        && (!Number.isInteger(item.status) || Number(item.status) < 200 || Number(item.status) >= 300))) {
        throw new Error('Publication multi-search failed.');
      }
      response = item;
    }
    const raw = record(body(response));
    const hits = record(raw.hits).hits;
    if (!Array.isArray(hits)) throw new Error('Malformed publication index results.');
    for (const value of hits) {
      const hit = record(value); const source = record(hit._source);
      if (typeof source.document_id !== 'string' || hit._index !== indexForDocument.get(source.document_id)) {
        throw new Error('Publication index provenance mismatch.');
      }
    }
    return response;
  } };
  const hits = await searchGenerationDocuments({ client, indexName: documents[0].indexName, scope: input.scope,
    pairs: documents.map(item => item.elasticsearch), query: input.query, topK: input.topK, signal: input.signal });
  assertNotAborted(input.signal);
  return hits;
}

/** COSINE scores are comparable only after callers verify a common embedding space. */
export function rankPublicationCandidates(
  results: readonly { documentId: string; generation: string;
    dense: readonly { id: string; score?: number }[]; lexical: readonly { document: { chunk_id: string } }[] }[],
  topK: number, strategy: NonNullable<RetrievalInput['strategy']> = 'hybrid',
  globalLexical?: readonly { document: { document_id: string; publication_generation: string; chunk_id: string } }[]
) {
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > MAX_SEARCH_HITS) throw new Error('Invalid publication retrieval limit.');
  if (results.length > 1 && strategy === 'semantic') {
    const candidates = results.flatMap(document => document.dense.map(item => {
      if (typeof item.id !== 'string' || !item.id || typeof item.score !== 'number'
        || !Number.isFinite(item.score) || item.score < -1.000001 || item.score > 1.000001) {
        throw new Error('Invalid publication cosine score.');
      }
      return { documentId: document.documentId, generation: document.generation, chunkId: item.id, score: item.score };
    }));
    return candidates.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId)
      || a.chunkId.localeCompare(b.chunkId)).slice(0, topK);
  }
  if (results.length > 1) {
    if (results.some(result => result.lexical.length) && !globalLexical) throw new Error('Publication corpus requires globally ranked lexical results.');
    const dense = results.flatMap(result => result.dense.map(item => ({ result, item })));
    if (dense.some(({ item }) => typeof item.score !== 'number' || !Number.isFinite(item.score)
      || item.score < -1.000001 || item.score > 1.000001)) throw new Error('Invalid publication cosine score.');
    dense.sort((a, b) => b.item.score! - a.item.score! || a.result.documentId.localeCompare(b.result.documentId)
      || a.item.id.localeCompare(b.item.id));
    const entries = new Map<string, { documentId: string; generation: string; chunkId: string; score: number; denseRank?: number; lexicalRank?: number }>();
    const add = (documentId: string, generation: string, chunkId: string, rank: number, source: 'dense' | 'lexical') => {
      const key = JSON.stringify([documentId, generation, chunkId]);
      const entry = entries.get(key) ?? { documentId, generation, chunkId, score: 0 };
      if ((source === 'dense' && entry.denseRank) || (source === 'lexical' && entry.lexicalRank)) throw new Error('Duplicate publication candidate.');
      entry.score += 1 / (60 + rank);
      if (source === 'dense') entry.denseRank = rank; else entry.lexicalRank = rank;
      entries.set(key, entry);
    };
    dense.forEach(({ result, item }, index) => add(result.documentId, result.generation, item.id, index + 1, 'dense'));
    globalLexical?.forEach((hit, index) => add(hit.document.document_id, hit.document.publication_generation, hit.document.chunk_id, index + 1, 'lexical'));
    return [...entries.values()].sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId)
      || a.chunkId.localeCompare(b.chunkId)).slice(0, topK);
  }
  const entries = new Map<string, { documentId: string; generation: string; chunkId: string; score: number;
    denseRank?: number; lexicalRank?: number }>();
  for (const document of results) {
    for (const [source, list] of [['dense', document.dense], ['lexical', document.lexical]] as const) {
      const seen = new Set<string>();
      for (const [index, item] of list.entries()) {
        const chunkId = source === 'dense' ? (item as { id: string }).id : (item as { document: { chunk_id: string } }).document.chunk_id;
        if (typeof chunkId !== 'string' || !chunkId || seen.has(chunkId)) throw new Error('Invalid publication candidate identity.');
        seen.add(chunkId);
        const key = JSON.stringify([document.documentId, document.generation, chunkId]);
        const entry = entries.get(key) ?? { documentId: document.documentId, generation: document.generation, chunkId, score: 0 };
        entry.score += 1 / (60 + index + 1);
        if (source === 'dense') entry.denseRank = index + 1;
        else entry.lexicalRank = index + 1;
        entries.set(key, entry);
      }
    }
  }
  return [...entries.values()].sort((left, right) => right.score - left.score
    || (left.documentId < right.documentId ? -1 : left.documentId > right.documentId ? 1 : 0)
    || (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0)).slice(0, topK);
}

function validateRequest(input: RetrievalInput): void {
  if (typeof input.query !== 'string' || !input.query.trim()
    || Buffer.byteLength(input.query, 'utf8') > MAX_QUERY_BYTES
    || !Number.isSafeInteger(input.topK) || input.topK < 1 || input.topK > MAX_SEARCH_HITS
    || (input.strategy !== undefined && !['semantic', 'keyword', 'hybrid'].includes(input.strategy))
    || (input.documentId !== undefined && (typeof input.documentId !== 'string' || !input.documentId.trim()
      || input.documentId !== input.documentId.trim() || input.documentId.length > 256))
    || (input.fileType !== undefined && !['pdf', 'docx', 'xlsx', 'csv', 'markdown', 'json', 'text', 'url', 'youtube'].includes(input.fileType))
    || typeof input.embedding !== 'function') throw new Error('Invalid publication retrieval request.');
}

async function assertElasticsearchIdentity(client: ElasticsearchClient, document: PublishedDocumentView): Promise<void> {
  const response = record(body(await client.indices.get({ index: document.indexName, allow_no_indices: false,
    ignore_unavailable: false, expand_wildcards: 'none' })));
  if (Object.keys(response).length !== 1 || !Object.hasOwn(response, document.indexName)) {
    throw new Error('Elasticsearch publication index identity is ambiguous.');
  }
  assertElasticsearchIndexEntry(response[document.indexName], document);
}

/** Validate the exact concrete index set before and after the whole corpus read. */
async function assertElasticsearchIdentities(client: ElasticsearchClient, documents: readonly PublishedDocumentView[]): Promise<void> {
  const names = documents.map(document => document.indexName);
  if (!names.length || new Set(names).size !== names.length) throw new Error('Publication index identity is ambiguous.');
  const batches: PublishedDocumentView[][] = [];
  let batch: PublishedDocumentView[] = [];
  for (const document of documents) {
    if (indexRequestTargetBytes([document.indexName], '', INDEX_TARGET_OPTIONS) > MAX_ES_REQUEST_TARGET_BYTES) {
      throw new Error('Publication index metadata request exceeds its URI budget.');
    }
    const next = [...batch, document];
    if (indexRequestTargetBytes(next.map(item => item.indexName), '', INDEX_TARGET_OPTIONS) > MAX_ES_REQUEST_TARGET_BYTES) {
      batches.push(batch);
      batch = [];
    }
    batch.push(document);
  }
  if (batch.length) batches.push(batch);
  // A failed batch cannot release a leased client while a sibling is still
  // reading, and no retrieval begins until every pre-fence batch has settled.
  await settlePublicationReads(batches.map(items => () => assertElasticsearchIdentityBatch(client, items)));
}

function indexRequestTargetBytes(names: readonly string[], suffix: string, query: Record<string, string | boolean>): number {
  const parameters = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  return Buffer.byteLength(`/${encodeURIComponent(names.join(','))}${suffix}?${parameters}`, 'utf8');
}

async function assertElasticsearchIdentityBatch(client: ElasticsearchClient, documents: readonly PublishedDocumentView[]): Promise<void> {
  const names = documents.map(document => document.indexName);
  const response = record(body(await client.indices.get({ index: names, ...INDEX_TARGET_OPTIONS })));
  // Exact key equality rejects partial responses, alias expansion and extra
  // indices; every expected UUID, owner and write block is still checked.
  if (Object.keys(response).length !== names.length || names.some(name => !Object.hasOwn(response, name))) {
    throw new Error('Elasticsearch publication index identity is not concrete.');
  }
  for (const document of documents) assertElasticsearchIndexEntry(response[document.indexName], document);
}

function assertElasticsearchIndexEntry(value: unknown, document: PublishedDocumentView): void {
  const entry = record(value);
  const aliases = record(entry.aliases);
  const metadata = record(record(entry.mappings)._meta);
  const settings = record(record(entry.settings).index);
  const blocks = record(settings.blocks);
  if (Object.keys(aliases).length !== 0 || metadata.generation_owner !== document.ownerMarker
    || settings.uuid !== document.indexUuid) throw new Error('Elasticsearch publication index identity changed.');
  if (blocks.write !== true && blocks.write !== 'true') throw new Error('Elasticsearch publication index is not sealed.');
}

export async function assertMilvusPublicationIdentity(client: MilvusReadClient, document: PublishedDocumentView): Promise<void> {
  // The root manifest binds this identifier to the only schema supported here.
  if (document.embedding.indexSchema !== 'milvus-publication/v1') throw new Error('Unsupported publication index schema.');
  const response = record(await client.describeCollection({ collection_name: document.collection, cache: false }));
  const status = record(response.status);
  const schema = record(response.schema);
  if (status.error_code !== 'Success' || response.collection_name !== document.collection
    || String(response.collectionID) !== document.collectionId || schema.name !== document.collection) {
    throw new Error('Milvus publication collection identity changed.');
  }
  const expected = buildPublicationCollectionSchema(document.collection, document.embedding.dimension).fields;
  if (schema.enable_dynamic_field !== false || !Array.isArray(schema.fields) || schema.fields.length !== expected.length) {
    throw new Error('Invalid Milvus publication schema.');
  }
  for (const item of expected) {
    const matches = schema.fields.map(record).filter(field => field.name === item.name);
    if (matches.length !== 1) throw new Error('Invalid Milvus publication field.');
    const field = matches[0];
    const type = ({ 21: 'VarChar', 5: 'Int64', 101: 'FloatVector' } as Record<number, string>)[item.data_type];
    const expectedParams = 'max_length' in item ? [{ key: 'max_length', value: String(item.max_length) }]
      : 'dim' in item ? [{ key: 'dim', value: String(item.dim) }] : [];
    if (field.data_type !== type || field.is_primary_key !== (('is_primary_key' in item && item.is_primary_key) || false)
      || (field.autoID !== false && field.autoID !== undefined) || field.nullable === true
      || !Array.isArray(field.type_params) || JSON.stringify(field.type_params) !== JSON.stringify(expectedParams)) {
      throw new Error('Milvus publication schema changed.');
    }
  }
  const indexResponse = record(await client.describeIndex({ collection_name: document.collection, field_name: 'embedding' }));
  if (record(indexResponse.status).error_code !== 'Success' || !Array.isArray(indexResponse.index_descriptions)
    || indexResponse.index_descriptions.length !== 1) throw new Error('Invalid Milvus publication index.');
  const index = record(indexResponse.index_descriptions[0]);
  if (index.field_name !== 'embedding' || index.index_name !== 'publication_vector_index' || index.state !== 'Finished'
    || !Array.isArray(index.params)) throw new Error('Invalid Milvus publication index.');
  for (const [key, value] of [['index_type', 'FLAT'], ['metric_type', 'COSINE']]) {
    const params = index.params.map(record).filter(param => param.key === key);
    if (params.length !== 1 || params[0].value !== value) throw new Error('Milvus publication index metric changed.');
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error('Publication retrieval cancelled.'), { name: 'AbortError' });
}
async function withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new Error('Publication retrieval budget exhausted.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Publication retrieval budget exhausted.')), remaining);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed publication backend response.');
  return value as Record<string, unknown>;
}
function body(value: unknown): unknown {
  return value && typeof value === 'object' && 'body' in value ? (value as Record<string, unknown>).body : value;
}
