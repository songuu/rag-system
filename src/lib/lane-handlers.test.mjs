import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const sourcePath = fileURLToPath(new URL('./lane-handlers.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const config = { fastModel: 'synthetic-fast', reasoningModel: 'synthetic-reasoning', embeddingModel: 'synthetic-embedding' };
const makeDocument = (id, content, score) => ({ id, content, score, distance: 1 - score, metadata: { source: `synthetic-${id}` } });
const plain = (value) => JSON.parse(JSON.stringify(value));

function createFixture(options = {}) {
  const calls = { llm: [], reasoning: [], streams: [], plans: [], searches: [], embeds: [], dimensions: [], collections: [], connects: 0 };
  const model = (name) => ({
    async *stream(prompt) {
      calls.streams.push({ name, prompt });
      if (options.streamError) throw options.streamError;
      for (const chunk of options.chunks ?? ['synthetic ', { content: 'answer' }]) yield chunk;
    },
    async invoke(prompt) {
      calls.plans.push(prompt);
      if (options.planError) throw options.planError;
      return options.planResponse ?? { content: '1. first synthetic subquery\n2. second synthetic subquery\n3. third synthetic subquery\n4. ignored synthetic subquery' };
    },
  });
  const dependencies = {
    './model-config': {
      createLLM(name, settings) { calls.llm.push({ name, settings }); return model(name); },
      createReasoningModel(name, settings) { calls.reasoning.push({ name, settings }); return model(name); },
      createEmbedding(name) {
        return { async embedQuery(query) { calls.embeds.push({ name, query }); return [1, 0]; } };
      },
      selectModelByDimension(dimension) { calls.dimensions.push(dimension); return options.noDimensionModel ? undefined : `synthetic-dimension-${dimension}`; },
    },
    './milvus-client': {
      getMilvusInstance(settings) {
        calls.collections.push(settings);
        return {
          async connect() { calls.connects += 1; if (options.connectError) throw options.connectError; },
          async getCollectionStats() { return Object.hasOwn(options, 'stats') ? options.stats : { embeddingDimension: 1024 }; },
          async search(vector, topK, threshold) {
            calls.searches.push({ vector, topK, threshold });
            return options.results ?? [makeDocument('one', 'synthetic evidence', 0.8)];
          },
        };
      },
    },
  };
  const exports = {};
  let clock = 1000;
  runInNewContext(compiled, {
    exports, module: { exports }, Error, Date: { now: () => ++clock },
    console: { log() {}, error() {} },
    require(specifier) {
      assert.ok(Object.hasOwn(dependencies, specifier), 'fixture must not load real providers or storage');
      return dependencies[specifier];
    },
  }, { filename: sourcePath });
  return { api: exports, calls };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return plain(events);
}

test('lane SSE protocol is discriminated and preserves business payload types', () => {
  const filename = path.join(path.dirname(sourcePath), 'lane-handlers.contract-types.ts');
  const contract = `
    import type { StreamEvent } from './lane-handlers';
    type IsAny<T> = 0 extends (1 & T) ? true : false;
    type ExpectFalse<T extends false> = T;
    type ExpectTrue<T extends true> = T;
    type Payload = ExpectFalse<IsAny<StreamEvent['data']>>;
    type Completion = Extract<StreamEvent, { type: 'complete' }>;
    type CompletionExists = ExpectTrue<Completion extends never ? false : true>;
    type RejectWrongError = ExpectFalse<{ type: 'error'; data: { answer: string }; timestamp: number } extends StreamEvent ? true : false>;
    type RejectWrongGeneration = ExpectFalse<{ type: 'generation'; data: { status: 'streaming'; content: string }; timestamp: number } extends StreamEvent ? true : false>;
    type History = ExpectFalse<IsAny<Completion['data']['thinkingProcess'][number]>>;
    const consume = (event: StreamEvent): string => {
      if (event.type === 'complete') return event.data.answer + event.data.workflow.totalDuration;
      if (event.type === 'retrieval') return String(event.data.documents.length + event.data.stats.totalCount);
      if (event.type === 'routing') return event.data.message;
      if (event.type === 'thinking') return event.data.content;
      if (event.type === 'lane_start') return event.data.model;
      if (event.type === 'error') return event.data.message;
      return event.data.status === 'streaming' ? event.data.fullContent : event.data.content;
    };
    export type Contract = [Payload, CompletionExists, RejectWrongError, RejectWrongGeneration, History, typeof consume];
  `;
  const cfg = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  assert.equal(cfg.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, process.cwd());
  const options = { ...parsed.options, noEmit: true, incremental: false };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, version, onError, fresh) => path.normalize(requested) === path.normalize(filename)
    ? ts.createSourceFile(filename, contract, version, true)
    : getSourceFile(requested, version, onError, fresh);
  const program = ts.createProgram([filename], options, host);
  assert.deepEqual([...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(({ code }) => code), []);
});

test('fast lane streams supported content without loading retrieval or reasoning', async () => {
  const { api, calls } = createFixture({ chunks: ['one', { content: ' two' }, { content: [] }, null, 5, {}] });
  const events = await collect(api.executeLane1('synthetic question', config));
  assert.deepEqual(events.map((event) => event.type), ['lane_start', 'thinking', 'generation', ...Array(6).fill('generation'), 'complete']);
  assert.equal(events.at(-1).data.answer, 'one two');
  assert.equal(events.at(-1).data.workflow.nodeExecutions[0].node, 'direct_generation');
  assert.equal(calls.llm[0].name, config.fastModel);
  assert.equal(calls.connects, 0);
  assert.equal(calls.reasoning.length, 0);
});

test('standard lane retains retrieval previews, dimension selection and complete documents', async () => {
  const results = [makeDocument('long', 'x'.repeat(201), 0.9), makeDocument('short', 'short', 0.5)];
  const { api, calls } = createFixture({ results });
  const events = await collect(api.executeLane2('synthetic question', { ...config, topK: 7, similarityThreshold: 0.4, collectionName: 'synthetic-collection', temperature: 0 }));
  const retrieval = events.find((event) => event.type === 'retrieval');
  const complete = events.at(-1);
  assert.equal(retrieval.data.documents[0].content, `${'x'.repeat(200)}...`);
  assert.equal(retrieval.data.documents[1].source, 'synthetic-short');
  assert.deepEqual(complete.data.retrieval.documents, results);
  assert.equal(complete.data.answer, 'synthetic answer');
  assert.deepEqual(calls.dimensions, [1024]);
  assert.deepEqual(calls.searches[0], { vector: [1, 0], topK: 7, threshold: 0.4 });
  assert.equal(calls.embeds[0].name, 'synthetic-dimension-1024');
  assert.equal(calls.llm[0].settings.temperature, 0);
  assert.match(calls.streams[0].prompt, /synthetic question/);
});

test('standard lane preserves null stats, embedding fallback and no-evidence generation', async () => {
  const { api, calls } = createFixture({ stats: null, noDimensionModel: true, results: [] });
  const events = await collect(api.executeLane2('synthetic question', config));
  assert.deepEqual(calls.dimensions, [768]);
  assert.equal(calls.embeds[0].name, config.embeddingModel);
  assert.equal(events.at(-1).data.retrieval.stats.totalCount, 0);
  assert.match(calls.streams[0].prompt, /synthetic question/);
  assert.equal(events.at(-1).data.workflow.iterations, 1);
});

test('reasoning lane preserves query fanout, last-content deduplication and score order', async () => {
  const results = [makeDocument('old', 'duplicate', 0.1), makeDocument('other', 'other evidence', 0.8), makeDocument('new', 'duplicate', 0.9)];
  const { api, calls } = createFixture({ results });
  const events = await collect(api.executeLane3('synthetic question', { ...config, topK: 20, rerankTopK: 2 }));
  const complete = events.at(-1);
  assert.equal(calls.searches.length, 4);
  assert.ok(calls.searches.every((call) => call.topK === 5));
  assert.deepEqual(complete.data.retrieval.documents.map((doc) => doc.id), ['new', 'other']);
  assert.equal(complete.data.retrieval.stats.queriesUsed, 4);
  assert.equal(complete.data.thinkingProcess.length, 4);
  assert.deepEqual(complete.data.workflow.phases, ['planner', 'executor', 'reasoner', 'reflector']);
  assert.equal(calls.reasoning.length, 2);
  assert.ok(calls.reasoning.every((call) => call.name === config.reasoningModel));
  assert.equal(calls.llm.length, 0);
});

test('lane failures retain the terminal error event and stop downstream work', async () => {
  for (const [lane, options] of [[1, { streamError: new Error('synthetic-stream') }], [2, { connectError: new Error('synthetic-connect') }], [3, { planError: new Error('synthetic-plan') }]]) {
    const { api, calls } = createFixture(options);
    const events = await collect(api[`executeLane${lane}`]('synthetic question', config));
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).data.message, /^synthetic-/);
    assert.equal(events.some((event) => event.type === 'complete'), false);
    assert.equal(calls.searches.length, 0);
  }
});

test('intent selector preserves all lanes and its existing invalid-lane fallback', async () => {
  for (const [suggestedLane, expectedLane] of [[1, 1], [2, 2], [3, 3], [99, 2]]) {
    const { api } = createFixture();
    const events = await collect(api.executeLaneByIntent('synthetic question', { suggestedLane }, { fastModel: '', reasoningModel: '', embeddingModel: '' }));
    assert.equal(events.at(-1).data.lane, expectedLane);
    assert.equal(events[0].data.model, expectedLane === 3 ? 'deepseek-r1:7b' : 'llama3.2');
  }
});
