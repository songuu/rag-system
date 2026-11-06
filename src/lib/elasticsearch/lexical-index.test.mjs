import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { createRetrievalScope } = await import('../security/retrieval-scope.ts');
const {
  bulkIndexElasticsearchDocuments,
  buildElasticsearchLexicalMapping,
  searchElasticsearchLexical,
} = await import('./lexical-index.ts');

const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['reviewed'],
  enforceIsolation: true,
});

test('lexical mapping indexes Chinese text but never vectors or generated context', () => {
  const mapping = buildElasticsearchLexicalMapping();
  assert.equal(mapping.mappings.properties.content.analyzer, 'cjk');
  assert.equal(mapping.mappings.properties.tenant_id.type, 'keyword');
  assert.equal(mapping.mappings.properties.metadata.enabled, false);
  assert.equal('embedding' in mapping.mappings.properties, false);
  assert.equal('contextual_preamble' in mapping.mappings.properties, false);
});

test('bulk indexing preserves normal multiline source text', async () => {
  const calls = [];
  const content = '第一段\n\n第二段\t带制表符';
  const indexed = await bulkIndexElasticsearchDocuments({
    client: {
      async bulk(input) {
        calls.push(input);
        return { errors: false };
      },
    },
    indexName: 'rag_chunks_v1',
    documents: [{
      chunk_id: 'chunk-1', tenant_id: 'tenant-a', corpus_id: 'corpus-a',
      document_id: 'doc-1', document_version: 'v1', trust_level: 'reviewed',
      content, metadata: {},
    }],
  });

  assert.equal(indexed, 1);
  assert.equal(calls[0].operations[1].content, content);
});

test('lexical search always sends tenant, corpus, and trust filters', async () => {
  const calls = [];
  const client = {
    async search(input) {
      calls.push(input);
      return {
        hits: {
          hits: [{
            _id: 'chunk-1',
            _score: 12,
            _source: {
              chunk_id: 'chunk-1', tenant_id: 'tenant-a', corpus_id: 'corpus-a',
              document_id: 'doc-1', document_version: 'v1', trust_level: 'reviewed',
              content: '错误代码 ERR-42', source: 'manual.pdf', start_offset: 0, end_offset: 12,
              metadata: { pageNumber: 1 },
            },
          }],
        },
      };
    },
  };

  const evidence = await searchElasticsearchLexical({
    client,
    indexName: 'rag_chunks_v1',
    query: 'ERR-42',
    topK: 5,
    laneId: 'dense-primary',
    scope,
  });
  const filters = calls[0].query.bool.filter;
  assert.deepEqual(filters, [
    { term: { tenant_id: 'tenant-a' } },
    { term: { corpus_id: 'corpus-a' } },
    { terms: { trust_level: ['reviewed'] } },
  ]);
  assert.equal(evidence[0].metadata.lexicalMatch, true);
  assert.equal(evidence[0].documentId, 'doc-1');
});

test('lexical search can narrow results to one server-validated document', async () => {
  const calls = [];
  const client = {
    async search(input) {
      calls.push(input);
      return { hits: { hits: [] } };
    },
  };
  await searchElasticsearchLexical({
    client,
    indexName: 'rag_chunks_v1',
    query: 'ERR-42',
    topK: 5,
    laneId: 'document-search',
    scope,
    documentId: 'doc-1',
  });
  assert.deepEqual(calls[0].query.bool.filter.at(-1), {
    term: { document_id: 'doc-1' },
  });
});

test('lexical search applies allowed file-type document ids before limiting candidates', async () => {
  const calls = [];
  const client = { async search(input) { calls.push(input); return { hits: { hits: [] } }; } };
  await searchElasticsearchLexical({ client, indexName: 'rag_chunks_v1', query: 'test', topK: 4,
    laneId: 'document-search', scope, documentIds: ['target'] });
  assert.equal(calls[0].size, 4);
  assert.deepEqual(calls[0].query.bool.filter.at(-1), { terms: { document_id: ['target'] } });
  await searchElasticsearchLexical({ client, indexName: 'rag_chunks_v1', query: 'test', topK: 4,
    laneId: 'document-search', scope, documentIds: [] });
  assert.equal(calls.length, 1);
});

test('lexical search rejects cross-scope or conflicting provenance hits', async () => {
  const client = {
    async search() {
      return {
        hits: { hits: [{
          _id: 'chunk-1', _score: 1,
          _source: {
            chunk_id: 'chunk-1', tenant_id: 'tenant-b', corpus_id: 'corpus-a',
            document_id: 'doc-1', document_version: 'v1', trust_level: 'reviewed',
            content: 'bad', source: 'bad.pdf', metadata: {},
          },
        }] },
      };
    },
  };
  await assert.rejects(
    searchElasticsearchLexical({
      client, indexName: 'rag_chunks_v1', query: 'bad', topK: 5,
      laneId: 'dense-primary', scope,
    }),
    error => error.code === 'ELASTICSEARCH_INTEGRITY_VIOLATION'
  );
});

test('lexical search returns verified UTF-16 highlight ranges without exposing markup', async () => {
  const start = '\uE000RAG_HIGHLIGHT_START\uE001';
  const end = '\uE000RAG_HIGHLIGHT_END\uE001';
  let request;
  const source = { chunk_id: 'chunk-1', tenant_id: 'tenant-a', corpus_id: 'corpus-a', document_id: 'doc-1', document_version: 'v1', trust_level: 'reviewed', content: '😀契丹<script>契丹', source: '契丹.pdf', metadata: {} };
  const client = { async search(input) { request = input; return { hits: { hits: [{ _id: 'chunk-1', _score: 1, _source: source, highlight: { content: [`😀${start}契丹${end}<script>${start}契丹${end}`], source: [`${start}契丹${end}.pdf`] } }] } }; } };
  const [item] = await searchElasticsearchLexical({ client, indexName: 'x', query: '契丹', topK: 1, laneId: 'document-search', scope, includeHighlights: true });
  assert.equal(request.highlight.fields.content.number_of_fragments, 0);
  assert.deepEqual(item.metadata.lexicalHighlights, { content: [{ start: 2, end: 4 }, { start: 12, end: 14 }], source: [{ start: 0, end: 2 }] });
});

test('source highlight offsets account for trimmed document titles', async () => {
  const start = '\uE000RAG_HIGHLIGHT_START\uE001';
  const end = '\uE000RAG_HIGHLIGHT_END\uE001';
  const source = { chunk_id: 'chunk-1', tenant_id: 'tenant-a', corpus_id: 'corpus-a', document_id: 'doc-1', document_version: 'v1', trust_level: 'reviewed', content: '内容', source: '  契丹.pdf  ', metadata: {} };
  const client = { async search() { return { hits: { hits: [{ _id: 'chunk-1', _score: 1, _source: source, highlight: { source: [`  ${start}契丹${end}.pdf  `] } }] } }; } };
  const [item] = await searchElasticsearchLexical({ client, indexName: 'x', query: '契丹', topK: 1, laneId: 'search', scope, includeHighlights: true });
  assert.equal(item.source, '契丹.pdf');
  assert.deepEqual(item.metadata.lexicalHighlights.source, [{ start: 0, end: 2 }]);
});
