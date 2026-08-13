import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  REQUEST_LIMITS,
  RequestValidationError,
  publicErrorPayload,
  readJsonObjectWithLimit,
  validateAskInput,
  validateBatchItems,
  validateChunking,
  validateEmbeddingModelSelection,
  validateQueryText,
  validateUploadedFiles,
  resolveRuntimeEmbeddingModel,
  resolveRuntimeLlmModel,
  validateRuntimeModelAllowlistCoherence,
} = await import('./request-validation.ts');

test('readJsonObjectWithLimit parses a bounded JSON object', async () => {
  const request = new Request('https://example.test', {
    method: 'POST',
    body: JSON.stringify({ question: 'hello' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await readJsonObjectWithLimit(request, 128), { question: 'hello' });
});

test('readJsonObjectWithLimit rejects declared oversized bodies', async () => {
  const request = new Request('https://example.test', {
    method: 'POST',
    body: '{}',
    headers: { 'content-length': '999' },
  });
  await assert.rejects(() => readJsonObjectWithLimit(request, 10), match('REQUEST_BODY_TOO_LARGE', 413));
});

test('readJsonObjectWithLimit rejects chunked oversized bodies', async () => {
  const request = new Request('https://example.test', { method: 'POST', body: JSON.stringify({ x: 'long' }) });
  await assert.rejects(() => readJsonObjectWithLimit(request, 5), match('REQUEST_BODY_TOO_LARGE', 413));
});

test('readJsonObjectWithLimit rejects malformed JSON and arrays', async () => {
  await assert.rejects(
    () => readJsonObjectWithLimit(new Request('https://example.test', { method: 'POST', body: '{' }), 10),
    match('INVALID_JSON', 400)
  );
  await assert.rejects(
    () => readJsonObjectWithLimit(new Request('https://example.test', { method: 'POST', body: '[]' }), 10),
    match('INVALID_JSON_OBJECT', 400)
  );
});

test('validateAskInput applies stable defaults and ignores legacy identity', () => {
  const input = validateAskInput({ question: '  What is RAG? ', userId: 'spoof', tenantId: 'spoof' }, {});
  assert.equal(input.question, 'What is RAG?');
  assert.equal(input.topK, 3);
  assert.equal(input.storageBackend, 'memory');
  assert.equal('userId' in input, false);
  assert.equal(input.executionMode, 'sync');
  assert.equal('tenantId' in input, false);
});

test('validateAskInput rejects whitespace and oversized questions', () => {
  assert.throws(() => validateAskInput({ question: '   ' }, {}), match('EMPTY_STRING', 400));
  assert.throws(
    () => validateAskInput({ question: 'x'.repeat(REQUEST_LIMITS.questionCharacters + 1) }, {}),
    match('STRING_TOO_LONG', 413)
  );
});

test('validateAskInput enforces strict topK and retry integers', () => {
  for (const topK of [0, 51, 1.5, '3', Number.NaN]) {
    assert.throws(() => validateAskInput({ question: 'q', topK }, {}), match('INVALID_INTEGER', 400));
  }
  assert.throws(() => validateAskInput({ question: 'q', maxRetries: 6 }, {}), match('INVALID_INTEGER', 400));
});

test('validateAskInput enforces finite threshold bounds', () => {
  for (const similarityThreshold of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    assert.throws(
      () => validateAskInput({ question: 'q', similarityThreshold }, {}),
      match('INVALID_NUMBER', 400)
    );
  }
});

test('validateAskInput enforces booleans and mutually exclusive advanced modes', () => {
  assert.throws(() => validateAskInput({ question: 'q', useAgenticRAG: 'true' }, {}), match('INVALID_BOOLEAN', 400));
  assert.throws(
    () => validateAskInput({ question: 'q', useAgenticRAG: true, useAdaptiveEntityRAG: true }, {}),
    match('CONFLICTING_RAG_MODES', 400)
  );
});


test('validateAskInput accepts only explicit sync or durable execution', () => {
  assert.equal(
    validateAskInput({ question: 'q', executionMode: 'durable' }, {}).executionMode,
    'durable'
  );
  assert.throws(
    () => validateAskInput({ question: 'q', executionMode: 'background' }, {}),
    match('INVALID_ENUM', 400)
  );
});
test('validateAskInput rejects unknown backend and unknown fields', () => {
  assert.throws(() => validateAskInput({ question: 'q', storageBackend: 'memroy' }, {}), match('INVALID_ENUM', 400));
  assert.throws(() => validateAskInput({ question: 'q', surprise: true }, {}), match('UNKNOWN_FIELDS', 400));
});

test('validateAskInput applies configured model allowlists before provider creation', () => {
  const env = {
    RAG_ALLOWED_LLM_MODELS: 'approved-llm,second-llm',
    RAG_ALLOWED_EMBEDDING_MODELS: 'approved-embed',
    OLLAMA_LLM_MODEL: 'approved-llm',
    OLLAMA_EMBEDDING_MODEL: 'approved-embed',
  };
  assert.equal(validateAskInput({ question: 'q' }, env).llmModel, 'approved-llm');
  assert.throws(
    () => validateAskInput({ question: 'q', llmModel: 'unapproved' }, env),
    match('MODEL_NOT_ALLOWED', 403)
  );
  assert.throws(
    () => validateAskInput({ question: 'q', embeddingModel: '../../secret' }, env),
    match('INVALID_MODEL_ID', 400)
  );
});

test('provider-aware request defaults match active LLM and Embedding providers', () => {
  const llmModels = [
    [{ MODEL_PROVIDER: 'ollama', OLLAMA_LLM_MODEL: 'ollama-active' }, 'ollama-active'],
    [{ MODEL_PROVIDER: 'openai', OPENAI_LLM_MODEL: 'openai-active' }, 'openai-active'],
    [{ MODEL_PROVIDER: 'custom', CUSTOM_LLM_MODEL: 'custom-active' }, 'custom-active'],
    [{ MODEL_PROVIDER: 'openrouter', OPENROUTER_LLM_MODEL: 'router-active' }, 'router-active'],
    [{ MODEL_PROVIDER: 'lemonade', LEMONADE_LLM_MODEL: 'lemonade-active' }, 'lemonade-active'],
    [{ MODEL_PROVIDER: 'azure', AZURE_OPENAI_LLM_DEPLOYMENT: 'azure-deployment' }, 'azure-deployment'],
  ];
  for (const [env, expected] of llmModels) {
    assert.equal(resolveRuntimeLlmModel(env), expected);
  }

  const embeddingModels = [
    [{ EMBEDDING_PROVIDER: 'ollama', OLLAMA_EMBEDDING_MODEL: 'ollama-embed' }, 'ollama-embed'],
    [{ EMBEDDING_PROVIDER: 'siliconflow', SILICONFLOW_EMBEDDING_MODEL: 'BAAI/bge-m3' }, 'BAAI/bge-m3'],
    [{ EMBEDDING_PROVIDER: 'openai', OPENAI_EMBEDDING_MODEL: 'openai-embed' }, 'openai-embed'],
    [{ EMBEDDING_PROVIDER: 'custom', CUSTOM_EMBEDDING_MODEL: 'custom-embed' }, 'custom-embed'],
  ];
  for (const [env, expected] of embeddingModels) {
    assert.equal(resolveRuntimeEmbeddingModel(env), expected);
  }
});

test('validateAskInput defaults to the active custom and SiliconFlow models without relaxing allowlists', () => {
  const env = {
    MODEL_PROVIDER: 'custom',
    CUSTOM_LLM_MODEL: 'deepseek-v4-flash',
    EMBEDDING_PROVIDER: 'siliconflow',
    SILICONFLOW_EMBEDDING_MODEL: 'BAAI/bge-m3',
    RAG_ALLOWED_LLM_MODELS: 'deepseek-v4-flash',
    RAG_ALLOWED_EMBEDDING_MODELS: 'BAAI/bge-m3',
  };

  const input = validateAskInput({ question: 'q' }, env);
  assert.equal(input.llmModel, 'deepseek-v4-flash');
  assert.equal(input.embeddingModel, 'BAAI/bge-m3');
  assert.equal(validateEmbeddingModelSelection(undefined, env), 'BAAI/bge-m3');
  assert.throws(
    () => validateAskInput({ question: 'q', llmModel: 'llama3.1' }, env),
    match('MODEL_NOT_ALLOWED', 403)
  );
  assert.throws(
    () => validateEmbeddingModelSelection('nomic-embed-text', env),
    match('MODEL_NOT_ALLOWED', 403)
  );
});

test('validateEmbeddingModelSelection applies the same server allowlist to ingestion', () => {
  const env = {
    EMBEDDING_PROVIDER: 'ollama',
    RAG_ALLOWED_EMBEDDING_MODELS: 'embed-a',
    OLLAMA_EMBEDDING_MODEL: 'embed-a',
  };
  assert.equal(validateEmbeddingModelSelection(undefined, env), 'embed-a');
  assert.throws(() => validateEmbeddingModelSelection('embed-b', env), match('MODEL_NOT_ALLOWED', 403));
});

test('runtime model allowlist coherence reports stale configured allowlists without adding models', () => {
  const validation = validateRuntimeModelAllowlistCoherence({
    MODEL_PROVIDER: 'custom',
    CUSTOM_LLM_MODEL: 'deepseek-v4-flash',
    EMBEDDING_PROVIDER: 'siliconflow',
    SILICONFLOW_EMBEDDING_MODEL: 'BAAI/bge-m3',
    RAG_ALLOWED_LLM_MODELS: 'llama3.1',
    RAG_ALLOWED_EMBEDDING_MODELS: 'nomic-embed-text',
  });

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.errors, [
    'Active LLM model "deepseek-v4-flash" is not in RAG_ALLOWED_LLM_MODELS.',
    'Active Embedding model "BAAI/bge-m3" is not in RAG_ALLOWED_EMBEDDING_MODELS.',
  ]);
});

test('validateQueryText bounds direct vector search queries', () => {
  assert.equal(validateQueryText('  scoped search  '), 'scoped search');
  assert.throws(
    () => validateQueryText('x'.repeat(REQUEST_LIMITS.questionCharacters + 1)),
    match('STRING_TOO_LONG', 413)
  );
});

test('validateAskInput validates session and corpus identifiers', () => {
  const input = validateAskInput({ question: 'q', sessionId: 's:1', corpusId: 'corpus-1' }, {});
  assert.equal(input.sessionId, 's:1');
  assert.equal(input.requestedCorpusId, 'corpus-1');
  assert.throws(() => validateAskInput({ question: 'q', corpusId: '../other' }, {}), match('INVALID_IDENTIFIER', 400));
});

test('validateChunking enforces bounded integer values and overlap ordering', () => {
  assert.deepEqual(validateChunking({}), { chunkSize: 500, chunkOverlap: 50 });
  assert.deepEqual(validateChunking({ chunkSize: 100, chunkOverlap: 50 }), { chunkSize: 100, chunkOverlap: 50 });
  assert.throws(() => validateChunking({ chunkSize: 99 }), match('INVALID_INTEGER', 400));
  assert.throws(() => validateChunking({ chunkSize: 100, chunkOverlap: 51 }), match('INVALID_INTEGER', 400));
});

test('validateBatchItems enforces item count, shape, and aggregate size', () => {
  assert.equal(validateBatchItems([{ text: 'ok' }]).length, 1);
  assert.throws(() => validateBatchItems([]), match('INVALID_BATCH', 400));
  assert.throws(
    () => validateBatchItems(Array.from({ length: REQUEST_LIMITS.batchItems + 1 }, () => ({ text: 'x' }))),
    match('BATCH_TOO_LARGE', 413)
  );
  assert.throws(() => validateBatchItems([{ nope: true }]), match('INVALID_BATCH_ITEM', 400));
});

test('validateUploadedFiles enforces count, single-file, and total limits', () => {
  const small = new File(['ok'], 'ok.txt');
  assert.doesNotThrow(() => validateUploadedFiles([small]));
  assert.throws(() => validateUploadedFiles([]), match('FILES_REQUIRED', 400));
  const tooMany = Array.from({ length: REQUEST_LIMITS.files + 1 }, (_, index) => new File(['x'], `${index}.txt`));
  assert.throws(() => validateUploadedFiles(tooMany), match('TOO_MANY_FILES', 413));
  const large = { name: 'large.bin', size: REQUEST_LIMITS.fileBytes + 1 };
  assert.throws(() => validateUploadedFiles([large]), match('FILE_TOO_LARGE', 413));
});

test('publicErrorPayload exposes stable validation errors and hides internal failures', () => {
  assert.deepEqual(
    publicErrorPayload(new RequestValidationError('BAD', 'safe', 422), 'INTERNAL', 'hidden', 'req-1'),
    { status: 422, body: { error: { code: 'BAD', message: 'safe' }, requestId: 'req-1' } }
  );
  const hidden = publicErrorPayload(new Error('token=secret internal.example'), 'INTERNAL', 'Try again.', 'req-2');
  assert.equal(JSON.stringify(hidden).includes('secret'), false);
  assert.equal(hidden.status, 500);
});

function match(code, status) {
  return (error) => error instanceof RequestValidationError && error.code === code && error.status === status;
}
