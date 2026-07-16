/**
 * MiroFish 模拟准备 API
 *
 * POST /api/mirofish/simulation/prepare - 幂等准备 Agent 人设与模拟配置
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/mirofish/project-store';
import { prepareMiroFishSimulation } from '@/lib/mirofish/prepare-service';
import {
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
} from '@/lib/mirofish/model-override';
import type {
  EntityProfile,
  GraphNode,
  ModelOverride,
  SimulationConfigDraft,
} from '@/lib/mirofish/types';

interface PrepareRequestBody {
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
    const body = await request.json() as PrepareRequestBody;

    if (!body.project_id) {
      return NextResponse.json(
        { success: false, error: '缺少 project_id' },
        { status: 400 }
      );
    }

    const store = getProjectStore();
    const project = store.get(body.project_id);
    if (!project) {
      return NextResponse.json(
        { success: false, error: '项目不存在' },
        { status: 404 }
      );
    }

    const graphNodes = normalizeGraphNodes(body.graphNodes ?? project.graph_data?.nodes);
    if (graphNodes.length === 0) {
      return NextResponse.json(
        { success: false, error: '缺少图谱节点，无法准备模拟环境' },
        { status: 400 }
      );
    }

    const modelOverride = validateHttpModelOverride(body.modelOverride) ?? project.model_config;
    const result = await prepareMiroFishSimulation({
      project,
      graphNodes,
      selectedEntityIds: body.selectedEntityIds,
      config: body.config,
      modelOverride: modelOverride as ModelOverride | undefined,
      providedProfiles: body.profiles,
      forceRegenerate: body.forceRegenerate,
    });

    store.update(project.id, {
      agent_profiles: result.profiles,
      simulation_config: result.config,
      prepare_id: result.prepare_id,
      prepare_fingerprint: result.prepare_fingerprint,
      prepared_at: result.prepared_at,
    });

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
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '准备模拟环境失败' },
      { status: 500 }
    );
  }
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
