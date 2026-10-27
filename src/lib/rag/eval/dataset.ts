import { createHash } from 'node:crypto';
import type { RagEvalDataset } from './types';

// Keep validation browser-safe so the editor and CLI enforce the same dataset contract.
export { parseRagEvalDataset } from './dataset-parser';

export function createRagEvalDatasetHash(dataset: RagEvalDataset): string {
  return createHash('sha256').update(stableStringify(dataset)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error('[rag-eval dataset] cannot hash an undefined value');
    }
    return encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

