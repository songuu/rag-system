import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { getSupabaseServerClient } from '../supabase/server-client';
import { SupabaseRestError } from '../supabase/rest-client';

export type RagAccessMode = 'local-dev' | 'single-tenant-token' | 'supabase';
export type RagTenantRole = 'owner' | 'admin' | 'member' | 'viewer';
export type RagCapability =
  | 'query'
  | 'ingest'
  | 'delete-document'
  | 'reindex'
  | 'manage-runtime';

export interface RagSecurityContext {
  actorId: string;
  tenantId: string;
  corpusId: string;
  role: RagTenantRole;
  accessMode: RagAccessMode;
  requestId: string;
  /**
   * Production-capable modes require every downstream store/retriever to apply
   * tenant/corpus isolation. local-dev remains compatible with the legacy shared stores.
   */
  enforceIsolation: boolean;
}

export interface RagSecurityRequest {
  headers: {
    get(name: string): string | null;
  };
}

export interface ResolveRagSecurityContextOptions {
  capability?: RagCapability;
  requestedCorpusId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  requestIdFactory?: () => string;
}

export type RagSecurityErrorCode =
  | 'RAG_AUTH_MODE_INVALID'
  | 'RAG_LOCAL_DEV_FORBIDDEN'
  | 'RAG_SCOPE_CONFIG_MISSING'
  | 'RAG_AUTH_CONFIG_MISSING'
  | 'RAG_AUTH_REQUIRED'
  | 'RAG_AUTH_INVALID'
  | 'RAG_AUTH_BACKEND_UNAVAILABLE'
  | 'RAG_CORPUS_INVALID'
  | 'RAG_CORPUS_REQUIRED'
  | 'RAG_CORPUS_FORBIDDEN'
  | 'RAG_TENANT_FORBIDDEN'
  | 'RAG_CAPABILITY_FORBIDDEN';

export class RagSecurityError extends Error {
  readonly code: RagSecurityErrorCode;
  readonly status: number;
  readonly requestId: string;

  constructor(input: {
    code: RagSecurityErrorCode;
    status: number;
    message: string;
    requestId: string;
  }) {
    super(input.message);
    this.name = 'RagSecurityError';
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
  }

  toResponseBody(): {
    error: { code: RagSecurityErrorCode; message: string; requestId: string };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId: this.requestId,
      },
    };
  }
}

const ROLE_CAPABILITIES: Readonly<Record<RagTenantRole, ReadonlySet<RagCapability>>> = {
  viewer: new Set(['query']),
  member: new Set(['query', 'ingest', 'delete-document']),
  admin: new Set(['query', 'ingest', 'delete-document', 'reindex', 'manage-runtime']),
  owner: new Set(['query', 'ingest', 'delete-document', 'reindex', 'manage-runtime']),
};

type CorpusRow = {
  id: string;
  tenant_id: string;
};

type MembershipRow = {
  tenant_id: string;
  user_id: string;
  role: string;
};

export async function resolveRagSecurityContext(
  request: RagSecurityRequest,
  options: ResolveRagSecurityContextOptions = {}
): Promise<RagSecurityContext> {
  const env = options.env ?? process.env;
  const requestId = resolveRequestId(request, options.requestIdFactory);
  const accessMode = resolveAccessMode(env, requestId);
  const capability = options.capability ?? 'query';
  const requestedCorpusId = normalizeCorpusId(options.requestedCorpusId, requestId);

  let context: RagSecurityContext;
  switch (accessMode) {
    case 'local-dev':
      context = resolveLocalDevContext(env, requestedCorpusId, requestId);
      break;
    case 'single-tenant-token':
      context = resolveSingleTenantContext(request, env, requestedCorpusId, requestId);
      break;
    case 'supabase':
      context = await resolveSupabaseContext(
        request,
        env,
        requestedCorpusId,
        requestId,
        options.fetchImpl
      );
      break;
  }

  assertCapability(context, capability);
  return context;
}

export function canRagRole(role: RagTenantRole, capability: RagCapability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export function assertCapability(
  context: RagSecurityContext,
  capability: RagCapability
): void {
  if (canRagRole(context.role, capability)) return;
  throw securityError(
    'RAG_CAPABILITY_FORBIDDEN',
    403,
    'The authenticated actor is not allowed to perform this operation.',
    context.requestId
  );
}

/** Backwards-friendly explicit name for callers that prefer a RAG-prefixed helper. */
export const assertRagCapability = assertCapability;

function resolveAccessMode(env: NodeJS.ProcessEnv, requestId: string): RagAccessMode {
  const raw = (env.RAG_ACCESS_MODE || env.RAG_AUTH_MODE || 'local-dev').trim().toLowerCase();
  if (raw === 'local-dev' || raw === 'single-tenant-token' || raw === 'supabase') {
    return raw;
  }
  throw securityError(
    'RAG_AUTH_MODE_INVALID',
    503,
    'RAG access mode is not configured correctly.',
    requestId
  );
}

function resolveLocalDevContext(
  env: NodeJS.ProcessEnv,
  requestedCorpusId: string | undefined,
  requestId: string
): RagSecurityContext {
  if (env.NODE_ENV === 'production') {
    throw securityError(
      'RAG_LOCAL_DEV_FORBIDDEN',
      503,
      'local-dev access mode is disabled in production.',
      requestId
    );
  }

  const tenantId = env.SUPABASE_DEFAULT_TENANT_ID?.trim() || 'local-dev-tenant';
  const corpusId = env.SUPABASE_DEFAULT_CORPUS_ID?.trim() || 'local-dev-corpus';
  assertFixedCorpus(requestedCorpusId, corpusId, requestId);

  return {
    actorId: 'local-dev',
    tenantId,
    corpusId,
    role: 'owner',
    accessMode: 'local-dev',
    requestId,
    enforceIsolation: false,
  };
}

function resolveSingleTenantContext(
  request: RagSecurityRequest,
  env: NodeJS.ProcessEnv,
  requestedCorpusId: string | undefined,
  requestId: string
): RagSecurityContext {
  const expectedToken = env.RAG_SINGLE_TENANT_TOKEN?.trim();
  const tenantId = env.SUPABASE_DEFAULT_TENANT_ID?.trim();
  const corpusId = env.SUPABASE_DEFAULT_CORPUS_ID?.trim();
  if (!expectedToken || !tenantId || !corpusId) {
    throw securityError(
      'RAG_SCOPE_CONFIG_MISSING',
      503,
      'Single-tenant access scope is not configured.',
      requestId
    );
  }

  const suppliedToken = readBearerToken(request);
  if (!suppliedToken) {
    throw securityError('RAG_AUTH_REQUIRED', 401, 'Authentication is required.', requestId);
  }
  if (!safeSecretEqual(suppliedToken, expectedToken)) {
    throw securityError('RAG_AUTH_INVALID', 401, 'Authentication failed.', requestId);
  }

  const role = resolveSingleTenantRole(env.RAG_SINGLE_TENANT_ROLE, requestId);
  assertFixedCorpus(requestedCorpusId, corpusId, requestId);
  return {
    actorId: env.RAG_SINGLE_TENANT_ACTOR_ID?.trim() || 'single-tenant-operator',
    tenantId,
    corpusId,
    role,
    accessMode: 'single-tenant-token',
    requestId,
    enforceIsolation: true,
  };
}

async function resolveSupabaseContext(
  request: RagSecurityRequest,
  env: NodeJS.ProcessEnv,
  requestedCorpusId: string | undefined,
  requestId: string,
  fetchImpl?: typeof fetch
): Promise<RagSecurityContext> {
  const accessToken = readBearerToken(request);
  if (!accessToken) {
    throw securityError('RAG_AUTH_REQUIRED', 401, 'Authentication is required.', requestId);
  }

  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '';
  const publishableKey = (
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  ).trim();
  const client = getSupabaseServerClient(accessToken, {
    config: { url, publishableKey },
    fetchImpl,
  });
  if (!client) {
    throw securityError(
      'RAG_AUTH_CONFIG_MISSING',
      503,
      'Supabase request authentication is not configured.',
      requestId
    );
  }

  let actorId: string;
  try {
    const user = await client.getAuthUser();
    actorId = typeof user.id === 'string' ? user.id.trim() : '';
  } catch (error) {
    if (error instanceof SupabaseRestError && (error.status === 401 || error.status === 403)) {
      throw securityError('RAG_AUTH_INVALID', 401, 'Authentication failed.', requestId);
    }
    throw securityError(
      'RAG_AUTH_BACKEND_UNAVAILABLE',
      503,
      'Authentication is temporarily unavailable.',
      requestId
    );
  }
  if (!actorId) {
    throw securityError('RAG_AUTH_INVALID', 401, 'Authentication failed.', requestId);
  }

  const corpusId = requestedCorpusId ?? env.SUPABASE_DEFAULT_CORPUS_ID?.trim();
  if (!corpusId) {
    throw securityError(
      'RAG_CORPUS_REQUIRED',
      400,
      'A corpus must be selected for this request.',
      requestId
    );
  }

  let corpus: CorpusRow | null;
  try {
    corpus = await client.selectSingle<CorpusRow>('corpora', {
      select: 'id,tenant_id',
      filters: { id: corpusId },
    });
  } catch {
    throw securityError(
      'RAG_AUTH_BACKEND_UNAVAILABLE',
      503,
      'Authorization data is temporarily unavailable.',
      requestId
    );
  }
  if (!corpus || corpus.id !== corpusId || !corpus.tenant_id) {
    throw securityError(
      'RAG_CORPUS_FORBIDDEN',
      403,
      'The selected corpus is not available to the authenticated actor.',
      requestId
    );
  }

  let membership: MembershipRow | null;
  try {
    membership = await client.selectSingle<MembershipRow>('tenant_members', {
      select: 'tenant_id,user_id,role',
      filters: {
        tenant_id: corpus.tenant_id,
        user_id: actorId,
      },
    });
  } catch {
    throw securityError(
      'RAG_AUTH_BACKEND_UNAVAILABLE',
      503,
      'Authorization data is temporarily unavailable.',
      requestId
    );
  }
  if (
    !membership ||
    membership.tenant_id !== corpus.tenant_id ||
    membership.user_id !== actorId ||
    !isTenantRole(membership.role)
  ) {
    throw securityError(
      'RAG_TENANT_FORBIDDEN',
      403,
      'Tenant membership is required for the selected corpus.',
      requestId
    );
  }

  return {
    actorId,
    tenantId: corpus.tenant_id,
    corpusId,
    role: membership.role,
    accessMode: 'supabase',
    requestId,
    enforceIsolation: true,
  };
}

function normalizeCorpusId(value: string | undefined, requestId: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw securityError(
      'RAG_CORPUS_INVALID',
      400,
      'The selected corpus identifier is invalid.',
      requestId
    );
  }
  return normalized;
}

function assertFixedCorpus(
  requestedCorpusId: string | undefined,
  fixedCorpusId: string,
  requestId: string
): void {
  if (!requestedCorpusId || requestedCorpusId === fixedCorpusId) return;
  throw securityError(
    'RAG_CORPUS_FORBIDDEN',
    403,
    'The selected corpus is outside the configured access scope.',
    requestId
  );
}

function resolveSingleTenantRole(
  value: string | undefined,
  requestId: string
): RagTenantRole {
  const role = value?.trim().toLowerCase() || 'owner';
  if (isTenantRole(role)) return role;
  throw securityError(
    'RAG_AUTH_MODE_INVALID',
    503,
    'Single-tenant role is not configured correctly.',
    requestId
  );
}

function isTenantRole(value: string): value is RagTenantRole {
  return value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer';
}

function readBearerToken(request: RagSecurityRequest): string | undefined {
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1];
}

function safeSecretEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function resolveRequestId(
  request: RagSecurityRequest,
  requestIdFactory: (() => string) | undefined
): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  if (supplied && supplied.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(supplied)) {
    return supplied;
  }
  return (requestIdFactory ?? randomUUID)();
}

function securityError(
  code: RagSecurityErrorCode,
  status: number,
  message: string,
  requestId: string
): RagSecurityError {
  return new RagSecurityError({ code, status, message, requestId });
}
