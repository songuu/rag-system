import type { MilvusSearchOptions } from '../../milvus-client';
import {
  buildScopedMilvusSearchOptions,
  type RagRetrievalScope,
} from '../../security/retrieval-scope';

export interface LegacyMilvusSearchArguments {
  options: number | MilvusSearchOptions;
  filter?: string;
  mode: 'server-scope' | 'legacy-local';
}

/**
 * Keeps legacy retrievers usable during the strangler migration while making
 * the authenticated boundary non-negotiable. LLM-derived filters are never
 * allowed to share the server-owned scope expression.
 */
export function resolveLegacyMilvusSearchArguments(input: {
  retrievalScope?: RagRetrievalScope;
  threshold: number;
  legacyLocalFilter?: string;
}): LegacyMilvusSearchArguments {
  if (input.retrievalScope?.enforceIsolation) {
    return {
      options: buildScopedMilvusSearchOptions(input.retrievalScope, {
        threshold: input.threshold,
      }),
      mode: 'server-scope',
    };
  }

  return {
    options: input.threshold,
    ...(input.legacyLocalFilter ? { filter: input.legacyLocalFilter } : {}),
    mode: 'legacy-local',
  };
}
