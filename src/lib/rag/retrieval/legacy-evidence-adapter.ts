import type { MilvusSearchResult } from '../../milvus-client';
import type { RagEvidence } from '../core/types';
import type {
  RagRetrievalScope,
  RagTrustLevel,
} from '../../security/retrieval-scope';

const SCOPED_METADATA_ALIASES = [
  ['tenantId', 'tenant_id'],
  ['corpusId', 'corpus_id'],
  ['documentId', 'document_id'],
  ['documentVersion', 'document_version'],
  ['trustLevel', 'trust_level'],
] as const;

export class LegacyEvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyEvidenceValidationError';
  }
}

export function adaptMilvusSearchResultsToEvidence(
  results: readonly MilvusSearchResult[],
  input: {
    laneId: string;
    scope: RagRetrievalScope;
  }
): RagEvidence[] {
  return results.map((result, index) => {
    const metadata = result.metadata ?? {};
    assertNoConflictingAliases(metadata);
    assertCanonicalResultShape(result, index);
    const tenantId = readString(metadata, ['tenant_id', 'tenantId']) ?? input.scope.tenantId;
    const corpusId = readString(metadata, ['corpus_id', 'corpusId']) ?? input.scope.corpusId;
    const trustLevel = normalizeTrustLevel(
      readString(metadata, ['trust_level', 'trustLevel']) ?? 'external'
    );

    assertScope(tenantId, corpusId, trustLevel, input.scope);
    if (input.scope.enforceIsolation) {
      assertAuthenticatedProvenance(metadata);
    }

    const source = readString(metadata, ['source']);
    const fallbackHash = stableLegacyHash(
      [tenantId, corpusId, source ?? '', result.content, String(index)].join('\u001f')
    );
    const documentId =
      readString(metadata, ['document_id', 'documentId']) ??
      source ??
      (result.id.trim() || 'legacy-document-' + fallbackHash);
    assertSafeDocumentId(documentId);
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
      throw new LegacyEvidenceValidationError('Milvus evidence contains an invalid source span.');
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

export async function invokeWithValidatedMilvusEvidence<T>(
  results: readonly MilvusSearchResult[],
  input: {
    laneId: string;
    scope: RagRetrievalScope;
  },
  invoke: (evidence: readonly RagEvidence[]) => Promise<T>
): Promise<T> {
  const evidence = adaptMilvusSearchResultsToEvidence(results, input);
  return invoke(evidence);
}

function assertScope(
  tenantId: string,
  corpusId: string,
  trustLevel: RagTrustLevel,
  scope: RagRetrievalScope
): void {
  if (trustLevel === 'quarantined') {
    throw new LegacyEvidenceValidationError('Milvus adapter rejected quarantined evidence.');
  }
  if (!scope.allowedTrustLevels.includes(trustLevel)) {
    throw new LegacyEvidenceValidationError('Milvus evidence trust level is outside the retrieval scope.');
  }
  if (scope.enforceIsolation && tenantId !== scope.tenantId) {
    throw new LegacyEvidenceValidationError('Milvus evidence tenant scope mismatch.');
  }
  if (scope.enforceIsolation && corpusId !== scope.corpusId) {
    throw new LegacyEvidenceValidationError('Milvus evidence corpus scope mismatch.');
  }
}

function normalizeTrustLevel(value: string): RagTrustLevel {
  if (value === 'trusted' || value === 'reviewed' || value === 'external' || value === 'quarantined') {
    return value;
  }
  throw new LegacyEvidenceValidationError('Milvus evidence contains an unsupported trust level.');
}

function assertNoConflictingAliases(metadata: Record<string, unknown>): void {
  for (const [canonical, alias] of SCOPED_METADATA_ALIASES) {
    if (
      Object.prototype.hasOwnProperty.call(metadata, canonical)
      && Object.prototype.hasOwnProperty.call(metadata, alias)
      && !Object.is(metadata[canonical], metadata[alias])
    ) {
      throw new LegacyEvidenceValidationError(
        `Milvus evidence contains conflicting ${canonical}/${alias} values.`
      );
    }
  }
}

function assertCanonicalResultShape(result: MilvusSearchResult, index: number): void {
  if (typeof result.id !== 'string') {
    throw new LegacyEvidenceValidationError(`Milvus evidence[${index}] id must be a string.`);
  }
  if (typeof result.content !== 'string') {
    throw new LegacyEvidenceValidationError(`Milvus evidence[${index}] content must be a string.`);
  }
  if (!Number.isFinite(result.score)) {
    throw new LegacyEvidenceValidationError(`Milvus evidence[${index}] score must be finite.`);
  }
}

function assertAuthenticatedProvenance(metadata: Record<string, unknown>): void {
  const requiredFields = [
    ['tenantId', ['tenant_id', 'tenantId']],
    ['corpusId', ['corpus_id', 'corpusId']],
    ['documentId', ['document_id', 'documentId']],
    ['trustLevel', ['trust_level', 'trustLevel']],
  ] as const;

  for (const [field, keys] of requiredFields) {
    if (!readString(metadata, keys)) {
      throw new LegacyEvidenceValidationError(
        `Authenticated Milvus evidence requires explicit ${field} provenance.`
      );
    }
  }
}

function assertSafeDocumentId(value: string): void {
  if (value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    throw new LegacyEvidenceValidationError(
      'Milvus evidence documentId must be at most 256 characters without control characters.'
    );
  }
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
