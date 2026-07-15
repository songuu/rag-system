import type { MilvusSearchResult } from '../../milvus-client';
import type { RagEvidence } from '../core/types';
import type {
  RagRetrievalScope,
  RagTrustLevel,
} from '../../security/retrieval-scope';

export function adaptMilvusSearchResultsToEvidence(
  results: readonly MilvusSearchResult[],
  input: {
    laneId: string;
    scope: RagRetrievalScope;
  }
): RagEvidence[] {
  return results.map((result, index) => {
    const metadata = result.metadata ?? {};
    const tenantId = readString(metadata, ['tenant_id', 'tenantId']) ?? input.scope.tenantId;
    const corpusId = readString(metadata, ['corpus_id', 'corpusId']) ?? input.scope.corpusId;
    const trustLevel = normalizeTrustLevel(
      readString(metadata, ['trust_level', 'trustLevel']) ?? 'external'
    );

    assertScope(tenantId, corpusId, trustLevel, input.scope);

    const source = readString(metadata, ['source']);
    const fallbackHash = stableLegacyHash(
      [tenantId, corpusId, source ?? '', result.content, String(index)].join('\u001f')
    );
    const documentId =
      readString(metadata, ['document_id', 'documentId']) ??
      source ??
      (result.id.trim() || 'legacy-document-' + fallbackHash);
    const documentVersion =
      readString(metadata, [
        'document_version',
        'documentVersion',
        'version',
        'source_hash',
        'sourceHash',
      ]) ?? 'legacy-v1';
    const startOffset = readNonNegativeInteger(metadata, ['startOffset', 'start_offset']);
    const endOffset = readNonNegativeInteger(metadata, ['endOffset', 'end_offset']);
    if (
      (startOffset === undefined) !== (endOffset === undefined) ||
      (
        startOffset !== undefined &&
        endOffset !== undefined &&
        startOffset >= endOffset
      )
    ) {
      throw new Error('Milvus evidence contains an invalid source span.');
    }

    return {
      id: result.id.trim() || 'legacy-evidence-' + fallbackHash,
      tenantId,
      corpusId,
      documentId,
      documentVersion,
      content: result.content,
      source,
      page: readPositiveInteger(metadata, ['page', 'pageNumber', 'page_number']),
      sectionPath: readStringArray(metadata, ['sectionPath', 'section_path']),
      startOffset,
      endOffset,
      retrievalScore: result.score,
      trustLevel,
      laneId: input.laneId,
      metadata: { ...metadata },
    };
  });
}

function assertScope(
  tenantId: string,
  corpusId: string,
  trustLevel: RagTrustLevel,
  scope: RagRetrievalScope
): void {
  if (trustLevel === 'quarantined') {
    throw new Error('Milvus adapter rejected quarantined evidence.');
  }
  if (!scope.allowedTrustLevels.includes(trustLevel)) {
    throw new Error('Milvus evidence trust level is outside the retrieval scope.');
  }
  if (scope.enforceIsolation && tenantId !== scope.tenantId) {
    throw new Error('Milvus evidence tenant scope mismatch.');
  }
  if (scope.enforceIsolation && corpusId !== scope.corpusId) {
    throw new Error('Milvus evidence corpus scope mismatch.');
  }
}

function normalizeTrustLevel(value: string): RagTrustLevel {
  if (value === 'trusted' || value === 'reviewed' || value === 'external' || value === 'quarantined') {
    return value;
  }
  throw new Error('Milvus evidence contains an unsupported trust level.');
}

function readString(
  metadata: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readStringArray(
  metadata: Record<string, unknown>,
  keys: readonly string[]
): string[] | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (
      Array.isArray(value) &&
      value.every(item => typeof item === 'string' && item.trim())
    ) {
      return value.map(item => item.trim());
    }
  }
  return undefined;
}

function readNonNegativeInteger(
  metadata: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function readPositiveInteger(
  metadata: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  const value = readNonNegativeInteger(metadata, keys);
  return value !== undefined && value > 0 ? value : undefined;
}

function stableLegacyHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
