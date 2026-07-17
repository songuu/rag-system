export const REQUEST_LIMITS = {
  askJsonBytes: 64 * 1024,
  pipelineJsonBytes: 2 * 1024 * 1024,
  milvusJsonBytes: 4 * 1024 * 1024,
  questionCharacters: 8_000,
  textCharacters: 2_000_000,
  urlCharacters: 2_048,
  batchItems: 20,
  batchCharacters: 4_000_000,
  files: 10,
  fileBytes: 10 * 1024 * 1024,
  totalFileBytes: 50 * 1024 * 1024,
} as const;

export type SupportedStorageBackend = 'memory' | 'milvus';

export interface ValidatedAskInput {
  question: string;
  topK: number;
  executionMode: 'sync' | 'durable';
  similarityThreshold: number;
  llmModel: string;
  embeddingModel: string;
  storageBackend: SupportedStorageBackend;
  sessionId?: string;
  requestedCorpusId?: string;
  useAgenticRAG: boolean;
  useAdaptiveEntityRAG: boolean;
  maxRetries: number;
  enableReranking: boolean;
  raw: Record<string, unknown>;
}

export class RequestValidationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'RequestValidationError';
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new RequestValidationError(code, message, status);
}

export async function readJsonObjectWithLimit(
  request: Request,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0) {
      fail('INVALID_CONTENT_LENGTH', 'Invalid Content-Length header.');
    }
    if (length > maxBytes) {
      fail('REQUEST_BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`, 413);
    }
  }

  if (!request.body) {
    fail('EMPTY_REQUEST_BODY', 'Request body is required.');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel('request body limit exceeded');
        fail('REQUEST_BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged));
  } catch {
    fail('INVALID_JSON', 'Request body must be valid UTF-8 JSON.');
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    fail('INVALID_JSON_OBJECT', 'Request body must be a JSON object.');
  }
  return parsed;
}

export function validateAskInput(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): ValidatedAskInput {
  assertKnownKeys(raw, new Set([
    'question',
    'topK',
    'similarityThreshold',
    'llmModel',
    'embeddingModel',
    'storageBackend',
    'sessionId',
    'executionMode',
    'corpusId',
    'useAgenticRAG',
    'useAdaptiveEntityRAG',
    'maxRetries',
    'enableReranking',
    // Legacy identity fields are accepted for compatibility but never trusted.
    'userId',
    'tenantId',
  ]));

  const question = requiredString(raw.question, 'question', REQUEST_LIMITS.questionCharacters);
  const topK = boundedInteger(raw.topK, 'topK', 1, 50, 3);
  const executionMode = optionalEnum(
    raw.executionMode,
    'executionMode',
    ['sync', 'durable'] as const,
    'sync'
  );
  const similarityThreshold = boundedNumber(
    raw.similarityThreshold,
    'similarityThreshold',
    0,
    1,
    0
  );
  const maxRetries = boundedInteger(raw.maxRetries, 'maxRetries', 0, 5, 2);
  const useAgenticRAG = optionalBoolean(raw.useAgenticRAG, 'useAgenticRAG', false);
  const useAdaptiveEntityRAG = optionalBoolean(
    raw.useAdaptiveEntityRAG,
    'useAdaptiveEntityRAG',
    false
  );
  if (useAgenticRAG && useAdaptiveEntityRAG) {
    fail('CONFLICTING_RAG_MODES', 'Agentic and adaptive modes cannot both be enabled.');
  }

  const storageBackend = optionalEnum(
    raw.storageBackend,
    'storageBackend',
    ['memory', 'milvus'] as const,
    'memory'
  );
  const llmModel = validatedModel(
    raw.llmModel,
    'llmModel',
    env.RAG_ALLOWED_LLM_MODELS,
    env.OLLAMA_LLM_MODEL || env.OPENAI_LLM_MODEL || 'llama3.1'
  );
  const embeddingModel = validatedModel(
    raw.embeddingModel,
    'embeddingModel',
    env.RAG_ALLOWED_EMBEDDING_MODELS,
    env.EMBEDDING_MODEL || env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text'
  );

  return {
    question,
    topK,
    executionMode,
    similarityThreshold,
    llmModel,
    embeddingModel,
    storageBackend,
    sessionId: optionalIdentifier(raw.sessionId, 'sessionId', 128),
    requestedCorpusId: optionalIdentifier(raw.corpusId, 'corpusId', 128),
    useAgenticRAG,
    useAdaptiveEntityRAG,
    maxRetries,
    enableReranking: optionalBoolean(raw.enableReranking, 'enableReranking', true),
    raw,
  };
}

export function validateChunking(input: {
  chunkSize?: unknown;
  chunkOverlap?: unknown;
}): { chunkSize: number; chunkOverlap: number } {
  const chunkSize = boundedInteger(input.chunkSize, 'chunkSize', 100, 4_000, 500);
  const maxOverlap = Math.floor(chunkSize / 2);
  const chunkOverlap = boundedInteger(input.chunkOverlap, 'chunkOverlap', 0, maxOverlap, 50);
  return { chunkSize, chunkOverlap };
}

export function validatePipelineText(value: unknown, field = 'text'): string {
  return requiredString(value, field, REQUEST_LIMITS.textCharacters);
}

export function validateQueryText(value: unknown, field = 'query'): string {
  return requiredString(value, field, REQUEST_LIMITS.questionCharacters);
}

export function validateExternalUrlInput(value: unknown, field = 'url'): string {
  return requiredString(value, field, REQUEST_LIMITS.urlCharacters);
}

export function validateEmbeddingModelSelection(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env
): string {
  return validatedModel(
    value,
    'embeddingModel',
    env.RAG_ALLOWED_EMBEDDING_MODELS,
    env.EMBEDDING_MODEL || env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text'
  );
}

export function validateBatchItems(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    fail('INVALID_BATCH', 'items must be a non-empty array.');
  }
  if (value.length > REQUEST_LIMITS.batchItems) {
    fail('BATCH_TOO_LARGE', `items cannot contain more than ${REQUEST_LIMITS.batchItems} entries.`, 413);
  }
  let totalCharacters = 0;
  const records = value.map((item, index) => {
    if (!isRecord(item) || Array.isArray(item)) {
      fail('INVALID_BATCH_ITEM', `items[${index}] must be an object.`);
    }
    const candidate = item.content ?? item.text ?? item.url;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      fail('INVALID_BATCH_ITEM', `items[${index}] must contain content, text, or url.`);
    }
    totalCharacters += candidate.length;
    return item;
  });
  if (totalCharacters > REQUEST_LIMITS.batchCharacters) {
    fail('BATCH_TOO_LARGE', `Batch content exceeds ${REQUEST_LIMITS.batchCharacters} characters.`, 413);
  }
  return records;
}

export function validateUploadedFiles(files: File[]): void {
  if (files.length === 0) fail('FILES_REQUIRED', 'At least one file is required.');
  if (files.length > REQUEST_LIMITS.files) {
    fail('TOO_MANY_FILES', `No more than ${REQUEST_LIMITS.files} files are allowed.`, 413);
  }
  let total = 0;
  for (const file of files) {
    if (file.size > REQUEST_LIMITS.fileBytes) {
      fail('FILE_TOO_LARGE', `File ${file.name} exceeds ${REQUEST_LIMITS.fileBytes} bytes.`, 413);
    }
    total += file.size;
  }
  if (total > REQUEST_LIMITS.totalFileBytes) {
    fail('FILES_TOO_LARGE', `Files exceed ${REQUEST_LIMITS.totalFileBytes} bytes in total.`, 413);
  }
}

export function publicErrorPayload(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  requestId: string
): { status: number; body: { error: { code: string; message: string }; requestId: string } } {
  if (error instanceof RequestValidationError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message }, requestId },
    };
  }
  return {
    status: 500,
    body: { error: { code: fallbackCode, message: fallbackMessage }, requestId },
  };
}

function assertKnownKeys(raw: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail('UNKNOWN_FIELDS', `Unknown request fields: ${unknown.sort().join(', ')}.`);
  }
}

function requiredString(value: unknown, field: string, maxCharacters: number): string {
  if (typeof value !== 'string') fail('INVALID_STRING', `${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized) fail('EMPTY_STRING', `${field} cannot be empty.`);
  if (normalized.length > maxCharacters) {
    fail('STRING_TOO_LONG', `${field} cannot exceed ${maxCharacters} characters.`, 413);
  }
  return normalized;
}

function optionalIdentifier(value: unknown, field: string, maxCharacters: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = requiredString(value, field, maxCharacters);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    fail('INVALID_IDENTIFIER', `${field} contains unsupported characters.`);
  }
  return normalized;
}

function boundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail('INVALID_NUMBER', `${field} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail('INVALID_BOOLEAN', `${field} must be a boolean.`);
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  field: string,
  values: T,
  fallback: T[number]
): T[number] {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !values.includes(value)) {
    fail('INVALID_ENUM', `${field} must be one of: ${values.join(', ')}.`);
  }
  return value as T[number];
}

function validatedModel(
  value: unknown,
  field: string,
  configuredAllowlist: string | undefined,
  fallback: string
): string {
  const model = value === undefined || value === null || value === ''
    ? fallback
    : requiredString(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(model)) {
    fail('INVALID_MODEL_ID', `${field} contains unsupported characters.`);
  }
  const allowlist = configuredAllowlist
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowlist?.length && !allowlist.includes(model)) {
    fail('MODEL_NOT_ALLOWED', `${field} is not allowed by server configuration.`, 403);
  }
  return model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}
