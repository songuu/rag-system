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
  EntityExtractionProviderBusyError,
  EntityExtractionProviderTimeoutError,
} = await import('./entity-extraction.ts');

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

function createExtractor(llmInstance, providerKey, maxChunkTimeout = 5) {
  return new EntityExtractor({
    chunkSize: 4_000,
    chunkOverlap: 0,
    enableGleaning: false,
    maxChunkTimeout,
    baseChunkTime: 1,
    timeoutPerChar: 0,
    llmModel: 'test-model',
  }, {
    llmInstance,
    embeddingInstance: {
      async embedQuery() {
        return [];
      },
      async embedDocuments(documents) {
        return documents.map(() => []);
      },
    },
    providerKey,
  });
}

function emptyExtractionResponse() {
  return { content: '{"entities":[],"relations":[]}' };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
