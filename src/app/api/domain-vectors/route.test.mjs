import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const timestamp = '2026-10-20T00:00:00.000Z';
const syntheticCwd = 'C:\\synthetic-domain-vectors';
const centroidsPath = path.join(syntheticCwd, 'data', 'centroids.json');
const dataDir = path.dirname(centroidsPath);
const fullCentroids = {
  tech: {
    name: 'Technical', description: 'Synthetic primary', color: '#112233', icon: 'T',
    centroid: [1, 0], seedWords: ['alpha', 'beta'], wordCount: 2, dimension: 2,
    calculatedAt: timestamp, extra: { retained: true },
  },
  business: {
    name: 'Business', description: 'Synthetic secondary', color: '#334455', icon: 'B',
    centroid: [0, 1], seedWords: ['gamma'], wordCount: 1, dimension: 2,
    calculatedAt: timestamp,
  },
  _meta: { savedAt: timestamp, totalDomains: 2, extra: 'metadata retained' },
};

function createRoute({
  centroids = fullCentroids, centroidText = JSON.stringify(centroids),
  fileExists = true, directoryExists = true, readError, writeError,
  embedding = { embedding: [1, 0] }, embeddings,
  generation = { response: '1. alpha, 2、 beta，gamma\n\n超出长度限制的词汇长度必须达到二十个字符以上才能被过滤' },
  tags = { models: [{ name: 'llama3.1:latest', size: 10 }, { name: 'nomic-embed-text:latest' }, { name: 'other' }] },
  modelOk = true,
} = {}) {
  const fixtureModule = { exports: {} };
  const calls = [];
  const reads = [];
  const writes = [];
  const mkdirs = [];
  const logs = [];
  let embeddingIndex = 0;
  const boundedFetch = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, headers: init.headers, body });
    const value = url.endsWith('/api/tags') ? tags
      : url.endsWith('/api/generate') ? generation
        : embeddings ? embeddings[embeddingIndex++] : embedding;
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
        existsSync(file) { assert([centroidsPath, dataDir].includes(file)); return file === dataDir ? directoryExists : fileExists; },
        mkdirSync(file, options) { assert.equal(file, dataDir); assert.equal(options.recursive, true); mkdirs.push(file); },
        readFileSync(file, encoding) {
          assert.equal(file, centroidsPath); assert.equal(encoding, 'utf-8'); reads.push(file);
          if (readError) throw readError;
          return centroidText;
        },
        writeFileSync(file, text, encoding) {
          assert.equal(file, centroidsPath); assert.equal(encoding, 'utf-8');
          if (writeError) throw writeError;
          writes.push({ text, value: JSON.parse(text) });
        },
      };
      if (specifier === '@/lib/model-config') return {
        createModelRequestTimeoutFetch(timeout) { assert.equal(timeout, 30_000); return boundedFetch; },
      };
      throw new Error(`Unexpected real route dependency: ${specifier}`);
    },
  });
  vm.runInContext(compiledRoute, context, { filename: routePath.pathname });
  return { ...fixtureModule.exports, calls, reads, writes, mkdirs, logs };
}

async function post(route, body) {
  const response = await route.POST({ json: async () => structuredClone(body) });
  return { status: response.status, body: await response.json() };
}

async function get(route, action) {
  const response = await route.GET({ nextUrl: { searchParams: new URLSearchParams(action ? { action } : {}) } });
  return { status: response.status, body: await response.json() };
}

test('GET configuration and default discovery keep the complete legacy contract', async () => {
  const route = createRoute();
  const config = await get(route, 'config');
  assert.equal(config.status, 200);
  assert.equal(config.body.success, true);
  assert.deepEqual(Object.keys(config.body.domains), ['tech', 'business', 'daily', 'emotion', 'academic', 'health', 'culture', 'nature']);
  for (const domain of Object.values(config.body.domains)) {
    assert.deepEqual(Object.keys(domain), ['name', 'description', 'color', 'icon', 'seedPrompt']);
    assert.equal(typeof domain.seedPrompt, 'string');
  }
  assert.deepEqual(await get(route), {
    status: 200, body: { success: true, message: 'Domain Vectors API', actions: ['config', 'centroids', 'check-ollama'] },
  });
  assert.equal(route.calls.length, 0);
  assert.equal(route.reads.length, 0);
});

test('GET persisted centroids preserves every valid existing field, extra field and metadata', async () => {
  const route = createRoute();
  assert.deepEqual(await get(route, 'centroids'), {
    status: 200, body: { success: true, centroids: fullCentroids, savedAt: timestamp },
  });
  assert.equal(route.reads.length, 1);
  assert.equal(route.writes.length, 0);
});

test('Ollama status preserves all model names and requirement matching', async () => {
  const route = createRoute();
  assert.deepEqual(await get(route, 'check-ollama'), {
    status: 200,
    body: { success: true, status: 'online', models: ['llama3.1:latest', 'nomic-embed-text:latest', 'other'],
      requirements: { llm: { model: 'llama3.1', available: true }, embedding: { model: 'nomic-embed-text', available: true } } },
  });
  assert.equal(route.calls.length, 1);
  assert.equal(route.calls[0].url, 'http://synthetic-model.invalid/api/tags');
  assert.equal(route.calls[0].method, 'GET');
});

test('seed generation preserves parsing, custom prompt, model and generation options', async () => {
  const route = createRoute();
  assert.deepEqual(await post(route, { action: 'generate-seeds', domain: 'tech' }), {
    status: 200, body: { success: true, domain: 'tech', words: ['alpha', '2', 'beta', 'gamma'], count: 4 },
  });
  assert.deepEqual(route.calls[0].body, {
    model: 'llama3.1', prompt: '请列出50个与软件开发、编程、系统架构、人工智能、数据科学相关的核心技术词汇。只输出词汇，用逗号分隔，不要编号和解释。',
    stream: false, options: { temperature: 0.7, num_predict: 500 },
  });
  const custom = createRoute({ generation: { response: ' custom , seed ' } });
  assert.deepEqual(await post(custom, { action: 'generate-seeds', domain: 'custom', customPrompt: 'synthetic custom prompt' }), {
    status: 200, body: { success: true, domain: 'custom', words: ['custom', 'seed'], count: 2 },
  });
  assert.equal(custom.calls[0].body.prompt, 'synthetic custom prompt');
});

test('single centroid calculation preserves batching, normalized mean, output, metadata and disk formatting', async () => {
  const route = createRoute({ embeddings: [{ embedding: [3, 4] }, { embedding: [3, 4] }] });
  assert.deepEqual(await post(route, { action: 'calculate-centroid', domain: 'tech', seedWords: ['alpha', 'beta'] }), {
    status: 200, body: { success: true, domain: 'tech', wordCount: 2, dimension: 2,
      embeddings: [{ text: 'alpha', magnitude: 5 }, { text: 'beta', magnitude: 5 }] },
  });
  const expected = {
    ...fullCentroids,
    tech: { name: '技术', description: '软件开发、编程、系统架构相关', color: '#3B82F6', icon: '💻',
      seedWords: ['alpha', 'beta'], wordCount: 2, centroid: [0.6, 0.8], dimension: 2, calculatedAt: timestamp },
    _meta: { savedAt: timestamp, totalDomains: 2 },
  };
  assert.deepEqual(route.writes.map(write => write.value), [expected]);
  assert.equal(route.writes[0].text, JSON.stringify(expected, null, 2));
  assert.deepEqual(route.calls.map(call => call.body), [
    { model: 'nomic-embed-text', prompt: 'alpha' }, { model: 'nomic-embed-text', prompt: 'beta' },
  ]);
});

test('batch calculation preserves action result shape and per-domain insertion order', async () => {
  const route = createRoute();
  assert.deepEqual(await post(route, { action: 'calculate-all', domains: { daily: ['alpha'], custom: ['beta'], empty: [] } }), {
    status: 200, body: { success: true, results: { daily: { wordCount: 1, dimension: 2 }, custom: { wordCount: 1, dimension: 2 } }, savedPath: centroidsPath },
  });
  assert.deepEqual(route.calls.map(call => call.body.prompt), ['alpha', 'beta']);
  assert.deepEqual(Object.keys(route.writes[0].value), ['tech', 'business', '_meta', 'daily', 'custom']);
  assert.equal(route.writes[0].value.daily.name, '日常');
  assert.equal(route.writes[0].value.custom.name, 'custom');
  assert.deepEqual(route.writes[0].value._meta, { savedAt: timestamp, totalDomains: 4 });
  assert.deepEqual(route.writes[0].value.tech, fullCentroids.tech);
});

test('custom domain creation preserves optional defaults, existing domains and full saved record', async () => {
  const route = createRoute();
  assert.deepEqual(await post(route, { action: 'add-custom-domain', domainId: 'custom', seedWords: ['alpha'] }), {
    status: 200, body: { success: true, domainId: 'custom', wordCount: 1, dimension: 2 },
  });
  assert.deepEqual(route.writes[0].value.custom, {
    name: 'custom', description: '', color: '#6B7280', icon: '📁', seedWords: ['alpha'],
    wordCount: 1, centroid: [1, 0], dimension: 2, isCustom: true, calculatedAt: timestamp,
  });
  assert.deepEqual(route.writes[0].value.tech, fullCentroids.tech);
  assert.deepEqual(route.writes[0].value._meta, { savedAt: timestamp, totalDomains: 3 });
});

test('deletion preserves absent-domain no-op and actual deletion response with metadata', async () => {
  const route = createRoute();
  assert.deepEqual(await post(route, { action: 'delete-domain', domainId: 'missing' }), {
    status: 200, body: { success: true, deleted: 'missing' },
  });
  assert.equal(route.writes.length, 0);
  assert.deepEqual(await post(route, { action: 'delete-domain', domainId: 'tech' }), {
    status: 200, body: { success: true, deleted: 'tech' },
  });
  assert.deepEqual(route.writes[0].value, { business: fullCentroids.business, _meta: { savedAt: timestamp, totalDomains: 1 } });
});

test('query similarity preserves every detailed numeric field and omission when details are false', async () => {
  const route = createRoute();
  const primary = { domain: 'tech', similarity: 1, name: 'Technical', icon: 'T', color: '#112233', details: {
    dotProduct: 1, queryNorm: 1, centroidNorm: 1, wordCount: 2, dimension: 2,
    topDimensions: [{ dim: 0, queryVal: 1, centroidVal: 1, contrib: 1 }, { dim: 1, queryVal: 0, centroidVal: 0, contrib: 0 }], seedSample: ['alpha', 'beta'],
  } };
  const secondary = { domain: 'business', similarity: 0, name: 'Business', icon: 'B', color: '#334455', details: {
    dotProduct: 0, queryNorm: 1, centroidNorm: 1, wordCount: 1, dimension: 2,
    topDimensions: [{ dim: 0, queryVal: 1, centroidVal: 0, contrib: 0 }, { dim: 1, queryVal: 0, centroidVal: 1, contrib: 0 }], seedSample: ['gamma'],
  } };
  assert.deepEqual(await post(route, { action: 'test-query', query: 'synthetic query', showDetails: true }), {
    status: 200, body: { success: true, query: 'synthetic query', similarities: [primary, secondary], topDomain: primary,
      stats: { mean: 0.5, std: 0.5, range: 1, queryNorm: 1, queryDim: 2 }, queryVector: { dimension: 2, norm: 1, sample: ['1.000000', '0.000000'] } },
  });
  const shallow = await post(createRoute(), { action: 'test-query', query: 'synthetic query' });
  assert.equal(shallow.status, 200);
  assert.equal('details' in shallow.body.similarities[0], false);
  assert.equal('queryVector' in shallow.body, false);
});

test('old partial centroid records remain usable and GET/disk records are never silently stripped', async () => {
  const centroids = { partial: { centroid: [1, 0], name: 'Partial', icon: 'P', extra: ['retained'] }, opaque: { legacy: true }, _meta: { extra: 'retained' } };
  const route = createRoute({ centroids });
  assert.deepEqual((await get(route, 'centroids')).body, { success: true, centroids });
  const result = await post(route, { action: 'test-query', query: 'synthetic query', showDetails: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.similarities[0], { domain: 'partial', similarity: 1, name: 'Partial', icon: 'P', color: '#6B7280', details: {
    dotProduct: 1, queryNorm: 1, centroidNorm: 1,
    topDimensions: [{ dim: 0, queryVal: 1, centroidVal: 1, contrib: 1 }, { dim: 1, queryVal: 0, centroidVal: 0, contrib: 0 }], seedSample: [],
  } });
  assert.equal(route.writes.length, 0);
  await post(route, { action: 'calculate-centroid', domain: 'tech', seedWords: ['alpha'] });
  assert.deepEqual(route.writes[0].value.partial, centroids.partial);
  assert.deepEqual(route.writes[0].value.opaque, centroids.opaque);
});

test('filesystem read and missing-file fallbacks, directory creation and existing save-failure response stay unchanged', async () => {
  for (const options of [{ fileExists: false, directoryExists: false }, { readError: new Error('synthetic read error') }, { centroidText: '{ malformed' }]) {
    const route = createRoute(options);
    assert.deepEqual(await get(route, 'centroids'), { status: 200, body: { success: true, centroids: {} } });
    assert.equal(route.writes.length, 0);
  }
  const route = createRoute({ writeError: new Error('synthetic write error') });
  const result = await post(route, { action: 'calculate-centroid', domain: 'tech', seedWords: ['alpha'] });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(route.writes.length, 0);
});

test('unknown JSON request roots are rejected before filesystem or model side effects', async () => {
  for (const body of [null, [], 'bad', 1]) {
    const route = createRoute();
    assert.deepEqual(await post(route, body), body === null
      ? { status: 500, body: { success: false, error: 'Invalid domain vectors request: body must be an object' } }
      : { status: 400, body: { success: false, error: 'Unknown action' } });
    assert.equal(route.calls.length, 0); assert.equal(route.reads.length, 0); assert.equal(route.writes.length, 0);
  }
});

test('invalid known action fields keep existing status paths and contextual errors before side effects', async () => {
  const cases = [
    [{ action: 'generate-seeds', domain: [] }, 500, 'Invalid generate-seeds request: domain must be a string'],
    [{ action: 'generate-seeds', domain: 'tech', customPrompt: {} }, 500, 'Invalid generate-seeds request: customPrompt must be a string'],
    [{ action: 'delete-domain', domainId: [] }, 500, 'Invalid delete-domain request: domainId must be a string'],
    [{ action: 'calculate-all', domains: [] }, 500, 'Invalid calculate-all request: domains must be an object'],
    [{ action: 'calculate-centroid', domain: 'tech', seedWords: 'alpha' }, 400, 'No seed words provided'],
    [{ action: 'calculate-centroid', domain: [], seedWords: ['alpha'] }, 400, 'No seed words provided'],
    [{ action: 'calculate-centroid', domain: 'tech', seedWords: ['alpha', 1] }, 400, 'No seed words provided'],
    [{ action: 'add-custom-domain', domainId: 'custom', seedWords: ['alpha'], name: {} }, 400, 'Missing required fields'],
    [{ action: 'add-custom-domain', domainId: 'custom', seedWords: [1] }, 400, 'Missing required fields'],
  ];
  for (const [body, status, error] of cases) {
    const route = createRoute();
    assert.deepEqual(await post(route, body), { status, body: { success: false, error } });
    assert.equal(route.calls.length, 0); assert.equal(route.reads.length, 0); assert.equal(route.writes.length, 0);
  }
});

test('calculate-all keeps skipping individual invalid entries including mixed non-string seed arrays', async () => {
  const route = createRoute();
  assert.deepEqual(await post(route, { action: 'calculate-all', domains: { bad: [1], missing: null, empty: [], good: ['alpha'] } }), {
    status: 200, body: { success: true, results: { good: { wordCount: 1, dimension: 2 } }, savedPath: centroidsPath },
  });
  assert.deepEqual(route.calls.map(call => call.body.prompt), ['alpha']);
  assert.equal('bad' in route.writes[0].value, false);
});

test('disk JSON roots are validated but opaque metadata and non-vector entries remain preserved', async () => {
  for (const centroidText of ['null', '[]', '7', '"bad"']) {
    const route = createRoute({ centroidText });
    assert.deepEqual(await get(route, 'centroids'), { status: 200, body: { success: true, centroids: {} } });
    assert.equal(route.writes.length, 0);
  }
});

test('metadata is not migrated while the savedAt projection only exposes its existing string contract', async () => {
  for (const metadata of [null, [], { savedAt: {} }, { savedAt: 7 }, { extra: 'retained' }]) {
    const centroids = { ...fullCentroids, _meta: metadata };
    const route = createRoute({ centroids });
    const result = await get(route, 'centroids');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.centroids, centroids);
    assert.equal('savedAt' in result.body, false);
    assert.equal(route.writes.length, 0);
  }
});

test('query reads only safe centroid/detail fields without deleting malformed neighboring records', async () => {
  const centroids = {
    ...fullCentroids, badNull: null, badVector: { centroid: 'bad' }, badNumbers: { centroid: [1, '0'] },
    details: { centroid: [1, 0], name: {}, icon: [], color: {}, seedWords: {}, wordCount: [], dimension: {} },
  };
  const route = createRoute({ centroids });
  const result = await post(route, { action: 'test-query', query: 'synthetic query', showDetails: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.similarities.map(value => value.domain), ['tech', 'details', 'business']);
  const details = result.body.similarities.find(value => value.domain === 'details');
  assert.equal('name' in details, false); assert.equal('icon' in details, false);
  assert.equal(details.color, '#6B7280'); assert.deepEqual(details.details.seedSample, []);
  assert.equal('wordCount' in details.details, false); assert.equal('dimension' in details.details, false);
  assert.deepEqual((await get(route, 'centroids')).body.centroids, centroids);
  assert.equal(route.writes.length, 0);
});

test('no usable disk vectors use the existing no-domain 400 without model access', async () => {
  const route = createRoute({ centroids: { broken: null, opaque: { retained: true }, _meta: {} } });
  assert.deepEqual(await post(route, { action: 'test-query', query: 'synthetic query' }), {
    status: 400, body: { success: false, error: '没有可用的领域质心数据，请先计算至少一个领域的质心' },
  });
  assert.equal(route.calls.length, 0); assert.equal(route.writes.length, 0);
});

test('model JSON envelopes and mixed or overflowing embedding vectors are rejected explicitly', async () => {
  for (const embedding of [null, [], { embedding: {} }, { embedding: [1, '0'] }, JSON.parse('{"embedding":[1e400,0]}')]) {
    const route = createRoute({ embedding });
    const result = await post(route, { action: 'calculate-centroid', domain: 'tech', seedWords: ['alpha'] });
    assert.deepEqual(result, { status: 500, body: { success: false, error: 'Invalid Ollama embedding response' } });
    assert.equal(route.writes.length, 0);
  }
  for (const generation of [null, [], { response: {} }]) {
    const route = createRoute({ generation });
    assert.deepEqual(await post(route, { action: 'generate-seeds', domain: 'tech' }), {
      status: 500, body: { success: false, error: 'Invalid Ollama generation response' },
    });
  }
});

test('invalid Ollama tag contracts keep the existing offline response', async () => {
  for (const tags of [null, [], { models: {} }, { models: [{ name: [] }] }]) {
    assert.deepEqual(await get(createRoute({ tags }), 'check-ollama'), {
      status: 200, body: { success: false, status: 'offline', error: 'Cannot connect to Ollama service' },
    });
  }
});

test('JSON numeric overflow in disk vectors is ignored only for query computation and preserved on GET', async () => {
  const centroidText = '{"bad":{"centroid":[1e400,0]},"partial":{"centroid":[1,0]},"_meta":{"extra":true}}';
  const route = createRoute({ centroidText });
  const result = await post(route, { action: 'test-query', query: 'synthetic query' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.similarities.map(value => value.domain), ['partial']);
  // Existing JSON serialization represents the opaque overflowing number as null; the disk is untouched.
  assert.deepEqual((await get(route, 'centroids')).body.centroids, {
    bad: { centroid: [null, 0] }, partial: { centroid: [1, 0] }, _meta: { extra: true },
  });
  assert.equal(route.writes.length, 0);
});

test('mean-normalization algorithm and batch size retain exact original JavaScript bodies', () => {
  const parsed = ts.createSourceFile(routePath.pathname, compiledRoute, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const printer = ts.createPrinter({ removeComments: true });
  const functionBodyHash = name => {
    const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert(declaration?.body);
    const body = printer.printNode(ts.EmitHint.Unspecified, declaration.body, parsed);
    return createHash('sha256').update(body).digest('hex');
  };
  // Fixed from the original source before any product edit, not generated from the new implementation.
  assert.equal(functionBodyHash('calculateCentroid'), '39aac5b18f8abcc2dbeed526e822b84b3f9df0a4e09e127fc80a855616f54280');
  assert.equal(functionBodyHash('getEmbeddings'), '22fd1f904ebcc56a3705314927cfe7fb3163c2e4af82476fb8c5f853aa895360');
  const config = parsed.statements.filter(ts.isVariableStatement)
    .flatMap(statement => statement.declarationList.declarations)
    .find(declaration => declaration.name.getText(parsed) === 'DOMAIN_CONFIG');
  assert(config?.initializer);
  const configText = printer.printNode(ts.EmitHint.Unspecified, config.initializer, parsed);
  assert.equal(createHash('sha256').update(configText).digest('hex'), '0a2479ba1c22e4f7c6de115bc991a0838a238a776f5f9638fd5794c901e0ed97');
});
