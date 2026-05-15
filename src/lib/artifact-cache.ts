/**
 * Shared artifact cache for expensive model-derived outputs.
 *
 * The cache key is based on stable JSON so callers can pass structured inputs
 * without relying on object insertion order.
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';

export interface ArtifactCacheIdentity<ModelSignature extends object> {
  cache_key: string;
  cache_file: string;
  source_hash: string;
  model_signature: ModelSignature & { version: string };
}

export interface ArtifactCacheHit<T> {
  artifact: T;
  created_at: string;
  source_hash: string;
  cache_key: string;
}

interface ArtifactCacheRecord<T, ModelSignature extends object> {
  version: string;
  cache_key: string;
  source_hash: string;
  model_signature: ModelSignature & { version: string };
  created_at: string;
  artifact: T;
  metadata?: Record<string, unknown>;
}

export function createStableHash(input: unknown): string {
  return createHash('sha256')
    .update(stableStringify(input))
    .digest('hex');
}

export function createArtifactCacheIdentity<ModelSignature extends object>(input: {
  cacheDir: string;
  version: string;
  source?: unknown;
  sourceHash?: string;
  modelSignature: ModelSignature;
}): ArtifactCacheIdentity<ModelSignature> {
  const sourceHash = input.sourceHash ?? createStableHash(input.source);
  const modelSignature = {
    version: input.version,
    ...input.modelSignature,
  };
  const cacheKey = createStableHash({ sourceHash, modelSignature }).slice(0, 32);
  const cacheDir = path.isAbsolute(input.cacheDir)
    ? input.cacheDir
    : input.cacheDir.startsWith('uploads/')
      ? path.join(process.cwd(), 'uploads', input.cacheDir.slice('uploads/'.length))
      : path.resolve(/*turbopackIgnore: true*/ process.cwd(), input.cacheDir);

  return {
    cache_key: cacheKey,
    cache_file: path.join(cacheDir, `${cacheKey}.json`),
    source_hash: sourceHash,
    model_signature: modelSignature,
  };
}

export async function loadArtifactFromCache<T, ModelSignature extends object>(
  identity: ArtifactCacheIdentity<ModelSignature>,
  validate: (artifact: unknown) => artifact is T
): Promise<ArtifactCacheHit<T> | null> {
  try {
    const raw = await readFile(identity.cache_file, 'utf-8');
    const record = JSON.parse(raw) as unknown;
    if (!isValidRecord(record, identity, validate)) return null;
    return {
      artifact: record.artifact,
      created_at: record.created_at,
      source_hash: record.source_hash,
      cache_key: record.cache_key,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    return null;
  }
}

export async function saveArtifactToCache<T, ModelSignature extends object>(
  identity: ArtifactCacheIdentity<ModelSignature>,
  artifact: T,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  try {
    await mkdir(path.dirname(identity.cache_file), { recursive: true });
    const record: ArtifactCacheRecord<T, ModelSignature> = {
      version: identity.model_signature.version,
      cache_key: identity.cache_key,
      source_hash: identity.source_hash,
      model_signature: identity.model_signature,
      created_at: new Date().toISOString(),
      artifact,
      metadata,
    };
    const tempFile = `${identity.cache_file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempFile, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tempFile, identity.cache_file);
    return true;
  } catch {
    return false;
  }
}

function isValidRecord<T, ModelSignature extends object>(
  record: unknown,
  identity: ArtifactCacheIdentity<ModelSignature>,
  validate: (artifact: unknown) => artifact is T
): record is ArtifactCacheRecord<T, ModelSignature> {
  if (!record || typeof record !== 'object') return false;
  const candidate = record as Partial<ArtifactCacheRecord<T, ModelSignature>>;
  return (
    candidate.version === identity.model_signature.version &&
    candidate.cache_key === identity.cache_key &&
    candidate.source_hash === identity.source_hash &&
    stableStringify(candidate.model_signature) === stableStringify(identity.model_signature) &&
    validate(candidate.artifact)
  );
}

function stableStringify(input: unknown): string {
  return JSON.stringify(normalizeForStableJson(input));
}

function normalizeForStableJson(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(normalizeForStableJson);
  }
  if (!input || typeof input !== 'object') {
    return input;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(input as Record<string, unknown>).sort()) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) normalized[key] = normalizeForStableJson(value);
  }
  return normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}
