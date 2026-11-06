import type { EntityProfile, GraphData, Ontology, Project, ProjectGraphIdentity } from './types';

export interface MiroFishWorkspaceOptions {
  simulationId?: string | null;
  reportId?: string | null;
  step?: number;
  signal?: AbortSignal;
}

/** Resolve history links through their saved run, without changing the project's current run. */
export async function loadMiroFishWorkspace(
  projectId: string,
  options: MiroFishWorkspaceOptions = {},
  fetcher: typeof fetch = fetch,
) {
  const read = async (url: string) => {
    const response = await fetcher(url, { signal: options.signal });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || '读取工作台失败');
    return body;
  };
  const { project } = await read(`/rag-api/mirofish/project/${encodeURIComponent(projectId)}`) as { project: Project };
  if (!project || project.id !== projectId) throw new Error('项目不存在');
  const historical = Boolean(options.simulationId || options.reportId);
  let simulationId = options.simulationId || (historical ? null : project.simulation_id) || null;
  const reportId = options.reportId || (!historical ? project.report_id : null) || null;
  let reportStatus: string | undefined;
  if (reportId) {
    const { report } = await read(`/rag-api/mirofish/report/${encodeURIComponent(reportId)}`);
    if (!report || report.report_id !== reportId || (report.project_id && report.project_id !== projectId)) {
      throw new Error('报告不属于当前项目');
    }
    if (simulationId && simulationId !== report.simulation_id) throw new Error('报告与所选模拟运行不匹配');
    simulationId = report.simulation_id;
    reportStatus = report.status;
  }
  let graphData: GraphData | null = project.graph_data || null;
  let graphIdentity: ProjectGraphIdentity | null = project.graph_identity || null;
  let profiles: EntityProfile[] = project.agent_profiles || [];
  let simulationStatus: string | undefined;
  let displayProject = project;
  if (simulationId) {
    const { snapshot } = await read(`/rag-api/mirofish/simulation/${encodeURIComponent(simulationId)}?action=snapshot`);
    if (!snapshot?.info || snapshot.info.simulation_id !== simulationId
      || (snapshot.info.project_id || snapshot.info.config?.project_id) !== projectId) {
      throw new Error('模拟运行不属于当前项目');
    }
    profiles = snapshot.info.agent_profiles || [];
    simulationStatus = snapshot.info.status;
    if (historical && snapshot.scenario) displayProject = { ...project,
      simulation_requirement: snapshot.scenario.requirement || project.simulation_requirement,
      seed_files: snapshot.scenario.seedFiles || [],
    };
    const identity: ProjectGraphIdentity | undefined = snapshot.sourceGraphIdentity;
    if (!identity?.documentId || !identity.documentVersion || !identity.trustLevel) throw new Error('此运行缺少可验证的来源图谱，请重新准备模拟环境');
    if (identity) {
      graphIdentity = identity;
    }
  }
  const graphId = graphIdentity?.documentId || graphData?.graph_id || project.graph_id;
  if (graphId) {
    // Cached project JSON is presentation state, never source authorization.
    const query = new URLSearchParams({ action: 'data', graphId });
    if (graphIdentity) {
      query.set('documentVersion', graphIdentity.documentVersion);
      query.set('trustLevel', graphIdentity.trustLevel);
      if (graphIdentity.graphGeneration) query.set('graphGeneration', graphIdentity.graphGeneration);
    }
    const data = await read(`/rag-api/mirofish/graph?${query}`);
    if (!data.graph || data.graph.graph_id !== graphId) throw new Error('运行来源图谱不可用');
    graphData = data.graph;
    if (!graphIdentity && data.documentVersion && data.trustLevel) graphIdentity = {
      documentId: graphId, documentVersion: data.documentVersion, trustLevel: data.trustLevel,
      ...(data.graphGeneration ? { graphGeneration: data.graphGeneration } : {}),
    };
  }
  let maxStep = graphData ? 1 : 0;
  if (simulationId) maxStep = 2;
  if (['completed', 'stopped'].includes(simulationStatus || '')) maxStep = 3;
  if (reportId && reportStatus === 'completed') maxStep = 4;
  const requestedStep = options.step ?? (historical ? maxStep : project.current_step);
  const currentStep = Math.min(maxStep, Math.max(historical ? 2 : 0, Number.isInteger(requestedStep) ? requestedStep : 0));
  return { project: displayProject, ontology: (project.ontology || null) as Ontology | null, graphData, graphIdentity,
    profiles, simulationId, reportId, simulationStatus, currentStep, maxStep, isHistorical: historical };
}
