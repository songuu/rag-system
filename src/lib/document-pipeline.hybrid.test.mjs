import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after } from 'node:test';

const milvusStubUrl = 'data:text/javascript,' + encodeURIComponent(`
let fixture = {
  hybridFailure: false,
  denseCompensationFailure: false,
  hybridCompensationFailure: false,
};
let signals = createSignals();
function createSignals() {
  return {
    instances: [],
    connect: 0,
    initialize: [],
    denseWrites: [],
    hybridWrites: [],
    denseDeletes: [],
    hybridDeletes: [],
    manifestInputs: [],
  };
}
export function setMilvusFixture(value = {}) {
  fixture = {
    hybridFailure: false,
    denseCompensationFailure: false,
    hybridCompensationFailure: false,
    ...structuredClone(value),
  };
  signals = createSignals();
}
export function getMilvusSignals() { return structuredClone(signals); }
export function createMilvusHybridRuntimeManifest(input) {
  signals.manifestInputs.push(structuredClone(input));
  return {
    version: 'milvus-hybrid-manifest/v1',
    collectionName: input.sourceCollectionName + '_hybrid_shadow',
    sourceCollectionName: input.sourceCollectionName,
    embeddingModel: input.embeddingModel,
    embeddingDimension: input.embeddingDimension,
  };
}
export function getMilvusInstance(config) {
  signals.instances.push(structuredClone(config));
  return {
    async connect() { signals.connect += 1; },
    async initializeCollection(autoRecreate) { signals.initialize.push(autoRecreate); },
    async insertDocuments(documents) {
      signals.denseWrites.push(structuredClone(documents));
      return documents.map(document => document.id);
    },
    async insertHybridDocuments(manifest, documents) {
      signals.hybridWrites.push({
        manifest: structuredClone(manifest),
        documents: structuredClone(documents),
      });
      if (fixture.hybridFailure) throw new Error('shadow collection unavailable');
    },
    async deleteScopedDocuments(ids, scope) {
      signals.denseDeletes.push({ ids: [...ids], scope: structuredClone(scope) });
      if (fixture.denseCompensationFailure) throw new Error('dense delete unavailable');
    },
    async deleteScopedHybridDocuments(manifest, ids, scope) {
      signals.hybridDeletes.push({
        manifest: structuredClone(manifest),
        ids: [...ids],
        scope: structuredClone(scope),
      });
      if (fixture.hybridCompensationFailure) throw new Error('hybrid delete unavailable');
    },
  };
}
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === './milvus-client' &&
      context.parentURL?.endsWith('/document-pipeline.ts')
    ) {
      return { url: milvusStubUrl, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND' &&
        (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const originalHybridMode = process.env.MILVUS_HYBRID_MODE;
const originalHybridEnabled = process.env.MILVUS_HYBRID_ENABLED;
const { storeToMilvus } = await import('./document-pipeline.ts');
const { getMilvusSignals, setMilvusFixture } = await import(milvusStubUrl);

after(() => {
  if (originalHybridMode === undefined) delete process.env.MILVUS_HYBRID_MODE;
  else process.env.MILVUS_HYBRID_MODE = originalHybridMode;
  if (originalHybridEnabled === undefined) delete process.env.MILVUS_HYBRID_ENABLED;
  else process.env.MILVUS_HYBRID_ENABLED = originalHybridEnabled;
});

test('Milvus hybrid off mode performs only the authoritative dense write', async () => {
  setHybridMode('off');
  setMilvusFixture();

  const ids = await storeToMilvus(fixtureDocuments(), fixtureConfig());
  const signals = getMilvusSignals();

  assert.deepEqual(ids, ['chunk-a']);
  assert.equal(signals.denseWrites.length, 1);
  assert.equal(signals.hybridWrites.length, 0);
  assert.equal(signals.manifestInputs.length, 0);
});

test('Milvus hybrid shadow mode keeps dense ingest successful when shadow write fails', async t => {
  t.mock.method(console, 'warn', () => {});
  setHybridMode('shadow');
  setMilvusFixture({ hybridFailure: true });

  const ids = await storeToMilvus(fixtureDocuments(), fixtureConfig());
  const signals = getMilvusSignals();

  assert.deepEqual(ids, ['chunk-a']);
  assert.equal(signals.denseWrites.length, 1);
  assert.equal(signals.hybridWrites.length, 1);
  assert.equal(signals.manifestInputs[0].sourceCollectionName, 'dense_main');
});

test('Milvus hybrid dual-write sends raw citation content and the server manifest', async () => {
  setHybridMode('active');
  setMilvusFixture();

  const ids = await storeToMilvus(fixtureDocuments(), fixtureConfig());
  const signals = getMilvusSignals();
  const hybridWrite = signals.hybridWrites[0];

  assert.deepEqual(ids, ['chunk-a']);
  assert.equal(signals.denseWrites.length, 1);
  assert.equal(signals.hybridWrites.length, 1);
  assert.equal(hybridWrite.manifest.collectionName, 'dense_main_hybrid_shadow');
  assert.equal(hybridWrite.documents[0].content, 'raw lexical evidence ERR-42');
  assert.equal(hybridWrite.documents[0].metadata.contextualIdentity, 'contextual-stable-a');
  assert.deepEqual(signals.manifestInputs[0], {
    sourceCollectionName: 'dense_main',
    embeddingModel: 'embedding-model-a',
    embeddingDimension: 3,
  });
});

test('Milvus hybrid active mode rolls back the exact scoped dual-write IDs on failure', async () => {
  setHybridMode('active');
  setMilvusFixture({ hybridFailure: true });

  await assert.rejects(
    () => storeToMilvus(fixtureDocuments(), fixtureConfig()),
    error => {
      assert.equal(error?.code, 'MILVUS_HYBRID_ACTIVE_WRITE_FAILED_ROLLED_BACK');
      assert.equal(error?.compensationStatus, 'rolled_back');
      assert.equal(error?.auditIdentity?.tenantId, 'tenant-a');
      assert.equal(error?.auditIdentity?.corpusId, 'corpus-a');
      assert.equal(error?.auditIdentity?.chunkCount, 1);
      assert.match(error?.auditIdentity?.reconciliationId, /^[a-f0-9]{64}$/);
      assert.equal(error.message.includes('shadow collection unavailable'), false);
      return true;
    }
  );
  const signals = getMilvusSignals();
  assert.equal(signals.denseWrites.length, 1);
  assert.equal(signals.hybridWrites.length, 1);
  assert.deepEqual(signals.denseDeletes[0].ids, ['chunk-a']);
  assert.deepEqual(signals.hybridDeletes[0].ids, ['chunk-a']);
  assert.equal(signals.denseDeletes[0].scope.tenantId, 'tenant-a');
  assert.equal(signals.denseDeletes[0].scope.corpusId, 'corpus-a');
  assert.equal(signals.denseDeletes[0].scope.enforceIsolation, true);
  assert.deepEqual(signals.denseDeletes[0].scope.allowedTrustLevels, ['external']);
});

test('Milvus hybrid compensation failure returns a stable reconciliation identity', async () => {
  setHybridMode('active');
  setMilvusFixture({
    hybridFailure: true,
    denseCompensationFailure: true,
  });

  await assert.rejects(
    () => storeToMilvus(fixtureDocuments(), fixtureConfig()),
    error => {
      assert.equal(error?.code, 'MILVUS_HYBRID_INGEST_RECONCILIATION_REQUIRED');
      assert.equal(error?.status, 503);
      assert.equal(error?.compensationStatus, 'reconciliation_required');
      assert.deepEqual(error?.failedCompensations, ['dense']);
      assert.equal(error?.auditIdentity?.tenantId, 'tenant-a');
      assert.equal(error?.auditIdentity?.corpusId, 'corpus-a');
      assert.match(error.message, /reconciliationId=[a-f0-9]{64}/);
      assert.match(error.message, /failedCompensations=dense/);
      assert.equal(error.message.includes('dense delete unavailable'), false);
      assert.equal(error.message.includes('shadow collection unavailable'), false);
      return true;
    }
  );
  const signals = getMilvusSignals();
  assert.deepEqual(signals.denseDeletes[0].ids, ['chunk-a']);
  assert.deepEqual(signals.hybridDeletes[0].ids, ['chunk-a']);
});

function setHybridMode(mode) {
  process.env.MILVUS_HYBRID_MODE = mode;
  delete process.env.MILVUS_HYBRID_ENABLED;
}

function fixtureConfig() {
  return {
    collectionName: 'dense_main',
    embeddingModel: 'embedding-model-a',
  };
}

function fixtureDocuments() {
  return [{
    id: 'chunk-a',
    content: 'raw lexical evidence ERR-42',
    embedding: [0.1, 0.2, 0.3],
    metadata: {
      tenant_id: 'tenant-a',
      corpus_id: 'corpus-a',
      document_id: 'document-a',
      document_version: 'sha256:document-a',
      trust_level: 'external',
      contextualIdentity: 'contextual-stable-a',
    },
  }];
}
