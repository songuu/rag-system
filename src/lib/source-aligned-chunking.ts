export interface SourceAlignedTextWindow {
  content: string;
  startChar: number;
  endChar: number;
  previousOverlap: string | null;
  nextOverlap: string | null;
}

export interface SourceAlignedChunkBudget {
  chunkCount: number;
  cumulativeContentCharacters: number;
}

/**
 * Exact count for the bounded sliding-window algorithm used by EntityExtractor.
 * Keeping this calculation shared lets HTTP admission reject amplification
 * before allocating either a task or a provider client.
 */
export function calculateSourceAlignedChunkCount(
  textLength: number,
  chunkSize: number,
  chunkOverlap: number
): number {
  assertChunkingInputs(textLength, chunkSize, chunkOverlap);
  if (textLength === 0) return 0;
  if (textLength <= chunkSize) return 1;

  return 1 + Math.ceil(
    (textLength - chunkSize) / (chunkSize - chunkOverlap)
  );
}

/** Exact sum of content characters sent across the extraction chunks. */
export function calculateSourceAlignedChunkBudget(
  textLength: number,
  chunkSize: number,
  chunkOverlap: number
): SourceAlignedChunkBudget {
  const chunkCount = calculateSourceAlignedChunkCount(
    textLength,
    chunkSize,
    chunkOverlap
  );
  if (chunkCount === 0) {
    return { chunkCount: 0, cumulativeContentCharacters: 0 };
  }

  const step = chunkSize - chunkOverlap;
  const finalChunkLength = textLength - ((chunkCount - 1) * step);
  const cumulativeContentCharacters =
    ((chunkCount - 1) * chunkSize) + finalChunkLength;
  if (!Number.isSafeInteger(cumulativeContentCharacters)) {
    throw new Error('Source-aligned chunk budget exceeds safe integer range.');
  }
  return { chunkCount, cumulativeContentCharacters };
}

/**
 * Produces only verbatim source slices. Long paragraphs and unbroken input use
 * the same bounded windows, so no paragraph can become an oversized prompt.
 */
export function createSourceAlignedTextWindows(
  text: string,
  chunkSize: number,
  chunkOverlap: number
): SourceAlignedTextWindow[] {
  const { chunkCount } = calculateSourceAlignedChunkBudget(
    text.length,
    chunkSize,
    chunkOverlap
  );
  if (chunkCount === 0) return [];

  const step = chunkSize - chunkOverlap;
  const ranges = Array.from({ length: chunkCount }, (_, index) => {
    const startChar = index * step;
    return {
      startChar,
      endChar: Math.min(text.length, startChar + chunkSize),
    };
  });

  return ranges.map((range, index) => {
    const previousRange = ranges[index - 1];
    const nextRange = ranges[index + 1];
    return {
      content: text.slice(range.startChar, range.endChar),
      startChar: range.startChar,
      endChar: range.endChar,
      previousOverlap: previousRange
        ? sliceIntersection(text, previousRange, range)
        : null,
      nextOverlap: nextRange
        ? sliceIntersection(text, range, nextRange)
        : null,
    };
  });
}

function sliceIntersection(
  text: string,
  left: { startChar: number; endChar: number },
  right: { startChar: number; endChar: number }
): string {
  const start = Math.max(left.startChar, right.startChar);
  const end = Math.min(left.endChar, right.endChar);
  return end > start ? text.slice(start, end) : '';
}

function assertChunkingInputs(
  textLength: number,
  chunkSize: number,
  chunkOverlap: number
): void {
  if (
    !Number.isSafeInteger(textLength)
    || textLength < 0
    || !Number.isSafeInteger(chunkSize)
    || chunkSize < 1
    || !Number.isSafeInteger(chunkOverlap)
    || chunkOverlap < 0
    || chunkOverlap >= chunkSize
  ) {
    throw new Error('Invalid source-aligned chunking inputs.');
  }
}
