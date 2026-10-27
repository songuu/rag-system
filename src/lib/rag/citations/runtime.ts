import { getPostgresClient } from '../../postgres/client';
import { getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../../postgres/env';
import type { RagSecurityContext } from '../../security/request-context';
import { CitationError, citationPartition, createCitationLocatorCodec } from './locator-codec';
import { invokePreRouteProviderWithDeadline } from '../retrieval/pre-route-provider-deadline';
import { previewCitation } from './preview';
import { createCitationSourceDependencies, createReadOnlyCitationNeo4jStore } from './source-authority';
import type { MiroFishGraphArtifactStore } from '../../mirofish/graph-artifact-store';

/** This loader is reached only after authentication and opaque request validation. */
export async function previewRuntimeCitation(input: { locator: string; security: RagSecurityContext; signal: AbortSignal }) {
  if (input.locator.startsWith('rcl2.')) {
    // Reject cross-subject replay before loading stores or consulting the active index pointer.
    const source = createCitationLocatorCodec().decodeDocument(input.locator);
    if (source.actorId !== input.security.actorId || source.tenantId !== input.security.tenantId || source.corpusId !== input.security.corpusId) throw new CitationError('RAG_CITATION_INVALID');
    return (await import('./document-runtime')).previewRuntimeDocumentCitation(input);
  }
  const source = createCitationLocatorCodec().decode(input.locator);
  if (source.actorId !== input.security.actorId || source.tenantId !== input.security.tenantId || source.corpusId !== input.security.corpusId) throw new CitationError('RAG_CITATION_INVALID');
  const config = getPostgresRuntimeConfig();
  const client = getPostgresClient(config);
  if (!shouldUsePostgresPersistence(config) || !client || config.vectorBackend !== 'milvus') throw new CitationError('RAG_CITATION_UNAVAILABLE', 503);
  const [{ getMilvusInstance }, { getMilvusConnectionConfig }, { withKnowledgeGraphQueryAdmission }] = await Promise.all([
    import('../../milvus-client'), import('../../milvus-config'), import('../../knowledge-graph/http'),
  ]);
  const backend = process.env.RAG_GRAPH_BACKEND?.trim().toLowerCase() || 'file';
  let store: Pick<MiroFishGraphArtifactStore, 'get'>;
  if (backend === 'neo4j') {
    const [{ getNeo4jClient }, { getNeo4jRuntimeConfig }] = await Promise.all([import('../../neo4j/driver'), import('../../neo4j/config')]);
    const neo4j = getNeo4jClient(getNeo4jRuntimeConfig());
    if (!neo4j) throw new CitationError('RAG_CITATION_UNAVAILABLE', 503);
    store = createReadOnlyCitationNeo4jStore(neo4j);
  } else if (backend === 'file' && process.env.NODE_ENV !== 'production') {
    store = (await import('../../mirofish/graph-artifact-runtime')).getMiroFishGraphArtifactRuntime().store;
  } else { throw new CitationError('RAG_CITATION_UNAVAILABLE', 503); }
  await (await import('../../embedding-index-persistence')).hydrateEmbeddingIndex();
  const connection = getMilvusConnectionConfig();
  const milvus = getMilvusInstance({ address: connection.address, collectionName: connection.defaultCollection, embeddingDimension: connection.defaultDimension, indexType: connection.defaultIndexType, metricType: connection.defaultMetricType, token: connection.token, ssl: connection.ssl });
  const dependencies = createCitationSourceDependencies({ client, store, milvus, localFileAuthority: backend === 'file' && process.env.NODE_ENV !== 'production' });
  return withKnowledgeGraphQueryAdmission({ security: input.security }, () => invokePreRouteProviderWithDeadline({
    operationKey: 'citation-preview:' + citationPartition(input.security), timeoutMs: 5000, signal: input.signal,
    invoke: signal => previewCitation({ ...input, signal, dependencies }),
  }));
}
