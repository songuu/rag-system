import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { getPostgresClient } from '../postgres/client';
import type { RagEvidence } from '../rag/core/types';
import type { RagRetrievalScope, RagTrustLevel } from '../security/retrieval-scope';
import type { DocumentSearchRequest } from './document-search-contract';
import { assertPublicationReaderPostgresCapability } from './publication-reader-capability';
import { resolvePublicationEmbedding } from './publication-embedding';
import { retrievePublicationCorpus } from './publication-retrieval';
import { createPublicationReaderClientCache, type PublicationReaderClientLease } from './publication-reader-client-cache';
import { settlePublicationReads } from './publication-parallel-reads';
import type { PublicationView } from './publication-view';

export class PublicationSearchUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'PUBLICATION_READ_UNAVAILABLE';
  readonly phase: string;
  constructor(cause?: unknown, phase = 'configuration') { super('Published document search is unavailable.', { cause }); this.name = 'PublicationSearchUnavailableError'; this.phase = phase; }
}

type ReaderConfig = { node: string; username: string; password: string; caPath?: string; caFingerprint?: string;
  milvusAddress: string; milvusUsername: string; milvusPassword: string };

interface ReaderClients { es: ElasticsearchClient; milvus: MilvusClient }
const readerGlobal = globalThis as typeof globalThis & {
  __ragPublicationReaderClientsV1?: ReturnType<typeof createPublicationReaderClientCache<ReaderClients>>;
};
const readerClients = readerGlobal.__ragPublicationReaderClientsV1 ??= createPublicationReaderClientCache<ReaderClients>({
  maxEntries: 4, idleTimeoutMs: 60_000,
  onCloseError: () => console.warn('[publication-search] failed to close retired reader clients'),
});

export async function closePublicationReaderClients(): Promise<void> {
  await readerClients.close();
}

export async function retryFailedPublicationReaderClosures(): Promise<void> {
  await readerClients.retryFailedClosures();
}

function createReaderClients(config: ReaderConfig, ca?: string) {
  const es = new ElasticsearchClient({ node: config.node, auth: { username: config.username, password: config.password },
    maxRetries: 0, requestTimeout: 10_000, ...(ca ? { tls: { ca } } : { caFingerprint: config.caFingerprint }) });
  let milvus: MilvusClient | undefined;
  let constructionFailure: unknown;
  try {
    milvus = new MilvusClient({ address: config.milvusAddress, username: config.milvusUsername, password: config.milvusPassword,
      maxRetries: 0, isGlobal: false, timeout: 10_000, channelOptions: { 'grpc.enable_retries': 0 } });
  } catch (error) {
    // Return a tracked partial resource: failed cleanup must count against the
    // same capacity limit as a completely constructed client pair.
    constructionFailure = error;
  }
  void milvus?.connectPromise.catch(() => {});
  let esClosed = false, milvusClosed = !milvus;
  return { get value(): ReaderClients {
    if (!milvus) throw new Error('Publication reader construction failed.', { cause: constructionFailure });
    return { es, milvus };
  }, async close() {
    await settlePublicationReads([
      async () => { if (!esClosed) { await es.close(); esClosed = true; } },
      async () => { if (!milvusClosed && milvus) { await milvus.closeConnection(); milvusClosed = true; } },
    ]);
  } };
}

/** Private readers use application credentials only; no administrative client
 * or caller-supplied backend object crosses the request boundary. Administrators
 * and the trusted publisher own the deployment and its immutable generations. */
export function resolvePublicationReaderConfig(env: NodeJS.ProcessEnv = process.env): ReaderConfig {
  const invalid = () => new PublicationSearchUnavailableError(new Error('Invalid publication reader configuration.'));
  let node: URL;
  try { node = new URL(env.ELASTICSEARCH_URL ?? ''); } catch { throw invalid(); }
  if (node.protocol !== 'https:' || node.username || node.password || node.search || node.hash
    || !['', '/'].includes(node.pathname) || !['127.0.0.1', 'localhost', '[::1]'].includes(node.hostname)) throw invalid();
  if (node.hostname === 'localhost') node.hostname = '127.0.0.1';
  const username = env.ELASTICSEARCH_USERNAME?.trim() ?? '';
  const password = env.ELASTICSEARCH_PASSWORD ?? '';
  const caPath = env.ELASTICSEARCH_CA_CERT_PATH?.trim();
  const caFingerprint = env.ELASTICSEARCH_CA_FINGERPRINT?.replaceAll(':', '').toLowerCase();
  if (!username || ['elastic', 'pub_writer', 'pub_sealer'].includes(username) || !password
    || (!caPath && !/^[a-f0-9]{64}$/.test(caFingerprint ?? '')) || env.ELASTICSEARCH_API_KEY) throw invalid();
  const address = env.MILVUS_LOCAL_ADDRESS?.trim() ?? '';
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/.exec(address);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw invalid();
  const token = env.MILVUS_TOKEN;
  const split = token?.indexOf(':') ?? -1;
  const milvusUsername = env.MILVUS_LOCAL_USERNAME?.trim() || (split > 0 ? token!.slice(0, split) : '');
  const milvusPassword = env.MILVUS_LOCAL_PASSWORD || (split > 0 ? token!.slice(split + 1) : '');
  if (!milvusUsername || ['root', 'pub_writer'].includes(milvusUsername) || !milvusPassword
    || (env.MILVUS_PROVIDER && env.MILVUS_PROVIDER !== 'local')
    || (env.MILVUS_DEFAULT_DATABASE && env.MILVUS_DEFAULT_DATABASE !== 'default')) throw invalid();
  return { node: node.href, username, password, ...(caPath ? { caPath } : { caFingerprint }),
    milvusAddress: `${match[1] === 'localhost' ? '127.0.0.1' : match[1]}:${Number(match[2])}`,
    milvusUsername, milvusPassword };
}

type PublicationSearchInput = DocumentSearchRequest & { scope: RagRetrievalScope; signal?: AbortSignal };
type PublicationSearchResult = { evidence: RagEvidence[]; diagnostics: {
    status: 'published-view'; mode: 'unified'; viewDigest: string; denseCandidateCount: number; lexicalCandidateCount: number;
  } };

export function searchPublishedDocuments(input: PublicationSearchInput,
  env: NodeJS.ProcessEnv = process.env): Promise<PublicationSearchResult> {
  return executePublicationSearch(input, env);
}

/** Server-only answer context; never spread this view into an HTTP response. */
export async function searchPublishedDocumentsForAnswer(input: PublicationSearchInput,
  env: NodeJS.ProcessEnv = process.env): Promise<{ view: PublicationView; result: PublicationSearchResult }> {
  let issuedView: PublicationView | undefined;
  const result = await executePublicationSearch(input, env, view => {
    if (issuedView) throw new Error('Publication search issued more than one initial view.');
    issuedView = view;
  });
  if (!issuedView || issuedView.digest !== result.diagnostics.viewDigest) {
    throw new PublicationSearchUnavailableError(new Error('Publication search view is unavailable.'), 'published-view-retrieval');
  }
  return { view: issuedView, result };
}

async function executePublicationSearch(input: PublicationSearchInput, env: NodeJS.ProcessEnv,
  onIssuedView?: (view: PublicationView) => void): Promise<PublicationSearchResult> {
  input.signal?.throwIfAborted();
  let lease: PublicationReaderClientLease<ReaderClients> | undefined;
  let phase = 'configuration';
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(input.signal ? [input.signal] : [])]);
  const work = (async () => {
    try {
    const config = resolvePublicationReaderConfig(env);
    const pg = getPostgresClient();
    if (!pg) throw new Error('Publication authority is unavailable.');
    phase = 'database-capability';
    await assertPublicationReaderPostgresCapability(pg);
    signal.throwIfAborted();
    phase = 'reader-construction';
    // Read the CA on every acquisition: replacing a file at the same path must
    // not silently reuse an old TLS trust configuration.
    const ca = config.caPath ? await readFile(config.caPath, 'utf8') : undefined;
    signal.throwIfAborted();
    const identity = createHash('sha256').update(JSON.stringify([config, ca ?? null])).digest('hex');
    lease = await readerClients.acquire(identity, () => createReaderClients(config, ca), signal);
    signal.throwIfAborted();
    const { es, milvus } = lease.value;
    // Authenticate the actual ES identity and require a reader-only role.
    phase = 'reader-capability';
    const [authenticated, privileges, milvusProbe] = await settlePublicationReads([
      () => es.security.authenticate(), () => es.security.getUserPrivileges(),
      () => milvus.hasCollection({ collection_name: 'publication_reader_auth_probe' }),
    ]);
    if (authenticated.username !== config.username || !readerOnlyPrivileges(privileges)
      || milvusProbe.status?.error_code !== 'Success') throw new Error('Publication reader capability is unavailable.');
    signal.throwIfAborted();
    phase = 'published-view-retrieval';
    const observed = await retrievePublicationCorpus({ ...input, signal, pg,
      elasticsearch: es as unknown as Parameters<typeof retrievePublicationCorpus>[0]['elasticsearch'], milvus,
      embedding: async (published, query, requestedSignal) => {
        const session = await resolvePublicationEmbedding({ model: published.model, revision: published.revision,
          dimension: published.dimension, signal: requestedSignal, scope: input.scope });
        if (JSON.stringify(session.config) !== JSON.stringify(published)) throw new Error('Published embedding identity differs.');
        return session.embedQuery(query, requestedSignal);
      } }, onIssuedView);
    signal.throwIfAborted();
    phase = 'evidence';
    const evidence = presentPublishedEvidence(input.scope, observed);
    return { evidence, diagnostics: { status: 'published-view' as const, mode: 'unified' as const, viewDigest: observed.viewDigest,
      denseCandidateCount: observed.documents.reduce((sum, item) => sum + item.dense.length, 0),
      lexicalCandidateCount: observed.documents.reduce((sum, item) => sum + item.lexical.length, 0) } };
    } catch (error) { lease?.invalidate(); throw error; }
    finally {
      // A cancelled HTTP caller can stop waiting before provider work settles.
      // Keep its lease until that work ends so other requests are not disrupted.
      lease?.release();
    }
  })();
  try { return await abortable(work, signal); }
  catch (error) { lease?.invalidate(); throw new PublicationSearchUnavailableError(error, phase); }
}

function readerOnlyPrivileges(value: unknown): boolean {
  const privileges = record(value);
  if (!['cluster', 'global', 'applications', 'run_as'].every(key => Array.isArray(privileges[key]) && privileges[key].length === 0)
    || !Array.isArray(privileges.indices) || privileges.indices.length < 1) return false;
  return privileges.indices.every(item => {
    const index = record(item);
    return Array.isArray(index.names) && index.names.length > 0 && index.names.every(name => ['codex-generation-seal-*', 'rag-publication-*'].includes(String(name)))
      && Array.isArray(index.privileges) && index.privileges.includes('read')
      && index.privileges.every(privilege => ['read', 'view_index_metadata'].includes(String(privilege)));
  });
}

function presentPublishedEvidence(scope: RagRetrievalScope, result: Awaited<ReturnType<typeof retrievePublicationCorpus>>): RagEvidence[] {
  return result.ranking.map(rank => {
    const document = result.documents.find(item => item.documentId === rank.documentId && item.generation === rank.generation);
    const lexical = document?.lexical.find(item => item.document.chunk_id === rank.chunkId)?.document;
    const dense = document?.dense.find(item => item.id === rank.chunkId);
    if (!document || !lexical && !dense) throw new Error('Ranked publication evidence is unavailable.');
    const row = record(dense);
    const content = lexical?.content ?? row.content;
    const version = lexical?.document_version ?? row.document_version;
    const trust = lexical?.trust_level ?? row.trust_level;
    if (typeof content !== 'string' || typeof version !== 'string' || typeof trust !== 'string'
      || !scope.allowedTrustLevels.includes(trust as RagTrustLevel)) throw new Error('Ranked publication evidence is unavailable.');
    const chunkIndex = Number(row.chunk_index ?? record(lexical?.metadata).chunkIndex);
    const source = lexical?.source ?? document.sources.find(item => item.chunkId === rank.chunkId)?.source ?? document.originalName ?? document.documentId;
    return { id: rank.chunkId, tenantId: scope.tenantId, corpusId: scope.corpusId, documentId: rank.documentId,
      documentVersion: version, content, source, ...(lexical?.page == null ? {} : { page: lexical.page }),
      trustLevel: trust as RagTrustLevel, laneId: 'document-search', retrievalScore: rank.score,
      metadata: { ...(lexical?.metadata ?? {}), ...(Number.isSafeInteger(chunkIndex) && chunkIndex >= 0 ? { chunkIndex } : {}),
        publicationGeneration: rank.generation, denseMatch: Boolean(dense), lexicalMatch: Boolean(lexical) } };
  });
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Publication search cancelled or timed out.'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}
