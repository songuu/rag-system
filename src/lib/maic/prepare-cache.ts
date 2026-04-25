/**
 * MAIC prepared artifact cache.
 *
 * The expensive part of initialization is deterministic enough for reuse when
 * both the source content and the LLM configuration are unchanged.
 */

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { getConfigSummary } from '../model-config';
import type { CoursePrepared, SlidePage } from './types';

const CACHE_VERSION = 'maic-prepared-v1';
const PREPARE_TEMPERATURE = 0.3;
const CACHE_DIR = path.join(process.cwd(), 'uploads', 'maic-cache');

export interface MaicPrepareCacheIdentity {
  cache_key: string;
  cache_file: string;
  source_hash: string;
  model_signature: {
    version: string;
    provider: string;
    llm_model: string;
    base_url: string;
    temperature: number;
  };
}

export interface MaicPrepareCacheHit {
  prepared: CoursePrepared;
  created_at: string;
  source_hash: string;
  cache_key: string;
}

interface MaicPrepareCacheRecord {
  version: string;
  cache_key: string;
  source_hash: string;
  model_signature: MaicPrepareCacheIdentity['model_signature'];
  created_at: string;
  page_count: number;
  prepared: CoursePrepared;
}

export function createMaicSourceHash(input: {
  sourceText: string;
  pages?: SlidePage[];
}): string {
  const pageBoundaryAwareSource = input.pages?.length
    ? input.pages.map(page => ({
        index: page.index,
        raw_text: normalizeText(page.raw_text),
      }))
    : normalizeText(input.sourceText);

  return createHash('sha256')
    .update(JSON.stringify(pageBoundaryAwareSource))
    .digest('hex');
}

export function getMaicPrepareCacheIdentity(input: {
  sourceText: string;
  pages?: SlidePage[];
}): MaicPrepareCacheIdentity {
  const summary = getConfigSummary();
  const sourceHash = createMaicSourceHash(input);
  const modelSignature: MaicPrepareCacheIdentity['model_signature'] = {
    version: CACHE_VERSION,
    provider: summary.provider,
    llm_model: summary.llmModel,
    base_url: summary.baseUrl,
    temperature: PREPARE_TEMPERATURE,
  };
  const cacheKey = createHash('sha256')
    .update(JSON.stringify({ sourceHash, modelSignature }))
    .digest('hex')
    .slice(0, 32);

  return {
    cache_key: cacheKey,
    cache_file: path.join(CACHE_DIR, `${cacheKey}.json`),
    source_hash: sourceHash,
    model_signature: modelSignature,
  };
}

export async function loadPreparedFromCache(
  identity: MaicPrepareCacheIdentity
): Promise<MaicPrepareCacheHit | null> {
  try {
    if (!existsSync(identity.cache_file)) return null;

    const raw = await readFile(identity.cache_file, 'utf-8');
    const record = JSON.parse(raw) as unknown;
    if (!isValidCacheRecord(record, identity)) return null;

    return {
      prepared: record.prepared,
      created_at: record.created_at,
      source_hash: record.source_hash,
      cache_key: record.cache_key,
    };
  } catch (error) {
    console.warn('[MAIC Cache] 读取 prepared 缓存失败:', formatError(error));
    return null;
  }
}

export async function savePreparedToCache(
  identity: MaicPrepareCacheIdentity,
  prepared: CoursePrepared
): Promise<boolean> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const record: MaicPrepareCacheRecord = {
      version: CACHE_VERSION,
      cache_key: identity.cache_key,
      source_hash: identity.source_hash,
      model_signature: identity.model_signature,
      created_at: new Date().toISOString(),
      page_count: prepared.pages.length,
      prepared,
    };
    const tempFile = `${identity.cache_file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempFile, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tempFile, identity.cache_file);
    return true;
  } catch (error) {
    console.warn('[MAIC Cache] 写入 prepared 缓存失败:', formatError(error));
    return false;
  }
}

function isValidCacheRecord(
  record: unknown,
  identity: MaicPrepareCacheIdentity
): record is MaicPrepareCacheRecord {
  if (!record || typeof record !== 'object') return false;
  const candidate = record as Partial<MaicPrepareCacheRecord>;
  return (
    candidate.version === CACHE_VERSION &&
    candidate.cache_key === identity.cache_key &&
    candidate.source_hash === identity.source_hash &&
    isSameModelSignature(candidate.model_signature, identity.model_signature) &&
    isCoursePrepared(candidate.prepared)
  );
}

function isSameModelSignature(
  a: MaicPrepareCacheRecord['model_signature'] | undefined,
  b: MaicPrepareCacheIdentity['model_signature']
): boolean {
  return (
    !!a &&
    a.version === b.version &&
    a.provider === b.provider &&
    a.llm_model === b.llm_model &&
    a.base_url === b.base_url &&
    a.temperature === b.temperature
  );
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
