/**
 * 模拟管理 API
 *
 * POST /api/mirofish/simulation - 创建模拟
 * GET /api/mirofish/simulation - 获取模拟列表
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildSimulationConfig } from '@/lib/mirofish/config-normalizer';
import { getScopedMiroFishProjectStore, resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { loadAuthorizedProjectGraph } from '@/lib/mirofish/project-graph';
import { simulationApiError } from '@/lib/mirofish/simulation-api-response';
import { getSimulationRunner,isSimulationSnapshotSourceAuthorized } from '@/lib/mirofish/simulation-runner';
import { getMiroFishRuntimeStore } from '@/lib/mirofish/runtime-store';
import { withMiroFishProjectLock } from '@/lib/mirofish/project-lifecycle';
import { bindPreparedProfilesToGraph, bindPreparedProfileConfig } from '@/lib/mirofish/profile-bindings';
import { readJsonObjectWithLimit } from '@/lib/security/request-validation';
import {
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
  validatePersistedModelOverride,
} from '@/lib/mirofish/model-override';
import type { EntityProfile, ReportInfo, SimulationConfigDraft } from '@/lib/mirofish/types';

export async function POST(request: NextRequest) {
  try {
    const { scope } = await resolveMiroFishRequestScope(request, 'ingest');
    const body = await readJsonObjectWithLimit(request,2*1024*1024);
    const { config, profiles, prepare_id, project_id } = body as {
      config?: SimulationConfigDraft & { project_id?: string };
      profiles?: EntityProfile[];
      prepare_id?: string;
      project_id?: string;
    };
    const selectedModel = validateHttpModelOverride(body.modelOverride);

    const projectId = config?.project_id || project_id;
    if (!projectId) {
      return NextResponse.json(
        { success: false, error: '缺少 project_id' },
        { status: 400 }
      );
    }

    return await withMiroFishProjectLock(scope,projectId,async()=>{
    const project = await getScopedMiroFishProjectStore(scope).get(projectId);
    if (!project) return NextResponse.json({success:false,error:'项目不存在'}, {status:404});
    const modelOverride=selectedModel??validatePersistedModelOverride(project.model_config)??undefined;
    const source = await loadAuthorizedProjectGraph(project,scope);
    if (!source) return NextResponse.json({success:false,error:'图谱来源不可用，请重新构建图谱'}, {status:409});
    if (prepare_id && project?.prepare_id !== prepare_id) {
      return NextResponse.json(
        { success: false, error: 'prepare_id 无效或已过期' },
        { status: 400 }
      );
    }

    const preparedProfiles = prepare_id ? project?.agent_profiles : undefined;
    const preparedConfig = prepare_id ? project?.simulation_config : undefined;
    const savedProfiles = preparedProfiles?.length ? preparedProfiles : profiles;
    const effectiveProfiles = savedProfiles?.length ? bindPreparedProfilesToGraph(savedProfiles, source.graph.nodes) : savedProfiles;
    const effectiveConfig = config ?? preparedConfig;

    if (!effectiveProfiles?.length) {
      return NextResponse.json(
        { success: false, error: '至少需要一个 Agent 人设' },
        { status: 400 }
      );
    }
    const nodeIds=new Set(source.graph.nodes.map(node=>node.uuid));
    if(effectiveProfiles.some(profile=>typeof profile.entity_id!=='string'||!nodeIds.has(profile.entity_id)))return NextResponse.json({success:false,error:'Agent人设与当前图谱不匹配，请重新准备环境'},{status:409});

    // 参数限制防止资源耗尽
    const MAX_PROFILES = 50;

    if (effectiveProfiles.length > MAX_PROFILES) {
      return NextResponse.json(
        { success: false, error: `Agent 人设数量不能超过 ${MAX_PROFILES}` },
        { status: 400 }
      );
    }

    const simulationId = `sim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const boundConfig = effectiveConfig && savedProfiles ? bindPreparedProfileConfig(effectiveConfig, savedProfiles, effectiveProfiles) : effectiveConfig;
    const fullConfig = buildSimulationConfig(boundConfig, {
      projectId,
      simulationId,
      profileCount: effectiveProfiles.length,
    });

    const runner = getSimulationRunner(scope);
    const info = await runner.create(fullConfig, effectiveProfiles, modelOverride,source.identity,{requirement:project.simulation_requirement,seedFiles:project.seed_files});

    return NextResponse.json({ success: true, simulation: info });
    });
  } catch (error) {
    const modelOverrideError = getHttpModelOverrideErrorResponse(error);
    if (modelOverrideError) {
      return NextResponse.json(modelOverrideError.body, { status: modelOverrideError.status });
    }
    return simulationApiError(error,'创建模拟失败');
  }
}

export async function GET(request:NextRequest) {
  try {
    const { scope } = await resolveMiroFishRequestScope(request);
    const runner = getSimulationRunner(scope);
    const projectId=new URL(request.url).searchParams.get('projectId')||undefined;
    const snapshots = await runner.listPersisted(projectId);
    const reports=await getMiroFishRuntimeStore(scope).list<ReportInfo>('report',{projectId,limit:500});
    const visible=await Promise.all(snapshots.map(async snapshot=>snapshot.sourceGraphIdentity&&await isSimulationSnapshotSourceAuthorized(snapshot,scope)?snapshot:null));
    const simulations = visible.flatMap(snapshot=>{if(!snapshot)return [];const matching=reports.filter(report=>report.project_id===snapshot.info.project_id&&report.simulation_id===snapshot.info.simulation_id).sort((a,b)=>Number(b.status==='completed')-Number(a.status==='completed')||b.updated_at.localeCompare(a.updated_at));return [{...snapshot.info,simulation_requirement:snapshot.scenario?.requirement,seed_files:snapshot.scenario?.seedFiles,engine:snapshot.engine,projection:snapshot.projection,report_id:matching[0]?.report_id,report_ids:matching.map(report=>report.report_id)}];});

    return NextResponse.json({ success: true, simulations });
  } catch (error) {
    return simulationApiError(error,'获取模拟列表失败');
  }
}
