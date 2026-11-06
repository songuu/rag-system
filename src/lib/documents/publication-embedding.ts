import { createHash } from 'node:crypto';
import { getEmbeddingConfigSummary } from '../embedding-config';
import { observeProviderInvocation } from '../rag/core/provider-usage-observer';
import { createProviderAdmissionFetch, type ProviderPriority } from '../models/provider-admission';
import { createRetrievalScope, type RagRetrievalScope } from '../security/retrieval-scope';
import { settlePublicationReads } from './publication-parallel-reads';
import { createPublicationQueryVectorCache } from './publication-query-vector-cache';

const MODEL_PREFIX = 'rag-publication-';
const NUM_CTX = 8192;
const TIMEOUT_MS = 30_000;
const SCHEMA = 'milvus-publication/v1';
type Config = { model: string; revision: string; dimension: number; indexSchema: string };
type Input = { model?: string; revision?: string; dimension?: number; signal?: AbortSignal; scope?: RagRetrievalScope };
const cacheGlobal = globalThis as typeof globalThis & {
  __ragPublicationQueryVectorsV1?: ReturnType<typeof createPublicationQueryVectorCache>;
};
const queryVectors = cacheGlobal.__ragPublicationQueryVectorsV1 ??= createPublicationQueryVectorCache();

/**
 * The local model administrator is trusted, as are the database/backend
 * administrators of this deployment. Ordinary model-tag updates are isolated
 * by a content-addressed alias. Do not grant model-management access to app
 * users or mutate publication aliases; every embedding verifies its alias.
 */
export async function resolvePublicationEmbedding(input: Input = {}) {
  const scope = input.scope ? createRetrievalScope(input.scope) : undefined;
  if (scope && !scope.enforceIsolation) throw new Error('Publication query cache requires an isolated server scope.');
  const summary = getEmbeddingConfigSummary();
  if (summary.provider !== 'ollama') throw new Error('Publication embedding requires local Ollama.');
  const base = localEndpoint(summary.baseUrl);
  const dimension = input.dimension ?? summary.dimension;
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 65536) throw new Error('Invalid publication embedding dimension.');
  const originalModel = input.model ?? summary.model;
  if (typeof originalModel !== 'string' || !originalModel.trim() || originalModel.length > 256 || originalModel !== originalModel.trim()) {
    throw new Error('Invalid publication embedding model.');
  }
  const requestedAlias = /^rag-publication-([a-f0-9]{64})(?::latest)?$/.exec(originalModel);
  if (input.revision && !requestedAlias) throw new Error('Published embedding model must use a content-addressed alias.');
  const readIdentity = (signal?: AbortSignal) => settlePublicationReads([
    () => tags(base, signal), () => request(base, '/api/version', undefined, signal),
  ] as const);
  const [models, resolvedVersion] = await readIdentity(input.signal);
  const source = findModel(models, originalModel);
  const digest = modelDigest(source);
  if (requestedAlias && requestedAlias[1] !== digest) throw new Error('Publication model identity changed.');
  const alias = `${MODEL_PREFIX}${digest}:latest`;
  let existing = models.find(item => item.name === alias);
  if (!existing) {
    if (input.revision) throw new Error('Published embedding model is unavailable.');
    // Copy preserves the manifest and blobs; it does not download or modify
    // the source tag. Verify the copied digest before using the new name.
    await request(base, '/api/copy', { source: originalModel, destination: alias }, input.signal, true);
    existing = findModel(await tags(base, input.signal), alias);
  }
  if (modelDigest(existing) !== digest) throw new Error('Publication model identity changed.');
  const versionData = object(resolvedVersion);
  if (typeof versionData.version !== 'string' || !/^[0-9][0-9A-Za-z.+_-]{0,99}$/.test(versionData.version)) throw new Error('Invalid Ollama runtime version.');
  const runtimeVersion = versionData.version;
  const revision = `sha256:${createHash('sha256').update(JSON.stringify({ schema: 'ollama-publication/v1', digest,
    runtimeVersion, numCtx: NUM_CTX, truncate: false })).digest('hex')}`;
  if (input.revision !== undefined && input.revision !== revision) throw new Error('Publication embedding revision differs from the published revision.');
  const config: Readonly<Config> = Object.freeze({ model: alias, revision, dimension, indexSchema: SCHEMA });
  const verify = async (signal?: AbortSignal) => {
    const [currentModels, currentVersion] = await readIdentity(signal);
    if (modelDigest(findModel(currentModels, alias)) !== digest) throw new Error('Publication model identity changed.');
    const current = object(currentVersion);
    if (current.version !== runtimeVersion) throw new Error('Publication embedding runtime changed.');
    signal?.throwIfAborted();
  };
  const embedBatch = async (batch: readonly string[], signal: AbortSignal | undefined, priority: ProviderPriority) => {
    const result = object(await request(base, '/api/embed', { model: alias, input: batch,
      truncate: false, options: { num_ctx: NUM_CTX } }, signal, false, priority));
    if (typeof result.model !== 'string' || normalizeName(result.model) !== alias || !Array.isArray(result.embeddings)
      || result.embeddings.length !== batch.length) throw new Error('Invalid publication embedding response.');
    return result.embeddings.map(vector => {
      if (!Array.isArray(vector) || vector.length !== dimension
        || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid publication embedding vector.');
      return [...vector] as number[];
    });
  };
  const embedDocuments = async (texts: readonly string[], signal?: AbortSignal, priority: ProviderPriority = 'background'): Promise<number[][]> => {
    validateTexts(texts);
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += 16) {
      await verify(signal);
      const batch = texts.slice(offset, offset + 16);
      const checked = await embedBatch(batch, signal, priority);
      await verify(signal);
      vectors.push(...checked);
    }
    return vectors;
  };
  const cacheIdentity = scope ? JSON.stringify({ schema: 'publication-query-vector/v1', provider: 'ollama',
    endpoint: base.href, digest, runtimeVersion, ...config, numCtx: NUM_CTX, truncate: false,
    scope: { ...scope, allowedTrustLevels: [...scope.allowedTrustLevels].sort() } }) : undefined;
  return Object.freeze({ config, embedDocuments,
    async embedQuery(text: string, signal?: AbortSignal) {
      if (!cacheIdentity) return (await embedDocuments([text], signal, 'interactive'))[0];
      validateTexts([text]);
      const key = createHash('sha256').update(JSON.stringify([cacheIdentity, text])).digest('hex');
      try {
        await verify(signal);
        const cached = queryVectors.get(key);
        const vector = cached ?? (await embedBatch([text], signal, 'interactive'))[0];
        // A cache hit is a vector optimization, never a substitute for current
        // model identity or the caller's final publication authorization fence.
        await verify(signal);
        if (!cached) queryVectors.set(key, vector);
        return vector;
      } catch (error) { queryVectors.delete(key); throw error; }
    } });
}

function validateTexts(texts: readonly string[]): void {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > 1000
    || texts.some(text => typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024)) {
    throw new Error('Invalid publication embedding input.');
  }
}

function localEndpoint(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Publication Ollama endpoint must be loopback.');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}
function normalizeName(name: string) { return name.includes(':') ? name : `${name}:latest`; }
function findModel(models: Record<string, unknown>[], model: string) {
  const matches = models.filter(item => item.name === normalizeName(model));
  if (matches.length !== 1) throw new Error('Publication embedding model is unavailable or ambiguous.');
  return matches[0];
}
function modelDigest(model: Record<string, unknown>) {
  const digest = typeof model.digest === 'string' ? model.digest.replace(/^sha256:/, '') : '';
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid publication model digest.');
  return digest;
}
async function tags(base: URL, signal?: AbortSignal) {
  const data = object(await request(base, '/api/tags', undefined, signal));
  if (!Array.isArray(data.models) || data.models.length > 10000) throw new Error('Invalid Ollama model inventory.');
  return data.models.map(object);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Ollama response.');
  return value as Record<string, unknown>;
}
async function request(base: URL, path: string, body?: unknown, signal?: AbortSignal, empty = false, priority: ProviderPriority = 'interactive'): Promise<unknown> {
  const combined = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  const providerFetch = path === '/api/embed'
    ? createProviderAdmissionFetch(fetch, { provider: 'ollama', baseUrl: base.href, priority }) : fetch;
  const invoke = () => providerFetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: combined });
  const response = await (path === '/api/embed' ? observeProviderInvocation('embedding', invoke) : invoke());
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Ollama publication request failed (${response.status}).`); }
  if (empty) { await response.body?.cancel(); return undefined; }
  if (!response.body) throw new Error('Empty Ollama response.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error('Ollama publication response exceeds limit.'); chunks.push(item.value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
