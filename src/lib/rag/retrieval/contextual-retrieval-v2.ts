import { createHash } from 'node:crypto';

export const CONTEXTUAL_RETRIEVAL_V2_VERSION = 'contextual-retrieval/v2' as const;
export const CONTEXTUAL_IDENTITY_VERSION = 'contextual-chunk-identity/v2' as const;

export type ContextualRetrievalV2Mode = 'off' | 'shadow' | 'active';

export interface ContextualChunkInputV2 {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface ContextualChunkIdentityV2 {
  version: typeof CONTEXTUAL_IDENTITY_VERSION;
  key: string;
  components: {
    sourceHash: string;
    documentVersion: string;
    chunkId: string;
    startOffset: number;
    endOffset: number;
    chunkTextHash: string;
    model: string;
    promptVersion: string;
    contextWindowStartOffset?: number;
    contextWindowEndOffset?: number;
    contextWindowHash?: string;
  };
}

export interface ContextualizerV2Input {
  documentText: string;
  /** Absolute source offset represented by documentText[0]. */
  documentWindowStartOffset: number;
  chunk: ContextualChunkInputV2;
  identity: ContextualChunkIdentityV2;
  model: string;
  promptVersion: string;
  maxOutputCharacters: number;
  signal?: AbortSignal;
}

export interface ContextualizerV2Port {
  generateContext(input: ContextualizerV2Input): Promise<string>;
}

export interface ContextualizedChunkV2 {
  id: string;
  identity: ContextualChunkIdentityV2;
  rawContent: string;
  generatedContext: string;
  denseText: string;
  shadowDenseText?: string;
  status: 'disabled' | 'contextualized' | 'fallback' | 'truncated';
  participatesInDenseIndex: boolean;
  errorCode?: 'CONTEXTUALIZER_FAILED';
}

export interface ContextualRetrievalV2Result {
  version: typeof CONTEXTUAL_RETRIEVAL_V2_VERSION;
  mode: ContextualRetrievalV2Mode;
  chunks: ContextualizedChunkV2[];
  generatedCharacters: number;
  fallbackCount: number;
}

export interface ContextualRetrievalV2Options {
  mode?: ContextualRetrievalV2Mode;
  documentText: string;
  sourceHash: string;
  documentVersion: string;
  model: string;
  promptVersion: string;
  chunks: readonly ContextualChunkInputV2[];
  contextualizer: ContextualizerV2Port;
  concurrency?: number;
  maxChunks?: number;
  maxProviderCalls?: number;
  maxTotalInputCharacters?: number;
  maxDocumentCharacters?: number;
  maxOutputCharactersPerChunk?: number;
  maxTotalOutputCharacters?: number;
  failureMode?: 'fallback' | 'throw';
  signal?: AbortSignal;
}

export function resolveContextualRetrievalV2Mode(
  env: Record<string, string | undefined> = process.env
): ContextualRetrievalV2Mode {
  const requested = env.CONTEXTUAL_RETRIEVAL_V2_MODE?.trim().toLowerCase();
  if (requested === undefined || requested === '') {
    return env.CONTEXTUAL_RETRIEVAL_ENABLED === 'true' ? 'shadow' : 'off';
  }
  if (requested === 'off' || requested === 'shadow' || requested === 'active') {
    return requested;
  }
  throw new Error('Unsupported CONTEXTUAL_RETRIEVAL_V2_MODE: ' + requested);
}

export function createContextualChunkIdentityV2(input: {
  sourceHash: string;
  documentVersion: string;
  chunk: ContextualChunkInputV2;
  model: string;
  promptVersion: string;
  contextWindow?: { text: string; startOffset: number };
}): ContextualChunkIdentityV2 {
  validateChunk(input.chunk);
  const components = {
    sourceHash: required(input.sourceHash, 'sourceHash'),
    documentVersion: required(input.documentVersion, 'documentVersion'),
    chunkId: required(input.chunk.id, 'chunk.id'),
    startOffset: input.chunk.startOffset,
    endOffset: input.chunk.endOffset,
    chunkTextHash: digest(input.chunk.text),
    model: required(input.model, 'model'),
    promptVersion: required(input.promptVersion, 'promptVersion'),
    ...(input.contextWindow
      ? {
          contextWindowStartOffset: input.contextWindow.startOffset,
          contextWindowEndOffset:
            input.contextWindow.startOffset + input.contextWindow.text.length,
          contextWindowHash: digest(input.contextWindow.text),
        }
      : {}),
  };
  const identityDigest = createHash('sha256')
    .update(JSON.stringify([CONTEXTUAL_IDENTITY_VERSION, components]))
    .digest('hex');
  return {
    version: CONTEXTUAL_IDENTITY_VERSION,
    key: 'contextual:v2:' + identityDigest,
    components,
  };
}

export async function contextualizeChunksV2(
  options: ContextualRetrievalV2Options
): Promise<ContextualRetrievalV2Result> {
  const mode = validateMode(options.mode ?? resolveContextualRetrievalV2Mode());
  if (options.failureMode !== undefined && !['fallback', 'throw'].includes(options.failureMode)) {
    throw new Error('Unsupported contextual failureMode: ' + String(options.failureMode));
  }
  const maxChunks = boundedInteger(options.maxChunks ?? 512, 1, 10_000, 'maxChunks');
  assertNonBlank(options.documentText, 'documentText');
  if (options.chunks.length > maxChunks) {
    throw new Error('Contextual chunk count exceeds the configured maxChunks budget.');
  }
  const sourceHash = required(options.sourceHash, 'sourceHash');
  const documentVersion = required(options.documentVersion, 'documentVersion');
  const model = required(options.model, 'model');
  const promptVersion = required(options.promptVersion, 'promptVersion');
  assertNotAborted(options.signal);

  options.chunks.forEach(chunk => assertChunkMatchesDocument(chunk, options.documentText));
  const rawIdentities = options.chunks.map(chunk =>
    createContextualChunkIdentityV2({
      sourceHash,
      documentVersion,
      chunk,
      model,
      promptVersion,
    })
  );
  if (new Set(rawIdentities.map(identity => identity.key)).size !== rawIdentities.length) {
    throw new Error('Contextual chunk identities must be unique within a document version.');
  }

  // Off is a true rollback path: validate source identity and raw spans only.
  // Provider-call, context-window, concurrency, and output budgets are inactive.
  if (mode === 'off') {
    return {
      version: CONTEXTUAL_RETRIEVAL_V2_VERSION,
      mode,
      chunks: options.chunks.map((chunk, index) => ({
        id: rawIdentities[index].components.chunkId,
        identity: rawIdentities[index],
        rawContent: chunk.text,
        generatedContext: '',
        denseText: chunk.text,
        status: 'disabled',
        participatesInDenseIndex: false,
      })),
      generatedCharacters: 0,
      fallbackCount: 0,
    };
  }

  const concurrency = boundedInteger(options.concurrency ?? 3, 1, 32, 'concurrency');
  const maxProviderCalls = boundedInteger(
    options.maxProviderCalls ?? 256,
    1,
    10_000,
    'maxProviderCalls'
  );
  const maxTotalInputCharacters = boundedInteger(
    options.maxTotalInputCharacters ?? 2_000_000,
    1,
    20_000_000,
    'maxTotalInputCharacters'
  );
  const maxDocumentCharacters = boundedInteger(
    options.maxDocumentCharacters ?? 25_000,
    1,
    1_000_000,
    'maxDocumentCharacters'
  );
  const maxPerChunk = boundedInteger(
    options.maxOutputCharactersPerChunk ?? 600,
    1,
    20_000,
    'maxOutputCharactersPerChunk'
  );
  const maxTotal = boundedInteger(
    options.maxTotalOutputCharacters ?? Math.max(maxPerChunk, maxPerChunk * options.chunks.length),
    1,
    5_000_000,
    'maxTotalOutputCharacters'
  );
  if (options.chunks.length > maxProviderCalls) {
    throw new Error('Contextual provider call count exceeds the configured budget.');
  }
  const contextWindows: Array<{ text: string; startOffset: number }> = [];
  let totalInputCharacters = 0;
  for (const chunk of options.chunks) {
    assertNotAborted(options.signal);
    const contextWindow = createBoundedDocumentWindow(
      options.documentText,
      chunk,
      maxDocumentCharacters
    );
    totalInputCharacters += contextWindow.text.length;
    if (totalInputCharacters > maxTotalInputCharacters) {
      throw new Error('Contextual provider input exceeds the configured character budget.');
    }
    contextWindows.push(contextWindow);
  }
  const identities = options.chunks.map((chunk, index) =>
    createContextualChunkIdentityV2({
      sourceHash,
      documentVersion,
      chunk,
      model,
      promptVersion,
      contextWindow: contextWindows[index],
    })
  );
  if (new Set(identities.map(identity => identity.key)).size !== identities.length) {
    throw new Error('Contextual chunk identities must be unique within a document version.');
  }

  const generated = new Array<{ context: string; failed: boolean }>(options.chunks.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, options.chunks.length)) },
    async () => {
      while (nextIndex < options.chunks.length) {
        const index = nextIndex++;
        assertNotAborted(options.signal);
        try {
          const sourceChunk = options.chunks[index];
          const contextWindow = contextWindows[index];
          const context = await options.contextualizer.generateContext({
            documentText: contextWindow.text,
            documentWindowStartOffset: contextWindow.startOffset,
            chunk: {
              ...sourceChunk,
              startOffset: sourceChunk.startOffset - contextWindow.startOffset,
              endOffset: sourceChunk.endOffset - contextWindow.startOffset,
            },
            identity: identities[index],
            model,
            promptVersion,
            maxOutputCharacters: maxPerChunk,
            signal: options.signal,
          });
          assertNotAborted(options.signal);
          generated[index] = {
            context: truncateWithoutSplittingSurrogate(context.trim(), maxPerChunk),
            failed: false,
          };
        } catch (error) {
          if (options.signal?.aborted) throw abortError();
          if (options.failureMode === 'throw') throw error;
          generated[index] = { context: '', failed: true };
        }
      }
    }
  );
  await Promise.all(workers);

  let remaining = maxTotal;
  let fallbackCount = 0;
  const chunks = options.chunks.map((chunk, index): ContextualizedChunkV2 => {
    const generatedItem = generated[index];
    const selectedContext = truncateWithoutSplittingSurrogate(
      generatedItem.context,
      remaining
    );
    remaining -= selectedContext.length;
    const wasTruncated = selectedContext.length < generatedItem.context.length;
    const contextualizedText = selectedContext
      ? selectedContext + '\n\n' + chunk.text
      : chunk.text;
    const failed = generatedItem.failed;
    if (failed) fallbackCount++;
    return {
      id: identities[index].components.chunkId,
      identity: identities[index],
      rawContent: chunk.text,
      generatedContext: selectedContext,
      denseText: mode === 'active' ? contextualizedText : chunk.text,
      ...(mode === 'shadow' ? { shadowDenseText: contextualizedText } : {}),
      status: failed
        ? 'fallback'
        : wasTruncated
          ? 'truncated'
          : 'contextualized',
      participatesInDenseIndex: mode === 'active',
      ...(failed ? { errorCode: 'CONTEXTUALIZER_FAILED' as const } : {}),
    };
  });

  return {
    version: CONTEXTUAL_RETRIEVAL_V2_VERSION,
    mode,
    chunks,
    generatedCharacters: maxTotal - remaining,
    fallbackCount,
  };
}

function validateChunk(chunk: ContextualChunkInputV2): void {
  required(chunk.id, 'chunk.id');
  required(chunk.text, 'chunk.text');
  if (!Number.isInteger(chunk.startOffset) || chunk.startOffset < 0) {
    throw new Error('Contextual chunk.startOffset must be a non-negative integer.');
  }
  if (!Number.isInteger(chunk.endOffset) || chunk.endOffset <= chunk.startOffset) {
    throw new Error('Contextual chunk.endOffset must be greater than startOffset.');
  }
}

function assertChunkMatchesDocument(
  chunk: ContextualChunkInputV2,
  documentText: string
): void {
  if (chunk.endOffset > documentText.length) {
    throw new Error('Contextual chunk span exceeds the source document.');
  }
  if (documentText.slice(chunk.startOffset, chunk.endOffset) !== chunk.text) {
    throw new Error('Contextual chunk text does not match its source document span.');
  }
}

function createBoundedDocumentWindow(
  documentText: string,
  chunk: ContextualChunkInputV2,
  maximumCharacters: number
): { text: string; startOffset: number } {
  if (chunk.text.length > maximumCharacters) {
    throw new Error(
      'Contextual maxDocumentCharacters must be large enough to contain every chunk.'
    );
  }
  if (documentText.length <= maximumCharacters) {
    return { text: documentText, startOffset: 0 };
  }
  const surroundingCharacters = maximumCharacters - chunk.text.length;
  const preferredStart = chunk.startOffset - Math.floor(surroundingCharacters / 2);
  const startOffset = Math.max(
    0,
    Math.min(preferredStart, documentText.length - maximumCharacters)
  );
  return {
    text: documentText.slice(startOffset, startOffset + maximumCharacters),
    startOffset,
  };
}

function validateMode(mode: ContextualRetrievalV2Mode): ContextualRetrievalV2Mode {
  if (!['off', 'shadow', 'active'].includes(mode)) {
    throw new Error('Unsupported contextual retrieval v2 mode: ' + String(mode));
  }
  return mode;
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      'Contextual ' + field + ' must be an integer between ' + minimum + ' and ' + maximum + '.'
    );
  }
  return value;
}

function required(value: string, field: string): string {
  assertNonBlank(value, field);
  return value.trim();
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Contextual ' + field + ' is required.');
  }
}

function digest(value: string): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error('Contextual retrieval was aborted.');
  error.name = 'AbortError';
  return error;
}

function truncateWithoutSplittingSurrogate(value: string, maximumCodeUnits: number): string {
  let end = Math.min(value.length, Math.max(0, maximumCodeUnits));
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end--;
  }
  return value.slice(0, end);
}
