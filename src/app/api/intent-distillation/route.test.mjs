import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const routePath = new URL('./route.ts', import.meta.url);
const routeSource = readFileSync(routePath, 'utf8');
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const query = 'synthetic query';
const timestamp = '2026-10-20T00:00:00.000Z';
const validCentroids = {
  _meta: { savedAt: timestamp },
  primary: { centroid: [1, 0], name: 'Primary', icon: 'P' },
  secondary: { centroid: [0, 1], name: 'Secondary', icon: 'S' },
};
const validIntent = {
  intent: 'Find a synthetic solution', intentType: '问题解决', confidence: 0.9,
  expandedQueries: ['first expansion', 'first expansion', 'second expansion'],
  keywords: ['alpha', 'beta', 'gamma'], reasoning: 'Synthetic intent reasoning',
};
const validExpansion = {
  originalKeywords: ['alpha', 'beta'], synonyms: { alpha: ['a', 'b'], beta: ['c'] },
  relatedTerms: ['delta', 'epsilon'], expandedQueries: ['expanded keyword query'],
  reasoning: 'Synthetic expansion reasoning',
};

function createRoute({
  centroids = validCentroids,
  centroidText = JSON.stringify(centroids),
  centroidExists = true,
  centroidReadError,
  embedding = { embedding: [1, 0] },
  modelResults = [{ response: JSON.stringify(validIntent) }, { response: JSON.stringify(validExpansion) }],
  modelOk = true,
} = {}) {
  const calls = [];
  const reads = [];
  const logs = [];
  const fixtureModule = { exports: {} };
  let generationIndex = 0;
  const syntheticCwd = 'C:\\synthetic-intent';
  const centroidsPath = path.join(syntheticCwd, 'data', 'centroids.json');
  const modelFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, ...init, body });
    const value = url.endsWith('/api/embeddings') ? embedding : modelResults[generationIndex++];
    return { ok: modelOk, statusText: 'synthetic failure', json: async () => structuredClone(value) };
  };
  const context = vm.createContext({
    exports: fixtureModule.exports,
    module: fixtureModule,
    process: { env: { OLLAMA_BASE_URL: 'http://synthetic-model.invalid' }, cwd: () => syntheticCwd },
    Date: class extends Date { constructor() { super(timestamp); } },
    console: Object.fromEntries(['log', 'error'].map(level => [level, (...args) => logs.push({ level, args })])),
    require(specifier) {
      if (specifier === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (specifier === 'path') return path;
      if (specifier === 'fs') return {
        existsSync(file) { assert.equal(file, centroidsPath); return centroidExists; },
        readFileSync(file, encoding) {
          assert.equal(file, centroidsPath);
          assert.equal(encoding, 'utf-8');
          reads.push(file);
          if (centroidReadError) throw centroidReadError;
          return centroidText;
        },
      };
      if (specifier === '@/lib/model-config') return {
        createModelRequestTimeoutFetch(timeout) { assert.equal(timeout, 30_000); return modelFetch; },
      };
      throw new Error(`Unexpected real route dependency: ${specifier}`);
    },
  });
  vm.runInContext(compiledRoute, context, { filename: routePath.pathname });
  return { ...fixtureModule.exports, calls, reads, logs };
}

async function post(route, body = { query }) {
  const response = await route.POST({ json: async () => structuredClone(body) });
  return { status: response.status, body: await response.json() };
}

test('valid real route preserves every existing response field, request order, models and options', async () => {
  const route = createRoute();
  const result = await post(route);
  assert.equal(result.status, 200);
  const topDomain = { domain: 'primary', name: 'Primary', similarity: 1, icon: 'P' };
  assert.deepEqual(result.body, {
    success: true, query, timestamp,
    domainAnalysis: {
      topDomain, allDomains: [topDomain, { domain: 'secondary', name: 'Secondary', similarity: 0, icon: 'S' }], domainCount: 2,
    },
    intentAnalysis: {
      intent: validIntent.intent, intentType: validIntent.intentType, confidence: 0.9,
      keywords: validIntent.keywords, reasoning: validIntent.reasoning,
    },
    queryExpansion: { ...validExpansion, totalSynonyms: 3, totalRelated: 2 },
    queryRewrite: {
      original: query,
      rewritten: ['first expansion', 'second expansion', `${query} (关键词: alpha, beta, gamma)`],
      improvements: [
        { type: '领域聚焦', description: '查询与 Primary 领域高度相关，已添加领域特定术语' },
        { type: '解决方案导向', description: '将查询重构为明确的解决方案请求' },
        { type: '关键词增强', description: '添加了 3 个识别的关键词' },
      ],
    },
    confidence: {
      overall: 0.82,
      factors: [
        { factor: '领域匹配度', score: 1, weight: 0.3 },
        { factor: 'LLM 分析置信度', score: 0.9, weight: 0.4 },
        { factor: '关键词丰富度', score: 0.3, weight: 0.2 },
        { factor: '查询扩展质量', score: 1, weight: 0.1 },
      ],
      level: 'high',
    },
    suggestions: [{ type: '查询扩展', message: '已生成 3 个扩展查询，可以帮助获得更全面的结果', priority: 'low' }],
    recommendedQuery: 'first expansion',
  });
  assert.deepEqual(route.calls.map(call => call.url), [
    'http://synthetic-model.invalid/api/embeddings', 'http://synthetic-model.invalid/api/generate',
    'http://synthetic-model.invalid/api/generate',
  ]);
  assert.deepEqual(route.calls[0].body, { model: 'nomic-embed-text', prompt: query });
  assert.deepEqual(route.calls.slice(1).map(call => ({
    model: call.body.model, stream: call.body.stream, options: call.body.options,
  })), [
    { model: 'llama3.1', stream: false, options: { temperature: 0.3, num_predict: 1000 } },
    { model: 'llama3.1', stream: false, options: { temperature: 0.4, top_p: 0.9, num_predict: 1000 } },
  ]);
  assert.equal(route.calls[1].body.prompt.includes('Primary(100.0%), Secondary(0.0%)'), true);
  assert.equal(route.calls[2].body.prompt.includes('主要领域: Primary'), true);
  assert.equal(route.reads.length, 1);
});

test('existing empty-field defaults and includeRewrite=false remain unchanged', async () => {
  const route = createRoute({ modelResults: [
    { response: JSON.stringify({ intent: '', intentType: '', confidence: 0, reasoning: '' }) },
    { response: '{}' },
  ] });
  const result = await post(route, { query, includeRewrite: false });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.intentAnalysis, {
    intent: '未识别', intentType: '信息查询', confidence: 0.5, keywords: [], reasoning: '无详细分析',
  });
  assert.deepEqual(result.body.queryExpansion, {
    originalKeywords: [], synonyms: {}, relatedTerms: [], expandedQueries: [], reasoning: '自动扩展分析',
    totalSynonyms: 0, totalRelated: 0,
  });
  assert.equal(result.body.queryRewrite, null);
  assert.equal(result.body.recommendedQuery, query);
});

test('wrong intent field types use existing typed defaults instead of crashing or returning illegal JSON', async () => {
  const route = createRoute({ modelResults: [
    { response: JSON.stringify({ intent: {}, intentType: ['bad'], confidence: '0.9', expandedQueries: {}, keywords: [9], reasoning: {} }) },
    { response: JSON.stringify(validExpansion) },
  ] });
  const result = await post(route);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.intentAnalysis, {
    intent: '未识别', intentType: '信息查询', confidence: 0.5, keywords: [], reasoning: '无详细分析',
  });
  assert.deepEqual(result.body.queryRewrite.rewritten, [query]);
  assert.deepEqual(result.body.queryExpansion, { ...validExpansion, totalSynonyms: 3, totalRelated: 2 });
});

test('wrong keyword expansion fields cannot leak strings, nested arrays or objects to UI array contracts', async () => {
  const route = createRoute({ modelResults: [
    { response: JSON.stringify(validIntent) },
    { response: JSON.stringify({ originalKeywords: 'bad', synonyms: { alpha: ['a', 1] }, relatedTerms: [{}], expandedQueries: [['bad']], reasoning: [] }) },
  ] });
  const result = await post(route);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.queryExpansion, {
    originalKeywords: [], synonyms: {}, relatedTerms: [], expandedQueries: [], reasoning: '自动扩展分析',
    totalSynonyms: 0, totalRelated: 0,
  });
  assert.equal(result.body.intentAnalysis.intent, validIntent.intent);
});

for (const [name, envelope] of [
  ['null', null], ['array envelope', []], ['non-string model response', { response: {} }],
  ['array JSON response', { response: '[]' }], ['unparseable response', { response: '{ broken }' }],
]) {
  test(`malformed ${name} preserves both established generation fallbacks`, async () => {
    const route = createRoute({ modelResults: [envelope, envelope] });
    const result = await post(route);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.intentAnalysis, {
      intent: '查询关于 Primary 领域的信息', intentType: '信息查询', confidence: 0.6,
      keywords: ['synthetic', 'query'], reasoning: 'LLM 分析失败，使用基础分析',
    });
    assert.deepEqual(result.body.queryExpansion, {
      originalKeywords: ['synthetic', 'query'], synonyms: {}, relatedTerms: [], expandedQueries: [query],
      reasoning: '扩展失败，使用原始查询', totalSynonyms: 0, totalRelated: 0,
    });
    assert.equal(route.calls.length, 3);
  });
}

for (const [name, centroids] of [
  ['null root', null], ['array root', [validCentroids.primary]],
  ['invalid entries', { _meta: {}, nullEntry: null, vectorString: { ...validCentroids.primary, centroid: 'bad' }, wrongNumber: { ...validCentroids.primary, centroid: [1, '0'] }, wrongName: { ...validCentroids.primary, name: 3 }, wrongIcon: { ...validCentroids.primary, icon: {} } }],
]) {
  test(`malformed centroid ${name} is excluded at the disk JSON boundary for GET and POST`, async () => {
    const route = createRoute({ centroids });
    const getResponse = await route.GET();
    const getBody = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.equal(getBody.domainCount, 0);
    assert.equal(getBody.available, false);
    assert.deepEqual(getBody.domains, []);
    const result = await post(route);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.domainAnalysis, { topDomain: null, allDomains: [], domainCount: 0 });
  });
}

test('valid centroid entries survive neighboring malformed entries and GET keeps all fields', async () => {
  const route = createRoute({ centroids: { ...validCentroids, broken: null } });
  const response = await route.GET();
  assert.deepEqual(await response.json(), {
    success: true, available: true, domainCount: 2,
    domains: [{ domain: 'primary', name: 'Primary', icon: 'P' }, { domain: 'secondary', name: 'Secondary', icon: 'S' }],
    supportedIntentTypes: ['信息查询', '问题解决', '学习探索', '操作指导', '对比分析', '创意生成'],
  });
  assert.equal((await post(route)).body.domainAnalysis.domainCount, 2);
});

test('missing, unreadable and malformed centroid files retain the empty-domain fallback', async () => {
  for (const options of [{ centroidExists: false }, { centroidReadError: new Error('synthetic read failure') }, { centroidText: '{ malformed' }]) {
    const route = createRoute(options);
    const result = await post(route);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.domainAnalysis, { topDomain: null, allDomains: [], domainCount: 0 });
  }
});

test('unknown request roots and invalid query values return the existing 400 before any model request', async () => {
  for (const body of [null, [], 'query', 7, {}, { query: null }, { query: [] }, { query: ' ' }]) {
    const route = createRoute();
    const result = await post(route, body);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { success: false, error: '查询文本不能为空' });
    assert.equal(route.calls.length, 0);
    assert.equal(route.reads.length, 0);
  }
});

test('invalid embedding arrays are rejected explicitly before either generation call', async () => {
  for (const embedding of [null, [], { embedding: {} }, { embedding: [1, '0'] }]) {
    const route = createRoute({ embedding });
    const result = await post(route);
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { success: false, error: 'Invalid Ollama embedding response' });
    assert.equal(route.calls.length, 1);
  }
});

test('model confidence JSON numeric overflow uses its established field default without clamping finite values', async () => {
  for (const literal of ['1e400', '-1e400', '-2', '1.5']) {
    const route = createRoute({ modelResults: [
      { response: `{"confidence":${literal}}` }, { response: JSON.stringify(validExpansion) },
    ] });
    const result = await post(route);
    assert.equal(result.status, 200);
    assert.equal(result.body.intentAnalysis.confidence, literal.includes('e400') ? 0.5 : Number(literal));
    assert.deepEqual(result.body.queryExpansion, { ...validExpansion, totalSynonyms: 3, totalRelated: 2 });
  }
});

test('embedding JSON numeric overflow is rejected before generation, not serialized as a null score', async () => {
  for (const literal of ['1e400', '-1e400']) {
    const route = createRoute({ embedding: JSON.parse(`{"embedding":[${literal},0]}`) });
    const result = await post(route);
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { success: false, error: 'Invalid Ollama embedding response' });
    assert.equal(route.calls.length, 1);
  }
});

test('centroid disk JSON numeric overflow excludes only the invalid domain', async () => {
  for (const literal of ['1e400', '-1e400']) {
    const route = createRoute({ centroidText: `{"primary":{"centroid":[${literal},0],"name":"Primary","icon":"P"},"secondary":{"centroid":[0,1],"name":"Secondary","icon":"S"}}` });
    const response = await route.GET();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.domainCount, 1);
    assert.deepEqual(body.domains, [{ domain: 'secondary', name: 'Secondary', icon: 'S' }]);
    const result = await post(route);
    const secondary = { domain: 'secondary', name: 'Secondary', similarity: 0, icon: 'S' };
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.domainAnalysis, { topDomain: secondary, allDomains: [secondary], domainCount: 1 });
  }
});
