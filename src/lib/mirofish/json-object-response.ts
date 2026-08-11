const INVALID_RESPONSE_CODE = 'MIROFISH_JSON_OBJECT_RESPONSE_INVALID';
const INVALID_RESPONSE_MESSAGE = 'Invalid MiroFish JSON object response.';
const REASONING_TAGS = ['think', 'thinking', 'reasoning'] as const;

export class MiroFishJsonObjectResponseError extends Error {
  readonly code = INVALID_RESPONSE_CODE;

  constructor() {
    // Keep this error context-free because model output can contain credentials
    // or private source material and errors can cross logging/API boundaries.
    super(INVALID_RESPONSE_MESSAGE);
    this.name = 'MiroFishJsonObjectResponseError';
  }
}

/**
 * Parse one strict JSON object from a MiroFish model response.
 *
 * Accepted envelopes are an exact JSON object, one complete `json` markdown
 * fence, or one leading model reasoning block followed by either form.
 */
export function parseMiroFishJsonObjectResponse(
  response: string,
): Record<string, unknown> {
  if (typeof response !== 'string') {
    throw new MiroFishJsonObjectResponseError();
  }

  const trimmedResponse = response.trim();
  if (!trimmedResponse) {
    throw new MiroFishJsonObjectResponseError();
  }

  // Exact JSON has priority so reasoning-like tags inside valid JSON strings
  // remain literal data instead of being interpreted as an envelope.
  const exactObject = tryParsePlainObject(trimmedResponse);
  if (exactObject) return exactObject;

  const fencedObject = tryParseJsonFence(trimmedResponse);
  if (fencedObject) return fencedObject;

  const unwrappedResponse = unwrapReasoningBlock(trimmedResponse);
  if (unwrappedResponse) {
    const finalObject = tryParsePlainObject(unwrappedResponse)
      ?? tryParseJsonFence(unwrappedResponse);
    if (finalObject) return finalObject;
  }

  throw new MiroFishJsonObjectResponseError();
}

function tryParsePlainObject(source: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(source);
    return isPlainObject(value) ? value : null;
  } catch {
    // Deliberately discard JSON.parse errors so malformed model text cannot be
    // retained as an Error cause or reflected through its message.
    return null;
  }
}

function tryParseJsonFence(source: string): Record<string, unknown> | null {
  const match = /^```[\t ]*json[\t ]*(?:\r\n|\n|\r)([\s\S]*)(?:\r\n|\n|\r)```[\t ]*$/iu.exec(source);
  if (!match) return null;

  return tryParsePlainObject(match[1].trim());
}

function unwrapReasoningBlock(source: string): string | null {
  for (const tag of REASONING_TAGS) {
    const openingTag = `<${tag}>`;
    if (!source.startsWith(openingTag)) continue;

    const closingTag = `</${tag}>`;
    const closingIndex = source.indexOf(closingTag, openingTag.length);
    if (closingIndex < 0) return null;

    const finalResponse = source
      .slice(closingIndex + closingTag.length)
      .trim();
    return finalResponse || null;
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
