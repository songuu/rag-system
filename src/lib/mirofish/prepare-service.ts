import { createHash } from 'node:crypto';
import { normalizeSimulationConfig } from './config-normalizer';
import { ProfileGenerator } from './profile-generator';
import type {
  EntityProfile,
  GraphNode,
  ModelOverride,
  NormalizedSimulationConfig,
  Project,
  SimulationConfigDraft,
  SimulationPrepareResult,
} from './types';

export interface MiroFishPrepareInput {
  project: Project;
  graphNodes: GraphNode[];
  selectedEntityIds?: string[];
  config?: SimulationConfigDraft | NormalizedSimulationConfig;
  modelOverride?: ModelOverride;
  providedProfiles?: EntityProfile[];
  forceRegenerate?: boolean;
}

export interface PrepareServiceDependencies {
  generateProfiles?: (entities: PreparedEntity[], simulationContext: string) => Promise<EntityProfile[]>;
  now?: () => Date;
  createId?: () => string;
}

export interface PreparedEntity {
  id: string;
  name: string;
  type: string;
  description: string;
  attributes?: Record<string, unknown>;
}

export async function prepareMiroFishSimulation(
  input: MiroFishPrepareInput,
  dependencies: PrepareServiceDependencies = {}
): Promise<SimulationPrepareResult> {
  const selectedEntities = selectEntities(input.graphNodes, input.selectedEntityIds);
  if (selectedEntities.length === 0) {
    throw new Error('至少需要选择一个实体来准备模拟环境');
  }

  const profileSource = input.providedProfiles?.length
    ? input.providedProfiles
    : input.forceRegenerate
      ? undefined
      : input.project.agent_profiles;
  const profileCount = profileSource?.length || selectedEntities.length;

  const normalizedConfig = normalizeSimulationConfig(input.config, { profileCount });
  const fingerprint = createPrepareFingerprint({
    projectId: input.project.id,
    simulationRequirement: input.project.simulation_requirement,
    selectedEntityIds: selectedEntities.map(entity => entity.id),
    config: normalizedConfig,
    modelOverride: input.modelOverride ?? input.project.model_config,
  });

  if (!input.forceRegenerate && isPreparedProject(input.project, fingerprint)) {
    return {
      prepare_id: input.project.prepare_id!,
      prepare_fingerprint: fingerprint,
      already_prepared: true,
      profiles: input.project.agent_profiles!,
      config: input.project.simulation_config!,
      prepared_at: input.project.prepared_at!,
      message: '已有完成的准备工作，已复用 Agent 人设与模拟配置',
    };
  }

  const profiles = profileSource?.length
    ? profileSource
    : await generateProfiles(selectedEntities, input.project.simulation_requirement, input.modelOverride, dependencies);

  if (profiles.length === 0) {
    throw new Error('Agent 人设生成结果为空，无法准备模拟环境');
  }

  const config = normalizeSimulationConfig(normalizedConfig, { profileCount: profiles.length });
  const finalFingerprint = createPrepareFingerprint({
    projectId: input.project.id,
    simulationRequirement: input.project.simulation_requirement,
    selectedEntityIds: selectedEntities.map(entity => entity.id),
    config,
    modelOverride: input.modelOverride ?? input.project.model_config,
  });
  const preparedAt = (dependencies.now?.() ?? new Date()).toISOString();

  return {
    prepare_id: dependencies.createId?.() ?? `prep_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    prepare_fingerprint: finalFingerprint,
    already_prepared: false,
    profiles,
    config,
    prepared_at: preparedAt,
    message: '模拟环境准备完成',
  };
}

export function createPrepareFingerprint(input: {
  projectId: string;
  simulationRequirement: string;
  selectedEntityIds: string[];
  config: NormalizedSimulationConfig;
  modelOverride?: ModelOverride;
}): string {
  const stablePayload = {
    projectId: input.projectId,
    simulationRequirement: input.simulationRequirement,
    selectedEntityIds: [...input.selectedEntityIds].sort(),
    config: input.config,
    modelOverride: input.modelOverride
      ? {
          provider: input.modelOverride.provider,
          modelName: input.modelOverride.modelName,
          baseUrl: input.modelOverride.baseUrl,
          temperature: input.modelOverride.temperature,
          hasApiKey: Boolean(input.modelOverride.apiKey),
        }
      : null,
  };

  return createHash('sha256')
    .update(JSON.stringify(stablePayload))
    .digest('hex');
}

function isPreparedProject(project: Project, fingerprint: string): boolean {
  return Boolean(
    project.prepare_id &&
    project.prepared_at &&
    project.prepare_fingerprint === fingerprint &&
    project.agent_profiles?.length &&
    project.simulation_config
  );
}

function selectEntities(graphNodes: GraphNode[], selectedEntityIds?: string[]): PreparedEntity[] {
  const selectedIdSet = selectedEntityIds?.length ? new Set(selectedEntityIds) : null;

  return graphNodes
    .filter(node => !selectedIdSet || selectedIdSet.has(node.uuid) || selectedIdSet.has(node.name))
    .map(node => ({
      id: node.uuid,
      name: node.name,
      type: node.labels[0] || 'Person',
      description: node.summary || node.name,
      attributes: node.attributes,
    }));
}

async function generateProfiles(
  entities: PreparedEntity[],
  simulationContext: string,
  modelOverride: ModelOverride | undefined,
  dependencies: PrepareServiceDependencies
): Promise<EntityProfile[]> {
  if (dependencies.generateProfiles) {
    return dependencies.generateProfiles(entities, simulationContext);
  }

  const generator = new ProfileGenerator(modelOverride);
  return generator.generateProfiles({
    entities,
    simulationContext,
  });
}
