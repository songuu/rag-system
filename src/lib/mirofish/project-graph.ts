import { getMiroFishGraphArtifactRuntime } from './graph-artifact-runtime';
import type { GraphData } from './types';
import type { MiroFishGraphArtifactIdentity, MiroFishGraphArtifactStore } from './graph-artifact-store';
import { createRetrievalScope } from '../security/retrieval-scope';
import { getGraphQueryAuthorityClient, readGraphQueryAuthority } from '../knowledge-graph/query-authority';
import { createMiroFishGraphVersion } from '../knowledge-graph/mirofish-adapter';
import { KnowledgeGraphError } from '../knowledge-graph/contracts';
import { getPostgresRuntimeConfig } from '../postgres/env';

interface ProjectGraphSelector { graph_id?: string; graph_identity?: Partial<MiroFishGraphArtifactIdentity> | null }
interface ProjectGraphDependencies {
  runtime?: { backend: 'file' | 'neo4j'; store: MiroFishGraphArtifactStore };
  readAuthority?: (identity: MiroFishGraphArtifactIdentity) => Promise<string | null>;
}
export async function loadAuthorizedProjectGraph(project: ProjectGraphSelector,
  scope?: { tenantId: string; corpusId: string }, dependencies: ProjectGraphDependencies = {}
): Promise<{ graph: GraphData; identity: MiroFishGraphArtifactIdentity; authority: string } | null> {
  if (!project.graph_id) return null;
  const defaults = getPostgresRuntimeConfig();
  const retrieval = createRetrievalScope({ tenantId: scope?.tenantId ?? defaults.defaultTenantId,
    corpusId: scope?.corpusId ?? defaults.defaultCorpusId, allowedTrustLevels: ['trusted', 'reviewed', 'external'], enforceIsolation: true });
  const runtime = dependencies.runtime ?? getMiroFishGraphArtifactRuntime();
  let identity: MiroFishGraphArtifactIdentity | undefined;
  if (project.graph_identity !== undefined && project.graph_identity !== null) {
    const selected = project.graph_identity;
    // A stored version is an exact selector, including the legacy undefined
    // generation namespace. Never silently replace it with the latest version.
    if (selected.documentId !== project.graph_id || typeof selected.documentVersion !== 'string' || !selected.documentVersion
      || !selected.trustLevel || !retrieval.allowedTrustLevels.includes(selected.trustLevel)
      || selected.tenantId !== undefined && selected.tenantId !== retrieval.tenantId
      || selected.corpusId !== undefined && selected.corpusId !== retrieval.corpusId) return null;
    identity = { tenantId: retrieval.tenantId, corpusId: retrieval.corpusId, documentId: selected.documentId,
      documentVersion: selected.documentVersion, trustLevel: selected.trustLevel,
      ...(selected.graphGeneration !== undefined ? { graphGeneration: selected.graphGeneration } : {}) };
  } else {
    const descriptors = await runtime.store.list(retrieval, { documentId: project.graph_id, limit: 1000 });
    identity = descriptors.find(descriptor => descriptor.identity.documentId === project.graph_id)?.identity;
  }
  if (!identity || identity.tenantId !== retrieval.tenantId || identity.corpusId !== retrieval.corpusId
    || !retrieval.allowedTrustLevels.includes(identity.trustLevel)) return null;
  const readAuthority = dependencies.readAuthority ?? ((value: MiroFishGraphArtifactIdentity) => runtime.backend === 'neo4j'
    ? readGraphQueryAuthority(getGraphQueryAuthorityClient(), retrieval, value, createMiroFishGraphVersion(value))
    : Promise.resolve(`file:${value.documentVersion}`));
  const before = await readAuthority(identity);
  if (!before) return null;
  const artifact = await runtime.store.get(identity, retrieval);
  const after = await readAuthority(identity);
  if (!after || before !== after) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_CONFLICT', 'Graph source changed during the query. Retry the request.');
  if (!artifact) return null;
  return { graph: artifact.graph, identity, authority: before };
}
