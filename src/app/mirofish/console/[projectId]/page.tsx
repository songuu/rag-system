'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import StepNav from '@/components/mirofish/StepNav';
import Step1GraphBuild from '@/components/mirofish/Step1GraphBuild';
import Step2EnvSetup from '@/components/mirofish/Step2EnvSetup';
import Step3Simulation from '@/components/mirofish/Step3Simulation';
import Step4Report from '@/components/mirofish/Step4Report';
import Step5Interaction from '@/components/mirofish/Step5Interaction';

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

export default function MiroFishConsolePage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentStep, setCurrentStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);

  // 工作流数据
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [profiles, setProfiles] = useState<EntityProfile[]>([]);
  const [simulationId, setSimulationId] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);

  // 加载项目
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

  // 更新项目状态
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

  // 步骤完成回调
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
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">
        项目不存在
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900">
      {/* 顶部导航栏 */}
      <nav style={{
        height: '56px',
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Link href="/mirofish" style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 800,
            fontSize: '15px',
            letterSpacing: '1px',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            textDecoration: 'none',
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-label="MiroFish Logo">
              <circle cx="12" cy="8" r="4" fill="#7C3AED"/>
              <path d="M4 20C4 16 7.5 13 12 13C16.5 13 20 16 20 20" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #A855F7 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>MIROFISH</span>
          </Link>

          <div style={{ height: '24px', width: '1px', background: 'rgba(255,255,255,0.15)' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)' }}>{project.name}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{
            padding: '4px 10px',
            borderRadius: '6px',
            fontSize: '12px',
            background: 'rgba(124, 58, 237, 0.2)',
            color: '#c4b5fd',
          }}>
            {project.status}
          </span>
        </div>
      </nav>

      {/* 步骤导航 */}
      <StepNav
        currentStep={currentStep}
        maxStep={maxStep}
        onStepChange={setCurrentStep}
      />

      {/* 内容区域 */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {currentStep === 0 && (
          <Step1GraphBuild
            projectId={projectId}
            simulationRequirement={project.simulation_requirement}
            ontology={ontology}
            graphData={graphData}
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
            onReportGenerated={setReportId}
            onComplete={handleStep4Complete}
          />
        )}

        {currentStep === 4 && simulationId && reportId && (
          <Step5Interaction
            simulationId={simulationId}
            reportId={reportId}
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
