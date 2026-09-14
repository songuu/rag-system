export type KnowledgeGraphRolloutMode = 'off' | 'shadow' | 'active';

type GraphRolloutEnvironment = Partial<Record<
  'RAG_GRAPH_MODE' | 'RAG_MIROFISH_GRAPH_MODE',
  string | undefined
>>;

export function resolveKnowledgeGraphRolloutMode(
  environment: GraphRolloutEnvironment = {
    RAG_GRAPH_MODE: process.env.RAG_GRAPH_MODE,
    RAG_MIROFISH_GRAPH_MODE: process.env.RAG_MIROFISH_GRAPH_MODE,
  }
): KnowledgeGraphRolloutMode {
  const canonical = environment.RAG_GRAPH_MODE?.trim().toLowerCase();
  const legacy = environment.RAG_MIROFISH_GRAPH_MODE?.trim().toLowerCase();
  const value = canonical || legacy || 'off';

  if (value === 'off' || value === 'shadow' || value === 'active') {
    return value;
  }

  const source = canonical ? 'RAG_GRAPH_MODE' : 'RAG_MIROFISH_GRAPH_MODE';
  throw new Error(`${source} must be off, shadow, or active.`);
}
