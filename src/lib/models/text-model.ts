/** Framework-neutral contract for single text generations. */
export interface TextModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TextModelCallOptions {
  signal?: AbortSignal;
}

export interface TextModelRequest extends TextModelCallOptions {
  /** Server-owned operation name; never include prompts or credentials. */
  operation: string;
  messages: readonly TextModelMessage[];
}

export interface TextModelUsage {
  measurement: 'provider' | 'partial' | 'unavailable';
  inputTokenCount?: number;
  outputTokenCount?: number;
}

export interface TextModelResult {
  text: string;
  stopReason: 'stop' | 'length' | 'content_filter' | 'unknown';
  usage: TextModelUsage;
}

export interface TextModelClient {
  complete(request: TextModelRequest): Promise<TextModelResult>;
}

export class TextModelError extends Error {
  readonly code: 'MODEL_INVOCATION_FAILED' | 'MODEL_RESPONSE_INVALID';
  readonly operation: string;

  constructor(code: TextModelError['code'], operation: string, options?: ErrorOptions) {
    // Provider errors can contain credentials; keep their text out of the public message.
    super('Text model operation failed (' + operation + ').', options);
    this.name = 'TextModelError';
    this.code = code;
    this.operation = operation;
  }
}

export function rethrowTextModelCancellation(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (error instanceof Error && error.name === 'AbortError') throw error;
}
