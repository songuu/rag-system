import { calculateEntityExtractionPromptCharacters } from '../entity-extraction';
import { calculateSourceAlignedChunkBudget } from '../source-aligned-chunking';

export const MIROFISH_GRAPH_EXTRACTION_CALL_LIMIT = 1_000;
export const MIROFISH_GRAPH_PROVIDER_INPUT_CHARACTER_LIMIT = 4_000_000;
export const MIROFISH_GRAPH_EXTRACTION_RESOURCE_LIMITS = Object.freeze({
  maxProviderOutputCharacters: 2_000_000,
  maxExtractedEntities: 1_000,
  maxExtractedRelations: 5_000,
  maxAggregationLookupComparisons: 100_000,
  maxEntityResolutionComparisons: 50_000,
  maxEntityResolutionVectorOperations: 50_000_000,
  maxEmbeddingDimensions: 4_096,
});

export interface MiroFishGraphExtractionBudget {
  providerCallCount: number;
  providerInputCharacters: number;
}

/**
 * Exact preflight budget for the mandatory per-chunk extraction calls. Any
 * output-dependent merge/community prompts are additionally capped at runtime
 * by EntityExtractor using these same task limits.
 */
export function calculateMiroFishGraphExtractionBudget(
  textLength: number,
  chunkSize: number,
  chunkOverlap: number
): MiroFishGraphExtractionBudget {
  const chunkBudget = calculateSourceAlignedChunkBudget(
    textLength,
    chunkSize,
    chunkOverlap
  );
  const promptOverhead = calculateEntityExtractionPromptCharacters(0);
  const providerInputCharacters =
    chunkBudget.cumulativeContentCharacters
    + (chunkBudget.chunkCount * promptOverhead);
  if (!Number.isSafeInteger(providerInputCharacters)) {
    throw new Error('MiroFish graph extraction budget exceeds safe integer range.');
  }
  return {
    providerCallCount: chunkBudget.chunkCount,
    providerInputCharacters,
  };
}
