import type { RagRetrievalScope } from '@/lib/security/retrieval-scope';
import type { MiroFishGraphArtifactIdentity } from '@/lib/mirofish/graph-artifact-store';
import { createMiroFishGraphVersion } from '@/lib/knowledge-graph/mirofish-adapter';
import { KnowledgeGraphError } from '@/lib/knowledge-graph/contracts';
import { calculateMiroFishGraphExtractionBudget } from '@/lib/mirofish/graph-extraction-budget';

export function shouldRequireDurableGraphBuildApi(
  env: Partial<Pick<NodeJS.ProcessEnv, 'NODE_ENV' | 'RAG_GRAPH_BACKEND'>>
): boolean {
  return env.NODE_ENV?.trim().toLowerCase() === 'production'
    && env.RAG_GRAPH_BACKEND?.trim().toLowerCase() === 'neo4j';
}

export async function withAuthorizedMirofishGraphArtifact<T>(
  backend: 'file' | 'neo4j', scope: RagRetrievalScope,
  identity: MiroFishGraphArtifactIdentity,
  readAuthority: (identity: MiroFishGraphArtifactIdentity, graphVersion: string) => Promise<string | null>,
  load: () => Promise<T>
): Promise<T | null> {
  if (backend === 'file') return load();
  if (identity.tenantId !== scope.tenantId || identity.corpusId !== scope.corpusId
    || !scope.allowedTrustLevels.includes(identity.trustLevel)) return null;
  const graphVersion = createMiroFishGraphVersion(identity);
  const before = await readAuthority(identity, graphVersion);
  if (!before) return null;
  const result = await load();
  const after = await readAuthority(identity, graphVersion);
  if (!after || before !== after) {
    throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_CONFLICT', 'Graph source changed during the query. Retry the request.');
  }
  return result;
}

export function calculateMiroFishGraphChunkUpperBound(textLength: number, chunkSize: number, chunkOverlap: number): number {
  return calculateMiroFishGraphExtractionBudget(textLength, chunkSize, chunkOverlap).providerCallCount;
}
