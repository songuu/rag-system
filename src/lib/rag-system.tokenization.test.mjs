import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const ragUrl = new URL('./rag-system.ts', import.meta.url).href;
const selfRagUrl = new URL('../app/api/self-rag/route.ts', import.meta.url).href;
const stub = source => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = {
  '@xenova/transformers': `export const AutoTokenizer = {
    async from_pretrained() {
      const fixture = globalThis.__ragTokenizationFixture;
      fixture.tokenizerLoads++;
      if (fixture.tokenizerOffline) throw new Error('tokenizer offline');
      return {
        encode: () => [101, 42, 102],
        batch_decode: () => ['[CLS]', '契丹', '[SEP]'],
        decode: () => '',
      };
    },
  };`,
  './model-config': `export function getModelFactory() {
    return { getEnvConfig: () => ({ OLLAMA_LLM_MODEL: 'fixture' }), getProvider: () => 'ollama' };
  }
  export function isCustomProvider() { return false; }
  export function isOllamaProvider() { return true; }
  export function createLLM() { return globalThis.__ragTokenizationFixture.llm; }
  export function createEmbedding() { return { async embedQuery(text) {
    const fixture = globalThis.__ragTokenizationFixture;
    fixture.embedded.push(text);
    if (fixture.embeddingError) throw fixture.embeddingError;
    return text.includes('契丹') ? [1, 0] : [0, 1];
  } }; }`,
  './embedding-config': `export function getEmbeddingProvider() { return 'ollama'; }
  export function getEmbeddingConfigSummary() { return { model: 'fixture-embedding' }; }`,
};
const routeMocks = {
  '@/lib/security/legacy-route-policy': 'export function createLegacyRagRouteResponse() {}',
  '@/lib/security/unified-publication-write-guard': 'export function getUnifiedPublicationWriteBlock() {}',
  '@/lib/rag-instance': `export async function getRagSystem() {
    return globalThis.__ragTokenizationFixture.system;
  }`,
  '@/lib/model-config': `export function createModelRequestTimeoutFetch() {
    return async (_url, request) => {
      const prompt = JSON.parse(request.body).prompt;
      let response;
      if (prompt.includes('"needRetrieval"')) response = JSON.stringify({ needRetrieval: true, confidence: 0.9 });
      else if (prompt.includes('"isRelevant"')) response = JSON.stringify({ isRelevant: true, relevanceScore: 0.9 });
      else if (prompt.includes('"overallSupport"')) response = JSON.stringify({ overallSupport: 0.9, segments: [] });
      else if (prompt.includes('"usefulnessScore"')) response = JSON.stringify({ isUseful: true, usefulnessScore: 0.9 });
      else response = '契丹人在历史上分布于东北亚。';
      return Response.json({ response });
    };
  }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === ragUrl && Object.hasOwn(mocks, specifier)) {
      return { shortCircuit: true, url: stub(mocks[specifier]) };
    }
    if (context.parentURL === selfRagUrl && Object.hasOwn(routeMocks, specifier)) {
      return { shortCircuit: true, url: stub(routeMocks[specifier]) };
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText };
  },
});

const [{ LocalRAGSystem }, { RunnableLambda }, { AIMessage }] = await Promise.all([
  import('./rag-system.ts'), import('@langchain/core/runnables'), import('@langchain/core/messages'),
]);

async function setup(t, reportProgress = false) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const fixture = {
    tokenizerLoads: 0,
    tokenizerOffline: true,
    embedded: [],
    progress: [],
    llm: RunnableLambda.from(async () => new AIMessage('契丹人在历史上分布于东北亚。')),
  };
  globalThis.__ragTokenizationFixture = fixture;
  t.after(() => { delete globalThis.__ragTokenizationFixture; });
  const system = new LocalRAGSystem(reportProgress
    ? { onQueryVectorizationProgress: event => fixture.progress.push(event) }
    : {});
  await system.reinitialize([{ content: '契丹人的历史分布位于东北亚。', filename: 'history.txt' }]);
  fixture.system = system;
  return { fixture, system };
}

test('Self-RAG retrieval skips the remote tokenizer when no token details are requested', async t => {
  const { fixture, system } = await setup(t);
  const result = await system.similaritySearch('契丹人在哪', 3, 0.3);

  assert.equal(fixture.tokenizerLoads, 0);
  assert.deepEqual(fixture.embedded, ['契丹人的历史分布位于东北亚。', '契丹人在哪']);
  assert.equal(result.searchResults[0].document.metadata.source, 'history.txt');
});

test('unavailable token details do not stop retrieval and can recover on a later request', async t => {
  const { fixture, system } = await setup(t, true);
  const first = await system.askWithDetails('契丹人在哪');

  assert.equal(first.retrievalDetails.searchResults.length, 1);
  assert.equal(first.answer, '契丹人在历史上分布于东北亚。');
  assert.equal(fixture.tokenizerLoads, 1);
  const unavailable = fixture.progress.find(event => /词元.*不可用/.test(event.message));
  assert.ok(unavailable);
  assert.equal(unavailable.tokenization, undefined);

  fixture.tokenizerOffline = false;
  const second = await system.askWithDetails('契丹人在哪');
  assert.equal(second.retrievalDetails.searchResults.length, 1);
  assert.equal(fixture.tokenizerLoads, 2);
  const actualTokens = fixture.progress.find(event => event.tokenization)?.tokenization.tokens;
  assert.deepEqual(actualTokens.map(token => token.tokenId), [101, 42, 102]);
});

test('embedding errors remain visible even when optional tokenization is unavailable', async t => {
  const { fixture, system } = await setup(t, true);
  fixture.embeddingError = new Error('embedding unavailable');
  await assert.rejects(system.askWithDetails('契丹人在哪'), /embedding unavailable/);
});

test('Self-RAG completes its retrieval workflow with the tokenizer offline', async t => {
  const { fixture } = await setup(t);
  const { POST } = await import(selfRagUrl);
  const response = await POST(new Request('http://localhost/api/self-rag', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '契丹人在哪', options: { maxIterations: 0 } }),
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.success, true);
  assert.equal(fixture.tokenizerLoads, 0);
  assert.equal(result.documents[0].source, 'history.txt');
  assert.equal(result.steps.find(step => step.stepName === 'Document Retrieval').status, 'completed');
  assert.match(result.finalResponse, /东北亚/);
});
