/**
 * MiroFish 模拟准备 API
 *
 * POST /api/mirofish/simulation/prepare - 幂等准备 Agent 人设与模拟配置
 */

import { NextRequest, NextResponse } from 'next/server';
import { getScopedMiroFishProjectStore, resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { loadAuthorizedProjectGraph } from '@/lib/mirofish/project-graph';
import { startSimulationPreparation, readSimulationPreparation } from '@/lib/mirofish/simulation-preparation';
import { simulationApiError } from '@/lib/mirofish/simulation-api-response';
import { withMiroFishProjectLock } from '@/lib/mirofish/project-lifecycle';
import { readJsonObjectWithLimit } from '@/lib/security/request-validation';
import {
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
  validatePersistedModelOverride,
} from '@/lib/mirofish/model-override';
import type {
  EntityProfile,
  GraphNode,
  SimulationConfigDraft,
} from '@/lib/mirofish/types';

interface PrepareRequestBody {
  async?:boolean;
  autoConfig?:boolean;
  language?:'zh'|'en';
  project_id?: string;
  graphNodes?: GraphNode[];
  selectedEntityIds?: string[];
  config?: SimulationConfigDraft;
  profiles?: EntityProfile[];
  modelOverride?: unknown;
  forceRegenerate?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const {scope}=await resolveMiroFishRequestScope(request,'ingest');
    const body = await readJsonObjectWithLimit(request,2*1024*1024) as PrepareRequestBody;
    const requestModelOverride = validateHttpModelOverride(body.modelOverride);

    if (!body.project_id) {
      return NextResponse.json(
        { success: false, error: '缺少 project_id' },
        { status: 400 }
      );
    }

    const projectId=body.project_id;
    const jobOrResponse=await withMiroFishProjectLock(scope,projectId,async()=>{
    const store = getScopedMiroFishProjectStore(scope);
    const project = await store.get(projectId);
    if (!project) {
      return NextResponse.json(
        { success: false, error: '项目不存在' },
        { status: 404 }
      );
    }

    const persistedModelOverride = validatePersistedModelOverride(project.model_config);
    const modelOverride = requestModelOverride ?? persistedModelOverride ?? undefined;
    const authorized = await loadAuthorizedProjectGraph(project,scope);
    if(!authorized)return NextResponse.json({success:false,error:'图谱来源不可用，请重新构建图谱'}, {status:409});
    const graphNodes = normalizeGraphNodes(authorized.graph.nodes).map(node=>({...node,summary:[node.summary,...authorized.graph.edges.filter(edge=>edge.source_node_uuid===node.uuid||edge.target_node_uuid===node.uuid).slice(0,20).map(edge=>edge.fact)].filter(Boolean).join('\n')}));
    if (graphNodes.length === 0) {
      return NextResponse.json(
        { success: false, error: '缺少图谱节点，无法准备模拟环境' },
        { status: 400 }
      );
    }

      const job=await startSimulationPreparation({project,graphNodes,selectedEntityIds:body.selectedEntityIds,config:body.config,modelOverride,providedProfiles:body.profiles,forceRegenerate:body.forceRegenerate},
        {scope,projectStore:store,autoConfig:body.autoConfig===true,language:body.language,sourceGraphIdentity:authorized.identity,authorize:async()=>{const current=await store.get(project.id);const source=current?await loadAuthorizedProjectGraph(current,scope):null;return !!source&&source.authority===authorized.authority;}});
      return job;
    });
    if(jobOrResponse instanceof Response)return jobOrResponse;
    if(body.async===true)return NextResponse.json({success:true,taskId:jobOrResponse.id,job:jobOrResponse},{status:202});
    // Legacy synchronous consumers await the same registered job without holding the project lock.
    let job=jobOrResponse;
    while(job.status==='processing'){await new Promise(resolve=>setTimeout(resolve,100));const latest=await readSimulationPreparation(job.id,{scope});if(!latest)throw new Error('PREPARE_NOT_FOUND');job=latest;}
    if(job.status!=='completed'||!job.result)throw new Error(job.errorCode||'PREPARE_GENERATION_FAILED');
    const result=job.result;
    return NextResponse.json({
      success: true,
      data: result,
      prepare_id: result.prepare_id,
      already_prepared: result.already_prepared,
      profiles: result.profiles,
      config: result.config,
    });
  } catch (error) {
    const modelOverrideError = getHttpModelOverrideErrorResponse(error);
    if (modelOverrideError) {
      return NextResponse.json(modelOverrideError.body, { status: modelOverrideError.status });
    }
    return simulationApiError(error,'准备模拟环境失败');
  }
}

export async function GET(request:NextRequest){
 try{
  const {scope}=await resolveMiroFishRequestScope(request);const id=new URL(request.url).searchParams.get('taskId');
  if(!id)return NextResponse.json({success:false,error:'缺少taskId'},{status:400});
  const job=await readSimulationPreparation(id,{scope});if(!job)return NextResponse.json({success:false,error:'准备任务不存在'},{status:404});
  const project=await getScopedMiroFishProjectStore(scope).get(job.projectId);const source=project?await loadAuthorizedProjectGraph(project,scope):null;const identity=job.sourceGraphIdentity;
  if(!source||!identity||source.identity.documentId!==identity.documentId||source.identity.documentVersion!==identity.documentVersion||source.identity.trustLevel!==identity.trustLevel||source.identity.graphGeneration!==identity.graphGeneration)return NextResponse.json({success:false,error:'准备任务来源图谱不可用'},{status:409});
  return NextResponse.json({success:true,job});
 }catch(error){return simulationApiError(error,'读取准备状态失败');}
}

function normalizeGraphNodes(input: unknown): GraphNode[] {
  if (!Array.isArray(input)) return [];

  return input.filter((node): node is GraphNode => (
    Boolean(node) &&
    typeof node === 'object' &&
    typeof (node as GraphNode).uuid === 'string' &&
    typeof (node as GraphNode).name === 'string' &&
    Array.isArray((node as GraphNode).labels)
  ));
}
