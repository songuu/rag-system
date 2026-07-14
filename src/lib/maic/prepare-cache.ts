/**
 * MAIC prepared artifact cache.
 *
 * The expensive part of initialization is deterministic enough for reuse when
 * both the source content and the LLM configuration are unchanged.
 */

import {
  createArtifactCacheIdentity,
  createStableHash,
  loadArtifactFromCache,
  saveArtifactToCache,
  type ArtifactCacheIdentity,
} from '../artifact-cache';
import { getConfigSummary } from '../model-config';
import { getMaicModelRoutesSnapshot } from './model-routes';
import type { CoursePrepared, SlidePage } from './types';

const CACHE_VERSION = 'maic-prepared-v2';
const PREPARE_TEMPERATURE = 0.3;
const CACHE_DIR = 'uploads/maic-cache';

export interface MaicPrepareCacheIdentity {
  cache_key: string;
  cache_file: string;
  source_hash: string;
  model_signature: MaicPrepareModelSignature & { version: string };
}

export interface MaicPrepareCacheHit {
  prepared: CoursePrepared;
  created_at: string;
  source_hash: string;
  cache_key: string;
}

type MaicPrepareModelSignature = {
  provider: string;
  llm_model: string;
  base_url: string;
  temperature: number;
  stage_routes?: Record<string, string>;
};

export function createMaicSourceHash(input: {
  sourceText: string;
  pages?: SlidePage[];
}): string {
  const pageBoundaryAwareSource = input.pages?.length
    ? input.pages.map(page => {
        const hasAnimationMetadata = !!page.animations?.length || !!page.turning_mode;
        return {
          index: page.index,
          raw_text: normalizeText(page.raw_text),
          ...(hasAnimationMetadata
            ? {
                animations: page.animations ?? [],
                turning_mode: page.turning_mode,
              }
            : {}),
        };
      })
    : normalizeText(input.sourceText);

  return createStableHash(pageBoundaryAwareSource);
}

export function getMaicPrepareCacheIdentity(input: {
  sourceText: string;
  pages?: SlidePage[];
}): MaicPrepareCacheIdentity {
  const summary = getConfigSummary();
  const sourceHash = createMaicSourceHash(input);
  const modelSignature: MaicPrepareModelSignature = {
    provider: summary.provider,
    llm_model: summary.llmModel,
    base_url: summary.baseUrl,
    temperature: PREPARE_TEMPERATURE,
  };
  const stageRoutes = getMaicModelRoutesSnapshot();
  if (Object.keys(stageRoutes).length > 0) {
    modelSignature.stage_routes = stageRoutes;
  }
  const identity = createArtifactCacheIdentity({
    cacheDir: CACHE_DIR,
    version: CACHE_VERSION,
    sourceHash,
    modelSignature,
  }) as ArtifactCacheIdentity<MaicPrepareModelSignature>;
  return identity;
}

export async function loadPreparedFromCache(
  identity: MaicPrepareCacheIdentity
): Promise<MaicPrepareCacheHit | null> {
  const hit = await loadArtifactFromCache(identity, isCoursePrepared);
  if (!hit) {
    return null;
  }
  return {
    prepared: hit.artifact,
    created_at: hit.created_at,
    source_hash: hit.source_hash,
    cache_key: hit.cache_key,
  };
}

export async function savePreparedToCache(
  identity: MaicPrepareCacheIdentity,
  prepared: CoursePrepared
): Promise<boolean> {
  return saveArtifactToCache(identity, prepared, { page_count: prepared.pages.length });
}

function isCoursePrepared(value: unknown): value is CoursePrepared {
  if (!value || typeof value !== 'object') return false;
  const prepared = value as Partial<CoursePrepared>;
  return (
    Array.isArray(prepared.pages) &&
    Array.isArray(prepared.lecture_script) &&
    Array.isArray(prepared.active_questions) &&
    !!prepared.knowledge_tree &&
    typeof prepared.knowledge_tree === 'object'
  );
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}
