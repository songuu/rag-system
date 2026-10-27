import { getPostgresClient } from '../../postgres/client';
import { getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../../postgres/env';
import { CitationError, citationPartition } from './locator-codec';
import { issueDocumentAnswerCitations, previewDocumentCitation } from './document-citations';
import { createDocumentCitationDependencies } from './document-source-authority';
import { invokePreRouteProviderWithDeadline } from '../retrieval/pre-route-provider-deadline';

async function loadDependencies() {
  const config = getPostgresRuntimeConfig();
  const client = getPostgresClient(config);
  if (!shouldUsePostgresPersistence(config) || !client || config.vectorBackend !== 'milvus') throw new CitationError('RAG_CITATION_UNAVAILABLE', 503);
  const [{ hydrateEmbeddingIndex }, { getMilvusInstance }, { getMilvusConnectionConfig }] = await Promise.all([
    import('../../embedding-index-persistence'), import('../../milvus-client'), import('../../milvus-config'),
  ]);
  // A cold preview worker must resolve the same active collection as ingestion and retrieval.
  await hydrateEmbeddingIndex();
  const connection = getMilvusConnectionConfig();
  const milvus = getMilvusInstance({ address: connection.address, collectionName: connection.defaultCollection, embeddingDimension: connection.defaultDimension, indexType: connection.defaultIndexType, metricType: connection.defaultMetricType, token: connection.token, ssl: connection.ssl });
  return createDocumentCitationDependencies({ client, milvus });
}

export async function issueRuntimeDocumentCitations(input: Omit<Parameters<typeof issueDocumentAnswerCitations>[0], 'dependencies'> & {
  graphCitations: NonNullable<Parameters<typeof issueDocumentAnswerCitations>[0]['graphCitations']>;
}) {
  if (!input.graphCitations.diagnostics.citationCount || input.graphCitations.diagnostics.reason === 'configuration-unavailable') return input.graphCitations;
  try {
    return await invokePreRouteProviderWithDeadline({
      operationKey: 'citation-issue:' + citationPartition(input.security), timeoutMs: 5000, signal: input.signal,
      invoke: async signal => issueDocumentAnswerCitations({ ...input, signal, dependencies: await loadDependencies() }),
    });
  } catch {
    input.signal?.throwIfAborted();
    return { ...input.graphCitations, status: 'unavailable' as const, items: [], diagnostics: {
      ...input.graphCitations.diagnostics, reason: 'sources-unavailable' as const,
      unavailableCitationCount: input.graphCitations.items.length + input.graphCitations.diagnostics.unavailableCitationCount,
    } };
  }
}

export async function previewRuntimeDocumentCitation(input: Omit<Parameters<typeof previewDocumentCitation>[0], 'dependencies'>) {
  return invokePreRouteProviderWithDeadline({
    operationKey: 'document-citation-preview:' + citationPartition(input.security), timeoutMs: 5000, signal: input.signal,
    invoke: async signal => previewDocumentCitation({ ...input, signal, dependencies: await loadDependencies() }),
  });
}
