'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import StepNav from '@/components/mirofish/StepNav';
import ModelSelector from '@/components/mirofish/ModelSelector';
import Step1GraphBuild from '@/components/mirofish/Step1GraphBuild';
import Step2EnvSetup from '@/components/mirofish/Step2EnvSetup';
import Step3Simulation from '@/components/mirofish/Step3Simulation';
import Step4Report from '@/components/mirofish/Step4Report';
import Step5Interaction from '@/components/mirofish/Step5Interaction';
import type { ModelOverride } from '@/lib/mirofish/types';

interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  current_step: number;
  simulation_requirement: string;
  ontology?: unknown;
  graph_id?: string;
  simulation_id?: string;
  report_id?: string;
  model_config?: ModelOverride;
}

interface Ontology {
  entity_types: Array<{
    name: string;
    description: string;
    attributes: Array<{ name: string; type: string; description: string }>;
    examples: string[];
  }>;
  edge_types: Array<{
    name: string;
    description: string;
    source_targets: Array<{ source: string; target: string }>;
    attributes: unknown[];
  }>;
  analysis_summary: string;
}

interface GraphData {
  graph_id: string;
  nodes: Array<{
    uuid: string;
    name: string;
    labels: string[];
    summary: string;
    attributes: Record<string, unknown>;
  }>;
  edges: Array<{
    uuid: string;
    name: string;
    fact: string;
    source_node_name: string;
    target_node_name: string;
  }>;
  node_count: number;
  edge_count: number;
}

interface EntityProfile {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  full_name: string;
  age?: number;
  gender?: string;
  occupation?: string;
  personality_traits: string[];
  speaking_style: string;
  social_media_style: string;
  typical_posts: string[];
  viewpoints: Record<string, string>;
  background: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; glow: string }> = {
  created: { label: '已创建', color: 'bg-slate-500/20 text-slate-300', glow: '' },
  graph_built: { label: '图谱已建', color: 'bg-blue-500/20 text-blue-300', glow: 'shadow-blue-500/10' },
  env_setup: { label: '环境就绪', color: 'bg-cyan-500/20 text-cyan-300', glow: 'shadow-cyan-500/10' },
  simulating: { label: '模拟中', color: 'bg-emerald-500/20 text-emerald-300 animate-pulse', glow: 'shadow-emerald-500/20' },
  report_generated: { label: '报告完成', color: 'bg-purple-500/20 text-purple-300', glow: 'shadow-purple-500/10' },
  completed: { label: '全部完成', color: 'bg-emerald-500/20 text-emerald-300', glow: 'shadow-emerald-500/10' },
};

export default function MiroFishConsolePage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentStep, setCurrentStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);

  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [profiles, setProfiles] = useState<EntityProfile[]>([]);
  const [simulationId, setSimulationId] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<ModelOverride | null>(null);

  useEffect(() => {
    const fetchProject = async () => {
      try {
        const response = await fetch(`/api/mirofish/project/${projectId}`);
        const data = await response.json();
        if (data.success && data.project) {
          setProject(data.project);
          setCurrentStep(data.project.current_step);
          setMaxStep(data.project.current_step);
          if (data.project.ontology) setOntology(data.project.ontology as Ontology);
          if (data.project.simulation_id) setSimulationId(data.project.simulation_id);
          if (data.project.report_id) setReportId(data.project.report_id);
          if (data.project.model_config) setModelOverride(data.project.model_config);
        } else {
          router.push('/mirofish');
        }
      } catch {
        router.push('/mirofish');
      } finally {
        setLoading(false);
      }
    };
    fetchProject();
  }, [projectId, router]);

  const updateProject = useCallback(async (updates: Record<string, unknown>) => {
    try {
      await fetch(`/api/mirofish/project/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
    } catch {
      // 忽略更新错误
    }
  }, [projectId]);

  const saveModelConfig = useCallback(async (override: ModelOverride | null) => {
    const response = await fetch(`/api/mirofish/project/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_config: override }),
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || '保存模型配置失败');
    }
  }, [projectId]);

  const handleStep1Complete = () => {
    const nextStep = 1;
    setCurrentStep(nextStep);
    setMaxStep(prev => Math.max(prev, nextStep));
    updateProject({ current_step: nextStep, status: 'graph_built', ontology });
  };

  const handleStep2Complete = (simIdOverride?: string) => {
    const nextStep = 2;
    const effectiveSimId = simIdOverride || simulationId;
    setCurrentStep(nextStep);
    setMaxStep(prev => Math.max(prev, nextStep));
    updateProject({ current_step: nextStep, status: 'env_setup', simulation_id: effectiveSimId });
  };

  const handleStep3Complete = () => {
    const nextStep = 3;
    setCurrentStep(nextStep);
    setMaxStep(prev => Math.max(prev, nextStep));
    updateProject({ current_step: nextStep, status: 'simulating' });
  };

  const handleStep4Complete = (rptIdOverride?: string) => {
    const nextStep = 4;
    const effectiveRptId = rptIdOverride || reportId;
    setCurrentStep(nextStep);
    setMaxStep(prev => Math.max(prev, nextStep));
    updateProject({ current_step: nextStep, status: 'report_generated', report_id: effectiveRptId });
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060612]">
        <div className="flex flex-col items-center gap-4">
          <div className="relative h-12 w-12">
            <div className="absolute inset-0 animate-spin rounded-full border-2 border-purple-500/30 border-t-purple-500" />
            <div className="absolute inset-2 animate-spin rounded-full border-2 border-violet-400/20 border-b-violet-400" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
          </div>
          <span className="text-sm text-white/40">加载项目中...</span>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060612] text-white/60">
        <div className="text-center">
          <div className="mb-4 text-5xl">🔍</div>
          <div className="text-lg">项目不存在</div>
          <Link href="/mirofish" className="mt-4 inline-block text-sm text-purple-400 hover:text-purple-300">
            返回项目列表 →
          </Link>
        </div>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[project.status] ?? STATUS_CONFIG.created;

  return (
    <div className="min-h-screen bg-[#060612]">
      {/* 背景装饰 */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-80 w-80 rounded-full bg-purple-600/[0.04] blur-[100px]" />
        <div className="absolute -right-20 top-1/3 h-60 w-60 rounded-full bg-violet-600/[0.03] blur-[80px]" />
        <div className="absolute bottom-0 left-1/3 h-40 w-80 rounded-full bg-blue-600/[0.03] blur-[60px]" />
      </div>

      {/* 顶部导航栏 */}
      <nav className="sticky top-0 z-50 border-b border-white/[0.06] bg-black/60 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <Link
              href="/mirofish"
              className="flex items-center gap-2.5 text-[15px] font-extrabold tracking-wider no-underline"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-violet-600 shadow-lg shadow-purple-500/20">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="8" r="4" fill="#fff" />
                  <path d="M4 20C4 16 7.5 13 12 13C16.5 13 20 16 20 20" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <span className="bg-gradient-to-r from-purple-400 to-violet-300 bg-clip-text text-transparent">
                MIROFISH
              </span>
            </Link>

            <div className="h-5 w-px bg-white/10" />

            <span className="max-w-[200px] truncate text-sm text-white/50">
              {project.name}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${statusCfg.color} ${statusCfg.glow} shadow-sm`}>
              {statusCfg.label}
            </span>
          </div>
        </div>
      </nav>

      {/* 模型选择器 */}
      <ModelSelector
        value={modelOverride}
        onChange={setModelOverride}
        onSave={saveModelConfig}
      />

      {/* 步骤导航 */}
      <StepNav
        currentStep={currentStep}
        maxStep={maxStep}
        onStepChange={setCurrentStep}
      />

      {/* 内容区域 */}
      <div className="relative mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {currentStep === 0 && (
          <Step1GraphBuild
            projectId={projectId}
            simulationRequirement={project.simulation_requirement}
            ontology={ontology}
            graphData={graphData}
            modelOverride={modelOverride}
            onOntologyGenerated={setOntology}
            onGraphBuilt={setGraphData}
            onComplete={handleStep1Complete}
          />
        )}

        {currentStep === 1 && graphData && (
          <Step2EnvSetup
            projectId={projectId}
            simulationRequirement={project.simulation_requirement}
            graphNodes={graphData.nodes}
            profiles={profiles}
            modelOverride={modelOverride}
            onProfilesGenerated={setProfiles}
            onSimulationCreated={(simId) => {
              setSimulationId(simId);
              handleStep2Complete(simId);
            }}
            onComplete={() => handleStep2Complete()}
          />
        )}

        {currentStep === 2 && simulationId && (
          <Step3Simulation
            simulationId={simulationId}
            onComplete={handleStep3Complete}
          />
        )}

        {currentStep === 3 && simulationId && (
          <Step4Report
            simulationId={simulationId}
            projectId={projectId}
            reportId={reportId}
            modelOverride={modelOverride}
            onReportGenerated={setReportId}
            onComplete={handleStep4Complete}
          />
        )}

        {currentStep === 4 && simulationId && reportId && (
          <Step5Interaction
            simulationId={simulationId}
            reportId={reportId}
            modelOverride={modelOverride}
            agents={profiles.map(p => ({
              entity_id: p.entity_id,
              entity_name: p.entity_name,
              entity_type: p.entity_type,
              full_name: p.full_name,
              occupation: p.occupation,
            }))}
          />
        )}
      </div>
    </div>
  );
}
