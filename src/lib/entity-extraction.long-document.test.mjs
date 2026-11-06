import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { EntityExtractor } = await import('./entity-extraction.ts');

function extraction(name) {
  return { content: JSON.stringify({
    entities: [{ name, type: 'PERSON', description: name }],
    relations: [],
  }), response_metadata: { done_reason: 'stop' } };
}

function makeExtractor(invoke, checkpoint) {
  const extractor = new EntityExtractor({
    chunkSize: 10, chunkOverlap: 0, enableGleaning: false,
    requireCompleteExtraction: true, adaptiveChunkSplitting: true,
    minAdaptiveChunkCharacters: 2, llmModel: 'test-model',
    maxChunkTimeout: 5_000, baseChunkTime: 5_000, timeoutPerChar: 0,
  }, {
    llmInstance: { invoke },
    embeddingInstance: { async embedDocuments() { return []; }, async embedQuery() { return []; } },
    providerKey: `long-document-${Math.random()}`,
    checkpoint,
  });
  extractor.startTime = Date.now();
  extractor.estimatedTimeout = 60_000;
  return extractor;
}

test('truncated model output is split and both halves retain the original evidence', async () => {
  const calls = [];
  const extractor = makeExtractor(async prompt => {
    const text = /## 输入文本\s*"""\s*([\s\S]*?)\s*"""/u.exec(prompt)?.[1];
    calls.push(text);
    if (text === 'ABCDEFGHIJ') return { content: '{"entities":', response_metadata: { done_reason: 'length' } };
    return extraction(text);
  });
  const chunks = await extractor.chunkDocument('ABCDEFGHIJ', 'document');
  const graph = await extractor.extractEntitiesAndRelations(chunks);
  assert.deepEqual(calls, ['ABCDEFGHIJ', 'ABCDE', 'FGHIJ']);
  assert.deepEqual([...graph.entities.values()].map(entity => entity.name), ['ABCDE', 'FGHIJ']);
  assert.deepEqual([...graph.entities.values()].map(entity => entity.sourceChunks), [
    ['document_chunk_0'], ['document_chunk_0'],
  ]);
});

test('retry resumes a completed split segment without repeating its model call', async () => {
  const saved = new Map();
  const checkpoint = {
    async load(segment) { return saved.get(segment.key) ?? null; },
    async save(segment, value) { saved.set(segment.key, value); },
  };
  let failRight = true;
  const calls = [];
  const invoke = async prompt => {
    const text = /## 输入文本\s*"""\s*([\s\S]*?)\s*"""/u.exec(prompt)?.[1];
    calls.push(text);
    if (text === 'ABCDEFGHIJ') return { content: '{', response_metadata: { done_reason: 'length' } };
    if (text === 'FGHIJ' && failRight) throw new Error('temporary provider failure');
    return extraction(text);
  };
  const first = makeExtractor(invoke, checkpoint);
  const chunks = await first.chunkDocument('ABCDEFGHIJ', 'document');
  await assert.rejects(first.extractEntitiesAndRelations(chunks), /文本块抽取失败/);
  failRight = false;
  const second = makeExtractor(invoke, checkpoint);
  const result = await second.extractEntitiesAndRelations(chunks);
  assert.deepEqual(calls, ['ABCDEFGHIJ', 'ABCDE', 'FGHIJ', 'FGHIJ']);
  assert.deepEqual([...result.entities.values()].map(entity => entity.name), ['ABCDE', 'FGHIJ']);
});

test('timed-out providers are not overlapped and the split is resumed after settlement', async () => {
  const saved = new Map();
  const checkpoint = {
    async load(segment) { return saved.get(segment.key) ?? null; },
    async save(segment, value) { saved.set(segment.key, value); },
  };
  let release;
  const calls = [];
  const extractor = makeExtractor(async prompt => {
    const text = /## 输入文本\s*"""\s*([\s\S]*?)\s*"""/u.exec(prompt)?.[1];
    calls.push(text);
    if (text === 'ABCDEFGHIJ') return new Promise(resolve => { release = () => resolve(extraction('late')); });
    return extraction(text);
  }, checkpoint);
  extractor.config.maxChunkTimeout = 5;
  const chunks = await extractor.chunkDocument('ABCDEFGHIJ', 'document');
  await assert.rejects(extractor.extractEntitiesAndRelations(chunks), /超时/);
  assert.deepEqual(calls, ['ABCDEFGHIJ']);
  assert.equal(saved.get('0:0:10').kind, 'split');
  release();
  await new Promise(resolve => setImmediate(resolve));
  const result = await extractor.extractEntitiesAndRelations(chunks);
  assert.deepEqual(calls, ['ABCDEFGHIJ', 'ABCDE', 'FGHIJ']);
  assert.equal(result.entities.size, 2);
});

test('ordinary adaptive extraction waits for cooperative cancellation before splitting a timed-out parent', async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const extractor = makeExtractor(async (prompt, options) => {
    const text = /## 输入文本\s*"""\s*([\s\S]*?)\s*"""/u.exec(prompt)?.[1];
    calls.push(text);
    active++;
    maximumActive = Math.max(maximumActive, active);
    if (text === 'ABCDEFGHIJ') return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => setTimeout(() => { active--; reject(options.signal.reason); }, 10), { once: true });
    });
    active--;
    return extraction(text);
  });
  extractor.config.maxChunkTimeout = 5;
  const result = await extractor.extractEntitiesAndRelations(await extractor.chunkDocument('ABCDEFGHIJ', 'document'));
  assert.deepEqual(calls, ['ABCDEFGHIJ', 'ABCDE', 'FGHIJ']);
  assert.equal(maximumActive, 1);
  assert.equal(result.entities.size, 2);
});

test('ordinary adaptive extraction never overlaps a provider that ignores cancellation', async () => {
  let release;
  const calls = [];
  const extractor = makeExtractor(async prompt => {
    const text = /## 输入文本\s*"""\s*([\s\S]*?)\s*"""/u.exec(prompt)?.[1];
    calls.push(text);
    return new Promise(resolve => { release = () => resolve(extraction(text)); });
  });
  extractor.config.maxChunkTimeout = 5;
  try {
    await assert.rejects(extractor.extractEntitiesAndRelations(await extractor.chunkDocument('ABCDEFGHIJ', 'document')),
      error => error.code === 'ENTITY_EXTRACTION_PROVIDER_TIMEOUT');
    assert.deepEqual(calls, ['ABCDEFGHIJ']);
  } finally { release?.(); }
});

test('aborting during checkpoint lookup does not save an empty completed segment', async () => {
  let extractor;
  let modelCalls = 0;
  let saves = 0;
  const checkpoint = {
    async load() { extractor.abort(); return null; },
    async save() { saves++; },
  };
  extractor = makeExtractor(async () => { modelCalls++; return extraction('unexpected'); }, checkpoint);
  const chunks = await extractor.chunkDocument('abcdefghij', 'document');
  await assert.rejects(extractor.extractEntitiesAndRelations(chunks), /中止|aborted/i);
  assert.equal(modelCalls, 0);
  assert.equal(saves, 0);
});

test('aborting while a model response settles does not save a completed segment', async () => {
  let extractor;
  let saves = 0;
  const checkpoint = { async load() { return null; }, async save() { saves++; } };
  extractor = makeExtractor(async () => { extractor.abort(); return extraction('Alice'); }, checkpoint);
  const chunks = await extractor.chunkDocument('abcdefghij', 'document');
  await assert.rejects(extractor.extractEntitiesAndRelations(chunks), /中止|aborted/i);
  assert.equal(saves, 0);
});

test('restored checkpoint results still count against the output budget', async () => {
  let calls = 0;
  const extractor = makeExtractor(async () => { calls++; return extraction('unexpected'); }, {
    async load() { return { kind: 'complete', result: { entities: [{ name: 'Alice', type: 'PERSON', description: 'A'.repeat(80) }], relations: [] } }; },
    async save() { throw new Error('unexpected save'); },
  });
  extractor.config.maxProviderOutputCharacters = 64;
  await assert.rejects(extractor.extractEntitiesAndRelations(await extractor.chunkDocument('source', 'document')),
    error => error.code === 'ENTITY_EXTRACTION_OUTPUT_BUDGET_EXCEEDED');
  assert.equal(calls, 0);
});

test('an invalid complete response is retried as smaller segments without accepting partial data', async () => {
  const calls = [];
  const extractor = makeExtractor(async prompt => {
    const text = /## 输入文本\s*"""\s*([\s\S]*?)\s*"""/u.exec(prompt)?.[1];
    calls.push(text);
    if (text === 'ABCDEFGHIJ') return { content: '{"entities":[', response_metadata: { done_reason: 'stop' } };
    return extraction(text);
  });
  const result = await extractor.extractEntitiesAndRelations(await extractor.chunkDocument('ABCDEFGHIJ', 'document'));
  assert.deepEqual(calls, ['ABCDEFGHIJ', 'ABCDE', 'FGHIJ']);
  assert.equal(result.entities.size, 2);
});

test('complete extraction rejects relations whose endpoints are absent from its entities', async () => {
  const extractor = makeExtractor(async () => ({ content: JSON.stringify({
    entities: [{ name: 'Alice', type: 'PERSON', description: '' }],
    relations: [{ source: 'Alice', target: 'Missing', type: 'knows', description: '' }],
  }), response_metadata: { done_reason: 'stop' } }));
  const chunks = await extractor.chunkDocument('ab', 'document');
  await assert.rejects(extractor.extractEntitiesAndRelations(chunks), /无法解析|完整/);
});

test('a minimum leaf gets one budgeted complete re-extraction for dangling relation endpoints', async () => {
  const prompts = [];
  const saves = [];
  const extractor = makeExtractor(async prompt => {
    prompts.push(prompt);
    return { content: JSON.stringify({
      entities: [ { name: 'Alice', type: 'PERSON', description: '' },
        ...(prompts.length === 2 ? [{ name: 'Bob', type: 'PERSON', description: '' }] : []) ],
      relations: [{ source: 'Alice', target: 'Bob', type: 'knows', description: '' }],
    }), response_metadata: { done_reason: 'stop' } };
  }, { async load() { return null; }, async save(_segment, value) { saves.push(value); } });
  const result = await extractor.extractEntitiesAndRelations(await extractor.chunkDocument('ab', 'document'));
  assert.equal(prompts.length, 2);
  assert(prompts[1].startsWith(prompts[0]), 'the full source is retained in the consistency re-extraction');
  assert.match(prompts[1], /逐字匹配/);
  assert.equal(result.entities.size, 2);
  assert.equal(result.relations.size, 1);
  assert.deepEqual([...result.relations.values()][0].sourceChunks, ['document_chunk_0']);
  assert.deepEqual(saves.map(value => value.kind), ['complete']);
});

test('minimum-leaf consistency re-extraction never loops or bypasses provider budgets', async () => {
  for (const budget of [1, 10]) {
    let calls = 0;
    const extractor = makeExtractor(async () => {
      calls++;
      return { content: '{}', response_metadata: { done_reason: 'stop' } };
    });
    extractor.config.maxProviderCalls = budget;
    await assert.rejects(extractor.extractEntitiesAndRelations(await extractor.chunkDocument('ab', 'document')),
      error => error.code === (budget === 1 ? 'ENTITY_EXTRACTION_PROVIDER_BUDGET_EXCEEDED' : 'ENTITY_EXTRACTION_INVALID_OUTPUT'));
    assert.equal(calls, budget === 1 ? 1 : 2);
  }
});

test('adaptive segments overlap and do not split UTF-16 surrogate pairs', async () => {
  const source = `${'a'.repeat(31)}😀${'b'.repeat(31)}`;
  const requests = [];
  const extractor = makeExtractor(async prompt => {
    const text = /## 输入文本\s*"""\s*([\s\S]*?)\s*"""/u.exec(prompt)?.[1];
    requests.push(text);
    return requests.length === 1
      ? { content: '{', response_metadata: { done_reason: 'length' } }
      : extraction(`entity-${requests.length}`);
  });
  extractor.config.chunkSize = source.length;
  await extractor.extractEntitiesAndRelations(await extractor.chunkDocument(source, 'document'));
  assert.equal(requests.length, 3);
  assert.equal(requests[1].isWellFormed(), true);
  assert.equal(requests[2].isWellFormed(), true);
  assert.ok(requests[1].length + requests[2].length > source.length);
  assert.equal(source.startsWith(requests[1]), true);
  assert.equal(source.endsWith(requests[2]), true);
});

test('truncation at the minimum segment size fails instead of saving partial output', async () => {
  const saved = [];
  const extractor = makeExtractor(async () => ({
    content: '{"entities":[]}', response_metadata: { done_reason: 'length' },
  }), { async load() { return null; }, async save(segment, value) { saved.push(value); } });
  const chunks = await extractor.chunkDocument('ab', 'document');
  await assert.rejects(extractor.extractEntitiesAndRelations(chunks), /截断|truncat/i);
  assert.deepEqual(saved, []);
});

test('adaptive splitting cannot bypass the cumulative provider-call budget', async () => {
  const calls = [];
  const extractor = makeExtractor(async prompt => {
    const text = /## 输入文本\s*"""\s*([\s\S]*?)\s*"""/u.exec(prompt)?.[1];
    calls.push(text);
    return text === 'ABCDEFGHIJ'
      ? { content: '{', response_metadata: { done_reason: 'length' } }
      : extraction(text);
  });
  extractor.config.maxProviderCalls = 2;
  await assert.rejects(
    extractor.extractEntitiesAndRelations(await extractor.chunkDocument('ABCDEFGHIJ', 'document')),
    error => error.code === 'ENTITY_EXTRACTION_PROVIDER_BUDGET_EXCEEDED'
  );
  assert.deepEqual(calls, ['ABCDEFGHIJ', 'ABCDE']);
});

test('the extraction prompt contains a valid JSON example without truncating source text', async () => {
  let observedPrompt;
  const extractor = makeExtractor(async prompt => { observedPrompt = prompt; return extraction('Alice'); });
  const chunks = await extractor.chunkDocument('source', 'document');
  await extractor.extractEntitiesAndRelations(chunks);
  const example = observedPrompt.split('## 输出格式')[1].slice(observedPrompt.split('## 输出格式')[1].indexOf('{'));
  assert.doesNotThrow(() => JSON.parse(example));
  assert.match(observedPrompt, /source/);
});

test('structured extraction uses its own model binding instead of changing other model stages', async () => {
  let generalCalls = 0;
  let extractionCalls = 0;
  const extractor = new EntityExtractor({
    chunkSize: 10, chunkOverlap: 0, enableGleaning: false,
    requireCompleteExtraction: true, llmModel: 'test-model',
    maxChunkTimeout: 5_000, baseChunkTime: 5_000, timeoutPerChar: 0,
  }, {
    llmInstance: { async invoke() { generalCalls++; return extraction('General'); } },
    extractionLlmInstance: { async invoke() { extractionCalls++; return extraction('Extracted'); } },
    embeddingInstance: { async embedDocuments() { return []; }, async embedQuery() { return []; } },
    providerKey: `structured-stage-${Math.random()}`,
  });
  extractor.startTime = Date.now();
  extractor.estimatedTimeout = 60_000;
  const result = await extractor.extractEntitiesAndRelations(await extractor.chunkDocument('source', 'document'));
  assert.equal(extractionCalls, 1);
  assert.equal(generalCalls, 0);
  assert.equal([...result.entities.values()][0].name, 'Extracted');
});

test('entity resolution batches embedding requests without dropping any entities', async () => {
  const batches = [];
  const extractor = new EntityExtractor({
    embeddingBatchSize: 2, llmModel: 'test-model', similarityThreshold: 2,
  }, {
    llmInstance: { async invoke() { throw new Error('unexpected merge request'); } },
    embeddingInstance: {
      async embedDocuments(documents) { batches.push(documents); return documents.map(() => [1, 0]); },
      async embedQuery() { return [1, 0]; },
    },
    providerKey: `embedding-batches-${Math.random()}`,
  });
  extractor.startTime = Date.now();
  extractor.estimatedTimeout = 60_000;
  const entities = new Map(Array.from({ length: 5 }, (_, i) => [`e${i}`, {
    id: `e${i}`, name: `Person ${i}`, type: 'PERSON', description: '', aliases: [], mentions: 1, sourceChunks: ['chunk'],
  }]));
  await extractor.resolveEntities(entities, new Map());
  assert.deepEqual(batches.map(batch => batch.length), [2, 2, 1]);
  assert.equal(entities.size, 5);
  assert.equal([...entities.values()].every(entity => Array.isArray(entity.embedding)), true);
});
