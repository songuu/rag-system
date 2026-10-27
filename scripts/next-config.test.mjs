import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));

function loadConfig(env = {}) {
  const fixture = { exports: {} };
  // Execute the real configuration with only synthetic environment values. A
  // config test must not import providers or inherit credentials from the host.
  const context = vm.createContext({
    process: { env: { ...env } }, module: fixture, exports: fixture.exports,
    require(specifier) { throw new Error(`Unexpected configuration dependency: ${specifier}`); },
  });
  vm.runInContext(emitted, context, { filename: 'next.config.ts' });
  return fixture.exports.default;
}

test('standalone startup leaves unrelated route and model entries on demand', () => {
  const config = loadConfig();
  assert.equal(config.output, 'standalone');
  assert.equal(config.experimental?.preloadEntriesOnStart, false);
});

test('prefixed standalone deployment also avoids eager route entry loading', () => {
  const config = loadConfig({ RAG_BASE_PATH: '/rag-system///' });
  assert.equal(config.experimental?.preloadEntriesOnStart, false);
  assert.equal(config.basePath, '/rag-system');
  assert.deepEqual(plain(config.env), { NEXT_PUBLIC_BASE_PATH: '/rag-system' });
  assert.equal(config.rewrites, undefined);
});

test('unprefixed standalone preserves its isolated API rewrite and public environment', async () => {
  const config = loadConfig({ SYNTHETIC_PROVIDER_SECRET: 'synthetic-private-value' });
  assert.equal(config.basePath, undefined);
  assert.deepEqual(plain(config.images), { unoptimized: true });
  assert.deepEqual(plain(config.env), { NEXT_PUBLIC_BASE_PATH: '' });
  assert.deepEqual(plain(await config.rewrites()), [
    { source: '/rag-api/:path*', destination: '/api/:path*' },
  ]);
});

test('static export keeps the Pages base path and does not add a server startup option', () => {
  for (const [env, expected] of [
    [{ STATIC_EXPORT: 'true' }, '/rag-system'],
    [{ STATIC_EXPORT: 'true', RAG_BASE_PATH: '/custom///' }, '/custom'],
  ]) {
    const config = loadConfig(env);
    assert.equal(config.output, 'export');
    assert.equal(config.basePath, expected);
    assert.deepEqual(plain(config.env), { NEXT_PUBLIC_BASE_PATH: expected });
    assert.deepEqual(plain(config.images), { unoptimized: true });
    assert.equal(config.experimental, undefined);
    assert.equal(config.rewrites, undefined);
  }
});

test('relative base paths still fail instead of changing route isolation', () => {
  for (const value of ['relative-path', 'relative/path']) {
    assert.throws(() => loadConfig({ RAG_BASE_PATH: value }), {
      name: 'Error', message: 'RAG_BASE_PATH must be a non-root absolute path.',
    });
  }
});

test('empty and slash-only base paths retain their existing normalized defaults', () => {
  for (const value of ['', '/', '////']) {
    const standalone = loadConfig({ RAG_BASE_PATH: value });
    assert.equal(standalone.basePath, undefined);
    assert.deepEqual(plain(standalone.env), { NEXT_PUBLIC_BASE_PATH: '' });
    assert.equal(typeof standalone.rewrites, 'function');
    const exported = loadConfig({ STATIC_EXPORT: 'true', RAG_BASE_PATH: value });
    assert.equal(exported.basePath, '/rag-system');
  }
});

test('provider packages remain native runtime dependencies in every deployment mode', () => {
  const packages = [
    'pdf-parse', '@llamaindex/liteparse', '@napi-rs/canvas', 'pdfjs-dist', 'canvas',
    'langchain', '@langchain/core', '@langchain/langgraph', '@langchain/ollama',
    '@langchain/openai', '@langchain/textsplitters', '@zilliz/milvus2-sdk-node',
  ];
  for (const env of [{}, { STATIC_EXPORT: 'true' }, { RAG_BASE_PATH: '/rag-system' }]) {
    const config = loadConfig(env);
    assert.deepEqual(plain(config.serverExternalPackages), packages);
    assert.deepEqual(plain(config.turbopack), {});
  }
});

test('startup optimization preserves route-scoped raw-source tracing exclusions', () => {
  const extensions = ['js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx', 'cts', 'mts'];
  const exclude = (...directories) => directories.flatMap(directory => extensions.map(extension => `${directory}/**/*.${extension}`));
  assert.deepEqual(plain(loadConfig().outputFileTracingExcludes), {
    '/api/ask': exclude('src/lib/rag/core', 'src/lib/rag/multimodal', 'src/lib/mirofish'),
    '/api/pipeline': exclude('src/lib/rag/multimodal'),
    '/api/document-search': exclude('src/lib/rag/core', 'src/lib/rag/multimodal'),
    '/api/mirofish/graph': exclude('src/lib/mirofish'),
  });
});

test('startup optimization preserves native runtime assets without adding broad excludes', () => {
  assert.deepEqual(plain(loadConfig().outputFileTracingIncludes), {
    '/api/ask': [
      'node_modules/.pnpm/sharp@*/node_modules/sharp/build/Release/*.dll',
      'node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v3/win32/**/*',
    ],
  });
});
