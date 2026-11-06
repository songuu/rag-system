import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { parseRagEvalDataset, createRagEvalDatasetHash, stableStringify } from './dataset';
import { canonicalJsonSha256 } from './canonical-json';
import type { RagEvalDataset } from './types';
import { configurationSchema, optionsSchema, contractSchema, knownVersion, factors, experimentComparisonIssues } from './experiment-schema';

export type RagEvalConfiguration = z.infer<typeof configurationSchema>;
export type RagEvalExperiment = z.infer<typeof contractSchema>;
export type RagEvalExperimentOptions = z.input<typeof optionsSchema>;

export function corpusSnapshotHash(dataset: RagEvalDataset): string {
  return createHash('sha256').update(stableStringify(dataset.corpus)).digest('hex');
}

/** Review records are explicit human declarations; this function never manufactures approval. */
export function createExperimentContract(datasetInput: unknown, input: RagEvalExperimentOptions): RagEvalExperiment {
  const dataset = parseRagEvalDataset(datasetInput);
  const options = optionsSchema.parse(input);
  if (new Set(options.variablePaths).size !== options.variablePaths.length) throw new Error('[rag-eval experiment] duplicate variable factor');
  if (dataset.schemaVersion !== 'rag-eval-dataset/v2') throw new Error('[rag-eval experiment] live evaluations require a scoped V2 dataset');
  for (const item of dataset.cases) {
    if (!item.tags.includes('human-reviewed') || item.tags.includes('needs-review')) throw new Error('[rag-eval experiment] every case requires human review: ' + item.id);
    if (!item.expectedAbstain && (!item.expectedAnswer?.referenceAnswer?.trim() || !item.expectedAnswer.requiredFacts.length
      || item.goldEvidence.some(gold => !gold.spans?.length))) throw new Error('[rag-eval experiment] incomplete answer/evidence annotation: ' + item.id);
  }
  for (const item of dataset.corpus) knownVersion.parse(item.documentVersion);
  const fixed = Object.fromEntries(Object.entries(options.configuration).filter(([key]) => !options.variablePaths.includes(key as typeof factors[number])));
  return { schemaVersion: 'rag-eval-experiment/v1', ...options,
    datasetSha256: createRagEvalDatasetHash(dataset), corpusSha256: corpusSnapshotHash(dataset),
    configurationHash: canonicalJsonSha256(options.configuration),
    comparisonHash: canonicalJsonSha256({ configuration: fixed, variablePaths: [...options.variablePaths].sort() }),
  };
}

export function validateExperimentContract(dataset: unknown, input: unknown): RagEvalExperiment {
  const parsed = contractSchema.parse(input);
  const rebuilt = createExperimentContract(dataset, { review: parsed.review, configuration: parsed.configuration, variablePaths: parsed.variablePaths });
  for (const field of ['datasetSha256', 'corpusSha256', 'configurationHash', 'comparisonHash'] as const) {
    if (parsed[field] !== rebuilt[field]) throw new Error('[rag-eval experiment] ' + field + ' binding/hash mismatch');
  }
  return rebuilt;
}

export function compareExperimentBindings(baseline: RagEvalExperiment, candidate: RagEvalExperiment): string[] {
  return experimentComparisonIssues(baseline, candidate);
}
