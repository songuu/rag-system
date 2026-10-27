import type { DocumentCatalogSummary } from './document-catalog';

export type DocumentChunkCounts = Pick<DocumentCatalogSummary,
  'chunkCount' | 'searchableChunkCount' | 'disabledChunkCount'>;

export function parseDocumentChunkCounts(value: unknown): DocumentChunkCounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const fields = ['chunkCount', 'searchableChunkCount', 'disabledChunkCount'] as const;
  if (!fields.every(field => Number.isSafeInteger(input[field]) && Number(input[field]) >= 0)) return null;
  const counts = Object.fromEntries(fields.map(field => [field, input[field]])) as DocumentChunkCounts;
  if (counts.chunkCount !== counts.searchableChunkCount + counts.disabledChunkCount) return null;
  return counts;
}

export function formatDocumentChunkCounts(counts: DocumentChunkCounts | null): string {
  if (!counts) return '文档块统计暂不可用';
  return `可检索 ${counts.searchableChunkCount.toLocaleString('zh-CN')} 块 · 已存储 ${counts.chunkCount.toLocaleString('zh-CN')} 块 · 已停用 ${counts.disabledChunkCount.toLocaleString('zh-CN')} 块`;
}
