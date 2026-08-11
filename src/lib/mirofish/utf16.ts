/** Slice UTF-16 text without creating a lone surrogate at either boundary. */
export function sliceWithoutSplittingSurrogate(
  value: string,
  startCodeUnit: number,
  endCodeUnit: number,
): string {
  let start = Math.min(value.length, Math.max(0, Math.trunc(startCodeUnit)));
  let end = Math.min(value.length, Math.max(start, Math.trunc(endCodeUnit)));

  if (
    start > 0
    && start < value.length
    && isHighSurrogate(value.charCodeAt(start - 1))
    && isLowSurrogate(value.charCodeAt(start))
  ) {
    start += 1;
  }

  if (
    end > start
    && end < value.length
    && isHighSurrogate(value.charCodeAt(end - 1))
    && isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1;
  }

  return value.slice(start, Math.max(start, end));
}

/** Keep the existing code-unit budget while preserving valid surrogate pairs. */
export function truncateWithoutSplittingSurrogate(
  value: string,
  maximumCodeUnits: number,
): string {
  return sliceWithoutSplittingSurrogate(value, 0, maximumCodeUnits);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
