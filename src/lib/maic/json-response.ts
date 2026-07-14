const REASONING_CLOSE_TAG = /<\/(?:think|thinking|reasoning)>\s*/gi;

/**
 * Parse structured MAIC output without trusting model prose around the payload.
 * Exact JSON is attempted first so literal reasoning tags inside JSON strings stay intact.
 */
export function parseMaicJsonResponse<T>(rawResponse: string): T | null {
  const response = rawResponse.trim();
  if (!response) return null;

  const exact = tryParseJson<T>(response);
  if (exact !== null) return exact;

  const afterReasoning = contentAfterLastReasoningTag(response);
  if (afterReasoning !== response) {
    const finalPayload = parseJsonCandidate<T>(afterReasoning);
    if (finalPayload !== null) return finalPayload;
  }

  return parseJsonCandidate<T>(response);
}

function contentAfterLastReasoningTag(response: string): string {
  const jsonRanges = findValidJsonRanges(response);
  const matches = Array.from(response.matchAll(REASONING_CLOSE_TAG)).filter(match => {
    if (match.index === undefined) return false;
    return !jsonRanges.some(range => match.index! >= range.start && match.index! <= range.end);
  });
  const lastMatch = matches.at(-1);
  if (!lastMatch || lastMatch.index === undefined) return response;
  return response.slice(lastMatch.index + lastMatch[0].length).trim();
}

function findValidJsonRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;

    const end = findBalancedJsonEnd(text, start);
    if (end === -1) continue;
    if (tryParseJson(text.slice(start, end + 1)) === null) continue;

    ranges.push({ start, end });
    start = end;
  }

  return ranges;
}

function parseJsonCandidate<T>(candidate: string): T | null {
  const direct = tryParseJson<T>(candidate.trim());
  if (direct !== null) return direct;

  for (const fencedMatch of candidate.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fencedBody = fencedMatch[1].trim();
    const fenced = tryParseJson<T>(fencedBody) ?? parseBalancedJson<T>(fencedBody);
    if (fenced !== null) return fenced;
  }

  return parseBalancedJson<T>(candidate);
}

function parseBalancedJson<T>(text: string): T | null {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;

    const end = findBalancedJsonEnd(text, start);
    if (end === -1) continue;

    const parsed = tryParseJson<T>(text.slice(start, end + 1));
    if (parsed !== null) return parsed;
  }

  return null;
}

function findBalancedJsonEnd(text: string, start: number): number {
  const closingStack: string[] = [];
  let insideString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }

    if (character === '"') {
      insideString = true;
      continue;
    }

    if (character === '{') {
      closingStack.push('}');
    } else if (character === '[') {
      closingStack.push(']');
    } else if (character === '}' || character === ']') {
      if (closingStack.at(-1) !== character) return -1;
      closingStack.pop();
      if (closingStack.length === 0) return index;
    }
  }

  return -1;
}

function tryParseJson<T>(candidate: string): T | null {
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}
