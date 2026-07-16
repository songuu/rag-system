import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  EntityExtractor,
  EntityExtractionOutputBudgetError,
  EntityExtractionProviderBudgetError,
  EntityExtractionProviderBusyError,
  EntityExtractionProviderTimeoutError,
  calculateEntityExtractionPromptCharacters,
} = await import('./entity-extraction.ts');

test('chunkDocument emits only bounded verbatim source slices with exact overlap', async () => {
  const source = `  heading\n\n${'x'.repeat(27)}\n tail  `;
  const extractor = createExtractor({
    async invoke() {
      throw new Error('chunking must not call provider');
    },
  }, `chunk-integrity:${Date.now()}`, 1_000, {
    chunkSize: 10,
    chunkOverlap: 3,
  });

  const chunks = await extractor.chunkDocument(source, 'source-doc');
  assert.equal(chunks.length, 7);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.content.length <= 10, true);
    assert.equal(source.slice(chunk.startChar, chunk.endChar), chunk.content);
    assert.equal(chunk.index, index);
    assert.equal(chunk.id, `source-doc_chunk_${index}`);

    const previous = chunks[index - 1];
    const next = chunks[index + 1];
    assert.equal(
      chunk.overlap.previous,
      previous
        ? source.slice(
          Math.max(previous.startChar, chunk.startChar),
          Math.min(previous.endChar, chunk.endChar)
        )
        : null
    );
    assert.equal(
      chunk.overlap.next,
      next
        ? source.slice(
          Math.max(chunk.startChar, next.startChar),
          Math.min(chunk.endChar, next.endChar)
        )
        : null
    );
  }
});

test('2M unbroken source is forced into bounded provider windows', async () => {
  const source = 'x'.repeat(2_000_000);
  const extractor = createExtractor({
    async invoke() {
      throw new Error('chunking must not call provider');
    },
  }, `chunk-2m-integrity:${Date.now()}`, 1_000, {
    chunkSize: 4_000,
    chunkOverlap: 300,
  });

  const chunks = await extractor.chunkDocument(source, 'source-2m');
  assert.equal(chunks.length, 541);
  assert.equal(chunks.every(chunk => chunk.content.length <= 4_000), true);
  assert.equal(
    chunks.every(chunk =>
      source.slice(chunk.startChar, chunk.endChar) === chunk.content
    ),
    true
  );
  assert.equal(chunks[0].overlap.next.length, 300);
  assert.equal(chunks.at(-1).overlap.previous.length, 300);
});

test('entity extraction enforces provider call budget before the next invocation', async () => {
  let providerCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      providerCalls += 1;
      return emptyExtractionResponse();
    },
  }, `provider-budget:${Date.now()}`, 1_000, {
    chunkSize: 10,
    chunkOverlap: 0,
    maxProviderCalls: 1,
    maxProviderInputCharacters: 100_000,
  });

  await assert.rejects(
    () => extractor.extract('x'.repeat(11), 'provider-budget-document'),
    EntityExtractionProviderBudgetError
  );
  assert.equal(providerCalls, 1);
});

test('entity extraction rejects cumulative prompt input before provider invocation', async () => {
  let providerCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      providerCalls += 1;
      return emptyExtractionResponse();
    },
  }, `provider-input-budget:${Date.now()}`, 1_000, {
    chunkSize: 10,
    chunkOverlap: 0,
    maxProviderCalls: 10,
    maxProviderInputCharacters: 1,
  });

  await assert.rejects(
    () => extractor.extract('source', 'provider-input-budget-document'),
    EntityExtractionProviderBudgetError
  );
  assert.equal(providerCalls, 0);
});

test('entity extraction rejects raw provider output before JSON parsing', async () => {
  let embeddingCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      return { content: 'x'.repeat(65) };
    },
  }, `provider-output-budget:${Date.now()}`, 1_000, {
    maxProviderOutputCharacters: 64,
  }, {
    async embedDocuments() {
      embeddingCalls += 1;
      return [];
    },
    async embedQuery() {
      embeddingCalls += 1;
      return [];
    },
  });

  await assert.rejects(
    () => extractor.extract('source', 'provider-output-budget-document'),
    EntityExtractionOutputBudgetError
  );
  assert.equal(embeddingCalls, 0);
});

test('invalid raw entity observations still consume the output budget', async () => {
  let embeddingCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      return {
        content: JSON.stringify({
          entities: [null, null, null],
          relations: [],
        }),
      };
    },
  }, `raw-observation-budget:${Date.now()}`, 1_000, {
    maxExtractedEntities: 2,
  }, {
    async embedDocuments() {
      embeddingCalls += 1;
      return [];
    },
    async embedQuery() {
      embeddingCalls += 1;
      return [];
    },
  });

  await assert.rejects(
    () => extractor.extract('source', 'raw-observation-budget-document'),
    EntityExtractionOutputBudgetError
  );
  assert.equal(embeddingCalls, 0);
});

test('raw relation observations are budgeted cumulatively across chunks', async () => {
  let providerCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      providerCalls += 1;
      return {
        content: JSON.stringify({
          entities: [],
          relations: [null],
        }),
      };
    },
  }, `cumulative-relation-budget:${Date.now()}`, 1_000, {
    chunkSize: 1,
    chunkOverlap: 0,
    maxExtractedRelations: 2,
  });

  await assert.rejects(
    () => extractor.extract('abc', 'cumulative-relation-budget-document'),
    EntityExtractionOutputBudgetError
  );
  assert.equal(providerCalls, 3);
});

test('gleaning shares the raw observation budget with primary extraction', async () => {
  let providerCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      providerCalls += 1;
      return providerCalls === 1
        ? oneEntityExtractionResponse()
        : {
          content: JSON.stringify({
            entities: [null, null],
            relations: [],
          }),
        };
    },
  }, `gleaning-output-budget:${Date.now()}`, 1_000, {
    enableGleaning: true,
    gleaningRounds: 1,
    maxExtractedEntities: 2,
  });

  await assert.rejects(
    () => extractor.extract('source', 'gleaning-output-budget-document'),
    EntityExtractionOutputBudgetError
  );
  assert.equal(providerCalls, 2);
});

test('entity extraction rejects overlong structured-output fields', async () => {
  let embeddingCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      return {
        content: JSON.stringify({
          entities: [{
            name: 'x'.repeat(513),
            type: 'PERSON',
            description: 'bounded',
          }],
          relations: [],
        }),
      };
    },
  }, `field-output-budget:${Date.now()}`, 1_000, {}, {
    async embedDocuments() {
      embeddingCalls += 1;
      return [];
    },
    async embedQuery() {
      embeddingCalls += 1;
      return [];
    },
  });

  await assert.rejects(
    () => extractor.extract('source', 'field-output-budget-document'),
    EntityExtractionOutputBudgetError
  );
  assert.equal(embeddingCalls, 0);
});

test('aggregation lookup budget fails before entity resolution embedding', async () => {
  let embeddingCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      return {
        content: JSON.stringify({
          entities: [
            { name: 'Alice', type: 'PERSON', description: '' },
            { name: 'Bob', type: 'PERSON', description: '' },
            { name: 'Carol', type: 'PERSON', description: '' },
          ],
          relations: [{
            source: 'Alice',
            target: 'Bob',
            type: 'KNOWS',
            description: '',
          }],
        }),
      };
    },
  }, `aggregation-lookup-budget:${Date.now()}`, 1_000, {
    maxAggregationLookupComparisons: 8,
  }, {
    async embedDocuments() {
      embeddingCalls += 1;
      return [];
    },
    async embedQuery() {
      embeddingCalls += 1;
      return [];
    },
  });

  await assert.rejects(
    () => extractor.extract('source', 'aggregation-lookup-budget-document'),
    EntityExtractionOutputBudgetError
  );
  assert.equal(embeddingCalls, 0);
});

test('entity resolution rejects pair count before embedding invocation', async () => {
  let embeddingCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      throw new Error('resolution budget must fail before LLM invocation');
    },
  }, `resolution-pair-budget:${Date.now()}`, 1_000, {
    maxEntityResolutionComparisons: 2,
  }, {
    async embedDocuments() {
      embeddingCalls += 1;
      return [];
    },
    async embedQuery() {
      embeddingCalls += 1;
      return [];
    },
  });

  await assert.rejects(
    () => extractor.resolveEntities(createEntityMap(3), new Map()),
    EntityExtractionOutputBudgetError
  );
  assert.equal(embeddingCalls, 0);
});

test('entity resolution validates embedding shape and vector-operation budget', async () => {
  const cases = [
    {
      name: 'count mismatch',
      embeddings: [[1]],
      config: {},
    },
    {
      name: 'dimension limit',
      embeddings: [[1, 0], [0, 1]],
      config: { maxEmbeddingDimensions: 1 },
    },
    {
      name: 'non-finite value',
      embeddings: [[1], [Number.POSITIVE_INFINITY]],
      config: {},
    },
    {
      name: 'vector operation limit',
      embeddings: [[1, 0], [0, 1]],
      config: { maxEntityResolutionVectorOperations: 1 },
    },
  ];

  for (const testCase of cases) {
    const extractor = createExtractor({
      async invoke() {
        throw new Error('invalid embeddings must not reach LLM resolution');
      },
    }, `embedding-shape-budget:${testCase.name}:${Date.now()}`, 1_000, {
      maxEntityResolutionComparisons: 10,
      ...testCase.config,
    }, {
      async embedDocuments() {
        return testCase.embeddings;
      },
      async embedQuery() {
        return [];
      },
    });
    initializeResolutionClock(extractor);

    await assert.rejects(
      () => extractor.resolveEntities(createEntityMap(2), new Map()),
      EntityExtractionOutputBudgetError,
      testCase.name
    );
  }
});

test('bounded entity resolution yields to the event loop after 1024 pairs', async () => {
  const entityCount = 46;
  const extractor = createExtractor({
    async invoke() {
      throw new Error('orthogonal vectors must not require LLM resolution');
    },
  }, `resolution-yield:${Date.now()}`, 1_000, {
    maxEntityResolutionComparisons: 2_000,
    maxEntityResolutionVectorOperations: 100_000,
    similarityThreshold: 2,
  }, {
    async embedDocuments(documents) {
      return documents.map((_, index) =>
        Array.from({ length: entityCount }, (__, dimension) =>
          dimension === index ? 1 : 0
        )
      );
    },
    async embedQuery() {
      return [];
    },
  });
  initializeResolutionClock(extractor);
  let eventLoopTurnObserved = false;
  setImmediate(() => {
    eventLoopTurnObserved = true;
  });

  await extractor.resolveEntities(createEntityMap(entityCount), new Map());
  assert.equal(eventLoopTurnObserved, true);
});

test('community embedding output is bounded before artifact retention', async () => {
  let llmCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      llmCalls += 1;
      return llmCalls === 1
        ? oneEntityExtractionResponse()
        : {
          content: JSON.stringify({
            name: 'community',
            summary: 'bounded summary',
            keywords: ['bounded'],
          }),
        };
    },
  }, `community-output-budget:${Date.now()}`, 1_000, {
    maxEmbeddingDimensions: 2,
  }, {
    async embedDocuments(documents) {
      return documents.map(() => [1]);
    },
    async embedQuery() {
      return [1, 2, 3];
    },
  });

  await assert.rejects(
    () => extractor.extract('one entity', 'community-output-budget-document'),
    EntityExtractionOutputBudgetError
  );
});

test('provider input accounting treats replacement metacharacters as literal source', async () => {
  const source = ['$&', '$`', "$'"].join('|');
  let providerCalls = 0;
  let observedPrompt;
  const extractor = createExtractor({
    async invoke(prompt) {
      providerCalls += 1;
      observedPrompt = prompt;
      return emptyExtractionResponse();
    },
  }, `provider-literal-budget:${Date.now()}`, 1_000, {
    chunkSize: 100,
    chunkOverlap: 0,
    maxProviderCalls: 1,
    maxProviderInputCharacters:
      calculateEntityExtractionPromptCharacters(source.length),
  });

  await extractor.extract(source, 'provider-literal-budget-document');
  assert.equal(providerCalls, 1);
  assert.equal(observedPrompt.length, calculateEntityExtractionPromptCharacters(source.length));
  assert.equal(observedPrompt.includes(source), true);
});

test('embedding calls share the extraction provider budget before invocation', async () => {
  let llmCalls = 0;
  let embeddingCalls = 0;
  const extractor = createExtractor({
    async invoke() {
      llmCalls += 1;
      return oneEntityExtractionResponse();
    },
  }, `embedding-budget:${Date.now()}`, 1_000, {
    maxProviderCalls: 1,
    maxProviderInputCharacters: 100_000,
  }, {
    async embedDocuments(documents) {
      embeddingCalls += 1;
      return documents.map(() => [1]);
    },
    async embedQuery() {
      embeddingCalls += 1;
      return [1];
    },
  });

  await assert.rejects(
    () => extractor.extract('one entity', 'embedding-budget-document'),
    EntityExtractionProviderBudgetError
  );
  assert.equal(llmCalls, 1);
  assert.equal(embeddingCalls, 0);
});

test('noncooperative community embedding keeps provider admission until settlement', async t => {
  const providerKey = `community-embedding-orphan:${Date.now()}:${Math.random()}`;
  const embeddingProviderKey = `${providerKey}:shared-embedding`;
  let providerCalls = 0;
  let embeddingCalls = 0;
  let releaseEmbedding;
  t.after(() => releaseEmbedding?.());

  const extractor = createExtractor({
    async invoke() {
      providerCalls += 1;
      return providerCalls === 1
        ? oneEntityExtractionResponse()
        : {
          content: JSON.stringify({
            name: 'community',
            summary: 'bounded community summary',
            keywords: ['bounded'],
          }),
        };
    },
  }, providerKey, 5, {}, {
    async embedDocuments(documents) {
      return documents.map(() => [1]);
    },
    embedQuery() {
      embeddingCalls += 1;
      return new Promise(resolve => {
        releaseEmbedding = () => resolve([1]);
      });
    },
  }, embeddingProviderKey);

  await assert.rejects(
    () => extractor.extract('one entity', 'community-embedding-document'),
    EntityExtractionProviderTimeoutError
  );
  assert.equal(providerCalls, 2);
  assert.equal(embeddingCalls, 1);

  let contenderCalls = 0;
  let contenderEmbeddingCalls = 0;
  const contender = createExtractor({
    async invoke() {
      contenderCalls += 1;
      return oneEntityExtractionResponse();
    },
  }, `${providerKey}:rotated-llm`, 1_000, {}, {
    async embedDocuments(documents) {
      contenderEmbeddingCalls += 1;
      return documents.map(() => [1]);
    },
    async embedQuery() {
      contenderEmbeddingCalls += 1;
      return [1];
    },
  }, embeddingProviderKey);
  await assert.rejects(
    () => contender.extract('blocked contender', 'blocked-community-embedding'),
    EntityExtractionProviderBusyError
  );
  assert.equal(contenderCalls, 1);
  assert.equal(contenderEmbeddingCalls, 0);

  releaseEmbedding();
  await new Promise(resolve => setImmediate(resolve));
  let recoveryProviderCalls = 0;
  let recoveryEmbeddingCalls = 0;
  const recoveredExtractor = createExtractor({
    async invoke() {
      recoveryProviderCalls += 1;
      return recoveryProviderCalls === 1
        ? oneEntityExtractionResponse()
        : {
          content: JSON.stringify({
            name: 'recovered community',
            summary: 'recovered summary',
            keywords: ['recovered'],
          }),
        };
    },
  }, `${providerKey}:recovered-llm`, 1_000, {}, {
    async embedDocuments(documents) {
      recoveryEmbeddingCalls += 1;
      return documents.map(() => [1]);
    },
    async embedQuery() {
      recoveryEmbeddingCalls += 1;
      return [1];
    },
  }, embeddingProviderKey);
  const recovered = await recoveredExtractor.extract(
    'recovered contender',
    'recovered-community-embedding'
  );
  assert.equal(recoveryProviderCalls, 2);
  assert.equal(recoveryEmbeddingCalls, 2);
  assert.equal(recovered.metadata.entityCount, 1);
});

test('entity extraction keeps timed-out provider work reserved until real settlement', async t => {
  const privatePassage = 'confidential-passage-entity-timeout';
  const privateDocumentId = 'private-document-entity-timeout';
  const providerKey = `test-provider:${Date.now()}:${Math.random()}`;
  const originalConsoleError = console.error;
  const logs = [];
  let firstCalls = 0;
  let firstSignal;
  let releaseFirst;
  const firstProvider = {
    invoke(_prompt, options) {
      firstCalls += 1;
      firstSignal = options?.signal;
      return new Promise(resolve => {
        releaseFirst = () => resolve(emptyExtractionResponse());
      });
    },
  };
  console.error = (...values) => logs.push(values);
  t.after(() => {
    console.error = originalConsoleError;
    releaseFirst?.();
  });

  const first = createExtractor(firstProvider, providerKey);
  await assert.rejects(
    () => first.extract(privatePassage, privateDocumentId),
    error => error instanceof EntityExtractionProviderTimeoutError
  );
  assert.equal(firstCalls, 1);
  assert.equal(firstSignal?.aborted, true);

  let contenderCalls = 0;
  const contender = createExtractor({
    async invoke() {
      contenderCalls += 1;
      return emptyExtractionResponse();
    },
  }, providerKey);
  await assert.rejects(
    () => contender.extract('safe contender', 'safe-contender'),
    error => error instanceof EntityExtractionProviderBusyError
  );
  assert.equal(contenderCalls, 0);

  releaseFirst();
  await new Promise(resolve => setImmediate(resolve));

  let recoveryCalls = 0;
  const recovered = createExtractor({
    async invoke() {
      recoveryCalls += 1;
      return emptyExtractionResponse();
    },
  }, providerKey, 1_000);
  const graph = await recovered.extract('safe recovery', 'safe-recovery');
  assert.equal(recoveryCalls, 1);
  assert.equal(graph.metadata.entityCount, 0);

  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, new RegExp(privatePassage));
  assert.doesNotMatch(serializedLogs, new RegExp(privateDocumentId));
  assert.match(serializedLogs, /ENTITY_EXTRACTION_PROVIDER_TIMEOUT/);
  assert.match(serializedLogs, /ENTITY_EXTRACTION_PROVIDER_BUSY/);
});

test('entity extraction releases a provider only after every concurrent orphan settles', async t => {
  const providerKey = `test-provider-multi:${Date.now()}:${Math.random()}`;
  const releases = [];
  const stalledProvider = {
    invoke() {
      return new Promise(resolve => {
        releases.push(() => resolve(emptyExtractionResponse()));
      });
    },
  };
  t.after(() => {
    for (const release of releases) release();
  });

  const first = createExtractor(stalledProvider, providerKey);
  const second = createExtractor(stalledProvider, providerKey);
  const outcomes = await Promise.allSettled([
    first.extract('first concurrent orphan', 'first-document'),
    second.extract('second concurrent orphan', 'second-document'),
  ]);
  assert.equal(releases.length, 2);
  assert.equal(
    outcomes.every(outcome =>
      outcome.status === 'rejected'
      && outcome.reason instanceof EntityExtractionProviderTimeoutError
    ),
    true
  );

  let contenderCalls = 0;
  const contender = createExtractor({
    async invoke() {
      contenderCalls += 1;
      return emptyExtractionResponse();
    },
  }, providerKey, 1_000);
  await assert.rejects(
    () => contender.extract('blocked while two remain', 'blocked-one'),
    EntityExtractionProviderBusyError
  );
  assert.equal(contenderCalls, 0);

  releases[0]();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    () => contender.extract('blocked while one remains', 'blocked-two'),
    EntityExtractionProviderBusyError
  );
  assert.equal(contenderCalls, 0);

  releases[1]();
  await new Promise(resolve => setImmediate(resolve));
  const graph = await contender.extract('released after all settle', 'released-document');
  assert.equal(contenderCalls, 1);
  assert.equal(graph.metadata.entityCount, 0);
});

function createExtractor(
  llmInstance,
  providerKey,
  maxChunkTimeout = 5,
  config = {},
  embeddingInstance = {
    async embedQuery() {
      return [];
    },
    async embedDocuments(documents) {
      return documents.map(() => []);
    },
  },
  embeddingProviderKey = `${providerKey}:embedding`
) {
  return new EntityExtractor({
    chunkSize: 4_000,
    chunkOverlap: 0,
    enableGleaning: false,
    maxChunkTimeout,
    baseChunkTime: 1,
    timeoutPerChar: 0,
    llmModel: 'test-model',
    ...config,
  }, {
    llmInstance,
    embeddingInstance,
    providerKey,
    embeddingProviderKey,
  });
}

function emptyExtractionResponse() {
  return { content: '{"entities":[],"relations":[]}' };
}

function oneEntityExtractionResponse() {
  return {
    content: JSON.stringify({
      entities: [{
        name: 'Alice',
        type: 'PERSON',
        description: 'A bounded entity.',
      }],
      relations: [],
    }),
  };
}

function createEntityMap(count) {
  return new Map(Array.from({ length: count }, (_, index) => {
    const id = `entity-${String(index).padStart(3, '0')}`;
    return [id, {
      id,
      name: `entity-name-${String(index).padStart(3, '0')}`,
      type: 'PERSON',
      description: `description-${index}`,
      aliases: [],
      mentions: 1,
      sourceChunks: ['chunk-1'],
    }];
  }));
}

function initializeResolutionClock(extractor) {
  extractor.startTime = Date.now();
  extractor.estimatedTimeout = 10_000;
  extractor.aborted = false;
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
