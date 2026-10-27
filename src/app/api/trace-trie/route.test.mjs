import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const routePath = new URL('./route.ts', import.meta.url);
const source = readFileSync(routePath, 'utf8');
const emitted = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, removeComments: true },
}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const text = 'synthetic text';
const defaultModel = 'Xenova/bert-base-multilingual-cased';
const finalTokens = [{ token: 'synthetic', tokenId: 7 }, { token: 'text', tokenId: 1042 }];
const waterfall = {
  input: text,
  stages: [
    { level: 'bytes', tokens: [{ token: 'not-final', tokenId: 99 }], processingTime: 1, mergeOperations: [] },
    { level: 'fullwords', tokens: finalTokens, processingTime: 2, mergeOperations: [] },
  ],
  totalTime: 3,
};
const vectorWeights = [{ token: 'synthetic', tokenId: 7, vectorMagnitude: 0.7, embedding: [], semanticUniqueness: 0.4 }];
const densityInfos = [{ token: 'synthetic', tokenId: 7, byteLength: 9, tokenLength: 9, density: 1, compressionRatio: 1 }];
const comparison = [{ modelName: 'second-model', tokenization: { tokenCount: 0, tokens: [] }, processingTime: 1 }];

function createRoute({ tokenizer = { model: { vocab: { synthetic: 7, text: 1042 } } }, loadError, analysisError } = {}) {
  const calls = [];
  const logs = [];
  let vocabulary;
  const fixtureModule = { exports: {} };
  class EnhancedTrie {
    buildFromVocabulary(value) { vocabulary = new Map(value); calls.push(['build', [...value]]); }
    getStats() { calls.push(['stats']); return { nodeCount: 4, vocabSize: vocabulary.size, maxDepth: 9 }; }
  }
  class LogicWaterfallGenerator {
    constructor(trie) { assert.ok(trie instanceof EnhancedTrie); calls.push(['waterfall-constructor']); }
    generate(value) { calls.push(['generate', value]); return waterfall; }
  }
  class VectorWeightAnalyzer {
    constructor(model) { calls.push(['vector-constructor', model]); }
    async initialize() { calls.push(['initialize']); if (analysisError) throw analysisError; }
    async analyzeVectorWeights(tokens) { calls.push(['vector', plain(tokens)]); return vectorWeights; }
  }
  class TokenDensityAnalyzer {
    analyzeDensity(tokens) { calls.push(['density', plain(tokens)]); return densityInfos; }
  }
  class ModelComparisonAnalyzer {
    async compareModels(value, models) { calls.push(['compare', value, plain(models)]); return comparison; }
  }
  const context = vm.createContext({
    Map, Error,
    exports: fixtureModule.exports,
    module: fixtureModule,
    console: Object.fromEntries(['log', 'error'].map(level => [level, (...args) => logs.push({ level, args })])),
    require(specifier) {
      if (specifier === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (specifier === '@/lib/trace-trie') return { EnhancedTrie, LogicWaterfallGenerator };
      if (specifier === '@/lib/token-analyzer') return { VectorWeightAnalyzer, TokenDensityAnalyzer, ModelComparisonAnalyzer };
      if (specifier === '@xenova/transformers') return {
        AutoTokenizer: { async from_pretrained(model) { calls.push(['load', model]); if (loadError) throw loadError; return tokenizer; } },
      };
      throw new Error(`Unexpected real route dependency: ${specifier}`);
    },
  });
  vm.runInContext(emitted, context, { filename: routePath.pathname });
  return { ...fixtureModule.exports, calls, logs, get vocabulary() { return vocabulary; } };
}

async function post(route, body = { text }) {
  const response = await route.POST({ json: async () => body });
  return { status: response.status, body: await response.json() };
}

test('real route vocabulary and compatibility adapter declarations contain no explicit any', () => {
  const syntax = ts.createSourceFile(routePath.pathname, source, ts.ScriptTarget.ES2022, true);
  const unchecked = [];
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) unchecked.push(node.pos);
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.deepEqual(unchecked, []);
});

test('type-only cleanup preserves every original emitted algorithm and dependency argument shape', () => {
  // Omitting the unused special-token key is the only emitted syntax change.
  const normalized = emitted.replace('forEach(([, value]) => {', 'forEach(([key, value]) => {');
  assert.equal(createHash('sha256').update(normalized).digest('hex'), 'ef866cd4870b5a1abbf652a353a75768680350b5ca5f24e4c77666d44c252492');
});

test('full real route preserves response fields, default model, metadata thresholds and final-stage analysis order', async () => {
  const route = createRoute();
  const result = await post(route);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    success: true,
    data: { waterfall, vectorWeights, densityInfos, modelComparisons: [], trieStats: { nodeCount: 4, vocabSize: 2, maxDepth: 9 } },
  });
  assert.deepEqual(plain(route.calls), [
    ['load', defaultModel],
    ['build', [['synthetic', { id: 7, rank: 0, frequency: 10000 }], ['text', { id: 1042, rank: 1042, frequency: 100 }]]],
    ['waterfall-constructor'], ['generate', text], ['vector-constructor', defaultModel], ['initialize'],
    ['vector', finalTokens], ['density', finalTokens], ['stats'],
  ]);
});

test('multiple caller models retain their order and comparison response unchanged', async () => {
  const route = createRoute({ tokenizer: { vocab: { first: 99, boundary: 100, upper: 999, thousand: 1000 } } });
  const models = ['primary-model', 'second-model'];
  const result = await post(route, { text, modelNames: models });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.modelComparisons, comparison);
  assert.deepEqual(plain([...route.vocabulary]), [
    ['first', { id: 99, rank: 0, frequency: 10000 }],
    ['boundary', { id: 100, rank: 100, frequency: 1000 }],
    ['upper', { id: 999, rank: 100, frequency: 1000 }],
    ['thousand', { id: 1000, rank: 1000, frequency: 100 }],
  ]);
  assert.deepEqual(route.calls[0], ['load', 'primary-model']);
  assert.deepEqual(route.calls.at(-2), ['compare', text, models]);
});

for (const [name, tokenizer, expected] of [
  ['model vocabulary', { model: { vocab: { first: 1 }, config: { vocab: { ignored: 2 } } } }, [['first', 1]]],
  ['model config vocabulary', { model: { config: { vocab: { second: 2 } } } }, [['second', 2]]],
  ['model encoder', { model: { encoder: { third: 3 } } }, [['third', 3]]],
  ['model BPE vocabulary', { model: { bpe: { vocab: { fourth: 4 } } } }, [['fourth', 4]]],
  ['direct vocabulary', { vocab: { fifth: 5 } }, [['fifth', 5]]],
  ['direct encoder', { encoder: { sixth: 6 } }, [['sixth', 6]]],
  ['internal model', { tokenizer_: { model: { vocab: { seventh: 7 } } } }, [['seventh', 7]]],
  ['internal vocabulary', { tokenizer_: { vocab: { eighth: 8 } } }, [['eighth', 8]]],
  ['config vocabulary', { config: { vocab: { ninth: 9 } } }, [['ninth', 9]]],
  ['nested private model', { _tokenizer: { model: { vocab: { tenth: 10 } } } }, [['tenth', 10]]],
]) {
  test(`vocabulary lookup retains ${name} compatibility path`, async () => {
    const route = createRoute({ tokenizer });
    assert.equal((await post(route)).status, 200);
    assert.deepEqual([...route.vocabulary].map(([token, metadata]) => [token, metadata.id]), expected);
  });
}

test('vocabulary formats retain Map directions, token arrays, partial integer keys and zero-id fallback', async () => {
  for (const [vocab, expected] of [
    [new Map([['forward', 1], [2, 'reverse'], [false, true]]), [['forward', 1], ['reverse', 2]]],
    [['first', { content: 'zero-uses-index', id: 0 }, { content: 'explicit', id: 8 }, null, 9], [['first', 0], ['zero-uses-index', 1], ['explicit', 8]]],
    [{ first: 1, '9suffix': 'partial-integer', invalid: 'ignored' }, [['first', 1], ['partial-integer', 9]]],
  ]) {
    const route = createRoute({ tokenizer: { vocab } });
    assert.equal((await post(route)).status, 200);
    assert.deepEqual([...route.vocabulary].map(([token, metadata]) => [token, metadata.id]), expected);
  }
});

test('added and special token overrides retain original order and skip invalid metadata', async () => {
  const route = createRoute({ tokenizer: {
    vocab: { base: 1, same: 2 },
    added_tokens: [{ content: 'same', id: 3 }, null, { content: '', id: 4 }, { content: 'invalid', id: 'bad' }],
    special_tokens: { first: { content: 'same', id: 5 }, second: { content: 'special', id: 6 }, third: null, fourth: 'ignored' },
  } });
  assert.equal((await post(route)).status, 200);
  assert.deepEqual([...route.vocabulary].map(([token, metadata]) => [token, metadata.id]), [['base', 1], ['same', 5], ['special', 6]]);
});

test('empty paths and recoverable getters still allow subsequent vocabulary paths', async () => {
  const route = createRoute({ tokenizer: { get model() { throw new Error('synthetic getter'); }, vocab: {}, encoder: { fallback: 8 } } });
  assert.equal((await post(route)).status, 200);
  assert.deepEqual([...route.vocabulary].map(([token, metadata]) => [token, metadata.id]), [['fallback', 8]]);
});

test('fallback preserves legacy two-argument encode call, batch options, trimming and token placeholders', async () => {
  const calls = [];
  const tokenizer = {
    encode(...args) { assert.equal(this, tokenizer); calls.push(['encode', ...args]); return [5, 6, 7]; },
    batch_decode(...args) { assert.equal(this, tokenizer); calls.push(['batch', ...args]); return [' first ', '', '   ']; },
  };
  const route = createRoute({ tokenizer });
  assert.equal((await post(route)).status, 200);
  assert.deepEqual(plain(calls), [
    ['encode', text, { add_special_tokens: false }], ['batch', [[5], [6], [7]], { skip_special_tokens: false }],
  ]);
  assert.deepEqual([...route.vocabulary].map(([token, metadata]) => [token, metadata.id]), [['first', 5], ['[TOKEN:6]', 6], ['', 7]]);
});

test('decode and optional id conversion retain ordered fallbacks and receiver binding', async () => {
  for (const useConverter of [false, true]) {
    const calls = [];
    const tokenizer = {
      encode() { return [5, 6]; },
      batch_decode() { calls.push(['batch']); throw new Error('synthetic batch failure'); },
      decode(ids) { assert.equal(this, tokenizer); calls.push(['decode', ...ids]); if (useConverter) throw new Error('synthetic decode failure'); return `decoded-${ids[0]}`; },
      convert_ids_to_tokens(ids) { assert.equal(this, tokenizer); calls.push(['convert', ...ids]); return ['converted-first', 'converted-second']; },
    };
    const route = createRoute({ tokenizer });
    assert.equal((await post(route)).status, 200);
    assert.deepEqual(plain(calls), useConverter ? [['batch'], ['decode', 5], ['convert', 5, 6]] : [['batch'], ['decode', 5], ['decode', 6]]);
    assert.deepEqual([...route.vocabulary].map(([token, metadata]) => [token, metadata.id]), useConverter
      ? [['converted-first', 5], ['converted-second', 6]] : [['decoded-5', 5], ['decoded-6', 6]]);
  }
});

test('unavailable conversion and failed encode preserve placeholder and empty-vocabulary behavior', async () => {
  const route = createRoute({ tokenizer: {
    encode() { return [5]; }, batch_decode() { throw new Error('synthetic batch'); }, decode() { throw new Error('synthetic decode'); },
  } });
  assert.equal((await post(route)).status, 200);
  assert.deepEqual([...route.vocabulary].map(([token, metadata]) => [token, metadata.id]), [['[TOKEN:5]', 5]]);
  const failed = createRoute({ tokenizer: { encode() { throw new Error('synthetic encode failure'); } } });
  assert.equal((await post(failed)).status, 200);
  assert.equal(failed.vocabulary.size, 0);
  assert.equal(failed.logs.filter(log => log.level === 'error').length, 1);
});

test('invalid text retains established 400 and no dependency calls, without trimming whitespace', async () => {
  for (const value of [undefined, null, '', 0, [], {}]) {
    const route = createRoute();
    const result = await post(route, { text: value });
    assert.deepEqual(result, { status: 400, body: { success: false, error: 'Invalid text input' } });
    assert.equal(route.calls.length, 0);
  }
  assert.equal((await post(createRoute(), { text: ' ' })).status, 200);
});

test('existing malformed JSON root, invalid model container and upstream failures retain original 500 behavior', async () => {
  for (const body of [null, { text, modelNames: null }]) {
    const route = createRoute();
    const result = await post(route, body);
    assert.equal(result.status, 500);
    assert.equal(result.body.success, false);
    assert.equal(typeof result.body.error, 'string');
    assert.equal(route.calls.length, 0);
  }
  for (const options of [{ loadError: new Error('synthetic tokenizer failure') }, { analysisError: new Error('synthetic analyzer failure') }]) {
    const route = createRoute(options);
    const result = await post(route);
    assert.equal(result.status, 500);
    assert.equal(result.body.error, (options.loadError ?? options.analysisError).message);
  }
  const route = createRoute();
  const response = await route.POST({ json: async () => { throw new Error('synthetic JSON failure'); } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { success: false, error: 'synthetic JSON failure' });
});
