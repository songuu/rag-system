import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const filename = fileURLToPath(new URL('./token-analyzer.ts', import.meta.url));
const source = fs.readFileSync(filename, 'utf8');
const emitted = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, removeComments: true },
}).outputText;

function loadAnalyzers({ tokenizer = async () => ({}), model = async () => ({}) } = {}) {
  const calls = { tokenizer: [], model: [], logs: [], warnings: [], errors: [] };
  const exports = {};
  const commonJs = { exports };
  let clock = 0;
  const context = vm.createContext({
    Map, TextEncoder, Float32Array, Date: { now: () => ++clock },
    console: Object.fromEntries(['log', 'warn', 'error'].map((method) => [method, (...args) => {
      calls[method === 'log' ? 'logs' : method === 'warn' ? 'warnings' : 'errors'].push(args);
    }])),
  });
  const evaluate = vm.runInContext(`(function(exports, require, module) { ${emitted}\n})`, context);
  evaluate(exports, (name) => {
    assert.equal(name, '@xenova/transformers');
    return {
      AutoTokenizer: { from_pretrained: async (name) => { calls.tokenizer.push(name); return tokenizer(name); } },
      AutoModel: { from_pretrained: async (name) => { calls.model.push(name); return model(name); } },
    };
  }, commonJs);
  return { ...commonJs.exports, calls };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('actual analyzer input/state types reject unchecked tokenizer values', { timeout: 15000 }, () => {
  const probe = path.join(path.dirname(filename), 'token-analyzer.contract-probe.ts');
  const probeSource = `
import type { ModelComparisonAnalyzer, VectorWeightAnalyzer } from './token-analyzer';
type IsAny<T> = 0 extends (1 & T) ? true : false;
type NotAny<T> = IsAny<T> extends true ? false : true;
type VocabularyInput = Parameters<ModelComparisonAnalyzer['extractVocabulary']>[0];
const checked: [NotAny<VocabularyInput>, NotAny<VectorWeightAnalyzer['tokenizer']>, NotAny<VectorWeightAnalyzer['model']>] = [true, true, true];
declare const acceptsVocabulary: (input: VocabularyInput) => void;
// @ts-expect-error primitive values are not a tokenizer vocabulary source
acceptsVocabulary(42);
void checked;
`;
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true, noEmit: true, skipLibCheck: true, types: [], ignoreDeprecations: '6.0',
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...rest) => path.resolve(file) === probe
    ? ts.createSourceFile(file, probeSource, options.target, true)
    : originalGetSourceFile(file, ...rest);
  const program = ts.createProgram([filename, probe], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), []);
});

test('type cleanup preserves the original emitted algorithms and dependency call shapes', () => {
  const normalized = emitted.replace('let embedding = [];', 'const embedding = [];')
    .replace(/\n[ \t]*void densityInfos;\n/, '\n');
  assert.equal(createHash('sha256').update(normalized).digest('hex'), 'db6516cc4c8a00807b8e418a697225c22df9720f6d235a5314335e2bbf8ca2ac');
});

test('vector weights retain heuristic values even when stored model weights exist', async () => {
  const weights = new Float32Array([99, 100]);
  const f = loadAnalyzers({ model: async () => ({ embeddings: { word_embeddings: { weight: { data: weights, shape: [1, 2] } } } }) });
  const analyzer = new f.VectorWeightAnalyzer('synthetic-model');
  const tokens = [{ token: '\u4e2d', tokenId: 200 }, { token: '[UNK]', tokenId: 0 }, { token: 'abcde', tokenId: 1001 }];
  const result = plain(await analyzer.analyzeVectorWeights(tokens));
  assert.deepEqual(result.map((item) => item.vectorMagnitude), [0.8, 0.1, 0.701]);
  assert.deepEqual(result.map((item) => item.embedding), [[], [], []]);
  assert.deepEqual(result.map((item) => item.semanticUniqueness), [0.8 * (1 / Math.log(101)), 0.1 * (1 / Math.log(1001)), 0.701 * (1 / Math.log(11))]);
  assert.equal(analyzer.embeddingWeights, weights);
  await analyzer.initialize();
  assert.deepEqual(f.calls.tokenizer, ['synthetic-model']);
  assert.deepEqual(f.calls.model, ['synthetic-model']);
});

test('model loading failure still falls back while tokenizer failure remains retryable and explicit', async () => {
  const unavailable = new Error('synthetic model failure');
  const fallback = loadAnalyzers({ model: async () => { throw unavailable; } });
  const fallbackAnalyzer = new fallback.VectorWeightAnalyzer('synthetic-fallback');
  assert.equal((await fallbackAnalyzer.analyzeVectorWeights([{ token: 'a', tokenId: 7 }]))[0].vectorMagnitude, 0.507);
  assert.equal(fallback.calls.warnings.length, 1);
  assert.equal(fallback.calls.warnings[0][1], unavailable);
  let attempts = 0;
  const f = loadAnalyzers({ tokenizer: async () => { if (++attempts === 1) throw unavailable; return {}; } });
  const analyzer = new f.VectorWeightAnalyzer('synthetic-retry');
  await assert.rejects(analyzer.initialize(), (error) => error === unavailable);
  await analyzer.initialize();
  assert.equal(attempts, 2);
  assert.equal(f.calls.errors[0][1], unavailable);
  assert.equal(f.calls.model.length, 1);
});

test('density and heatmap preserve UTF-8 byte lengths, UTF-16 token lengths and thresholds', () => {
  const { TokenDensityAnalyzer } = loadAnalyzers();
  const analyzer = new TokenDensityAnalyzer();
  const result = plain(analyzer.analyzeDensity([{ token: 'a', tokenId: 1 }, { token: '\u4e2d', tokenId: 2 }, { token: '\ud83d\ude00', tokenId: 3 }, { token: '', tokenId: 4 }]));
  assert.deepEqual(result.map(({ byteLength, tokenLength, density, compressionRatio }) => ({ byteLength, tokenLength, density, compressionRatio })), [
    { byteLength: 1, tokenLength: 1, density: 1, compressionRatio: 1 },
    { byteLength: 3, tokenLength: 1, density: 1 / 3, compressionRatio: 3 },
    { byteLength: 4, tokenLength: 2, density: 0.5, compressionRatio: 2 },
    { byteLength: 0, tokenLength: 0, density: 0, compressionRatio: 0 },
  ]);
  assert.deepEqual(plain(analyzer.generateHeatmapData([2, 1.2, 0.75, 0.5].map((density, index) => ({ density, byteLength: index + 1 })))), {
    positions: [0, 1, 3, 6], densities: [2, 1.2, 0.75, 0.5], colors: ['#1e3a8a', '#3b82f6', '#60a5fa', '#dbeafe'],
  });
});

test('scorecard preserves OOV formulas and existing empty-input NaN semantics', () => {
  const { TokenizationScorecardGenerator } = loadAnalyzers();
  const generator = new TokenizationScorecardGenerator();
  const score = generator.generateScorecard('abc', [{ token: '[0x41]', tokenId: 0 }, { token: '[UNK]', tokenId: 2 }], [{ vectorMagnitude: 0.2 }, { vectorMagnitude: 0.6 }], []);
  assert.equal(score.fragmentationRate, 1.5);
  assert.equal(score.semanticAlignment.mean, 0.4);
  assert.ok(Math.abs(score.semanticAlignment.variance - 0.04) < 1e-12);
  assert.deepEqual(plain(score.semanticAlignment.distribution), [0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(plain(score.oovRobustness), { byteFallbackCount: 1, byteFallbackRate: 0.5, unkTokenCount: 2 });
  const empty = generator.generateScorecard('', [], [], []);
  assert.equal(empty.fragmentationRate, 0);
  assert.equal(Number.isNaN(empty.semanticAlignment.mean), true);
  assert.equal(Number.isNaN(empty.semanticAlignment.variance), true);
  assert.equal(Number.isNaN(empty.overallScore), true);
});

test('vocabulary extraction retains both Map directions, arrays, object IDs and added-token overrides', () => {
  const { ModelComparisonAnalyzer } = loadAnalyzers();
  const analyzer = new ModelComparisonAnalyzer();
  const extract = (tokenizer) => [...analyzer.extractVocabulary(tokenizer)];
  assert.deepEqual(extract({ model: { vocab: new Map([['first', 1], [2, 'second'], [false, false]]) } }), [[1, 'first'], [2, 'second']]);
  assert.deepEqual(extract({ vocab: ['first', { id: 0, content: 'zero-uses-index' }, { id: 7, content: 'seventh' }, null] }), [[0, 'first'], [1, 'zero-uses-index'], [7, 'seventh']]);
  assert.deepEqual(extract({ encoder: { first: 1, '9suffix': 'ninth', invalid: 'ignored' }, added_tokens: [{ id: 1, content: 'override' }, { id: 3, content: '' }, { id: 'bad', content: 'ignored' }] }), [[1, 'override'], [9, 'ninth']]);
});

test('vocabulary path order, recoverable getter errors and added-token error boundary remain intact', () => {
  const { ModelComparisonAnalyzer } = loadAnalyzers();
  const analyzer = new ModelComparisonAnalyzer();
  const paths = [
    { model: { vocab: { first: 1 }, encoder: { second: 2 } }, vocab: { third: 3 } },
    { model: { encoder: { second: 2 } } }, { vocab: { third: 3 } }, { encoder: { fourth: 4 } },
    { tokenizer_: { model: { vocab: { fifth: 5 } } } }, { tokenizer_: { vocab: { sixth: 6 } } },
    { _tokenizer: { model: { vocab: { seventh: 7 } } } },
  ];
  assert.deepEqual(paths.map((tokenizer) => [...analyzer.extractVocabulary(tokenizer)]), paths.map((_item, index) => [[index + 1, ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'][index]]]));
  const error = new Error('synthetic getter failure');
  assert.deepEqual([...analyzer.extractVocabulary({ get model() { throw error; }, vocab: { fallback: 8 } })], [[8, 'fallback']]);
  assert.throws(() => analyzer.extractVocabulary({ get added_tokens() { throw error; } }), (actual) => actual === error);
});

test('model comparison preserves current encode argument shape, dictionary fallback, decode and per-model continuation', async () => {
  const encodeCalls = [];
  const decodeCalls = [];
  const tokenizer = async (name) => {
    if (name === 'synthetic-failed') throw new Error('synthetic tokenizer failure');
    return {
      ...(name === 'synthetic-vocab' ? { model: { vocab: { first: 1 } } } : {}),
      encode: (...args) => { encodeCalls.push(args); return [1, 2]; },
      batch_decode: (...args) => { decodeCalls.push(args); return ['decoded', '']; },
    };
  };
  const f = loadAnalyzers({ tokenizer });
  const analyzer = new f.ModelComparisonAnalyzer();
  const results = plain(await analyzer.compareModels('abc', ['synthetic-vocab', 'synthetic-failed', 'synthetic-decoded']));
  assert.deepEqual(results.map((item) => item.modelName), ['synthetic-vocab', 'synthetic-decoded']);
  assert.deepEqual(results.map((item) => item.tokenization.tokens.map((token) => token.token)), [['first', '[UNK:2]'], ['decoded', '[TOKEN:2]']]);
  assert.deepEqual(plain(encodeCalls), [['abc', { add_special_tokens: false }], ['abc', { add_special_tokens: false }]]);
  assert.deepEqual(plain(decodeCalls), [[[[1], [2]], { skip_special_tokens: false }]]);
  assert.deepEqual(results.map((item) => item.processingTime), [1, 1]);
  assert.equal(f.calls.errors.length, 1);
  assert.deepEqual(f.calls.model, ['synthetic-vocab', 'synthetic-decoded']);
});
