/**
 * MiroFish model artifact cache.
 *
 * Caches deterministic LLM artifacts such as ontology and profile generation
 * without mutating the global model factory state.
 */

import {
  createArtifactCacheIdentity,
  loadArtifactFromCache,
  saveArtifactToCache,
  type ArtifactCacheIdentity,
  type ArtifactCacheHit,
} from '../artifact-cache';
import { getConfigSummary } from '../model-config';
import type {
  EntityProfile,
  GraphBuildRequest,
  GraphData,
  ModelOverride,
  Ontology,
  OntologyGenerateRequest,
  ProfileBatchGenerateRequest,
  ProfileGenerateRequest,
} from './types';

const CACHE_VERSION = 'mirofish-llm-artifact-v1';
const CACHE_DIR = 'uploads/mirofish-cache';

type MiroFishCacheArtifact = 'ontology' | 'profile' | 'profile_batch' | 'graph';

interface MiroFishModelSignature {
  artifact: MiroFishCacheArtifact;
  provider: string;
  model_name: string;
  base_url: string;
  temperature: number;
}

export type MiroFishCacheIdentity = ArtifactCacheIdentity<MiroFishModelSignature>;
export type MiroFishCacheHit<T> = ArtifactCacheHit<T>;

export function getMiroFishOntologyCacheIdentity(input: {
  request: OntologyGenerateRequest;
  modelOverride?: ModelOverride;
}): MiroFishCacheIdentity {
  return createMiroFishCacheIdentity({
    artifact: 'ontology',
    temperature: input.modelOverride?.temperature ?? 0.3,
    modelOverride: input.modelOverride,
    source: {
      texts: input.request.texts.map(normalizeText),
      simulationRequirement: normalizeText(input.request.simulationRequirement),
      additionalContext: normalizeText(input.request.additionalContext ?? ''),
    },
  });
}

export function getMiroFishProfileCacheIdentity(input: {
  request: ProfileGenerateRequest;
  modelOverride?: ModelOverride;
}): MiroFishCacheIdentity {
  return createMiroFishCacheIdentity({
    artifact: 'profile',
    temperature: input.modelOverride?.temperature ?? 0.7,
    modelOverride: input.modelOverride,
    source: {
      entity: normalizeEntity(input.request.entity),
      simulationContext: normalizeText(input.request.simulationContext),
      options: input.request.options ?? {},
    },
  });
}

export function getMiroFishProfileBatchCacheIdentity(input: {
  request: ProfileBatchGenerateRequest;
  modelOverride?: ModelOverride;
}): MiroFishCacheIdentity {
  return createMiroFishCacheIdentity({
    artifact: 'profile_batch',
    temperature: input.modelOverride?.temperature ?? 0.7,
    modelOverride: input.modelOverride,
    source: {
      entities: input.request.entities.map(normalizeEntity),
      simulationContext: normalizeText(input.request.simulationContext),
      options: input.request.options ?? {},
    },
  });
}

export function getMiroFishGraphCacheIdentity(input: {
  request: GraphBuildRequest;
  modelOverride?: ModelOverride;
}): MiroFishCacheIdentity {
  return createMiroFishCacheIdentity({
    artifact: 'graph',
    temperature: input.modelOverride?.temperature ?? 0.1,
    modelOverride: input.modelOverride,
    source: {
      text: normalizeText(input.request.text),
      ontology: normalizeOntology(input.request.ontology),
      chunkSize: input.request.chunkSize,
      chunkOverlap: input.request.chunkOverlap,
      batchSize: input.request.batchSize,
    },
  });
}

export function loadMiroFishOntologyFromCache(
  identity: MiroFishCacheIdentity
): Promise<MiroFishCacheHit<Ontology> | null> {
  return loadArtifactFromCache(identity, isOntology);
}

export function saveMiroFishOntologyToCache(
  identity: MiroFishCacheIdentity,
  ontology: Ontology
): Promise<boolean> {
  return saveArtifactToCache(identity, ontology, {
    artifact: 'ontology',
    entity_type_count: ontology.entity_types.length,
    edge_type_count: ontology.edge_types.length,
  });
}

export function loadMiroFishProfileFromCache(
  identity: MiroFishCacheIdentity
): Promise<MiroFishCacheHit<EntityProfile> | null> {
  return loadArtifactFromCache(identity, isEntityProfile);
}

export function saveMiroFishProfileToCache(
  identity: MiroFishCacheIdentity,
  profile: EntityProfile
): Promise<boolean> {
  return saveArtifactToCache(identity, profile, {
    artifact: 'profile',
    entity_name: profile.entity_name,
  });
}

export function loadMiroFishProfileBatchFromCache(
  identity: MiroFishCacheIdentity
): Promise<MiroFishCacheHit<EntityProfile[]> | null> {
  return loadArtifactFromCache(identity, isEntityProfileArray);
}

export function saveMiroFishProfileBatchToCache(
  identity: MiroFishCacheIdentity,
  profiles: EntityProfile[]
): Promise<boolean> {
  return saveArtifactToCache(identity, profiles, {
    artifact: 'profile_batch',
    profile_count: profiles.length,
  });
}

export function loadMiroFishGraphFromCache(
  identity: MiroFishCacheIdentity
): Promise<MiroFishCacheHit<GraphData> | null> {
  return loadArtifactFromCache(identity, isGraphData);
}

export function saveMiroFishGraphToCache(
  identity: MiroFishCacheIdentity,
  graph: GraphData
): Promise<boolean> {
  return saveArtifactToCache(identity, graph, {
    artifact: 'graph',
    node_count: graph.node_count,
    edge_count: graph.edge_count,
  });
}

function createMiroFishCacheIdentity(input: {
  artifact: MiroFishCacheArtifact;
  temperature: number;
  modelOverride?: ModelOverride;
  source: unknown;
}): MiroFishCacheIdentity {
  return createArtifactCacheIdentity({
    cacheDir: CACHE_DIR,
    version: CACHE_VERSION,
    source: input.source,
    modelSignature: buildModelSignature(input.artifact, input.temperature, input.modelOverride),
  });
}

function buildModelSignature(
  artifact: MiroFishCacheArtifact,
  temperature: number,
  modelOverride?: ModelOverride
): MiroFishModelSignature {
  if (modelOverride) {
    return {
      artifact,
      provider: modelOverride.provider,
      model_name: modelOverride.modelName,
      base_url: modelOverride.baseUrl ?? '',
      temperature,
    };
  }

  const summary = getConfigSummary();
  return {
    artifact,
    provider: summary.provider,
    model_name: summary.llmModel,
    base_url: summary.baseUrl,
    temperature,
  };
}

function normalizeEntity(entity: ProfileGenerateRequest['entity']): Record<string, unknown> {
  return {
    name: normalizeText(entity.name),
    type: normalizeText(entity.type),
    description: normalizeText(entity.description),
    attributes: entity.attributes ?? {},
  };
}

function normalizeOntology(ontology: Ontology | undefined): Record<string, unknown> | null {
  if (!ontology) return null;
  return {
    entity_types: ontology.entity_types.map(entity => ({
      name: normalizeText(entity.name),
      description: normalizeText(entity.description),
      attributes: entity.attributes.map(attribute => ({
        name: normalizeText(attribute.name),
        type: normalizeText(attribute.type),
        description: normalizeText(attribute.description),
      })),
      examples: entity.examples.map(normalizeText),
    })),
    edge_types: ontology.edge_types.map(edge => ({
      name: normalizeText(edge.name),
      description: normalizeText(edge.description),
      source_targets: edge.source_targets.map(sourceTarget => ({
        source: normalizeText(sourceTarget.source),
        target: normalizeText(sourceTarget.target),
      })),
      attributes: edge.attributes.map(attribute => ({
        name: normalizeText(attribute.name),
        type: normalizeText(attribute.type),
        description: normalizeText(attribute.description),
      })),
    })),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function isOntology(value: unknown): value is Ontology {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Ontology>;
  return Array.isArray(candidate.entity_types) && Array.isArray(candidate.edge_types);
}

function isEntityProfile(value: unknown): value is EntityProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EntityProfile>;
  return (
    typeof candidate.entity_name === 'string' &&
    typeof candidate.entity_type === 'string' &&
    typeof candidate.full_name === 'string' &&
    Array.isArray(candidate.personality_traits) &&
    Array.isArray(candidate.typical_posts)
  );
}

function isEntityProfileArray(value: unknown): value is EntityProfile[] {
  return Array.isArray(value) && value.every(isEntityProfile);
}

function isGraphData(value: unknown): value is GraphData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GraphData>;
  return (
    typeof candidate.graph_id === 'string' &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges) &&
    typeof candidate.node_count === 'number' &&
    typeof candidate.edge_count === 'number'
  );
}
