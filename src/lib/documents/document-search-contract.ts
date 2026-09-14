import type { RagEvidence } from '../rag/core/types';

export type DocumentSearchStrategy = 'hybrid' | 'semantic' | 'keyword';
export type DocumentFileType =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'csv'
  | 'markdown'
  | 'json'
  | 'text'
  | 'url'
  | 'youtube';

export interface DocumentSearchRequest {
  query: string;
  strategy: DocumentSearchStrategy;
  topK: number;
  documentId?: string;
  fileType?: DocumentFileType;
}

export interface DocumentSearchItem {
  id: string;
  documentId: string;
  documentVersion: string;
  title: string;
  snippet: string;
  page?: number;
  score: number;
  trustLevel: RagEvidence['trustLevel'];
  match: 'hybrid' | 'semantic' | 'keyword';
  chunkIndex?: number;
  totalChunks?: number;
}

const STRATEGIES = new Set<DocumentSearchStrategy>(['hybrid', 'semantic', 'keyword']);
const FILE_TYPES = new Set<DocumentFileType>([
  'pdf', 'docx', 'xlsx', 'csv', 'markdown', 'json', 'text', 'url', 'youtube',
]);

export function parseDocumentSearchRequest(value: unknown): DocumentSearchRequest {
  if (!isRecord(value)) throw new Error('Document search request must be an object.');
  const query = boundedText(value.query, 'query', 2_000);
  const strategy = value.strategy === undefined
    ? 'hybrid'
    : boundedEnum(value.strategy, STRATEGIES, 'strategy');
  const topK = value.topK === undefined ? 12 : boundedInteger(value.topK, 'topK', 1, 100);
  const documentId = value.documentId === undefined
    ? undefined
    : boundedIdentifier(value.documentId, 'documentId', 256);
  const fileType = value.fileType === undefined
    ? undefined
    : boundedEnum(value.fileType, FILE_TYPES, 'fileType');

  return {
    query,
    strategy,
    topK,
    ...(documentId ? { documentId } : {}),
    ...(fileType ? { fileType } : {}),
  };
}

export function presentDocumentSearchEvidence(
  evidence: readonly RagEvidence[]
): DocumentSearchItem[] {
  return evidence.map((item) => ({
    id: item.id,
    documentId: item.documentId,
    documentVersion: item.documentVersion,
    title: item.source?.trim() || item.documentId,
    snippet: boundedSnippet(item.content),
    ...(item.page === undefined ? {} : { page: item.page }),
    score: finiteScore(item.retrievalScore ?? item.score ?? 0),
    trustLevel: item.trustLevel,
    match: resolveMatch(item),
    ...(readNonNegativeInteger(item.metadata, ['chunkIndex', 'chunk_index']) === undefined
      ? {}
      : { chunkIndex: readNonNegativeInteger(item.metadata, ['chunkIndex', 'chunk_index']) }),
    ...(readPositiveInteger(item.metadata, ['totalChunks', 'total_chunks']) === undefined
      ? {}
      : { totalChunks: readPositiveInteger(item.metadata, ['totalChunks', 'total_chunks']) }),
  }));
}

export function matchesDocumentFileType(
  evidence: RagEvidence,
  fileType: DocumentFileType | undefined
): boolean {
  if (!fileType) return true;
  const source = (evidence.source ?? evidence.documentId).toLowerCase();
  switch (fileType) {
    case 'pdf': return source.endsWith('.pdf');
    case 'docx': return source.endsWith('.docx') || source.endsWith('.doc');
    case 'xlsx': return source.endsWith('.xlsx') || source.endsWith('.xls');
    case 'csv': return source.endsWith('.csv');
    case 'markdown': return source.endsWith('.md') || source.endsWith('.markdown');
    case 'json': return source.endsWith('.json');
    case 'text': return source.endsWith('.txt');
    case 'youtube': return /(?:youtube\.com|youtu\.be)/i.test(source);
    case 'url': return /^https?:\/\//i.test(source) && !/(?:youtube\.com|youtu\.be)/i.test(source);
  }
}

function resolveMatch(item: RagEvidence): DocumentSearchItem['match'] {
  const matchedLanes = Array.isArray(item.metadata?.matchedLanes)
    ? item.metadata.matchedLanes
    : [];
  const dense = matchedLanes.includes('dense') || item.metadata?.denseMatch === true;
  const lexical = matchedLanes.includes('lexical') || item.metadata?.lexicalMatch === true;
  if (dense && lexical) return 'hybrid';
  return lexical ? 'keyword' : 'semantic';
}

function boundedSnippet(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized.length <= 900 ? normalized : normalized.slice(0, 897) + '...';
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`Document search ${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Document search ${field} is invalid.`);
  }
  return normalized;
}

function boundedIdentifier(value: unknown, field: string, maxLength: number): string {
  const normalized = boundedText(value, field, maxLength);
  if (normalized.includes('..')) throw new Error(`Document search ${field} is invalid.`);
  return normalized;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Document search ${field} must be between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function boundedEnum<T extends string>(value: unknown, values: Set<T>, field: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    throw new Error(`Document search ${field} is invalid.`);
  }
  return value as T;
}

function finiteScore(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function readNonNegativeInteger(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  }
  return undefined;
}

function readPositiveInteger(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): number | undefined {
  const value = readNonNegativeInteger(metadata, keys);
  return value !== undefined && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
