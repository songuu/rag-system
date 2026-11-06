'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import StepNav from '@/components/mirofish/StepNav';
import ModelSelector from '@/components/mirofish/ModelSelector';
import Step1GraphBuild from '@/components/mirofish/Step1GraphBuild';
import Step2EnvSetup, { type SimulationConfigInput } from '@/components/mirofish/Step2EnvSetup';
import Step3Simulation from '@/components/mirofish/Step3Simulation';
import Step4Report from '@/components/mirofish/Step4Report';
import Step5Interaction from '@/components/mirofish/Step5Interaction';
import MiroFishGraphWorkbench from '@/components/mirofish/MiroFishGraphWorkbench';
import { useMiroFishLocale } from '@/components/mirofish/MiroFishLocaleProvider';
import { loadMiroFishWorkspace } from '@/lib/mirofish/workspace-client';
import { bindPreparedProfilesToGraph } from '@/lib/mirofish/profile-bindings';
import type { EntityProfile, GraphData, ModelOverride, Ontology, Project, ProjectGraphIdentity } from '@/lib/mirofish/types';
import type { MiroFishSeedFileInfo } from '@/lib/mirofish/seed-file-contract';

export default function MiroFishConsolePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const query = useSearchParams();
  const selectedSimulation = query.get('simulationId');
  const selectedReport = query.get('reportId');
  const requestedStep = query.get('step');
  const historical = Boolean(selectedSimulation || selectedReport);
  const { t } = useMiroFishLocale();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [currentStep, setCurrentStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphIdentity, setGraphIdentity] = useState<ProjectGraphIdentity | null>(null);
  const [profiles, setProfiles] = useState<EntityProfile[]>([]);
  const [simulationId, setSimulationId] = useState<string | null>(null);
  const [simulationStatus, setSimulationStatus] = useState<string>();
  const [reportId, setReportId] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<ModelOverride | null>(null);
  const [persistenceError, setPersistenceError] = useState('');
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const writeGeneration = useRef(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    writeGeneration.current += 1;
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return null;
      setLoading(true); setLoadError('');
      return loadMiroFishWorkspace(projectId, { simulationId: selectedSimulation, reportId: selectedReport,
        step: requestedStep === null ? undefined : Number(requestedStep), signal: controller.signal });
    }).then(workspace => {
      if (!workspace || controller.signal.aborted) return;
      setProject(workspace.project);
      setCurrentStep(workspace.currentStep);
      setMaxStep(workspace.maxStep);
      setOntology(workspace.ontology);
      setGraphData(workspace.graphData);
      setGraphIdentity(workspace.graphIdentity);
      setProfiles(workspace.profiles);
      setSimulationId(workspace.simulationId);
      setSimulationStatus(workspace.simulationStatus);
      setReportId(workspace.reportId);
      setModelOverride(workspace.project.model_config || null);
    }).catch(cause => {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : '读取项目失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); writeGeneration.current += 1; };
  }, [projectId, selectedSimulation, selectedReport, requestedStep, reload]);

  useEffect(() => () => { if (draftTimer.current) clearTimeout(draftTimer.current); }, []);

  // Serialize draft and stage writes so a slower request cannot undo a saved transition.
  const updateProject = useCallback((updates: Record<string, unknown>): Promise<Project | null> => {
    const generation = writeGeneration.current;
    const operation = saveQueue.current.then(async () => {
      try {
        const response = await fetch(`/rag-api/mirofish/project/${encodeURIComponent(projectId)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
        });
        const data = await response.json();
        if (!response.ok || !data.success || !data.project) throw new Error(data.error || '保存项目进度失败');
        if (generation !== writeGeneration.current) return null;
        setProject(data.project);
        setPersistenceError('');
        return data.project as Project;
      } catch (cause) {
        if (generation === writeGeneration.current) setPersistenceError(cause instanceof Error ? cause.message : '保存项目进度失败');
        return null;
      }
    });
    saveQueue.current = operation;
    return operation;
  }, [projectId]);
  const requireSaved = useCallback(async (updates: Record<string, unknown>) => {
    const saved = await updateProject(updates);
    if (!saved) throw new Error('保存项目进度失败，请重试');
    return saved;
  }, [updateProject]);
  const handleTextsPersist = useCallback(async (texts: string[]) => { await requireSaved({ texts }); }, [requireSaved]);
  const handleSeedFilesPersist = useCallback(async (seed_files: MiroFishSeedFileInfo[]) => {
    await requireSaved({ seed_files });
  }, [requireSaved]);
  const handleOntologyGenerated = useCallback(async (next: Ontology) => {
    await requireSaved({ ontology: next }); setOntology(next);
  }, [requireSaved]);
  const handleGraphTaskStarted = useCallback(async (graph_task_id: string | null) => {
    await requireSaved({ graph_task_id });
  }, [requireSaved]);
  const handleGraphBuilt = useCallback(async (graph: GraphData, identity?: ProjectGraphIdentity) => {
    await requireSaved({ graph_data: graph, graph_id: graph.graph_id, graph_identity: identity || null,
      graph_task_id: null, status: 'graph_built' });
    setGraphData(graph); setGraphIdentity(identity || null); setMaxStep(previous => Math.max(previous, 1));
  }, [requireSaved]);
  const handleDraftChange = useCallback((draft: { selectedEntityIds: string[]; config: SimulationConfigInput }) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { void updateProject({ selected_entity_ids: draft.selectedEntityIds,
      simulation_config: draft.config }); }, 350);
  }, [updateProject]);
  const handlePrepareTaskStarted = useCallback(async (prepare_task_id: string) => {
    await requireSaved({ prepare_task_id });
  }, [requireSaved]);
  const handlePrepared = useCallback(async (result: { prepare_id: string; profiles: EntityProfile[];
    config: SimulationConfigInput; prepared_at: string; prepare_fingerprint: string }) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    await requireSaved({ prepare_id: result.prepare_id, agent_profiles: result.profiles, simulation_config: result.config,
      prepared_at: result.prepared_at, prepare_fingerprint: result.prepare_fingerprint, prepare_task_id: null });
    setProfiles(result.profiles);
  }, [requireSaved]);
  const saveModelConfig = useCallback(async (model_config: ModelOverride | null) => {
    if (historical) return;
    await requireSaved({ model_config });
  }, [requireSaved, historical]);
  const handleStep1Complete = async () => {
    if (!graphData) return;
    const saved = await updateProject({ current_step: 1, status: 'graph_built', ontology, graph_data: graphData });
    if (saved) { setCurrentStep(1); setMaxStep(previous => Math.max(previous, 1)); }
  };
  const handleSimulationCreated = async (id: string, config?: SimulationConfigInput) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const boundProfiles = bindPreparedProfilesToGraph(profiles, graphData?.nodes ?? []);
    await requireSaved({ current_step: 2, status: 'env_setup', simulation_id: id, report_id: null,
      agent_profiles: boundProfiles, selected_entity_ids: boundProfiles.map(profile => profile.entity_id),
      ...(config ? { simulation_config: config } : {}) });
    setProfiles(boundProfiles);
    setSimulationId(id); setReportId(null); setSimulationStatus('ready');
    setCurrentStep(2); setMaxStep(2);
  };
  const handleStep3Complete = async () => {
    if (!historical) await requireSaved({ current_step: 3, status: 'simulating' });
    setSimulationStatus('completed'); setCurrentStep(3); setMaxStep(previous => Math.max(previous, 3));
  };
  const handleReportGenerated = useCallback(async (id: string) => {
    if (!historical) await requireSaved({ report_id: id });
    setReportId(id);
  }, [historical, requireSaved]);
  const handleStep4Complete = async () => {
    if (!reportId) return;
    if (!historical) await requireSaved({ current_step: 4, status: 'report_generated', report_id: reportId });
    setCurrentStep(4); setMaxStep(previous => Math.max(previous, 4));
  };

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-[#060612] text-slate-300">{t('加载项目中...', 'Loading workspace...')}</div>;
  if (loadError || !project) return <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#060612] text-slate-200">
    <p role="alert">{loadError || t('项目不存在', 'Project not found')}</p>
    <button onClick={() => setReload(previous => previous + 1)} className="rounded-lg bg-purple-600 px-4 py-2">{t('重新读取', 'Retry')}</button>
    <Link href="/mirofish">{t('返回项目列表', 'Back to projects')}</Link>
  </div>;

  return <div className="min-h-screen bg-[#060612] text-white">
    <nav className="sticky top-0 z-50 border-b border-white/10 bg-black/80 backdrop-blur-xl">
      <div className="mx-auto flex min-h-14 max-w-[1600px] flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-4"><Link href="/mirofish" className="font-extrabold tracking-wider text-purple-300">MIROFISH</Link>
          <span className="max-w-64 truncate text-sm text-slate-300">{project.name}</span></div>
      </div>
    </nav>
    {!historical && <ModelSelector value={modelOverride} onChange={setModelOverride} onSave={saveModelConfig} />}
    <StepNav currentStep={currentStep} maxStep={maxStep} minStep={historical ? 2 : 0}
      onStepChange={step => { if (!historical || step >= 2) setCurrentStep(step); }} />
    <main className="relative mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
      {historical && <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-400/20 bg-sky-400/5 p-3 text-sm text-sky-200">
        <span>{t('查看历史运行', 'Viewing saved run')} · {simulationId}</span>
        <Link href={`/mirofish/console/${encodeURIComponent(projectId)}`}>{t('返回当前项目进度', 'Return to current workspace')}</Link>
      </div>}
      {persistenceError && <div role="alert" className="mb-5 rounded-xl border border-rose-500/20 bg-rose-500/5 p-3 text-sm text-rose-300">
        {t('项目状态保存失败：', 'Unable to save project progress: ')}{persistenceError}
      </div>}
      <MiroFishGraphWorkbench graph={graphData} identity={graphIdentity} simulationId={simulationId || undefined}
        simulationRunning={['running', 'stopping', 'finalizing'].includes(simulationStatus || '')}>
        {currentStep === 0 && <Step1GraphBuild projectId={projectId} simulationRequirement={project.simulation_requirement}
          initialTexts={project.texts} initialSeedFiles={project.seed_files} ontology={ontology} graphData={graphData}
          modelOverride={modelOverride} initialTaskId={project.graph_task_id} onTaskStarted={handleGraphTaskStarted}
          onTextsPersist={handleTextsPersist} onSeedFilesPersist={handleSeedFilesPersist} onOntologyGenerated={handleOntologyGenerated}
          onGraphBuilt={handleGraphBuilt} onComplete={handleStep1Complete} />}
        {currentStep === 1 && graphData && <Step2EnvSetup projectId={projectId} simulationRequirement={project.simulation_requirement}
          graphNodes={graphData.nodes} profiles={profiles} modelOverride={modelOverride}
          initialPrepareTaskId={project.prepare_task_id} initialPrepareId={project.prepare_id}
          initialSelectedEntityIds={project.selected_entity_ids} initialConfig={project.simulation_config}
          onPrepareTaskStarted={handlePrepareTaskStarted} onPrepared={handlePrepared} onDraftChange={handleDraftChange}
          onProfilesGenerated={setProfiles} onSimulationCreated={handleSimulationCreated}
          onComplete={() => simulationId ? handleSimulationCreated(simulationId) : undefined} />}
        {currentStep === 2 && simulationId && <Step3Simulation key={simulationId} simulationId={simulationId}
          onStatusChange={setSimulationStatus} onComplete={handleStep3Complete} />}
        {currentStep === 3 && simulationId && <Step4Report key={simulationId} simulationId={simulationId} projectId={projectId}
          reportId={reportId} modelOverride={modelOverride} onReportGenerated={handleReportGenerated} onComplete={handleStep4Complete} />}
        {currentStep === 4 && simulationId && reportId && <Step5Interaction key={`${simulationId}:${reportId}`}
          simulationId={simulationId} reportId={reportId} modelOverride={modelOverride} agents={profiles.map(profile => ({
            entity_id: profile.entity_id, entity_name: profile.entity_name, entity_type: profile.entity_type,
            full_name: profile.full_name, occupation: profile.occupation,
          }))} />}
      </MiroFishGraphWorkbench>
    </main>
  </div>;
}
