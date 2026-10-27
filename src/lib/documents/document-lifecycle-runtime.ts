import { getMilvusInstance } from '../milvus-client';
import { getMilvusConnectionConfig } from '../milvus-config';
import { getElasticsearchClient } from '../elasticsearch/client';
import { getElasticsearchRuntimeConfig } from '../elasticsearch/config';
import { replaceElasticsearchDocument } from '../elasticsearch/lexical-index';
import { PostgresElasticsearchOutboxStore } from '../elasticsearch/postgres-outbox-store';
import { getPostgresClient } from '../postgres/client';
import { PostgresDocumentLifecycleStore } from './postgres-document-lifecycle-store';
import type { DocumentDeletionPorts } from './document-lifecycle';
import type { RagTrustLevel } from '../security/retrieval-scope';

export function createDocumentDeletionPorts(): DocumentDeletionPorts {
  return {
    store: new PostgresDocumentLifecycleStore(),
    deleteVectors: (document, scope) => getMilvusInstance({ collectionName: getMilvusConnectionConfig().defaultCollection })
      .deleteManagedDocument(document.documentId, scope),
    async deleteLexical(document, scope) {
      const postgres = getPostgresClient();
      if (!postgres) throw new Error('Document deletion requires PostgreSQL.');
      const identity = { tenantId: scope.tenantId, corpusId: scope.corpusId, documentId: document.documentId };
      // Queue cleanup even while ES is off; it must run before future projections
      // when the optional backend is brought back online.
      await new PostgresElasticsearchOutboxStore(postgres).enqueueDelete(identity);
      const config = getElasticsearchRuntimeConfig();
      const client = await getElasticsearchClient(config);
      if (!client || !await client.indices.exists({ index: config.indexName })) return;
      await replaceElasticsearchDocument({ client, indexName: config.indexName, identity, documents: [] });
    },
    async deleteAssets(document, scope) {
      const visual = record(document.metadata.pdf_visual);
      if (visual.status !== 'published') return;
      const metadata = record(document.metadata.document);
      const documentVersion = visual.documentVersion;
      const trustLevel = metadata.trustLevel ?? metadata.trust_level ?? 'external';
      if (typeof documentVersion !== 'string' || !scope.allowedTrustLevels.includes(trustLevel as RagTrustLevel)) {
        throw new Error('PDF asset deletion identity is invalid.');
      }
      const { getPdfVisualAssetRuntime } = await import('../rag/multimodal/pdf-visual-runtime');
      await getPdfVisualAssetRuntime().store.delete({ tenantId: scope.tenantId, corpusId: scope.corpusId,
        documentId: document.documentId, documentVersion, trustLevel: trustLevel as RagTrustLevel }, scope);
    },
  };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
