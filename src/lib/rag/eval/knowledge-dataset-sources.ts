import type { DocumentCatalogItem } from '../../documents/document-catalog';
import type { MilvusDocumentQueryIdentity, MilvusQueryRow } from '../../milvus-client';
import { RequestValidationError } from '../../security/request-validation';
import { createRetrievalScope, type RagRetrievalScope } from '../../security/retrieval-scope';
import type { RagEvalCorpusDocument } from './types';

const MAX_DOCUMENTS = 8;
const MAX_DOCUMENT_CHUNKS = 100_000;
const MAX_CHUNKS_PER_DOCUMENT = 6;
const MAX_CHARACTERS = 24_000;

export interface KnowledgeDatasetSourceCoverage {
  documentAssetId: string;
  source: string;
  documentVersion: string;
  totalChunks: number;
  selectedChunks: number;
  characterCount: number;
  sampled: boolean;
}

export interface KnowledgeDatasetSourcePorts {
  listDocuments(scope: RagRetrievalScope): Promise<DocumentCatalogItem[]>;
  queryDocumentRows(
    scope: RagRetrievalScope,
    identity: MilvusDocumentQueryIdentity,
    expectedChunks: number,
    options: { readOnly: true; consistencyLevel: 'Strong'; chunkIndices: number[] }
  ): Promise<MilvusQueryRow[]>;
}

export async function loadKnowledgeDatasetSources(input: {
  documentAssetIds: string[];
  scope: RagRetrievalScope;
  signal?: AbortSignal;
}, ports: KnowledgeDatasetSourcePorts = runtimePorts()): Promise<{
  corpus: RagEvalCorpusDocument[];
  sourceCoverage: KnowledgeDatasetSourceCoverage[];
}> {
  const assetIds = validateAssetIds(input.documentAssetIds);
  const scope = validateScope(input.scope);
  input.signal?.throwIfAborted();
  try {
    const catalog = await ports.listDocuments(scope);
    input.signal?.throwIfAborted();
    const documents = assetIds.map(id => {
      const matches = catalog.filter(document => document.id === id);
      if (matches.length !== 1) fail('KNOWLEDGE_DATASET_DOCUMENT_NOT_FOUND', '所选文档不存在或无权访问，请刷新知识库列表。', 404);
      assertAvailableDocument(matches[0], scope);
      return matches[0];
    });
    const candidates: RagEvalCorpusDocument[][] = [];
    const seenEvidence = new Set<string>();
    for (const document of documents) {
      input.signal?.throwIfAborted();
      const identity = {
        tenantId: scope.tenantId, corpusId: scope.corpusId,
        documentId: document.documentId, documentVersion: document.documentVersion,
        trustLevel: document.trustLevel,
      };
      const indices = sampleChunkIndices(document.chunkCount);
      const rows = await ports.queryDocumentRows(scope, identity, document.chunkCount, {
        readOnly: true, consistencyLevel: 'Strong', chunkIndices: indices,
      });
      input.signal?.throwIfAborted();
      candidates.push(normalizeRows(rows, indices, document, identity, seenEvidence));
    }

    // The catalog, rather than the browser's selection or an old vector row,
    // authorizes the revision. A second read catches concurrent disable/delete.
    const currentCatalog = await ports.listDocuments(scope);
    input.signal?.throwIfAborted();
    for (const before of documents) {
      const matches = currentCatalog.filter(value => value.id === before.id);
      const current = matches[0];
      if (matches.length !== 1 || current.documentId !== before.documentId
        || current.documentVersion !== before.documentVersion || current.trustLevel !== before.trustLevel
        || current.chunkCount !== before.chunkCount) changedDocument();
      assertAvailableDocument(current, scope);
    }

    const selected = selectWithinBudget(candidates);
    const sourceCoverage = documents.map((document, index) => ({
      documentAssetId: document.id, source: document.name, documentVersion: document.documentVersion,
      totalChunks: document.chunkCount, selectedChunks: selected[index].length,
      characterCount: selected[index].reduce((sum, source) => sum + source.content.length, 0),
      sampled: selected[index].length < document.chunkCount,
    }));
    return {
      corpus: selected.flatMap((sources, index) => sources.map(source => ({
        ...source, metadata: { ...source.metadata, selectedChunks: sourceCoverage[index].selectedChunks,
          sampled: sourceCoverage[index].sampled },
      }))),
      sourceCoverage,
    };
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof RequestValidationError) throw error;
    fail('KNOWLEDGE_DATASET_SOURCE_UNAVAILABLE', '无法读取知识库资料，请检查文档索引状态后重试。', 503);
  }
}

function runtimePorts(): KnowledgeDatasetSourcePorts {
  return {
    async listDocuments(scope) {
      const { listDocumentCatalog } = await import('../../documents/document-catalog');
      return listDocumentCatalog({ scope, limit: 1_000 });
    },
    async queryDocumentRows(scope, identity, expectedChunks, options) {
      const [{ getMilvusInstance }, { getMilvusConnectionConfig }] = await Promise.all([
        import('../../milvus-client'), import('../../milvus-config'),
      ]);
      const connection = getMilvusConnectionConfig();
      const store = getMilvusInstance({
        address: connection.address, collectionName: connection.defaultCollection,
        embeddingDimension: connection.defaultDimension, indexType: connection.defaultIndexType,
        metricType: connection.defaultMetricType, token: connection.token, ssl: connection.ssl,
      });
      return store.queryDocumentRows(scope, identity, expectedChunks, options);
    },
  };
}

function validateAssetIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DOCUMENTS) {
    fail('INVALID_KNOWLEDGE_DATASET_SELECTION', '请选择 1 到 8 份知识库文档。', 400);
  }
  const ids = value.map(id => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id.trim())) {
      fail('INVALID_KNOWLEDGE_DATASET_SELECTION', '所选文档标识无效，请刷新列表重新选择。', 400);
    }
    return id.trim();
  });
  if (new Set(ids).size !== ids.length) fail('INVALID_KNOWLEDGE_DATASET_SELECTION', '请勿重复选择同一文档。', 400);
  return ids;
}

function validateScope(scope: RagRetrievalScope): RagRetrievalScope {
  if (scope?.enforceIsolation !== true || !Array.isArray(scope.allowedTrustLevels)
    || !scope.allowedTrustLevels.length || scope.allowedTrustLevels.includes('quarantined')) {
    fail('KNOWLEDGE_DATASET_SCOPE_INVALID', '无法确认当前知识库访问范围。', 403);
  }
  try { return createRetrievalScope({ ...scope, enforceIsolation: true }); }
  catch { fail('KNOWLEDGE_DATASET_SCOPE_INVALID', '无法确认当前知识库访问范围。', 403); }
}

function assertAvailableDocument(document: DocumentCatalogItem, scope: RagRetrievalScope): void {
  if (!document.enabled || document.lifecycle !== 'active' || document.milvusStatus !== 'ready'
    || !Number.isSafeInteger(document.chunkCount) || document.chunkCount < 1 || document.chunkCount > MAX_DOCUMENT_CHUNKS
    || !document.documentVersion?.trim() || ['unknown', 'unversioned'].includes(document.documentVersion)
    || !document.documentId?.trim() || !document.name?.trim()
    || document.trustLevel === 'quarantined' || !scope.allowedTrustLevels.includes(document.trustLevel)) changedDocument();
}

function changedDocument(): never {
  fail('KNOWLEDGE_DATASET_DOCUMENT_CHANGED', '所选文档已变更、停用或尚未完成索引，请刷新列表后重试。', 409);
}

function sampleChunkIndices(total: number): number[] {
  const count = Math.min(total, MAX_CHUNKS_PER_DOCUMENT);
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) => Math.round(index * (total - 1) / (count - 1)));
}

function normalizeRows(
  rows: MilvusQueryRow[], indices: number[], document: DocumentCatalogItem,
  identity: MilvusDocumentQueryIdentity, seenEvidence: Set<string>
): RagEvalCorpusDocument[] {
  if (!Array.isArray(rows) || rows.length !== indices.length) throw new Error('Incomplete selected document inventory.');
  const expectedIndices = new Set(indices);
  const seenIndices = new Set<number>();
  const corpus = rows.map(row => {
    const chunkIndex = indexedInteger(row.chunk_index, 0);
    const totalChunks = indexedInteger(row.total_chunks, 1);
    if (row.tenant_id !== identity.tenantId || row.corpus_id !== identity.corpusId
      || row.document_id !== identity.documentId || row.document_version !== identity.documentVersion
      || row.trust_level !== identity.trustLevel || totalChunks !== document.chunkCount
      || !expectedIndices.has(chunkIndex) || seenIndices.has(chunkIndex)
      || typeof row.id !== 'string' || !row.id.trim() || seenEvidence.has(row.id)) {
      throw new Error('Invalid selected document provenance.');
    }
    seenIndices.add(chunkIndex); seenEvidence.add(row.id);
    const metadata = parseMetadata(row.metadata_json);
    for (const [keys, expected] of [
      [['tenantId', 'tenant_id'], identity.tenantId], [['corpusId', 'corpus_id'], identity.corpusId],
      [['documentId', 'document_id'], identity.documentId], [['documentVersion', 'document_version'], identity.documentVersion],
      [['trustLevel', 'trust_level'], identity.trustLevel], [['chunkIndex', 'chunk_index'], chunkIndex],
      [['totalChunks', 'total_chunks'], document.chunkCount],
    ] as const) {
      for (const key of keys) {
        if (metadata[key] === undefined) continue;
        const actual = typeof expected === 'number' ? indexedInteger(metadata[key], 0) : metadata[key];
        if (actual !== expected) throw new Error('Conflicting source metadata.');
      }
    }
    const content = typeof metadata.originalContent === 'string' && metadata.originalContent.trim()
      ? metadata.originalContent : row.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Empty source chunk.');
    const safeMetadata: Record<string, unknown> = {
      documentAssetId: document.id, chunkIndex, totalChunks,
    };
    for (const [keys, target] of [
      [['page', 'pageNumber', 'page_number'], 'page'],
      [['startOffset', 'start_offset'], 'sourceStartOffset'], [['endOffset', 'end_offset'], 'sourceEndOffset'],
    ] as const) {
      const value = keys.map(key => metadata[key]).find(value => value !== undefined);
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safeMetadata[target] = value;
    }
    return { evidenceId: row.id, documentId: identity.documentId, documentVersion: identity.documentVersion,
      tenantId: identity.tenantId, corpusId: identity.corpusId, trustLevel: identity.trustLevel,
      source: document.name, content, metadata: safeMetadata };
  });
  return corpus.sort((left, right) => Number(left.metadata.chunkIndex) - Number(right.metadata.chunkIndex));
}

function indexedInteger(value: unknown, minimum: number): number {
  // Milvus represents Int64 fields as decimal strings; provenance checks must
  // compare their numeric values without coercing floats, empty strings or booleans.
  const normalized = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new Error('Invalid indexed source integer.');
  }
  return normalized;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 65_000) throw new Error('Invalid source metadata.');
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid source metadata.');
  return parsed as Record<string, unknown>;
}

function selectWithinBudget(candidates: RagEvalCorpusDocument[][]): RagEvalCorpusDocument[][] {
  const selected = candidates.map(sources => [sources.reduce((shortest, source) => source.content.length < shortest.content.length ? source : shortest)]);
  let characters = selected.reduce((sum, sources) => sum + sources[0].content.length, 0);
  if (characters > MAX_CHARACTERS) {
    fail('KNOWLEDGE_DATASET_SOURCES_TOO_LARGE', '所选文档的完整资料片段超过 24,000 字符，请减少文档后重试。', 413);
  }
  // Reserve one whole chunk per document before allocating the remaining budget,
  // so a large first document cannot silently exclude the other selections.
  for (let position = 0; position < MAX_CHUNKS_PER_DOCUMENT; position++) {
    for (const [index, sources] of candidates.entries()) {
      const source = sources[position];
      if (!source || selected[index].includes(source) || characters + source.content.length > MAX_CHARACTERS) continue;
      selected[index].push(source); characters += source.content.length;
    }
  }
  return selected.map(sources => sources.sort((left, right) => Number(left.metadata?.chunkIndex) - Number(right.metadata?.chunkIndex)));
}

function fail(code: string, message: string, status: number): never {
  throw new RequestValidationError(code, message, status);
}
