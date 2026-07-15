import { createHash } from 'node:crypto';

export const RAG_CACHE_IDENTITY_VERSION = 'rag-cache-identity/v1' as const;

export interface RagCacheEvidenceFingerprint {
  evidenceId: string;
  documentId: string;
  documentVersion: string;
  startOffset?: number;
  endOffset?: number;
  position: number;
}

export type RagCacheEvidenceFingerprintInput = Omit<
  RagCacheEvidenceFingerprint,
  'position'
>;

export interface RagCacheIdentityInput {
  kind: 'answer' | 'context';
  tenantId: string;
  corpusId: string;
  corpusVersion: string;
  contextDigest: string;
  documentVersions: readonly string[];
  evidenceFingerprints?: readonly RagCacheEvidenceFingerprintInput[];
  schemaVersion: string;
  indexVersion: string;
  llmModel: string;
  embeddingModel: string;
  promptVersion: string;
  policyId: string;
  fusionVersion: string;
}

export interface RagCacheIdentityComponents
  extends Omit<RagCacheIdentityInput, 'documentVersions' | 'evidenceFingerprints'> {
  documentVersions: string[];
  evidenceFingerprints: RagCacheEvidenceFingerprint[];
}

export interface RagCacheIdentity {
  version: typeof RAG_CACHE_IDENTITY_VERSION;
  key: string;
  components: RagCacheIdentityComponents;
}

export function createRagCacheIdentity(
  input: RagCacheIdentityInput
): RagCacheIdentity {
  const components: RagCacheIdentityComponents = {
    kind: input.kind,
    tenantId: required(input.tenantId, 'tenantId'),
    corpusId: required(input.corpusId, 'corpusId'),
    corpusVersion: required(input.corpusVersion, 'corpusVersion'),
    contextDigest: required(input.contextDigest, 'contextDigest'),
    documentVersions: normalizeVersions(input.documentVersions),
    evidenceFingerprints: normalizeEvidenceFingerprints(
      input.evidenceFingerprints ?? []
    ),
    schemaVersion: required(input.schemaVersion, 'schemaVersion'),
    indexVersion: required(input.indexVersion, 'indexVersion'),
    llmModel: required(input.llmModel, 'llmModel'),
    embeddingModel: required(input.embeddingModel, 'embeddingModel'),
    promptVersion: required(input.promptVersion, 'promptVersion'),
    policyId: required(input.policyId, 'policyId'),
    fusionVersion: required(input.fusionVersion, 'fusionVersion'),
  };
  const digest = createHash('sha256')
    .update(stableStringify({
      version: RAG_CACHE_IDENTITY_VERSION,
      ...components,
    }))
    .digest('hex');
  return {
    version: RAG_CACHE_IDENTITY_VERSION,
    key: 'rag:' + input.kind + ':' + digest,
    components,
  };
}

export function createRagContextDigest(context: string): string {
  if (typeof context !== 'string') {
    throw new Error('[rag cache identity] context must be a string');
  }
  return 'sha256:' + createHash('sha256').update(context).digest('hex');
}

function normalizeEvidenceFingerprints(
  fingerprints: readonly RagCacheEvidenceFingerprintInput[]
): RagCacheEvidenceFingerprint[] {
  if (!Array.isArray(fingerprints)) {
    throw new Error('[rag cache identity] evidenceFingerprints must be an array');
  }
  return fingerprints.map((fingerprint, position) => {
    if (!fingerprint || typeof fingerprint !== 'object') {
      throw new Error(
        '[rag cache identity] evidenceFingerprints[' + position + '] must be an object'
      );
    }
    const startOffset = optionalOffset(
      fingerprint.startOffset,
      'evidenceFingerprints[' + position + '].startOffset'
    );
    const endOffset = optionalOffset(
      fingerprint.endOffset,
      'evidenceFingerprints[' + position + '].endOffset'
    );
    if (
      (startOffset === undefined) !== (endOffset === undefined) ||
      (
        startOffset !== undefined &&
        endOffset !== undefined &&
        endOffset <= startOffset
      )
    ) {
      throw new Error(
        '[rag cache identity] evidenceFingerprints[' + position + '] has an invalid span'
      );
    }
    return {
      evidenceId: required(
        fingerprint.evidenceId,
        'evidenceFingerprints[' + position + '].evidenceId'
      ),
      documentId: required(
        fingerprint.documentId,
        'evidenceFingerprints[' + position + '].documentId'
      ),
      documentVersion: required(
        fingerprint.documentVersion,
        'evidenceFingerprints[' + position + '].documentVersion'
      ),
      ...(startOffset === undefined ? {} : { startOffset, endOffset }),
      position,
    };
  });
}

function normalizeVersions(versions: readonly string[]): string[] {
  if (!Array.isArray(versions)) {
    throw new Error('[rag cache identity] documentVersions must be an array');
  }
  return [...new Set(versions.map((value, index) =>
    required(value, 'documentVersions[' + index + ']')
  ))].sort();
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('[rag cache identity] ' + field + ' is required');
  }
  return value.trim();
}

function optionalOffset(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('[rag cache identity] ' + field + ' must be a non-negative integer');
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  return (
    '{' +
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ':' + stableStringify(item))
      .join(',') +
    '}'
  );
}
