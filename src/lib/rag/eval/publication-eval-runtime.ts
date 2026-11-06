import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NextRequest } from 'next/server';
import { resolveRagSecurityContext } from '../../security/request-context';
import type { RagSecurityContext, RagSecurityRequest, ResolveRagSecurityContextOptions } from '../../security/request-context';
import { createRetrievalScope } from '../../security/retrieval-scope';
import type { RagRetrievalScope } from '../../security/retrieval-scope';
import { resolveOllamaRuntimeSettings } from '../../ollama-readiness';
import { canonicalJsonSha256 } from './canonical-json';
import { stableStringify } from './dataset';
import type { RagEvalConfiguration } from './experiment-contract';
import type { LiveAskInput } from './live-ask-target';
import { captureAskProviderUsage } from '../core/provider-usage-observer';
import { importRuntimeModule } from './runtime-module-import.mjs';

export interface PublicationEvalRuntimeOptions {
  projectRoot: string;
  model: string;
  judgeModel?: string;
  topK: number;
  /** The published hybrid Ask path has no score threshold option. */
  similarityThreshold?: number;
  signal?: AbortSignal;
}
export interface PublicationEvalView {
  tenantId: string; corpusId: string; allowedTrustLevels: readonly string[]; digest: string;
  documents: readonly {
    documentId: string; collection: string; collectionId: string; indexName: string; indexUuid: string;
    embedding: { model: string; revision: string; dimension: number; indexSchema: string };
  }[];
}
/** Test seams are process-local; the CLI never accepts these from JSON. */
export interface PublicationEvalRuntimeDependencies {
  env?: () => NodeJS.ProcessEnv;
  listSourceFiles?: (projectRoot: string) => Promise<string[]>;
  readSourceFile?: (relativePath: string, projectRoot: string) => Promise<Uint8Array>;
  authenticate?: (request: RagSecurityRequest, options: ResolveRagSecurityContextOptions) => Promise<RagSecurityContext>;
  readView?: (scope: RagRetrievalScope, signal: AbortSignal) => Promise<PublicationEvalView>;
  fetch?: typeof fetch;
  post?: (request: NextRequest) => Promise<Response>;
  /** May shorten, never extend, the production 180 second operation deadline. */
  timeoutMs?: number;
}

const PROMPT_PATH = 'src/lib/rag/retrieval/ask-route-contract.ts';
const DEADLINE_MS = 180_000;
const DIGEST = /^[a-f0-9]{64}$/;
type ErrorCode = 'invalid-options' | 'unsupported-runtime' | 'authentication-failed' | 'scope-mismatch'
  | 'publication-identity-unavailable' | 'model-identity-unavailable' | 'source-identity-unavailable'
  | 'request-binding-mismatch' | 'observation-failed' | 'ask-failed' | 'deadline-exceeded' | 'cancelled';
class PublicationEvalRuntimeError extends Error {
  constructor(code: ErrorCode) { super('[publication-eval runtime] ' + code); this.name = 'PublicationEvalRuntimeError'; }
}

/** Observe immutable identities using read-only service calls, then enter the
 * real authenticated NextRequest/POST path. No model copies or synthetic scope. */
export function createPublicationEvalRuntime(options: PublicationEvalRuntimeOptions,
  dependencies: PublicationEvalRuntimeDependencies = {}) {
  const projectRoot = path.resolve(options.projectRoot);
  const model = checkedModelName(options.model);
  const judgeModel = options.judgeModel === undefined ? undefined : checkedModelName(options.judgeModel);
  if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 100
    || (options.similarityThreshold ?? 0) !== 0) throw failure('invalid-options');
  const topK = options.topK;
  const timeoutMs = dependencies.timeoutMs ?? DEADLINE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS) throw failure('invalid-options');
  const environment = dependencies.env ?? (() => process.env);
  const authenticate = dependencies.authenticate ?? resolveRagSecurityContext;
  const readView = dependencies.readView ?? (async (scope: RagRetrievalScope) => {
    const [{ getPostgresClient }, { readPublicationView }] = await Promise.all([
      importRuntimeModule<typeof import('../../postgres/client')>(pathToFileURL(path.join(projectRoot, 'src/lib/postgres/client.ts')).href),
      importRuntimeModule<typeof import('../../documents/publication-view')>(pathToFileURL(path.join(projectRoot, 'src/lib/documents/publication-view.ts')).href),
    ]);
    const client = getPostgresClient();
    if (!client) throw failure('publication-identity-unavailable');
    return readPublicationView(scope, client) as Promise<PublicationEvalView>;
  });
  const fetchRead = dependencies.fetch ?? globalThis.fetch;

  function runtimeEnvironment(): NodeJS.ProcessEnv {
    const env = { ...environment() };
    const embeddingProvider = env.EMBEDDING_PROVIDER || (env.SILICONFLOW_API_KEY ? 'siliconflow' : 'ollama');
    if (env.RAG_UNIFIED_PUBLICATION_MODE?.trim().toLowerCase() !== 'active'
      || (env.MODEL_PROVIDER || 'ollama') !== 'ollama' || embeddingProvider !== 'ollama') throw failure('unsupported-runtime');
    localEndpoint(env.OLLAMA_BASE_URL || 'http://localhost:11434');
    return env;
  }
  async function authorization(env: NodeJS.ProcessEnv, signal: AbortSignal) {
    const headers = new Headers({ 'content-type': 'application/json' });
    const token = (env.RAG_EVAL_TOKEN || env.RAG_SINGLE_TENANT_TOKEN)?.trim();
    if (token) headers.set('authorization', 'Bearer ' + token);
    signal.throwIfAborted();
    let context: RagSecurityContext;
    try { context = await authenticate({ headers }, { capability: 'query', env }); }
    catch { throw failure('authentication-failed'); }
    signal.throwIfAborted();
    const scope = createRetrievalScope({ tenantId: context.tenantId, corpusId: context.corpusId, enforceIsolation: true });
    return { headers, scope };
  }
  async function observe(env: NodeJS.ProcessEnv, scope: RagRetrievalScope, signal: AbortSignal): Promise<RagEvalConfiguration> {
    const view = await readView(scope, signal);
    signal.throwIfAborted();
    if (view.tenantId !== scope.tenantId || view.corpusId !== scope.corpusId
      || !sameStrings(view.allowedTrustLevels, scope.allowedTrustLevels) || !/^sha256:[a-f0-9]{64}$/.test(view.digest)
      || !Array.isArray(view.documents) || view.documents.length < 1) throw failure('publication-identity-unavailable');
    const embedding = view.documents[0].embedding;
    if (view.documents.some(document => canonicalJsonSha256(document.embedding) !== canonicalJsonSha256(embedding))
      || embedding.indexSchema !== 'milvus-publication/v1' || !Number.isSafeInteger(embedding.dimension)
      || embedding.dimension < 1 || embedding.dimension > 65536) throw failure('publication-identity-unavailable');
    const alias = /^rag-publication-([a-f0-9]{64})(?::latest)?$/.exec(embedding.model);
    if (!alias) throw failure('model-identity-unavailable');
    const base = localEndpoint(env.OLLAMA_BASE_URL || 'http://localhost:11434');
    const [tags, versionValue, source] = await Promise.all([
      readProviderJson(new URL('/api/tags', base), fetchRead, signal),
      readProviderJson(new URL('/api/version', base), fetchRead, signal),
      sourceIdentity(projectRoot, dependencies, signal),
    ]);
    signal.throwIfAborted();
    const inventory = object(tags).models;
    if (!Array.isArray(inventory) || inventory.length > 10000) throw failure('model-identity-unavailable');
    const version = object(versionValue).version;
    if (typeof version !== 'string' || !/^[0-9][0-9A-Za-z.+_-]{0,99}$/.test(version)) throw failure('model-identity-unavailable');
    const embeddingDigest = installedDigest(inventory, embedding.model);
    if (embeddingDigest !== alias[1]) throw failure('model-identity-unavailable');
    // Match the published embedding runtime identity WITHOUT calling its
    // resolver, which can create aliases via /api/copy during ingestion.
    const expectedRevision = 'sha256:' + hash(JSON.stringify({ schema: 'ollama-publication/v1',
      digest: embeddingDigest, runtimeVersion: version, numCtx: 8192, truncate: false }));
    if (embedding.revision !== expectedRevision) throw failure('model-identity-unavailable');
    const routingName = env.RAG_SEMANTIC_ROUTER === 'off' ? undefined : checkedModelName(env.FAST_LLM_MODEL || 'qwen2.5:0.5b');
    const settings = resolveOllamaRuntimeSettings(env);
    const environmentFields = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined
      && /^(RAG_|MODEL_|OLLAMA_|EMBEDDING_|FAST_|MILVUS_|ELASTICSEARCH_|POSTGRES_|PG|DATABASE_|SILICONFLOW_|OPENAI_|CUSTOM_|NODE_ENV$|NODE_OPTIONS$|TZ$)/.test(key)));
    const indexes = view.documents.map(document => ({ documentId: required(document.documentId),
      collection: required(document.collection), collectionId: required(document.collectionId),
      indexName: required(document.indexName), indexUuid: required(document.indexUuid) }))
      .sort((left, right) => left.documentId.localeCompare(right.documentId, 'en'));
    if (new Set(indexes.map(item => item.documentId)).size !== indexes.length) throw failure('publication-identity-unavailable');
    return { ...source,
      model: { provider: 'ollama', name: model, revision: 'sha256:' + installedDigest(inventory, model),
        parameters: { temperature: 0.7, numCtx: settings.numCtx, keepAlive: settings.keepAlive, maxRetries: 0,
          providerVersion: version, environmentSha256: canonicalJsonSha256(environmentFields),
          ...(routingName ? { routingModel: { name: routingName, revision: 'sha256:' + installedDigest(inventory, routingName) } } : {}),
          ...(judgeModel ? { evalJudge: { name: judgeModel, revision: 'sha256:' + installedDigest(inventory, judgeModel) } } : {}) } },
      embedding: { provider: 'ollama', name: embedding.model, revision: embedding.revision, dimensions: embedding.dimension },
      index: { id: 'sha256:' + canonicalJsonSha256(indexes), revision: view.digest },
      retrieval: { topK, similarityThreshold: 0 },
      rerank: { enabled: false, provider: 'none', model: 'none', revision: 'none', topN: topK },
      context: { maxTokens: 4000 }, cache: { mode: 'disabled', identity: 'none' } };
  }

  return {
    async observeRuntime(): Promise<RagEvalConfiguration> {
      return bounded(timeoutMs, options.signal, async signal => {
        const env = runtimeEnvironment(), { scope } = await authorization(env, signal);
        return observe(env, scope, signal);
      }, 'observation-failed');
    },
    async invokeAsk(input: LiveAskInput): Promise<Response> {
      return bounded(timeoutMs, options.signal, async signal => {
        const env = runtimeEnvironment(), { headers, scope } = await authorization(env, signal);
        if (!input.scope || input.scope.tenantId !== scope.tenantId || input.scope.corpusId !== scope.corpusId
          || !sameStrings(input.scope.allowedTrustLevels, scope.allowedTrustLevels)) throw failure('scope-mismatch');
        if (input.topK !== topK || input.similarityThreshold !== 0 || input.llmModel !== model
          || typeof input.question !== 'string' || !input.question.trim()) throw failure('request-binding-mismatch');
        const configuration = await observe(env, scope, signal);
        if (input.embeddingModel !== configuration.embedding.name) throw failure('request-binding-mismatch');
        signal.throwIfAborted();
        const { NextRequest: RequestConstructor } = await importRuntimeModule<typeof import('next/server')>('next/server.js');
        const post = dependencies.post ?? (await importRuntimeModule<typeof import('../../../app/api/ask/route')>(pathToFileURL(path.join(projectRoot, 'src/app/api/ask/route.ts')).href)).POST;
        signal.throwIfAborted();
        const request = new RequestConstructor('http://127.0.0.1/api/ask', { method: 'POST', headers, signal,
          body: JSON.stringify({ question: input.question, corpusId: scope.corpusId, topK,
            similarityThreshold: 0, llmModel: model, embeddingModel: configuration.embedding.name,
            storageBackend: 'milvus', executionMode: 'sync' }) });
        const response = await captureAskProviderUsage(() => post(request), { signal });
        signal.throwIfAborted();
        if (!(response instanceof Response)) throw failure('ask-failed');
        return response;
      }, 'ask-failed');
    },
  };
}

async function sourceIdentity(projectRoot: string, dependencies: PublicationEvalRuntimeDependencies, signal: AbortSignal) {
  let paths: string[], entries: Array<{ path: string; sha256: string }>;
  try {
    const files = await (dependencies.listSourceFiles ?? listSourceFiles)(projectRoot);
    paths = files.filter(name => {
      if (name.includes('\\') || name.split('/').includes('..') || path.posix.isAbsolute(name)) throw failure('source-identity-unavailable');
      return ['package.json', 'pnpm-lock.yaml'].includes(name) || (name.startsWith('src/')
        && !name.startsWith('src/lib/rag/eval/') && !/(^|\/)(__tests__|__mocks__)(\/|$)|\.(test|spec)([.-])/.test(name));
    }).sort();
    if (new Set(paths).size !== paths.length || paths.length > 20000
      || !['package.json', 'pnpm-lock.yaml', PROMPT_PATH].every(name => paths.includes(name))) throw failure('source-identity-unavailable');
    const read = dependencies.readSourceFile ?? (async (name: string, root: string) => readFile(path.join(root, name)));
    entries = [];
    for (let index = 0; index < paths.length; index += 16) {
      signal.throwIfAborted();
      entries.push(...await Promise.all(paths.slice(index, index + 16).map(async name => {
        const bytes = await read(name, projectRoot);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > 32 * 1024 * 1024) throw failure('source-identity-unavailable');
        return { path: name, sha256: hash(bytes) };
      })));
    }
    signal.throwIfAborted();
  } catch { throw failure('source-identity-unavailable'); }
  return { implementationSha256: hash(stableStringify(entries)), promptSha256: entries.find(item => item.path === PROMPT_PATH)!.sha256 };
}

async function listSourceFiles(root: string): Promise<string[]> {
  async function walk(relative: string): Promise<string[]> {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    const nested = await Promise.all(entries.map(async entry => {
      const name = relative + '/' + entry.name;
      if (name === 'src/lib/rag/eval' || entry.name === '__tests__' || entry.name === '__mocks__') return [];
      if (entry.isSymbolicLink()) throw failure('source-identity-unavailable');
      if (entry.isDirectory()) return walk(name);
      return entry.isFile() ? [name] : [];
    }));
    return nested.flat();
  }
  return [...await walk('src'), 'package.json', 'pnpm-lock.yaml'];
}

async function readProviderJson(url: URL, fetchRead: typeof fetch, signal: AbortSignal): Promise<unknown> {
  const response = await fetchRead(url, { method: 'GET', redirect: 'error', signal });
  if (!response.ok || response.redirected || !response.body) throw failure('model-identity-unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4 * 1024 * 1024) { void reader.cancel().catch(() => {}); throw failure('model-identity-unavailable'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function bounded<T>(timeoutMs: number, parent: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>, fallback: ErrorCode): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let listener: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      listener = () => reject(failure(parent?.aborted ? 'cancelled' : 'deadline-exceeded'));
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    });
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      if (signal.aborted) throw failure(parent?.aborted ? 'cancelled' : 'deadline-exceeded');
      return work(signal);
    })]);
  } catch (error) { throw error instanceof PublicationEvalRuntimeError ? error : failure(fallback); }
  finally { clearTimeout(timer); if (listener) signal.removeEventListener('abort', listener); }
}
function installedDigest(inventory: unknown[], name: string): string {
  const normalized = name.includes(':') ? name : name + ':latest';
  const matches = inventory.map(object).filter(item => item.name === normalized);
  if (matches.length !== 1 || typeof matches[0].digest !== 'string') throw failure('model-identity-unavailable');
  const digest = matches[0].digest.replace(/^sha256:/, '');
  if (!DIGEST.test(digest)) throw failure('model-identity-unavailable');
  return digest;
}
function localEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw failure('unsupported-runtime'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw failure('unsupported-runtime');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}
function sameStrings(left: readonly string[], right: readonly string[]) {
  return Array.isArray(left) && Array.isArray(right) && new Set(left).size === left.length
    && new Set(right).size === right.length && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function checkedModelName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256) throw failure('invalid-options');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('model-identity-unavailable');
  return value as Record<string, unknown>;
}
function required(value: string): string { if (typeof value !== 'string' || !value.trim()) throw failure('publication-identity-unavailable'); return value; }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function failure(code: ErrorCode) { return new PublicationEvalRuntimeError(code); }
