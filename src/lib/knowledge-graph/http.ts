import { NextResponse } from 'next/server';
import {
  KnowledgeGraphError,
  type KnowledgeGraphClaimSourceResult,
  type KnowledgeGraphCommunityResult,
  type KnowledgeGraphEntityResult,
  type KnowledgeGraphPathResult,
  type KnowledgeGraphQueryPort,
} from './contracts';
import { createMiroFishGraphVersion } from './mirofish-adapter';
import {
  getMiroFishGraphArtifactRuntime,
  type MiroFishGraphArtifactRuntime,
} from '../mirofish/graph-artifact-runtime';
import {
  RagSecurityError,
  resolveRagSecurityContext,
  type RagCapability,
  type RagSecurityContext,
} from '../security/request-context';
import {
  createRetrievalScope,
  type RagRetrievalScope,
  type RagTrustLevel,
} from '../security/retrieval-scope';
import { RequestValidationError } from '../security/request-validation';
import { redactErrorForLog } from '../security/error-redaction';
import type { KnowledgeGraphBuildJob } from './postgres-graph-build-store';
import { MiroFishGraphStoreError } from '../mirofish/graph-artifact-store';

export interface KnowledgeGraphHttpContext {
  security: RagSecurityContext;
  scope: RagRetrievalScope;
  runtime: MiroFishGraphArtifactRuntime;
}

export type KnowledgeGraphBuildJobHttpProjection = Pick<
  KnowledgeGraphBuildJob,
  | 'id'
  | 'graphVersion'
  | 'status'
  | 'progress'
  | 'artifactDigest'
  | 'errorCode'
  | 'createdAt'
  | 'updatedAt'
>;

/** Keeps worker ownership tokens, internal metadata, and raw errors server-side. */
export function projectKnowledgeGraphBuildJobForHttp(
  job: KnowledgeGraphBuildJob
): KnowledgeGraphBuildJobHttpProjection {
  return {
    id: job.id,
    graphVersion: job.graphVersion,
    status: job.status,
    progress: job.progress,
    artifactDigest: job.artifactDigest,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

type KnowledgeGraphQueryAdmissionCode =
  | 'KNOWLEDGE_GRAPH_QUERY_BUSY'
  | 'KNOWLEDGE_GRAPH_RATE_LIMITED';

interface KnowledgeGraphQueryAdmissionState {
  windowStartedAt: number;
  requestCount: number;
  inFlight: number;
}

const QUERY_ADMISSION_WINDOW_MS = 60_000;
const QUERY_ADMISSION_MAX_KEYS = 10_000;
const queryAdmissionByScopeActor = new Map<string, KnowledgeGraphQueryAdmissionState>();
const buildAdmissionByScopeActor = new Map<string, KnowledgeGraphQueryAdmissionState>();

class KnowledgeGraphQueryAdmissionError extends Error {
  readonly status = 429;
  readonly code: KnowledgeGraphQueryAdmissionCode;
  readonly retryAfterSeconds: number;

  constructor(
    code: KnowledgeGraphQueryAdmissionCode,
    message: string,
    retryAfterSeconds: number
  ) {
    super(message);
    this.name = 'KnowledgeGraphQueryAdmissionError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function acquireKnowledgeGraphQueryPermit(
  security: Pick<RagSecurityContext, 'tenantId' | 'corpusId' | 'actorId'>,
  options: {
    env?: Record<string, string | undefined>;
    now?: () => number;
  } = {}
): () => void {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const maxConcurrency = boundedAdmissionSetting(
    env.RAG_KG_QUERY_MAX_CONCURRENCY,
    8,
    64,
    'RAG_KG_QUERY_MAX_CONCURRENCY'
  );
  const ratePerMinute = boundedAdmissionSetting(
    env.RAG_KG_QUERY_RATE_PER_MINUTE,
    120,
    10_000,
    'RAG_KG_QUERY_RATE_PER_MINUTE'
  );
  pruneQueryAdmission(now);
  const key = [security.tenantId, security.corpusId, security.actorId].join('\0');
  let state = queryAdmissionByScopeActor.get(key);
  if (!state) {
    if (queryAdmissionByScopeActor.size >= QUERY_ADMISSION_MAX_KEYS) {
      throw new KnowledgeGraphQueryAdmissionError(
        'KNOWLEDGE_GRAPH_RATE_LIMITED',
        'Knowledge graph query admission capacity is exhausted.',
        60
      );
    }
    state = { windowStartedAt: now, requestCount: 0, inFlight: 0 };
    queryAdmissionByScopeActor.set(key, state);
  } else if (now - state.windowStartedAt >= QUERY_ADMISSION_WINDOW_MS) {
    state.windowStartedAt = now;
    state.requestCount = 0;
  }
  if (state.inFlight >= maxConcurrency) {
    throw new KnowledgeGraphQueryAdmissionError(
      'KNOWLEDGE_GRAPH_QUERY_BUSY',
      'Knowledge graph query concurrency limit reached.',
      1
    );
  }
  if (state.requestCount >= ratePerMinute) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((state.windowStartedAt + QUERY_ADMISSION_WINDOW_MS - now) / 1_000)
    );
    throw new KnowledgeGraphQueryAdmissionError(
      'KNOWLEDGE_GRAPH_RATE_LIMITED',
      'Knowledge graph query rate limit reached.',
      retryAfterSeconds
    );
  }
  state.requestCount += 1;
  state.inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state!.inFlight = Math.max(0, state!.inFlight - 1);
  };
}

export function acquireKnowledgeGraphBuildPermit(
  security: Pick<RagSecurityContext, 'tenantId' | 'corpusId' | 'actorId'>,
  options: {
    env?: Record<string, string | undefined>;
    now?: () => number;
  } = {}
): void {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const ratePerMinute = boundedAdmissionSetting(
    env.RAG_KG_BUILD_RATE_PER_MINUTE,
    20,
    1_000,
    'RAG_KG_BUILD_RATE_PER_MINUTE'
  );
  pruneAdmissionMap(buildAdmissionByScopeActor, now);
  const key = [security.tenantId, security.corpusId, security.actorId].join('\0');
  let state = buildAdmissionByScopeActor.get(key);
  if (!state) {
    if (buildAdmissionByScopeActor.size >= QUERY_ADMISSION_MAX_KEYS) {
      throw new KnowledgeGraphQueryAdmissionError(
        'KNOWLEDGE_GRAPH_RATE_LIMITED',
        'Knowledge graph build admission capacity is exhausted.',
        60
      );
    }
    state = { windowStartedAt: now, requestCount: 0, inFlight: 0 };
    buildAdmissionByScopeActor.set(key, state);
  } else if (now - state.windowStartedAt >= QUERY_ADMISSION_WINDOW_MS) {
    state.windowStartedAt = now;
    state.requestCount = 0;
  }
  if (state.requestCount >= ratePerMinute) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((state.windowStartedAt + QUERY_ADMISSION_WINDOW_MS - now) / 1_000)
    );
    throw new KnowledgeGraphQueryAdmissionError(
      'KNOWLEDGE_GRAPH_RATE_LIMITED',
      'Knowledge graph build rate limit reached.',
      retryAfterSeconds
    );
  }
  state.requestCount += 1;
}

export async function withKnowledgeGraphQueryAdmission<T>(
  context: Pick<KnowledgeGraphHttpContext, 'security'>,
  work: () => Promise<T>
): Promise<T> {
  const release = acquireKnowledgeGraphQueryPermit(context.security);
  try {
    return await work();
  } finally {
    release();
  }
}

export function resetKnowledgeGraphQueryAdmissionForTests(): void {
  queryAdmissionByScopeActor.clear();
  buildAdmissionByScopeActor.clear();
}

export function isKnowledgeGraphAdmissionError(
  error: unknown
): error is KnowledgeGraphQueryAdmissionError {
  return error instanceof KnowledgeGraphQueryAdmissionError;
}

export async function resolveKnowledgeGraphHttpContext(
  request: Request,
  capability: RagCapability,
  options: { management?: boolean } = {}
): Promise<KnowledgeGraphHttpContext> {
  const requestedCorpusId = request.headers.get('x-rag-corpus-id')?.trim() || undefined;
  const security = await resolveRagSecurityContext(request, {
    capability,
    requestedCorpusId,
  });
  const scope = createRetrievalScope({
    tenantId: security.tenantId,
    corpusId: security.corpusId,
    allowedTrustLevels: options.management
      ? ['trusted', 'reviewed', 'external', 'quarantined']
      : ['trusted', 'reviewed', 'external'],
    enforceIsolation: security.enforceIsolation,
  });
  return {
    security,
    scope,
    runtime: getMiroFishGraphArtifactRuntime(),
  };
}

export function requireKnowledgeGraphQueryPort(
  runtime: MiroFishGraphArtifactRuntime
): KnowledgeGraphQueryPort {
  if (!runtime.queryPort) {
    throw new KnowledgeGraphError(
      'KNOWLEDGE_GRAPH_UNAVAILABLE',
      'Knowledge graph queries require RAG_GRAPH_BACKEND=neo4j.'
    );
  }
  return runtime.queryPort;
}

export async function resolveActiveGraphVersion(
  context: KnowledgeGraphHttpContext
): Promise<string> {
  const pointer = await context.runtime.store.getActive(context.scope);
  if (!pointer.identity) {
    throw new KnowledgeGraphError(
      'KNOWLEDGE_GRAPH_NOT_FOUND',
      'No active knowledge graph snapshot is available.'
    );
  }
  return createMiroFishGraphVersion(pointer.identity);
}

const CLAIM_SOURCE_MAX_PASSAGES = 10;
const CLAIM_SOURCE_MAX_CONTENT_BYTES = 16 * 1024;

export interface KnowledgeGraphClaimSourcesHttpProjection {
  claim: {
    id: string;
    predicate: string;
    fact: string;
    factType: string;
    sourceEntityId: string;
    targetEntityId: string;
    sourceEntityName: string;
    targetEntityName: string;
    confidence: number;
    status: KnowledgeGraphClaimSourceResult['claim']['status'];
  };
  passages: Array<{
    id: string;
    content: string;
    contentTruncated: boolean;
    index: number;
    startOffset: number;
    endOffset: number;
    source?: string;
    page?: number;
    sectionPath?: string[];
    documentId: string;
    documentVersion: string;
    trustLevel: RagTrustLevel;
  }>;
  contentTruncated: boolean;
  truncated: boolean;
}

/** Projects only bounded, user-visible provenance fields across the HTTP boundary. */
export function projectClaimSourcesForHttp(
  input: KnowledgeGraphClaimSourceResult,
  options: { limit?: number } = {}
): KnowledgeGraphClaimSourcesHttpProjection {
  const passageLimit = Math.max(
    1,
    Math.min(CLAIM_SOURCE_MAX_PASSAGES, options.limit ?? CLAIM_SOURCE_MAX_PASSAGES)
  );
  let projectedFieldTruncated = false;
  const text = (value: string, maximumBytes: number): string => {
    const projected = truncateUtf8(value, maximumBytes);
    projectedFieldTruncated ||= projected.truncated;
    return projected.value;
  };
  const passages = input.passages.slice(0, passageLimit).map(passage => {
    const projectedContent = truncateUtf8(passage.content, CLAIM_SOURCE_MAX_CONTENT_BYTES);
    const sectionPath = passage.sectionPath?.slice(0, 32).map(section => text(section, 256));
    if ((passage.sectionPath?.length ?? 0) > (sectionPath?.length ?? 0)) {
      projectedFieldTruncated = true;
    }
    return {
      id: text(passage.id, 512),
      content: projectedContent.value,
      contentTruncated: projectedContent.truncated,
      index: passage.index,
      startOffset: passage.startOffset,
      endOffset: passage.endOffset,
      ...(passage.source ? { source: text(passage.source, 2_048) } : {}),
      ...(passage.page !== undefined ? { page: passage.page } : {}),
      ...(sectionPath ? { sectionPath } : {}),
      documentId: text(passage.documentId, 512),
      documentVersion: text(passage.documentVersion, 512),
      trustLevel: passage.trustLevel,
    };
  });
  const contentTruncated = passages.some(passage => passage.contentTruncated);
  return {
    claim: {
      id: text(input.claim.id, 512),
      predicate: text(input.claim.predicate, 512),
      fact: text(input.claim.fact, CLAIM_SOURCE_MAX_CONTENT_BYTES),
      factType: text(input.claim.factType, 512),
      sourceEntityId: text(input.claim.sourceEntityId, 512),
      targetEntityId: text(input.claim.targetEntityId, 512),
      sourceEntityName: text(input.claim.sourceEntityName, 512),
      targetEntityName: text(input.claim.targetEntityName, 512),
      confidence: input.claim.confidence,
      status: input.claim.status,
    },
    passages,
    contentTruncated,
    truncated:
      input.passages.length > passageLimit
      || contentTruncated
      || projectedFieldTruncated,
  };
}

const GRAPH_QUERY_MAX_RESULTS = 100;
const GRAPH_QUERY_MAX_RESPONSE_BYTES = 1024 * 1024;
const GRAPH_QUERY_MAX_SUMMARY_BYTES = 8 * 1024;
const GRAPH_QUERY_MAX_REFERENCE_IDS = 64;

interface KnowledgeGraphQueryHttpProjection<T> {
  data: T[];
  truncated: boolean;
}

export function projectKnowledgeGraphEntityResultsForHttp(
  input: readonly KnowledgeGraphEntityResult[]
): KnowledgeGraphQueryHttpProjection<{
  entity: Omit<KnowledgeGraphEntityResult['entity'], 'attributes'>;
  score?: number;
}> {
  const state = { truncated: input.length > GRAPH_QUERY_MAX_RESULTS };
  const data = input.slice(0, GRAPH_QUERY_MAX_RESULTS).map(result => ({
    entity: {
      id: boundedHttpText(result.entity.id, 512, state),
      name: boundedHttpText(result.entity.name, 2_048, state),
      normalizedName: boundedHttpText(result.entity.normalizedName, 2_048, state),
      labels: boundedHttpTextList(result.entity.labels, 16, 512, state),
      summary: boundedHttpText(result.entity.summary, GRAPH_QUERY_MAX_SUMMARY_BYTES, state),
      aliases: boundedHttpTextList(result.entity.aliases, 32, 512, state),
      passageIds: boundedHttpTextList(
        result.entity.passageIds,
        GRAPH_QUERY_MAX_REFERENCE_IDS,
        512,
        state
      ),
      ...(result.entity.createdAt
        ? { createdAt: boundedHttpText(result.entity.createdAt, 128, state) }
        : {}),
    },
    ...(result.score !== undefined && Number.isFinite(result.score)
      ? { score: result.score }
      : {}),
  }));
  return { data, truncated: state.truncated };
}

export function projectKnowledgeGraphCommunityResultsForHttp(
  input: readonly KnowledgeGraphCommunityResult[]
): KnowledgeGraphQueryHttpProjection<KnowledgeGraphCommunityResult> {
  const state = { truncated: input.length > GRAPH_QUERY_MAX_RESULTS };
  const data = input.slice(0, GRAPH_QUERY_MAX_RESULTS).map(result => ({
    community: {
      id: boundedHttpText(result.community.id, 512, state),
      name: boundedHttpText(result.community.name, 2_048, state),
      entityIds: boundedHttpTextList(
        result.community.entityIds,
        GRAPH_QUERY_MAX_REFERENCE_IDS,
        512,
        state
      ),
      claimIds: boundedHttpTextList(
        result.community.claimIds,
        GRAPH_QUERY_MAX_REFERENCE_IDS,
        512,
        state
      ),
      summary: boundedHttpText(result.community.summary, GRAPH_QUERY_MAX_SUMMARY_BYTES, state),
      keywords: boundedHttpTextList(result.community.keywords, 32, 512, state),
      level: result.community.level,
      ...(result.community.parentId
        ? { parentId: boundedHttpText(result.community.parentId, 512, state) }
        : {}),
    },
    ...(result.score !== undefined && Number.isFinite(result.score)
      ? { score: result.score }
      : {}),
  }));
  return { data, truncated: state.truncated };
}

export function projectKnowledgeGraphPathResultsForHttp(
  input: readonly KnowledgeGraphPathResult[]
): KnowledgeGraphQueryHttpProjection<KnowledgeGraphPathResult> {
  const state = { truncated: input.length > GRAPH_QUERY_MAX_RESULTS };
  const data = input.slice(0, GRAPH_QUERY_MAX_RESULTS).map(result => ({
    entityIds: boundedHttpTextList(result.entityIds, 8, 512, state),
    claimIds: boundedHttpTextList(result.claimIds, 8, 512, state),
    passageIds: boundedHttpTextList(
      result.passageIds,
      GRAPH_QUERY_MAX_REFERENCE_IDS,
      512,
      state
    ),
    score: Number.isFinite(result.score) ? result.score : 0,
  }));
  return { data, truncated: state.truncated };
}

export function knowledgeGraphJsonResponse(
  body: Record<string, unknown>,
  requestId?: string
): NextResponse {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, 'utf8') > GRAPH_QUERY_MAX_RESPONSE_BYTES) {
    return NextResponse.json({
      success: false,
      code: 'KNOWLEDGE_GRAPH_RESPONSE_TOO_LARGE',
      error: 'Knowledge graph response exceeds the safe response budget.',
      ...(requestId ? { requestId } : {}),
    }, { status: 413 });
  }
  return NextResponse.json(body);
}

export function isKnowledgeGraphConsoleAvailable(
  env: Pick<NodeJS.ProcessEnv, 'NODE_ENV'> = process.env
): boolean {
  return env.NODE_ENV !== 'production';
}

export function knowledgeGraphHttpError(
  error: unknown,
  requestId?: string
): NextResponse {
  if (error instanceof KnowledgeGraphQueryAdmissionError) {
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
      ...(requestId ? { requestId } : {}),
    }, {
      status: error.status,
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
    });
  }
  if (error instanceof RagSecurityError) {
    return NextResponse.json(error.toResponseBody(), { status: error.status });
  }
  if (error instanceof RequestValidationError) {
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
      ...(requestId ? { requestId } : {}),
    }, { status: error.status });
  }
  if (error instanceof MiroFishGraphStoreError) {
    const mapped = {
      MIROFISH_GRAPH_ACTIVE_REVISION_CONFLICT: {
        status: 409,
        message: 'Graph snapshot revision changed. Refresh and retry.',
      },
      MIROFISH_GRAPH_ARTIFACT_ACTIVE: {
        status: 409,
        message: 'Active graph snapshots must be deactivated before deletion.',
      },
      MIROFISH_GRAPH_ARTIFACT_CONFLICT: {
        status: 409,
        message: 'Graph snapshot conflicts with existing data.',
      },
      MIROFISH_GRAPH_ARTIFACT_CAPACITY: {
        status: 503,
        message: 'Knowledge graph storage capacity is unavailable.',
      },
      MIROFISH_GRAPH_SHARED_STORE_REQUIRED: {
        status: 503,
        message: 'Shared knowledge graph control is unavailable.',
      },
    }[error.code];
    return NextResponse.json({
      success: false,
      code: error.code,
      error: mapped.message,
      ...(requestId ? { requestId } : {}),
    }, { status: mapped.status });
  }
  if (error instanceof KnowledgeGraphError) {
    const status = {
      KNOWLEDGE_GRAPH_UNAVAILABLE: 503,
      KNOWLEDGE_GRAPH_QUERY_TIMEOUT: 504,
      KNOWLEDGE_GRAPH_CAPACITY: 429,
      KNOWLEDGE_GRAPH_CONFLICT: 409,
      KNOWLEDGE_GRAPH_SCOPE_VIOLATION: 403,
      KNOWLEDGE_GRAPH_NOT_FOUND: 404,
    }[error.code];
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
      ...(requestId ? { requestId } : {}),
    }, { status });
  }
  console.error('[knowledge-graph] request failed:', redactErrorForLog(error));
  return NextResponse.json({
    success: false,
    code: 'KNOWLEDGE_GRAPH_REQUEST_FAILED',
    error: 'Knowledge graph request failed.',
    ...(requestId ? { requestId } : {}),
  }, { status: 500 });
}

export function requiredString(
  value: unknown,
  field: string,
  maximum = 512
): string {
  if (typeof value !== 'string') {
    throw new RequestValidationError('INVALID_' + field.toUpperCase(), field + ' is required.');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/.test(normalized)) {
    throw new RequestValidationError('INVALID_' + field.toUpperCase(), field + ' is invalid.');
  }
  return normalized;
}

export function boundedInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || Number(parsed) < minimum || Number(parsed) > maximum) {
    throw new RequestValidationError(
      'INVALID_' + field.toUpperCase(),
      field + ' must be between ' + minimum + ' and ' + maximum + '.'
    );
  }
  return Number(parsed);
}

export function requiredTrustLevel(value: unknown): RagTrustLevel {
  if (
    value === 'trusted'
    || value === 'reviewed'
    || value === 'external'
    || value === 'quarantined'
  ) {
    return value;
  }
  throw new RequestValidationError(
    'INVALID_TRUSTLEVEL',
    'trustLevel must be trusted, reviewed, external, or quarantined.'
  );
}

function boundedAdmissionSetting(
  rawValue: string | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  if (rawValue === undefined || rawValue.trim() === '') return fallback;
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(name + ' must be between 1 and ' + maximum + '.');
  }
  return parsed;
}

function pruneQueryAdmission(now: number): void {
  pruneAdmissionMap(queryAdmissionByScopeActor, now);
}

function pruneAdmissionMap(
  admission: Map<string, KnowledgeGraphQueryAdmissionState>,
  now: number
): void {
  if (admission.size < QUERY_ADMISSION_MAX_KEYS) return;
  for (const [key, state] of admission) {
    if (state.inFlight === 0 && now - state.windowStartedAt >= QUERY_ADMISSION_WINDOW_MS) {
      admission.delete(key);
    }
  }
}

function truncateUtf8(value: string, maximumBytes: number): {
  value: string;
  truncated: boolean;
} {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) {
    return { value, truncated: false };
  }
  let byteCount = 0;
  let projected = '';
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteCount + characterBytes > maximumBytes) break;
    projected += character;
    byteCount += characterBytes;
  }
  return { value: projected, truncated: true };
}

function boundedHttpText(
  value: string,
  maximumBytes: number,
  state: { truncated: boolean }
): string {
  const projected = truncateUtf8(value, maximumBytes);
  state.truncated ||= projected.truncated;
  return projected.value;
}

function boundedHttpTextList(
  values: readonly string[],
  maximumItems: number,
  maximumItemBytes: number,
  state: { truncated: boolean }
): string[] {
  const projected: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !value) {
      state.truncated = true;
      continue;
    }
    const item = boundedHttpText(value, maximumItemBytes, state);
    if (seen.has(item)) {
      state.truncated = true;
      continue;
    }
    if (projected.length >= maximumItems) {
      state.truncated = true;
      break;
    }
    seen.add(item);
    projected.push(item);
  }
  if (values.length > projected.length) state.truncated = true;
  return projected;
}
