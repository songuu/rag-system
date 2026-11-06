import type { Project } from './types';
import { getPostgresClient, PostgresQueryError, withPostgresClientContext, type PostgresQueryClient } from '../postgres/client';
import { getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../postgres/env';
import { getMiroFishRuntimeStore, type MiroFishRuntimeScope, type MiroFishRuntimeStore } from './runtime-store';

export class MiroFishProjectInUseError extends Error {
  readonly code = 'MIROFISH_PROJECT_IN_USE';
  constructor() { super('项目仍有图谱构建、环境准备、模拟或报告任务，请先结束任务再重置或删除。'); }
}
const lockGlobal = globalThis as typeof globalThis & { __miroFishProjectLocksV1?: Map<string, Promise<unknown>> };
const locks = lockGlobal.__miroFishProjectLocksV1 ??= new Map<string, Promise<unknown>>();

/** Lock both the project and its durable job pointer across API processes. */
export async function withMiroFishProjectLock<T>(scope: MiroFishRuntimeScope, projectId: string, work: () => Promise<T>,
  dependencies: { client?: PostgresQueryClient | null } = {}): Promise<T> {
  const key = JSON.stringify([scope.tenantId, scope.corpusId, projectId]);
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const config = getPostgresRuntimeConfig();
    const client = dependencies.client !== undefined ? dependencies.client
      : shouldUsePostgresPersistence(config) ? getPostgresClient(config) : null;
    if (!client) return work();
    if (!client.withTransaction) throw new Error('Project mutation requires a PostgreSQL transaction.');
    let workError: unknown;
    try {
      return await client.withTransaction('mutate MiroFish project', async transaction => {
        await transaction.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`mirofish-project:${key}`]);
        return withPostgresClientContext(client, transaction, async () => {
          try { return await work(); } catch (error) { workError = error; throw error; }
        });
      });
    } catch (error) {
      // Retain domain errors such as PROJECT_IN_USE after a successful rollback.
      if (workError && error instanceof PostgresQueryError && error.cause === workError) throw workError;
      throw error;
    }
  });
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}

export async function assertMiroFishProjectIdle(project: Project, scope: MiroFishRuntimeScope,
  dependencies: { store?: MiroFishRuntimeStore; graphTaskStatus?: (id: string) => Promise<string | undefined>;
    graphBuildActive?: (projectId: string) => Promise<boolean> } = {}) {
  const durableActive = dependencies.graphBuildActive
    ? await dependencies.graphBuildActive(project.id)
    : !dependencies.store && Boolean(await (await import('./standalone-graph-runtime')).findActiveStandaloneGraphTask(project.id, scope));
  if (durableActive) throw new MiroFishProjectInUseError();
  if (project.graph_task_id) {
    if (!dependencies.graphTaskStatus) throw new MiroFishProjectInUseError();
    const status = await dependencies.graphTaskStatus?.(project.graph_task_id);
    // The caller checks native tasks and durable leases. Stale recovery
    // metadata alone must not permanently block reset.
    if (status && ['pending', 'processing'].includes(status)) throw new MiroFishProjectInUseError();
  }
  const store = dependencies.store ?? getMiroFishRuntimeStore(scope);
  const [simulations, reports, preparations] = await Promise.all([
    store.list<{ info: { status: string } }>('simulation', { projectId: project.id, limit: 200 }),
    store.list<{ status: string; report_id?: string }>('report', { projectId: project.id, limit: 200 }),
    store.list<{ status: string; id?: string }>('prepare', { projectId: project.id, limit: 200 }),
  ]);
  if (!dependencies.store) {
    // Normalize abandoned single-process jobs before deciding whether recovery
    // can reset a project. Raw persisted 'generating' is not a live owner lease.
    const { getMiroFishReportRuntime } = await import('./report-runtime');
    const { readSimulationPreparation } = await import('./simulation-preparation');
    const runtime = await getMiroFishReportRuntime(scope);
    for (const report of reports) if (report.status === 'generating' && report.report_id) {
      const current = await runtime.get(report.report_id);
      if (current) report.status = current.status;
    }
    for (const preparation of preparations) if (preparation.status === 'processing' && preparation.id) {
      const current = await readSimulationPreparation(preparation.id, { scope });
      if (current) preparation.status = current.status;
    }
  }
  // A capped scan cannot establish absence of older active consumers.
  if ([simulations, reports, preparations].some(records => records.length >= 200)
    || simulations.some(record => ['running', 'paused', 'stopping', 'finalizing', 'preparing'].includes(record.info?.status))
    || reports.some(record => record.status === 'generating') || preparations.some(record => record.status === 'processing')) {
    throw new MiroFishProjectInUseError();
  }
}
