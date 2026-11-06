import { loadAuthorizedProjectGraph } from './project-graph';
import { MiroFishReportError, type MiroFishReportContext, type MiroFishReportScope, type MiroFishReportSnapshot } from './report-contracts';
import { getScopedMiroFishProjectStore } from './request-scope';

export function assertReportSimulationReady(context: MiroFishReportContext): void {
  const { snapshot } = context;
  if (!['completed', 'stopped'].includes(snapshot.info.status)
    || snapshot.projection?.enabled && snapshot.projection.status !== 'complete') {
    throw new MiroFishReportError('MIROFISH_REPORT_SIMULATION_NOT_READY', '请等待模拟成功结束且图谱记忆写入完成后生成报告。');
  }
}
export function reportContextIdentity(context: MiroFishReportContext): string {
  const identity = context.identity;
  return JSON.stringify([context.projectId, identity.tenantId, identity.corpusId, identity.documentId,
    identity.documentVersion, identity.trustLevel, identity.graphGeneration ?? null, context.authority,
    context.snapshot.info.updated_at ?? null, context.snapshot.info.current_round, context.snapshot.posts.length,
    context.snapshot.projection?.runId ?? null, context.snapshot.projection?.committedEventSequence ?? null]);
}
/** Resolve the same immutable source used by graph readback; reporting never bypasses its authority checks. */
export async function loadMiroFishReportContext(simulationId: string, scope?: MiroFishReportScope): Promise<MiroFishReportContext> {
  const { loadSimulationSnapshot } = await import('./simulation-runner');
  const snapshot = await loadSimulationSnapshot(simulationId, scope) as MiroFishReportSnapshot | null;
  if (!snapshot) throw new MiroFishReportError('MIROFISH_REPORT_SIMULATION_NOT_FOUND', '模拟不存在。', 404);
  const project = await getScopedMiroFishProjectStore(scope).get(snapshot.info.project_id);
  if (!project) throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_UNAVAILABLE', '模拟所属项目已不可用。');
  // A historical run owns its immutable source selector. A later reset or new
  // project graph does not revoke that source; the PG authority check still can.
  const bound = snapshot.sourceGraphIdentity;
  if (!bound) throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_UNBOUND', '旧模拟没有可验证的来源版本，请重新准备并运行模拟。');
  const selector = { graph_id: bound.documentId, graph_identity: bound };
  if (!selector.graph_id) throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_UNAVAILABLE', '项目尚未绑定可读取的图谱。');
  const loaded = await loadAuthorizedProjectGraph(selector, scope);
  if (!loaded) throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_UNAVAILABLE', '图谱来源已不可用或授权已撤销。');
  const { graph, identity, authority } = loaded;
  if (bound && (bound.documentId !== identity.documentId || bound.documentVersion !== identity.documentVersion
    || bound.trustLevel !== identity.trustLevel || bound.graphGeneration !== identity.graphGeneration
    || bound.tenantId !== undefined && bound.tenantId !== identity.tenantId
    || bound.corpusId !== undefined && bound.corpusId !== identity.corpusId)) {
    throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_CHANGED', '模拟绑定的图谱已变化，请重新准备模拟。');
  }
  return { snapshot, graph, identity, authority,
    requirement: snapshot.scenario?.requirement ?? project.simulation_requirement, projectId: project.id };
}
