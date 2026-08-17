import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

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
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    const source = readFileSync(new URL(url), 'utf8');
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    };
  },
});

const { loadInitialRagDocuments } = await import('./rag-system.ts');

test('postgres RAG initialization reads text documents through BlobStore', async () => {
  const reads = [];
  const documents = await loadInitialRagDocuments('/unused-local-path', {
    resolvePersistenceBackend: () => 'postgres',
    createPersistence: () => ({
      blobStore: createBlobStore({
        files: ['manual.pdf', 'guide.txt', 'empty.txt', 'pipeline-abc.parsed'],
        texts: {
          'guide.txt': 'PostgreSQL is the document source of truth.',
          'empty.txt': '   ',
          'pipeline-abc.parsed': 'Pipeline parsed text also comes from PostgreSQL.',
        },
        reads,
      }),
    }),
  });

  assert.deepEqual(reads, ['guide.txt', 'empty.txt', 'pipeline-abc.parsed']);
  assert.deepEqual(
    documents.map((document) => ({
      content: document.pageContent,
      source: document.metadata.source,
    })),
    [{
      content: 'PostgreSQL is the document source of truth.',
      source: 'guide.txt',
    }, {
      content: 'Pipeline parsed text also comes from PostgreSQL.',
      source: 'pipeline-abc.parsed',
    }]
  );
});

test('empty postgres persistence stays empty instead of injecting example documents', async () => {
  const documents = await loadInitialRagDocuments('/unused-local-path', {
    resolvePersistenceBackend: () => 'postgres',
    createPersistence: () => ({
      blobStore: createBlobStore({ files: [] }),
    }),
  });

  assert.deepEqual(documents, []);
});

test('postgres list and read failures fail closed with persistence context', async (t) => {
  await t.test('list failure', async () => {
    const failure = new Error('database unavailable');
    await assert.rejects(
      loadInitialRagDocuments('/unused-local-path', {
        resolvePersistenceBackend: () => 'postgres',
        createPersistence: () => ({
          blobStore: createBlobStore({ listError: failure }),
        }),
      }),
      (error) => {
        assert.match(error.message, /load RAG documents from PostgreSQL persistence/i);
        assert.equal(error.cause, failure);
        return true;
      }
    );
  });

  await t.test('read failure', async () => {
    const failure = new Error('blob query failed');
    await assert.rejects(
      loadInitialRagDocuments('/unused-local-path', {
        resolvePersistenceBackend: () => 'postgres',
        createPersistence: () => ({
          blobStore: createBlobStore({ files: ['broken.txt'], readError: failure }),
        }),
      }),
      (error) => {
        assert.match(error.message, /load RAG documents from PostgreSQL persistence/i);
        assert.equal(error.cause, failure);
        return true;
      }
    );
  });
});

test('empty local development persistence keeps the existing example fallback', async () => {
  const documents = await loadInitialRagDocuments('/unused-local-path', {
    resolvePersistenceBackend: () => 'local',
    createPersistence: () => ({
      blobStore: createBlobStore({ files: [] }),
    }),
  });

  assert.deepEqual(
    documents.map((document) => document.metadata.source),
    [
      'ai-intro.txt',
      'ml-intro.txt',
      'dl-intro.txt',
      'smartphone-intro.txt',
      'apple-intro.txt',
    ]
  );
});

function createBlobStore({
  files = [],
  texts = {},
  reads = [],
  listError,
  readError,
}) {
  return {
    async list() {
      if (listError) throw listError;
      return files;
    },
    async readText(filename) {
      reads.push(filename);
      if (readError) throw readError;
      return texts[filename] ?? '';
    },
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
