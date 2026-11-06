import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../rag/eval/canonical-json';
import { getPostgresClient, queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../postgres/env';
import { PostgresKnowledgeGraphBuildJobStore, type KnowledgeGraphBuildJob } from '../knowledge-graph/postgres-graph-build-store';
import { createMiroFishGraphVersion } from '../knowledge-graph/mirofish-adapter';
import { createRetrievalScope, type RagTrustLevel } from '../security/retrieval-scope';
import { RequestValidationError } from '../security/request-validation';
import { normalizeMiroFishGraphOntology } from './graph-builder';
import { validateHttpModelOverride, type ServerModelOverride } from './model-override';
import { getMiroFishRuntimeStore, type MiroFishRuntimeScope, type MiroFishRuntimeStore } from './runtime-store';
import type { Ontology } from './types';
import type { EmbeddingProvider } from '../embedding-config';

export const STANDALONE_GRAPH_TRIGGER = 'mirofish-standalone-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const textDigest = (text: string) => {
  // In Unicode mode valid surrogate pairs form one code point. Reject isolated
  // units so UTF-8 replacement cannot make distinct source strings hash alike.
  if (/[\uD800-\uDFFF]/u.test(text)) throw new StandaloneGraphRequestError();
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
};

export interface MiroFishStandaloneGraphRequest {
  schemaVersion: 1;
  recordType: 'request';
  id: string;
  projectId: string;
  scope: MiroFishRuntimeScope;
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
  graphName: string;
  text: string;
  ontology: Ontology;
  chunkSize: number;
  chunkOverlap: number;
  modelOverride: ServerModelOverride;
  embeddingModel: string;
  embeddingProvider: EmbeddingProvider;
  ttlMs?: number;
  createdAt: string;
  profileHash: string;
  requestDigest: string;
  taskId?: string;
}
export interface StandaloneGraphInput {
  projectId: string; text: string; ontology: Ontology; chunkSize: number; chunkOverlap: number;
  trustLevel: RagTrustLevel; modelOverride: ServerModelOverride; embeddingModel: string; embeddingProvider: EmbeddingProvider;
  ttlMs?: number;
}
type JobStore = Pick<PostgresKnowledgeGraphBuildJobStore, 'get' | 'enqueueDocumentBuild' | 'resumeFailedDocumentBuild'>;
interface Dependencies { records?: MiroFishRuntimeStore; jobs?: JobStore;
  findActive?: (projectId: string, scope: MiroFishRuntimeScope) => Promise<string | null> }

export class StandaloneGraphRequestError extends Error {
  readonly code = 'MIROFISH_GRAPH_REQUEST_INVALID';
  constructor() { super('已保存的图谱构建请求不可用或已变更。'); }
}

export function standaloneGraphTaskId(jobId: string): string {
  if (!UUID.test(jobId)) throw new StandaloneGraphRequestError();
  return `task_${jobId}`;
}
export function standaloneGraphJobId(taskId: string): string | null {
  return taskId.startsWith('task_') && UUID.test(taskId.slice(5)) ? taskId.slice(5) : null;
}
export function standaloneGraphIdentity(request: MiroFishStandaloneGraphRequest) {
  return { ...request.scope, documentId: request.documentId, documentVersion: request.documentVersion, trustLevel: request.trustLevel };
}
function fingerprint(input: StandaloneGraphInput, scope: MiroFishRuntimeScope): string {
  const { text, ttlMs, ...settings } = input;
  return hash({ scope: { tenantId: scope.tenantId, corpusId: scope.corpusId }, ...settings, textDigest: textDigest(text),
    ...(ttlMs === undefined ? {} : { ttlMs }), ontology: normalizeMiroFishGraphOntology(input.ontology),
    modelOverride: frozenModel(input.modelOverride), profile: 'complete-structured-v2:embedding-90s:llm-cold-start' });
}
function frozenModel(model: ServerModelOverride): ServerModelOverride {
  if (!model || !['ollama', 'openai', 'custom', 'azure', 'openrouter', 'lemonade'].includes(model.provider)) throw new StandaloneGraphRequestError();
  // Reuse the same model-name, temperature and credential/endpoint bans. The
  // wider provider comes only from the server default, never the HTTP selector.
  const selected = validateHttpModelOverride({ ...model, provider: 'custom' })!;
  return { ...selected, provider: model.provider };
}
function requestHash(request: Omit<MiroFishStandaloneGraphRequest, 'requestDigest'>): string {
  const { taskId: _taskId, text, ...frozen } = request;
  void _taskId;
  // Hash raw source separately: the metadata canonicalizer has a 256 KiB cap.
  return hash({ ...frozen, textDigest: textDigest(text) });
}
export function freezeStandaloneGraphRequest(input: StandaloneGraphInput, scope: MiroFishRuntimeScope): MiroFishStandaloneGraphRequest {
  if (!/^proj_[A-Za-z0-9_-]{1,128}$/.test(input.projectId) || !input.text.trim() || input.text.length > 2_000_000
    || !Number.isSafeInteger(input.chunkSize) || input.chunkSize < 1 || !Number.isSafeInteger(input.chunkOverlap)
    || input.chunkOverlap < 0 || input.chunkOverlap >= input.chunkSize || !input.embeddingModel.trim()) throw new StandaloneGraphRequestError();
  const frozen: Omit<MiroFishStandaloneGraphRequest, 'requestDigest'> = {
    schemaVersion: 1, recordType: 'request', id: `graph_request_${randomUUID()}`, projectId: input.projectId,
    scope: { tenantId: scope.tenantId, corpusId: scope.corpusId }, documentId: `mirofish_${randomUUID()}`,
    documentVersion: `sha256:${createHash('sha256').update(input.text).digest('hex')}`,
    trustLevel: input.trustLevel, graphName: `Project ${input.projectId} Graph`, text: input.text,
    ontology: normalizeMiroFishGraphOntology(input.ontology), chunkSize: input.chunkSize, chunkOverlap: input.chunkOverlap,
    modelOverride: frozenModel(input.modelOverride), embeddingModel: input.embeddingModel,
    embeddingProvider: input.embeddingProvider, createdAt: new Date().toISOString(), profileHash: fingerprint(input, scope),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  };
  return { ...frozen, requestDigest: requestHash(frozen) };
}

function queueStore(): PostgresKnowledgeGraphBuildJobStore {
  const config = getPostgresRuntimeConfig();
  const client = shouldUsePostgresPersistence(config) && getPostgresClient(config);
  if (!client) throw new StandaloneGraphRequestError();
  return new PostgresKnowledgeGraphBuildJobStore(client);
}
export function usesDurableStandaloneGraphBuilds(): boolean {
  return process.env.RAG_GRAPH_BACKEND?.trim() === 'neo4j' && shouldUsePostgresPersistence(getPostgresRuntimeConfig());
}
/** Recover the enqueue-to-project-save gap without scanning private source blobs. */
export async function findActiveStandaloneGraphTask(projectId: string, scope: MiroFishRuntimeScope,
  client?: PostgresQueryClient): Promise<string | null> {
  if (!client && !shouldUsePostgresPersistence(getPostgresRuntimeConfig())) return null;
  const query = client ?? getPostgresClient();
  if (!query) throw new StandaloneGraphRequestError();
  const result = await queryPostgres<{ id: string }>(query, `select id::text from public.graph_build_jobs
    where tenant_id = $1 and corpus_id = $2 and metadata->>'trigger' = $3
      and metadata #>> '{mirofishStandalone,projectId}' = $4 and status in ('queued', 'running', 'staged')
    order by created_at desc, id desc limit 1`,
  [scope.tenantId, scope.corpusId, STANDALONE_GRAPH_TRIGGER, projectId], 'find active standalone project graph');
  return result.rows[0] ? standaloneGraphTaskId(result.rows[0].id) : null;
}
export async function readStandaloneGraphRequest(job: KnowledgeGraphBuildJob, records = getMiroFishRuntimeStore(job)) {
  const metadata = job.metadata.mirofishStandalone;
  if (job.metadata.trigger !== STANDALONE_GRAPH_TRIGGER || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new StandaloneGraphRequestError();
  const reference = metadata as Record<string, unknown>;
  if (typeof reference.requestId !== 'string') throw new StandaloneGraphRequestError();
  const request = await records.read<MiroFishStandaloneGraphRequest>('graph', reference.requestId);
  if (!request || request.schemaVersion !== 1 || request.recordType !== 'request' || request.id !== reference.requestId
    || !request.scope || typeof request.scope !== 'object'
    || request.scope.tenantId !== job.tenantId || request.scope.corpusId !== job.corpusId
    || request.projectId !== reference.projectId || request.requestDigest !== reference.requestDigest
    || request.profileHash !== reference.profileHash
    || request.taskId !== undefined && request.taskId !== standaloneGraphTaskId(job.id)) throw new StandaloneGraphRequestError();
  const { requestDigest, ...body } = request;
  if (requestHash(body) !== requestDigest || createMiroFishGraphVersion(standaloneGraphIdentity(request)) !== job.graphVersion
    || canonicalJson(job.metadata.documentIdentity) !== canonicalJson(standaloneGraphIdentity(request))) throw new StandaloneGraphRequestError();
  return request;
}

export async function enqueueStandaloneGraphBuild(input: StandaloneGraphInput, scope: MiroFishRuntimeScope,
  previousTaskId?: string | null, dependencies: Dependencies = {}): Promise<string> {
  const records = dependencies.records ?? getMiroFishRuntimeStore(scope);
  const jobs = dependencies.jobs ?? queueStore();
  const retrieval = createRetrievalScope({ ...scope, allowedTrustLevels: [input.trustLevel], enforceIsolation: true });
  const active = dependencies.findActive ?? (!dependencies.jobs ? findActiveStandaloneGraphTask : undefined);
  const candidateTaskId = await active?.(input.projectId, scope) ?? previousTaskId;
  const previousJobId = candidateTaskId && standaloneGraphJobId(candidateTaskId);
  if (previousJobId) {
    const previous = await jobs.get(scope, previousJobId);
    if (previous?.metadata.trigger === STANDALONE_GRAPH_TRIGGER) {
      const saved = await readStandaloneGraphRequest(previous, records);
      if (saved.projectId !== input.projectId) throw new StandaloneGraphRequestError();
      if (saved.profileHash === fingerprint(input, scope) && previous.status !== 'cancelled') {
        if (previous.status === 'failed') await jobs.resumeFailedDocumentBuild(retrieval, standaloneGraphIdentity(saved), previous.id);
        const taskId = standaloneGraphTaskId(previous.id);
        if (!saved.taskId) await records.write('graph', saved.id, { ...saved, taskId }, { projectId: saved.projectId });
        return taskId;
      }
      if (['queued', 'running', 'staged'].includes(previous.status)) throw new RequestValidationError('MIROFISH_PROJECT_GRAPH_BUILDING', '项目已有图谱构建任务', 409);
    }
  }
  const request = freezeStandaloneGraphRequest(input, scope);
  // Source text must be durable before its queue reference becomes claimable.
  await records.write('graph', request.id, request, { projectId: request.projectId });
  const job = await jobs.enqueueDocumentBuild(retrieval, standaloneGraphIdentity(request), {
    trigger: STANDALONE_GRAPH_TRIGGER, sourceName: request.graphName,
    mirofishStandalone: { requestId: request.id, projectId: request.projectId, requestDigest: request.requestDigest, profileHash: request.profileHash },
  }, { regenerate: false });
  const taskId = standaloneGraphTaskId(job.id);
  await records.write('graph', request.id, { ...request, taskId }, { projectId: request.projectId });
  return taskId;
}

export async function readStandaloneGraphTask(taskId: string, scope: MiroFishRuntimeScope, dependencies: Dependencies = {}) {
  const id = standaloneGraphJobId(taskId);
  if (!id || !dependencies.jobs && !shouldUsePostgresPersistence(getPostgresRuntimeConfig())) return null;
  const job = await (dependencies.jobs ?? queueStore()).get(scope, id);
  if (!job || job.metadata.trigger !== STANDALONE_GRAPH_TRIGGER) return null;
  const request = await readStandaloneGraphRequest(job, dependencies.records ?? getMiroFishRuntimeStore(scope));
  if (request.trustLevel === 'quarantined') return null;
  const completed = job.status === 'validated' || job.status === 'published';
  const failed = job.status === 'failed' || job.status === 'cancelled';
  return {
    success: true, status: completed ? 'completed' : failed ? 'failed' : job.status === 'queued' ? 'pending' : 'processing',
    progress: completed ? 100 : Math.min(99, Math.round(job.progress * 100)),
    message: completed ? '图谱构建完成' : failed ? '图谱构建失败' : job.status === 'queued' ? '任务已保存，等待构建或恢复...' : '正在构建图谱，已保存进度，可在刷新后继续。',
    ...(completed ? { graphId: request.documentId, documentVersion: request.documentVersion, trustLevel: request.trustLevel } : {}),
    ...(failed ? { code: job.errorCode || 'MIROFISH_GRAPH_BUILD_FAILED' } : {}),
  };
}
