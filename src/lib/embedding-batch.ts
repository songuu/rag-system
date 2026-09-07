const MAX_EMBEDDING_BATCH_SIZE = 64;
const MAX_EMBEDDING_DIMENSION = 65_536;

export class EmbeddingOutputValidationError extends Error {
  readonly code = 'EMBEDDING_OUTPUT_INVALID';
  readonly status = 502;

  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingOutputValidationError';
  }
}

/**
 * Keeps provider fan-out bounded and validates the complete embedding output
 * before callers publish any vectors.
 */
export async function embedTextsInBatches(input: {
  texts: readonly string[];
  batchSize: number;
  expectedDimension?: number;
  signal?: AbortSignal;
  embedBatch(texts: string[]): Promise<number[][]>;
  onProgress?(completed: number, total: number): void;
}): Promise<number[][]> {
  if (
    !Number.isSafeInteger(input.batchSize)
    || input.batchSize < 1
    || input.batchSize > MAX_EMBEDDING_BATCH_SIZE
  ) {
    throw new Error(
      `Embedding batchSize must be an integer between 1 and ${MAX_EMBEDDING_BATCH_SIZE}.`
    );
  }
  if (
    input.expectedDimension !== undefined
    && (
      !Number.isSafeInteger(input.expectedDimension)
      || input.expectedDimension < 1
      || input.expectedDimension > MAX_EMBEDDING_DIMENSION
    )
  ) {
    throw new Error('Embedding expectedDimension is outside the supported range.');
  }

  const vectors: number[][] = [];
  let resolvedDimension = input.expectedDimension;
  for (let offset = 0; offset < input.texts.length; offset += input.batchSize) {
    input.signal?.throwIfAborted();
    const batch = input.texts.slice(offset, offset + input.batchSize);
    const batchVectors = await input.embedBatch(batch);
    input.signal?.throwIfAborted();

    if (!Array.isArray(batchVectors) || batchVectors.length !== batch.length) {
      throw new EmbeddingOutputValidationError(
        `Embedding provider returned ${Array.isArray(batchVectors) ? batchVectors.length : 0} vectors for a batch of ${batch.length}.`
      );
    }

    for (let index = 0; index < batchVectors.length; index += 1) {
      const vector = batchVectors[index];
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new EmbeddingOutputValidationError(
          `Embedding provider returned an empty vector at batch index ${index}.`
        );
      }
      resolvedDimension ??= vector.length;
      if (
        vector.length !== resolvedDimension
        || vector.some(value => !Number.isFinite(value))
      ) {
        throw new EmbeddingOutputValidationError(
          `Embedding provider returned an invalid vector at batch index ${index}.`
        );
      }
      vectors.push(vector);
    }

    input.onProgress?.(vectors.length, input.texts.length);
  }

  return vectors;
}
