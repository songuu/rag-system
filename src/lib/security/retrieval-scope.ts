import type { MilvusSearchOptions } from '../milvus-client';

export type RagTrustLevel = 'trusted' | 'reviewed' | 'external' | 'quarantined';

export interface RagRetrievalScope {
  tenantId: string;
  corpusId: string;
  allowedTrustLevels: RagTrustLevel[];
  enforceIsolation: boolean;
}

export interface ScopedDocumentMetadata extends Record<string, unknown> {
  tenantId: string;
  corpusId: string;
  trustLevel: RagTrustLevel;
}

const SAFE_SCOPE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVER_SCOPE_MARKER = Symbol('rag.server-derived-scope');

export function createRetrievalScope(input: {
  tenantId: string;
  corpusId: string;
  allowedTrustLevels?: RagTrustLevel[];
  enforceIsolation?: boolean;
}): RagRetrievalScope {
  const tenantId = validateScopeIdentifier(input.tenantId, 'tenantId');
  const corpusId = validateScopeIdentifier(input.corpusId, 'corpusId');
  const allowedTrustLevels = input.allowedTrustLevels ?? ['trusted', 'reviewed', 'external'];
  if (allowedTrustLevels.length === 0) {
    throw new Error('A retrieval scope must allow at least one trust level.');
  }
  const uniqueTrustLevels = [...new Set(allowedTrustLevels)];
  for (const level of uniqueTrustLevels) {
    if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(level)) {
      throw new Error(`Unsupported trust level: ${String(level)}`);
    }
  }
  return {
    tenantId,
    corpusId,
    allowedTrustLevels: uniqueTrustLevels,
    enforceIsolation: input.enforceIsolation === true,
  };
}

export function buildScopedMilvusSearchOptions(
  scope: RagRetrievalScope,
  input: Omit<MilvusSearchOptions, 'filter' | 'exprValues'> = {}
): MilvusSearchOptions {
  if (!scope.enforceIsolation) return input;
  return markServerDerivedScope({
    ...input,
    filter: [
      'tenant_id == {tenantId}',
      'corpus_id == {corpusId}',
      'trust_level in {allowedTrustLevels}',
    ].join(' && '),
    exprValues: {
      tenantId: scope.tenantId,
      corpusId: scope.corpusId,
      allowedTrustLevels: [...scope.allowedTrustLevels],
    },
  });
}

export function stampDocumentScope(
  metadata: Record<string, unknown> | undefined,
  scope: RagRetrievalScope,
  trustLevel: RagTrustLevel = 'external'
): ScopedDocumentMetadata {
  if (!scope.allowedTrustLevels.includes(trustLevel)) {
    throw new Error(`Trust level ${trustLevel} is not allowed by the current scope.`);
  }
  return markServerDerivedScope({
    ...(metadata ?? {}),
    // Server-derived values intentionally override user metadata.
    tenantId: scope.tenantId,
    tenant_id: scope.tenantId,
    corpusId: scope.corpusId,
    corpus_id: scope.corpusId,
    trustLevel,
    trust_level: trustLevel,
  } as ScopedDocumentMetadata);
}

export function getDocumentSecurityFields(
  metadata: Record<string, unknown> | undefined,
  fallback: { tenantId: string; corpusId: string; trustLevel?: RagTrustLevel }
): {
  tenant_id: string;
  corpus_id: string;
  document_id: string;
  trust_level: RagTrustLevel;
} {
  if (isTenantIsolationRequired() && !isServerDerivedScope(metadata)) {
    throw new Error('Document metadata was not derived from an authenticated server scope.');
  }
  const tenantId = readMetadataIdentifier(metadata, ['tenantId', 'tenant_id']) || fallback.tenantId;
  const corpusId = readMetadataIdentifier(metadata, ['corpusId', 'corpus_id']) || fallback.corpusId;
  const documentId = readMetadataIdentifier(metadata, ['documentId', 'document_id', 'source']) || 'unknown';
  const trustCandidate = readMetadataIdentifier(metadata, ['trustLevel', 'trust_level']) || fallback.trustLevel || 'external';
  if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(trustCandidate)) {
    throw new Error(`Unsupported document trust level: ${trustCandidate}`);
  }
  return {
    tenant_id: validateScopeIdentifier(tenantId, 'tenantId'),
    corpus_id: validateScopeIdentifier(corpusId, 'corpusId'),
    document_id: validateDocumentIdentifier(documentId),
    trust_level: trustCandidate as RagTrustLevel,
  };
}

export function isServerDerivedScope(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as Record<symbol, unknown>)[SERVER_SCOPE_MARKER] === true
  );
}

export function isTenantIsolationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const accessMode = (env.RAG_ACCESS_MODE || env.RAG_AUTH_MODE || 'local-dev')
    .trim()
    .toLowerCase();
  return env.RAG_TENANT_ISOLATION_REQUIRED === 'true' || accessMode !== 'local-dev';
}

function validateScopeIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!SAFE_SCOPE_IDENTIFIER.test(normalized)) {
    throw new Error(`${field} must be a safe identifier of at most 128 characters.`);
  }
  return normalized;
}

function validateDocumentIdentifier(value: string): string {
  const normalized = value.trim().slice(0, 256);
  if (!normalized || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error('documentId must be a non-empty identifier without control characters.');
  }
  return normalized;
}

function readMetadataIdentifier(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function markServerDerivedScope<T extends object>(value: T): T {
  Object.defineProperty(value, SERVER_SCOPE_MARKER, {
    value: true,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return value;
}
