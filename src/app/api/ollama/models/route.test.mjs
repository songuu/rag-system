import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const modelConfigStubUrl = 'data:text/javascript,' + encodeURIComponent(`
const installedModels = [
  { name: 'nomic-embed-text-v2-moe:latest', size: 913320000 },
  { name: 'bge-m3:latest', size: 1080000000 },
  { name: 'qwen3-embedding:latest', size: 4360000000 },
  { name: 'nomic-embed-text:latest', size: 261600000 },
  { name: 'llama3.1:latest', size: 4580000000 },
];
export function createModelRequestTimeoutFetch() {
  return async () => new Response(JSON.stringify({ models: installedModels }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
export function getConfigSummary() {
  return {
    llmModel: 'llama3.1',
    reasoningModel: 'llama3.1',
    reasoningBaseUrl: 'http://localhost:11434',
  };
}
export function getCurrentProvider() { return 'ollama'; }
export function getReasoningProvider() { return 'ollama'; }
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/model-config') {
      return { url: modelConfigStubUrl, shortCircuit: true };
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const modulePath = path.resolve(process.cwd(), 'src', specifier.slice(2));
      const target = existsSync(`${modulePath}.ts`)
        ? `${modulePath}.ts`
        : path.join(modulePath, 'index.ts');
      return nextResolve(pathToFileURL(target).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const originalEnvironment = {
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
  OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL,
};
Object.assign(process.env, {
  EMBEDDING_PROVIDER: 'ollama',
  OLLAMA_EMBEDDING_MODEL: 'nomic-embed-text',
});

const { NextRequest } = await import('next/server');
const { GET } = await import('./route.ts');

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('GET includes dimensions for installed Ollama embedding models', async () => {
  const response = await GET(new NextRequest('http://localhost/api/ollama/models'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(
    Object.fromEntries(body.embeddingModels.map(model => [model.name, model.dimension])),
    {
      'nomic-embed-text-v2-moe:latest': 768,
      'bge-m3:latest': 1024,
      'qwen3-embedding:latest': 1024,
      'nomic-embed-text:latest': 768,
    }
  );
});
