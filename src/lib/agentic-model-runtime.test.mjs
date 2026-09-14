import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';

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
});

const {
  AgenticModelUnavailableError,
  describeAgenticModelFailure,
  discoverInstalledOllamaModels,
  reconcileAgenticOllamaModels,
  resolveAgenticGenerationTimeoutMs,
} = await import('./agentic-model-runtime.ts');

const agenticSource = await readFile(new URL('./agentic-rag.ts', import.meta.url), 'utf8');
const routeSource = await readFile(
  new URL('../app/api/agentic-rag/route.ts', import.meta.url),
  'utf8'
);

const installedModels = [
  { name: 'deepseek-v4-flash:cloud', size: 348 },
  { name: 'glm-4.7-flash:latest', size: 19_019_270_852 },
  { name: 'llama3.1:latest', size: 4_920_753_328 },
  { name: 'qwen3-embedding:latest', size: 4_676_805_193 },
];

test('missing auxiliary models fall back to the smallest installed chat model', () => {
  const resolved = reconcileAgenticOllamaModels({
    requestedLlmModel: 'glm-4.7-flash:latest',
    configuredFastLlmModel: 'qwen2.5:0.5b',
    configuredRerankerModel: 'qwen2.5:0.5b',
    installedModels,
  });

  assert.equal(resolved.llmModel, 'glm-4.7-flash:latest');
  assert.equal(resolved.fastLlmModel, 'llama3.1:latest');
  assert.equal(resolved.rerankerModel, 'llama3.1:latest');
  assert.equal(resolved.fallbacks.length, 2);
  assert.match(resolved.fallbacks[0], /qwen2\.5:0\.5b/);
});

test('untagged configured models resolve to their concrete installed latest tag', () => {
  const resolved = reconcileAgenticOllamaModels({
    requestedLlmModel: 'llama3.1',
    configuredFastLlmModel: 'llama3.1',
    configuredRerankerModel: 'llama3.1',
    installedModels,
  });

  assert.equal(resolved.llmModel, 'llama3.1:latest');
  assert.equal(resolved.fastLlmModel, 'llama3.1:latest');
  assert.equal(resolved.rerankerModel, 'llama3.1:latest');
  assert.deepEqual(resolved.fallbacks, []);
});

test('an unavailable requested main model fails before starting the workflow', () => {
  assert.throws(
    () => reconcileAgenticOllamaModels({
      requestedLlmModel: 'missing-main',
      configuredFastLlmModel: 'llama3.1',
      configuredRerankerModel: 'llama3.1',
      installedModels,
    }),
    error => error instanceof AgenticModelUnavailableError
      && error.code === 'AGENTIC_LLM_MODEL_UNAVAILABLE'
  );
});

test('generation timeout uses the longer existing model policy', () => {
  assert.equal(resolveAgenticGenerationTimeoutMs(30_000, 90_000), 240_000);
  assert.equal(resolveAgenticGenerationTimeoutMs(300_000, 90_000), 300_000);
});

test('model failures produce safe actionable details', () => {
  assert.equal(
    describeAgenticModelFailure(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      { modelName: 'glm-4.7-flash:latest', timeoutMs: 90_000 }
    ),
    '模型 glm-4.7-flash:latest 请求超过 90 秒，请改用更小模型或提高模型超时。'
  );
  assert.equal(
    describeAgenticModelFailure(new Error("model 'qwen2.5:0.5b' not found"), {
      modelName: 'qwen2.5:0.5b',
      timeoutMs: 30_000,
    }),
    '模型 qwen2.5:0.5b 未安装或名称不正确。'
  );
});

test('Ollama discovery keeps only valid model records', async () => {
  const models = await discoverInstalledOllamaModels('http://ollama.test/', {
    fetchImplementation: async (url) => {
      assert.equal(url, 'http://ollama.test/api/tags');
      return new Response(JSON.stringify({
        models: [
          { name: 'llama3.1:latest', size: 123 },
          { name: '', size: 456 },
          { unexpected: true },
        ],
      }), { status: 200 });
    },
  });

  assert.deepEqual(models, [{ name: 'llama3.1:latest', size: 123 }]);
});

test('Ollama discovery reports an actionable service error', async () => {
  await assert.rejects(
    discoverInstalledOllamaModels('http://ollama.test', {
      fetchImplementation: async () => new Response('', { status: 503 }),
    }),
    /Ollama 模型列表请求失败: HTTP 503/
  );
});

test('Agentic runtime wires fallback models, long generation timeout, and safe error details', () => {
  assert.match(routeSource, /discoverInstalledOllamaModels/);
  assert.match(routeSource, /reconcileAgenticOllamaModels/);
  assert.match(routeSource, /fastLlmModel: runtimeModels\.fastLlmModel/);
  assert.match(agenticSource, /resolveAgenticGenerationTimeoutMs/);
  assert.match(agenticSource, /keepAlive: 0/);
  assert.match(agenticSource, /errorDetail: describeAgenticModelFailure/);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
