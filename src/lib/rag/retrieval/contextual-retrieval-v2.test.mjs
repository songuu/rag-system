import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const {
  contextualizeChunksV2,
  createContextualChunkIdentityV2,
  resolveContextualRetrievalV2Mode,
} = await import('./contextual-retrieval-v2.ts');

test('contextual identity binds source, document version, span, model and prompt version', () => {
  const base = identityInput();
  const first = createContextualChunkIdentityV2(base);
  const second = createContextualChunkIdentityV2(base);
  assert.equal(first.key, second.key);
  for (const mutation of [
    { sourceHash: 'sha256:different' },
    { documentVersion: 'v2' },
    { model: 'model-b' },
    { promptVersion: 'prompt-v2' },
    { chunk: { ...base.chunk, startOffset: 1, endOffset: 12 } },
  ]) {
    assert.notEqual(createContextualChunkIdentityV2({ ...base, ...mutation }).key, first.key);
  }
});

test('legacy contextual flag can only opt v2 into shadow mode', () => {
  assert.equal(resolveContextualRetrievalV2Mode({}), 'off');
  assert.equal(resolveContextualRetrievalV2Mode({ CONTEXTUAL_RETRIEVAL_ENABLED: 'true' }), 'shadow');
  assert.equal(resolveContextualRetrievalV2Mode({ CONTEXTUAL_RETRIEVAL_V2_MODE: 'active' }), 'active');
});

test('explicit contextual runtime mode rejects invalid JavaScript input', async () => {
  await assert.rejects(
    contextualizeChunksV2({
      ...baseOptions(),
      mode: 'invalid',
      contextualizer: { async generateContext() { return 'unused'; } },
    }),
    /Unsupported contextual retrieval v2 mode/
  );
});

test('off mode keeps raw text and never calls contextualizer', async () => {
  let called = false;
  const result = await contextualizeChunksV2({
    ...baseOptions(),
    mode: 'off',
    contextualizer: {
      async generateContext() {
        called = true;
        return 'unused';
      },
    },
  });
  assert.equal(called, false);
  assert.equal(result.chunks[0].denseText, result.chunks[0].rawContent);
  assert.equal(result.chunks[0].status, 'disabled');
});

test('off mode ignores inactive provider budgets even above the default call cap', async () => {
  let calls = 0;
  const result = await contextualizeChunksV2({
    ...baseOptions(257),
    mode: 'off',
    maxProviderCalls: 1,
    concurrency: 0,
    maxDocumentCharacters: 1,
    maxOutputCharactersPerChunk: 0,
    maxTotalOutputCharacters: 0,
    contextualizer: {
      async generateContext() {
        calls += 1;
        return 'unused';
      },
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.chunks.length, 257);
  assert.ok(result.chunks.every(chunk => chunk.status === 'disabled'));
});

test('shadow mode enforces concurrency and total output cap without changing dense text', async () => {
  let active = 0;
  let maximumActive = 0;
  const options = baseOptions(3);
  const result = await contextualizeChunksV2({
    ...options,
    mode: 'shadow',
    concurrency: 2,
    maxOutputCharactersPerChunk: 4,
    maxTotalOutputCharacters: 5,
    contextualizer: {
      async generateContext(input) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        assert.equal(input.documentText.length, 18);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return 'ABCDE';
      },
    },
  });
  assert.equal(maximumActive, 2);
  assert.equal(result.generatedCharacters, 5);
  assert.deepEqual(result.chunks.map(chunk => chunk.generatedContext), ['ABCD', 'A', '']);
  assert.ok(result.chunks.every(chunk => chunk.denseText === chunk.rawContent));
  assert.match(result.chunks[0].shadowDenseText, /^ABCD\n\n/);
  assert.equal(result.chunks[1].status, 'truncated');
});

test('active mode falls back per chunk and preserves raw content', async () => {
  const result = await contextualizeChunksV2({
    ...baseOptions(2),
    mode: 'active',
    contextualizer: {
      async generateContext(input) {
        if (input.chunk.id === 'chunk-2') throw new Error('fixture failure');
        return 'context for ' + input.chunk.id;
      },
    },
  });
  assert.match(result.chunks[0].denseText, /^context for chunk-1\n\n/);
  assert.equal(result.chunks[1].denseText, result.chunks[1].rawContent);
  assert.equal(result.chunks[1].status, 'fallback');
  assert.equal(result.chunks[1].errorCode, 'CONTEXTUALIZER_FAILED');
  assert.equal(result.fallbackCount, 1);
});

test('contextualizer input is capped without trimming source document boundaries', async () => {
  let receivedDocument;
  await contextualizeChunksV2({
    ...baseOptions(),
    mode: 'active',
    documentText: '  source document  ',
    chunks: [{ id: 'chunk-1', text: '  sou', startOffset: 0, endOffset: 5 }],
    maxDocumentCharacters: 5,
    contextualizer: {
      async generateContext(input) {
        receivedDocument = input.documentText;
        return 'context';
      },
    },
  });
  assert.equal(receivedDocument, '  sou');
});

test('bounded contextualizer windows always contain chunks outside the source prefix', async () => {
  let received;
  await contextualizeChunksV2({
    ...baseOptions(),
    mode: 'active',
    documentText: '0123456789',
    chunks: [{ id: 'chunk-1', text: '678', startOffset: 6, endOffset: 9 }],
    maxDocumentCharacters: 5,
    contextualizer: {
      async generateContext(input) {
        received = input;
        return 'context';
      },
    },
  });

  assert.equal(received.documentText.length, 5);
  assert.equal(
    received.documentText.slice(received.chunk.startOffset, received.chunk.endOffset),
    '678'
  );
  assert.equal(received.documentWindowStartOffset + received.chunk.startOffset, 6);
  assert.equal(received.identity.components.contextWindowHash.startsWith('sha256:'), true);
});

test('contextual v2 rejects duplicate identities and aborted work', async () => {
  const duplicate = baseOptions(1);
  await assert.rejects(
    contextualizeChunksV2({
      ...duplicate,
      chunks: [duplicate.chunks[0], { ...duplicate.chunks[0] }],
      contextualizer: { async generateContext() { return 'unused'; } },
    }),
    /identities must be unique/
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    contextualizeChunksV2({
      ...baseOptions(),
      signal: controller.signal,
      contextualizer: { async generateContext() { return 'unused'; } },
    }),
    error => error?.name === 'AbortError'
  );
});

test('contextual v2 rejects call and total-input amplification before provider work', async () => {
  let calls = 0;
  const contextualizer = {
    async generateContext() {
      calls += 1;
      return 'unused';
    },
  };
  await assert.rejects(
    contextualizeChunksV2({
      ...baseOptions(2),
      mode: 'shadow',
      maxProviderCalls: 1,
      contextualizer,
    }),
    /provider call count/
  );
  await assert.rejects(
    contextualizeChunksV2({
      ...baseOptions(2),
      mode: 'shadow',
      maxDocumentCharacters: 6,
      maxTotalInputCharacters: 10,
      contextualizer,
    }),
    /provider input/
  );
  assert.equal(calls, 0);
});

test('contextual identity rejects spans that do not map to source text', async () => {
  const options = baseOptions();
  await assert.rejects(
    contextualizeChunksV2({
      ...options,
      chunks: [{ ...options.chunks[0], endOffset: options.documentText.length + 1 }],
      contextualizer: { async generateContext() { return 'unused'; } },
    }),
    /span exceeds/
  );
  await assert.rejects(
    contextualizeChunksV2({
      ...options,
      chunks: [{ ...options.chunks[0], text: 'forged' }],
      contextualizer: { async generateContext() { return 'unused'; } },
    }),
    /does not match/
  );
});

function identityInput() {
  return {
    sourceHash: 'sha256:source',
    documentVersion: 'v1',
    chunk: { id: 'chunk-1', text: 'hello world', startOffset: 0, endOffset: 11 },
    model: 'model-a',
    promptVersion: 'prompt-v1',
  };
}

function baseOptions(chunkCount = 1) {
  const texts = Array.from({ length: chunkCount }, (_, index) => 'text-' + (index + 1));
  let cursor = 0;
  const chunks = texts.map((text, index) => {
    const startOffset = cursor;
    cursor += text.length;
    return {
      id: 'chunk-' + (index + 1),
      text,
      startOffset,
      endOffset: cursor,
    };
  });
  return {
    documentText: texts.join(''),
    sourceHash: 'sha256:source',
    documentVersion: 'v1',
    model: 'model-a',
    promptVersion: 'prompt-v1',
    chunks,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
