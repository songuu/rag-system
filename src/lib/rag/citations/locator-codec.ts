import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { RagSecurityContext } from '../../security/request-context';
import type { RagTrustLevel } from '../../security/retrieval-scope';

const AUDIENCE = 'rag-ask-citation-preview';
const PURPOSE = 'graph-source-preview';
const MAX_TOKEN_BYTES = 8192;
const MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const SAFE_KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class CitationError extends Error {
  readonly code: 'RAG_CITATION_INVALID' | 'RAG_CITATION_UNAVAILABLE' | 'RAG_CITATION_SOURCE_UNAVAILABLE';
  readonly status: number;

  constructor(code: CitationError['code'], status: number = 404) {
    super(code === 'RAG_CITATION_UNAVAILABLE' ? 'Citation preview is not configured or temporarily unavailable.' : 'The citation source is unavailable.');
    this.name = 'CitationError';
    this.code = code;
    this.status = status;
  }
}

export interface CitationSourceLocator {
  tenantId: string;
  corpusId: string;
  actorId: string;
  graphVersion: string;
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
  passageId: string;
  claimIds: string[];
  startOffset: number;
  endOffset: number;
  contentHash: string;
  iat: number;
  exp: number;
}

interface Envelope extends CitationSourceLocator {
  v: 1;
  iss: string;
  aud: string;
  environment: string;
  purpose: string;
  maxTTL: number;
  jti: string;
}

/** Chunk-local coordinates avoid depending on overlap reconstruction or graph artifacts. */
export interface DocumentCitationSourceLocator extends Omit<CitationSourceLocator, 'graphVersion' | 'passageId' | 'claimIds'> {
  chunkId: string;
  chunkIndex: number;
  chunkHash: string;
}

interface DocumentEnvelope extends DocumentCitationSourceLocator {
  v: 2;
  iss: string;
  aud: string;
  environment: string;
  purpose: string;
  maxTTL: number;
  jti: string;
}

export function citationPartition(security: Pick<RagSecurityContext, 'actorId' | 'tenantId' | 'corpusId'>): string {
  return createHash('sha256').update(JSON.stringify(['rag-citation-partition/v1', security.actorId, security.tenantId, security.corpusId])).digest('hex');
}

export function createCitationLocatorCodec(env: NodeJS.ProcessEnv = process.env) {
  let keys: Map<string, Buffer>;
  let active: string;
  let issuer: string;
  let environment: string;
  let ttlSeconds: number;
  let maxSeconds: number;
  const retirements = new Map<string, { issuedBefore: number; verifyNotAfter: number }>();
  const revoked = new Set((env.RAG_CITATION_REVOKED_KEY_IDS ?? '').split(',').filter(Boolean));
  try {
    const input: unknown = JSON.parse(env.RAG_CITATION_KEYS ?? 'null');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const entries = Object.entries(input);
    if (entries.length < 1 || entries.length > 8) throw new Error();
    keys = new Map(entries.map(([kid, value]) => {
      if (!SAFE_KEY_ID.test(kid) || typeof value !== 'string') throw new Error();
      const key = Buffer.from(value, 'base64');
      if (key.length !== 32 || key.toString('base64') !== value) throw new Error();
      return [kid, key];
    }));
    active = env.RAG_CITATION_ACTIVE_KEY_ID ?? '';
    issuer = boundedText(env.RAG_CITATION_ISSUER, 128);
    environment = boundedText(env.RAG_CITATION_ENVIRONMENT, 128);
    if (!keys.has(active) || revoked.has(active) || [...revoked].some(kid => !SAFE_KEY_ID.test(kid))) throw new Error();
    ttlSeconds = seconds(env.RAG_CITATION_TTL_SECONDS ?? '86400');
    maxSeconds = seconds(env.RAG_CITATION_MAX_TTL_SECONDS ?? '604800');
    if (ttlSeconds > maxSeconds) throw new Error();
    const retirementInput: unknown = JSON.parse(env.RAG_CITATION_KEY_RETIREMENTS ?? '{}');
    if (!retirementInput || typeof retirementInput !== 'object' || Array.isArray(retirementInput)) throw new Error();
    for (const [kid, entry] of Object.entries(retirementInput)) {
      if (!keys.has(kid) || kid === active || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
      const fields = Object.keys(entry);
      if (fields.length !== 2 || !fields.includes('issuedBefore') || !fields.includes('verifyNotAfter')) throw new Error();
      const { issuedBefore, verifyNotAfter } = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(issuedBefore) || !Number.isSafeInteger(verifyNotAfter)
        || Number(issuedBefore) < 0 || Number(verifyNotAfter) <= Number(issuedBefore)
        || Number(verifyNotAfter) - Number(issuedBefore) > maxSeconds * 1000) throw new Error();
      retirements.set(kid, { issuedBefore: Number(issuedBefore), verifyNotAfter: Number(verifyNotAfter) });
    }
    // This first version supports one issuing key plus explicitly bounded retired verification keys.
    if ([...keys.keys()].some(kid => kid !== active && !retirements.has(kid))) throw new Error();
  } catch { throw new CitationError('RAG_CITATION_UNAVAILABLE', 503); }

  const aad = (kid: string, version = 1, purpose = PURPOSE) => Buffer.from(JSON.stringify(['rag-citation-locator/v' + version, kid, issuer, AUDIENCE, environment, purpose]), 'utf8');
  const documentPurpose = 'document-chunk-preview';
  return {
    ttlMs: ttlSeconds * 1000,
    encode(source: Omit<CitationSourceLocator, 'iat' | 'exp'>, now = Date.now()): { locator: string; expiresAt: number } {
      const value: Envelope = { ...source, v: 1, iss: issuer, aud: AUDIENCE, environment, purpose: PURPOSE, iat: now, exp: now + ttlSeconds * 1000, maxTTL: maxSeconds * 1000, jti: randomBytes(24).toString('base64url') };
      validateEnvelope(value, now, maxSeconds * 1000);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keys.get(active)!, iv);
      cipher.setAAD(aad(active));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      const locator = ['rcl1', active, iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
      if (locator.length > MAX_TOKEN_BYTES) throw new CitationError('RAG_CITATION_INVALID');
      return { locator, expiresAt: value.exp };
    },
    decode(locator: string, now = Date.now()): CitationSourceLocator {
      try {
        if (typeof locator !== 'string' || locator.length > MAX_TOKEN_BYTES) throw new Error();
        const parts = locator.split('.');
        if (parts.length !== 5 || parts[0] !== 'rcl1' || !SAFE_KEY_ID.test(parts[1])) throw new Error();
        const [, kid, ivText, encryptedText, tagText] = parts;
        const key = keys.get(kid);
        if (!key || revoked.has(kid)) throw new Error();
        const iv = decodeBase64Url(ivText); const tag = decodeBase64Url(tagText); const encrypted = decodeBase64Url(encryptedText);
        if (iv.length !== 12 || tag.length !== 16 || encrypted.length < 1) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(aad(kid)); decipher.setAuthTag(tag);
        const value: unknown = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
        validateEnvelope(value, now, maxSeconds * 1000);
        if (value.iss !== issuer || value.aud !== AUDIENCE || value.environment !== environment || value.purpose !== PURPOSE) throw new Error();
        if (kid !== active) {
          const retired = retirements.get(kid);
          if (!retired || value.iat > retired.issuedBefore || now >= retired.verifyNotAfter) throw new Error();
        }
        return value;
      } catch { throw new CitationError('RAG_CITATION_INVALID'); }
    },
    encodeDocument(source: Omit<DocumentCitationSourceLocator, 'iat' | 'exp'>, now = Date.now()): { locator: string; expiresAt: number } {
      const value: DocumentEnvelope = { ...source, v: 2, iss: issuer, aud: AUDIENCE, environment, purpose: documentPurpose, iat: now, exp: now + ttlSeconds * 1000, maxTTL: maxSeconds * 1000, jti: randomBytes(24).toString('base64url') };
      validateDocumentEnvelope(value, now, maxSeconds * 1000);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keys.get(active)!, iv);
      cipher.setAAD(aad(active, 2, documentPurpose));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      const locator = ['rcl2', active, iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
      if (locator.length > MAX_TOKEN_BYTES) throw new CitationError('RAG_CITATION_INVALID');
      return { locator, expiresAt: value.exp };
    },
    decodeDocument(locator: string, now = Date.now()): DocumentCitationSourceLocator {
      try {
        if (typeof locator !== 'string' || locator.length > MAX_TOKEN_BYTES) throw new Error();
        const parts = locator.split('.');
        if (parts.length !== 5 || parts[0] !== 'rcl2' || !SAFE_KEY_ID.test(parts[1])) throw new Error();
        const [, kid, ivText, encryptedText, tagText] = parts;
        const key = keys.get(kid);
        if (!key || revoked.has(kid)) throw new Error();
        const iv = decodeBase64Url(ivText); const tag = decodeBase64Url(tagText); const encrypted = decodeBase64Url(encryptedText);
        if (iv.length !== 12 || tag.length !== 16 || encrypted.length < 1) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(aad(kid, 2, documentPurpose)); decipher.setAuthTag(tag);
        const value: unknown = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
        validateDocumentEnvelope(value, now, maxSeconds * 1000);
        if (value.iss !== issuer || value.aud !== AUDIENCE || value.environment !== environment || value.purpose !== documentPurpose) throw new Error();
        if (kid !== active) {
          const retired = retirements.get(kid);
          if (!retired || value.iat > retired.issuedBefore || now >= retired.verifyNotAfter) throw new Error();
        }
        return value;
      } catch { throw new CitationError('RAG_CITATION_INVALID'); }
    },
  };
}

function validateEnvelope(input: unknown, now: number, maxTTL: number): asserts input is Envelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  const value = input as Record<string, unknown>;
  const fields = ['tenantId', 'corpusId', 'actorId', 'graphVersion', 'documentId', 'documentVersion', 'trustLevel', 'passageId', 'claimIds', 'startOffset', 'endOffset', 'contentHash', 'iat', 'exp', 'v', 'iss', 'aud', 'environment', 'purpose', 'maxTTL', 'jti'];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new Error();
  for (const field of ['tenantId', 'corpusId', 'actorId', 'graphVersion', 'documentId', 'documentVersion', 'passageId', 'iss', 'aud', 'environment', 'purpose']) boundedText(value[field], 512);
  if (value.v !== 1 || !['trusted', 'reviewed', 'external'].includes(String(value.trustLevel))) throw new Error();
  if (!Array.isArray(value.claimIds) || value.claimIds.length > 16 || new Set(value.claimIds).size !== value.claimIds.length) throw new Error();
  for (const id of value.claimIds) boundedText(id, 512);
  if (typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash) || typeof value.jti !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.jti)) throw new Error();
  for (const field of ['startOffset', 'endOffset', 'iat', 'exp', 'maxTTL']) if (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0) throw new Error();
  if (!Number.isSafeInteger(now) || now < 0 || Number(value.endOffset) <= Number(value.startOffset) || Number(value.endOffset) - Number(value.startOffset) > 120_000) throw new Error();
  if (Number(value.iat) > now || Number(value.exp) <= now || Number(value.exp) <= Number(value.iat) || Number(value.maxTTL) > MAX_LIFETIME_SECONDS * 1000 || Number(value.exp) - Number(value.iat) > Math.min(maxTTL, Number(value.maxTTL))) throw new Error();
}

function validateDocumentEnvelope(input: unknown, now: number, maxTTL: number): asserts input is DocumentEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  const value = input as Record<string, unknown>;
  const fields = ['tenantId', 'corpusId', 'actorId', 'documentId', 'documentVersion', 'trustLevel', 'chunkId', 'chunkIndex', 'chunkHash', 'startOffset', 'endOffset', 'contentHash', 'iat', 'exp', 'v', 'iss', 'aud', 'environment', 'purpose', 'maxTTL', 'jti'];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new Error();
  const { chunkId, chunkIndex, chunkHash, ...shared } = value;
  // Reuse the v1 bounds and lifetime checks while keeping the wire purposes disjoint.
  validateEnvelope({ ...shared, v: 1, graphVersion: 'document', passageId: 'chunk', claimIds: [] }, now, maxTTL);
  boundedText(chunkId, 512);
  if (value.v !== 2 || !Number.isSafeInteger(chunkIndex) || Number(chunkIndex) < 0 || Number(chunkIndex) >= 100_000
    || typeof chunkHash !== 'string' || !/^[a-f0-9]{64}$/.test(chunkHash)) throw new Error();
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
  return value;
}
function seconds(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_LIFETIME_SECONDS) throw new Error();
  return Number(value);
}
function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error();
  return bytes;
}
