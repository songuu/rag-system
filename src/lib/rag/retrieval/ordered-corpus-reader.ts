import type { MilvusQueryRow, MilvusSearchResult } from '../../milvus-client';
import type { RagEvidence } from '../core/types';
import type { RagRetrievalScope, RagTrustLevel } from '../../security/retrieval-scope';
import { adaptMilvusSearchResultsToEvidence } from './legacy-evidence-adapter';
import { invokePreRouteProviderWithDeadline } from './pre-route-provider-deadline';

export const ORDERED_CORPUS_READER_VERSION = 'ordered-corpus-reader/v1' as const;
export const DEFAULT_ORDERED_CORPUS_PROVIDER_TIMEOUT_MS = 5_000;

export const DEFAULT_ORDERED_CORPUS_LIMITS = {
  maxDocuments: 6,
  maxCharacters: 120_000,
  maxChunks: 256,
} as const;

export interface OrderedCorpusLimits {
  maxDocuments: number;
  maxCharacters: number;
  maxChunks: number;
}

export interface OrderedCorpusInventory {
  documentCount: number;
  characterCount: number;
  chunkCount: number;
  complete: boolean;
}

export interface OrderedCorpusSnapshot {
  version: typeof ORDERED_CORPUS_READER_VERSION;
  usable: boolean;
  reason:
    | 'complete'
    | 'empty_corpus'
    | 'schema_unavailable'
    | 'provider_unavailable'
    | 'chunk_limit_exceeded'
    | 'document_limit_exceeded'
    | 'character_limit_exceeded'
    | 'invalid_chunk_inventory';
  inventory: OrderedCorpusInventory;
  evidence: RagEvidence[];
  searchResults: MilvusSearchResult[];
}

export interface OrderedCorpusMilvusPort {
  connect(): Promise<void>;
  initializeCollection(): Promise<void>;
  hasOrderedContextSchema(): boolean;
  queryOrderedCorpusRows(scope: RagRetrievalScope, maxChunks: number): Promise<MilvusQueryRow[]>;
}

export class OrderedCorpusScopeError extends Error {
  readonly code = 'RAG_ORDERED_CORPUS_SCOPE_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'OrderedCorpusScopeError';
  }
}

export async function readBoundedOrderedCorpus(input: {
  store: OrderedCorpusMilvusPort;
  scope: RagRetrievalScope;
  laneId: string;
  limits?: Partial<OrderedCorpusLimits>;
  signal?: AbortSignal;
  deadlineMs?: number;
  providerKey?: string;
}): Promise<OrderedCorpusSnapshot> {
  const limits = resolveLimits(input.limits);
  let rows: MilvusQueryRow[];
  try {
    const providerRead = await invokePreRouteProviderWithDeadline({
      operationKey: input.providerKey ?? `ordered-corpus:${input.laneId}`,
      timeoutMs: input.deadlineMs ?? DEFAULT_ORDERED_CORPUS_PROVIDER_TIMEOUT_MS,
      signal: input.signal,
      async invoke(signal) {
        signal.throwIfAborted();
        await input.store.connect();
        signal.throwIfAborted();
        await input.store.initializeCollection();
        signal.throwIfAborted();
        if (!input.store.hasOrderedContextSchema()) {
          return { schemaAvailable: false as const, rows: [] };
        }
        const providerRows = await input.store.queryOrderedCorpusRows(
          input.scope,
          limits.maxChunks
        );
        signal.throwIfAborted();
        return { schemaAvailable: true as const, rows: providerRows };
      },
    });
    if (!providerRead.schemaAvailable) {
      return unavailable('schema_unavailable');
    }
    rows = providerRead.rows;
  } catch (error) {
    // Cancellation and provenance failures retain fail-closed semantics. Provider
    // transport/availability failures become a diagnostic-only snapshot so both
    // shadow and active modes can use the authoritative dense rollback lane.
    if (input.signal?.aborted || error instanceof OrderedCorpusScopeError) throw error;
    return unavailable('provider_unavailable');
  }
  if (rows.length > limits.maxChunks) {
    return unavailable('chunk_limit_exceeded', { chunkCount: rows.length });
  }
  if (rows.length === 0) {
    return unavailable('empty_corpus');
  }

  let normalized: Array<ReturnType<typeof normalizeRow>>;
  try {
    normalized = rows.map((row, index) => normalizeRow(row, index, input.scope));
  } catch (error) {
    if (error instanceof OrderedCorpusScopeError) throw error;
    return unavailable('invalid_chunk_inventory');
  }
  normalized.sort(compareOrderedRows);
  const documentVersions = new Map<string, string>();
  const documentChunks = new Map<string, { total: number; indices: Set<number> }>();
  const evidenceIds = new Set<string>();
  let characterCount = 0;

  for (const item of normalized) {
    if (evidenceIds.has(item.result.id)) {
      return unavailable('invalid_chunk_inventory');
    }
    evidenceIds.add(item.result.id);
    characterCount += item.result.content.length;
    const priorVersion = documentVersions.get(item.documentId);
    if (priorVersion !== undefined && priorVersion !== item.documentVersion) {
      return unavailable('invalid_chunk_inventory');
    }
    documentVersions.set(item.documentId, item.documentVersion);
    const key = item.documentId + '\u001f' + item.documentVersion;
    const chunks = documentChunks.get(key) ?? { total: item.totalChunks, indices: new Set<number>() };
    if (chunks.total !== item.totalChunks || chunks.indices.has(item.chunkIndex)) {
      return unavailable('invalid_chunk_inventory');
    }
    chunks.indices.add(item.chunkIndex);
    documentChunks.set(key, chunks);
  }

  if (documentVersions.size > limits.maxDocuments) {
    return unavailable('document_limit_exceeded', {
      documentCount: documentVersions.size,
      characterCount,
      chunkCount: normalized.length,
    });
  }
  if (characterCount > limits.maxCharacters) {
    return unavailable('character_limit_exceeded', {
      documentCount: documentVersions.size,
      characterCount,
      chunkCount: normalized.length,
    });
  }
  for (const chunks of documentChunks.values()) {
    if (chunks.indices.size !== chunks.total) return unavailable('invalid_chunk_inventory');
    for (let index = 0; index < chunks.total; index += 1) {
      if (!chunks.indices.has(index)) return unavailable('invalid_chunk_inventory');
    }
  }

  const searchResults = normalized.map(item => item.result);
  let evidence: RagEvidence[];
  try {
    evidence = adaptMilvusSearchResultsToEvidence(searchResults, {
      laneId: input.laneId,
      scope: input.scope,
    });
  } catch {
    return unavailable('invalid_chunk_inventory');
  }
  return {
    version: ORDERED_CORPUS_READER_VERSION,
    usable: true,
    reason: 'complete',
    inventory: {
      documentCount: documentVersions.size,
      characterCount,
      chunkCount: normalized.length,
      complete: true,
    },
    evidence,
    searchResults,
  };
}

function normalizeRow(
  row: MilvusQueryRow,
  index: number,
  scope: RagRetrievalScope
): {
  result: MilvusSearchResult;
  documentId: string;
  documentVersion: string;
  chunkIndex: number;
  totalChunks: number;
  page?: number;
  startOffset?: number;
} {
  const id = requiredString(row.id, 'id', index);
  const content = requiredString(row.content, 'content', index);
  const tenantId = requiredString(row.tenant_id, 'tenant_id', index);
  const corpusId = requiredString(row.corpus_id, 'corpus_id', index);
  const documentId = requiredString(row.document_id, 'document_id', index);
  const documentVersion = requiredString(row.document_version, 'document_version', index);
  const trustLevel = requiredString(row.trust_level, 'trust_level', index) as RagTrustLevel;
  if (tenantId !== scope.tenantId || corpusId !== scope.corpusId) {
    throw new OrderedCorpusScopeError('Ordered corpus row is outside the authenticated scope.');
  }
  if (trustLevel === 'quarantined' || !scope.allowedTrustLevels.includes(trustLevel)) {
    throw new OrderedCorpusScopeError('Ordered corpus row is outside the allowed trust boundary.');
  }
  if (documentVersion === 'unversioned') {
    throw new Error('Ordered corpus row requires a stable document version.');
  }
  const chunkIndex = requiredInteger(row.chunk_index, 'chunk_index', index, 0);
  const totalChunks = requiredInteger(row.total_chunks, 'total_chunks', index, 1);
  if (chunkIndex >= totalChunks) {
    throw new Error('Ordered corpus chunk index exceeds total chunks.');
  }

  const metadata = parseMetadata(row.metadata_json);
  const originalContent = typeof metadata.originalContent === 'string'
    && metadata.originalContent.trim()
    ? metadata.originalContent
    : content;
  const canonicalMetadata = {
    ...metadata,
    tenantId,
    tenant_id: tenantId,
    corpusId,
    corpus_id: corpusId,
    documentId,
    document_id: documentId,
    documentVersion,
    document_version: documentVersion,
    trustLevel,
    trust_level: trustLevel,
    chunkIndex,
    chunk_index: chunkIndex,
    totalChunks,
    total_chunks: totalChunks,
    source: typeof row.source === 'string' ? row.source : metadata.source,
  };
  return {
    result: {
      id,
      content: originalContent,
      metadata: canonicalMetadata,
      score: 1,
      distance: 0,
    },
    documentId,
    documentVersion,
    chunkIndex,
    totalChunks,
    page: optionalInteger(metadata.page ?? metadata.pageNumber ?? metadata.page_number, 1),
    startOffset: optionalInteger(metadata.startOffset ?? metadata.start_offset, 0),
  };
}

function compareOrderedRows(
  left: ReturnType<typeof normalizeRow>,
  right: ReturnType<typeof normalizeRow>
): number {
  return left.documentId.localeCompare(right.documentId)
    || left.documentVersion.localeCompare(right.documentVersion)
    || compareOptional(left.page, right.page)
    || compareOptional(left.startOffset, right.startOffset)
    || left.chunkIndex - right.chunkIndex
    || left.result.id.localeCompare(right.result.id);
}

function compareOptional(left?: number, right?: number): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function requiredString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OrderedCorpusScopeError('Ordered corpus row[' + index + '] is missing ' + field + '.');
  }
  return value.trim();
}

function requiredInteger(
  value: unknown,
  field: string,
  index: number,
  minimum: number
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error('Ordered corpus row[' + index + '] has invalid ' + field + '.');
  }
  return value;
}

function optionalInteger(value: unknown, minimum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : undefined;
}

function resolveLimits(input: Partial<OrderedCorpusLimits> | undefined): OrderedCorpusLimits {
  const limits = { ...DEFAULT_ORDERED_CORPUS_LIMITS, ...input };
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('Ordered corpus ' + field + ' must be a positive safe integer.');
    }
  }
  if (limits.maxChunks > 512 || limits.maxCharacters > 500_000 || limits.maxDocuments > 32) {
    throw new Error('Ordered corpus limits exceed the production safety ceiling.');
  }
  return limits;
}

function unavailable(
  reason: Exclude<OrderedCorpusSnapshot['reason'], 'complete'>,
  inventory: Partial<OrderedCorpusInventory> = {}
): OrderedCorpusSnapshot {
  return {
    version: ORDERED_CORPUS_READER_VERSION,
    usable: false,
    reason,
    inventory: {
      documentCount: inventory.documentCount ?? 0,
      characterCount: inventory.characterCount ?? 0,
      chunkCount: inventory.chunkCount ?? 0,
      complete: false,
    },
    evidence: [],
    searchResults: [],
  };
}
