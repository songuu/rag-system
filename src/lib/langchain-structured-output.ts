import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export interface StructuredJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface InvokeStructuredJsonOptions<T> {
  model: BaseChatModel;
  input: BaseLanguageModelInput;
  schema: StructuredJsonSchema;
  normalize: (value: unknown) => T;
  signal?: AbortSignal;
}

export interface StructuredJsonResult<T> {
  data: T;
  mode: 'native' | 'json';
  raw: unknown;
}

type StructuredRunnable<T> = {
  invoke(
    input: BaseLanguageModelInput,
    options?: { signal?: AbortSignal }
  ): Promise<T | { parsed: T; raw?: unknown }>;
};

/**
 * Prefer provider-native structured output when the model supports it, but keep
 * prompt JSON parsing as the compatibility path for local Ollama and older integrations.
 */
export async function invokeStructuredJson<T>({
  model,
  input,
  schema,
  normalize,
  signal,
}: InvokeStructuredJsonOptions<T>): Promise<StructuredJsonResult<T>> {
  signal?.throwIfAborted();
  try {
    const runnable = model.withStructuredOutput?.(schema.schema, { name: schema.name }) as
      | StructuredRunnable<unknown>
      | undefined;

    if (runnable) {
      const raw = await runnable.invoke(input, { signal });
      signal?.throwIfAborted();
      const parsed = isParsedStructuredOutput(raw) ? raw.parsed : raw;
      return {
        data: normalize(parsed),
        mode: 'native',
        raw,
      };
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
    // Some local providers expose the method but do not support the schema path.
  }

  signal?.throwIfAborted();
  const raw = await model.invoke(input, { signal });
  signal?.throwIfAborted();
  return {
    data: normalize(parseStructuredJson(raw)),
    mode: 'json',
    raw,
  };
}

function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) signal.throwIfAborted();
  if (error instanceof Error && error.name === 'AbortError') throw error;
}

export function parseStructuredJson(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !('content' in raw)) {
    return raw;
  }

  const text = extractModelText(raw).trim();
  if (!text) return {};

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const direct = tryJsonParse(cleaned);
  if (direct !== undefined) return direct;

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    const fenced = tryJsonParse(fencedMatch[1].trim());
    if (fenced !== undefined) return fenced;
  }

  const objectText = extractFirstJsonObject(cleaned);
  if (objectText) {
    const objectValue = tryJsonParse(objectText);
    if (objectValue !== undefined) return objectValue;
  }

  return {};
}

export function extractModelText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';

  const content = 'content' in raw ? (raw as { content?: unknown }).content : raw;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : JSON.stringify(text);
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }

  return JSON.stringify(content);
}

function isParsedStructuredOutput(value: unknown): value is { parsed: unknown; raw?: unknown } {
  return Boolean(value && typeof value === 'object' && 'parsed' in value);
}

function tryJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;

    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return null;
}
