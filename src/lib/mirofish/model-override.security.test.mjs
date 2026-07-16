import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const target = path.resolve(process.cwd(), 'src', `${specifier.slice(2)}.ts`);
      return nextResolve(pathToFileURL(target).href, context);
    }
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
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
  validateModelOverride,
} = await import('./model-override.ts');

test('untrusted HTTP model overrides retain only server-endpoint-safe selection fields', () => {
  assert.deepEqual(validateHttpModelOverride({
    provider: 'openai',
    modelName: '  gpt-safe  ',
    temperature: 0.25,
  }), {
    provider: 'openai',
    modelName: 'gpt-safe',
    temperature: 0.25,
  });
  assert.equal(validateHttpModelOverride(undefined), null);
});

test('untrusted HTTP model overrides reject endpoint and credential fields by presence', () => {
  for (const forbiddenInput of [
    { provider: 'ollama', modelName: 'test', baseUrl: 'http://127.0.0.1:11434' },
    { provider: 'openai', modelName: 'test', baseUrl: '' },
    { provider: 'openai', modelName: 'test', baseUrl: null },
    { provider: 'openai', modelName: 'test', apiKey: 'secret' },
    { provider: 'openai', modelName: 'test', apiKey: '' },
    { provider: 'openai', modelName: 'test', apiKey: null },
  ]) {
    assert.throws(
      () => validateHttpModelOverride(forbiddenInput),
      error => {
        const response = getHttpModelOverrideErrorResponse(error);
        assert.equal(response?.status, 400);
        assert.equal(response?.body.code, 'MIROFISH_HTTP_MODEL_OVERRIDE_FORBIDDEN');
        assert.doesNotMatch(JSON.stringify(response), /127\.0\.0\.1|secret/);
        return true;
      }
    );
  }
});

test('trusted internal model normalization still supports server-managed endpoints and credentials', () => {
  assert.deepEqual(validateModelOverride({
    provider: 'custom',
    modelName: 'internal-model',
    baseUrl: 'https://server-configured.example/v1',
    apiKey: 'server-managed-secret',
  }), {
    provider: 'custom',
    modelName: 'internal-model',
    baseUrl: 'https://server-configured.example/v1',
    apiKey: 'server-managed-secret',
  });
});

test('every request-facing MiroFish model configuration route uses the untrusted validator', async () => {
  const routeInputs = new Map([
    ['src/app/api/mirofish/graph/route.ts', 'body.modelOverride'],
    ['src/app/api/mirofish/ontology/route.ts', 'body.modelOverride'],
    ['src/app/api/mirofish/profile/route.ts', 'body.modelOverride'],
    ['src/app/api/mirofish/simulation/route.ts', 'body.modelOverride'],
    ['src/app/api/mirofish/report/route.ts', 'body.modelOverride'],
    ['src/app/api/mirofish/interaction/interview/route.ts', 'body.modelOverride'],
    ['src/app/api/mirofish/interaction/chat/route.ts', 'body.modelOverride'],
    ['src/app/api/mirofish/simulation/prepare/route.ts', 'body.modelOverride'],
    ['src/app/api/mirofish/project/[id]/route.ts', 'body.model_config'],
  ]);

  for (const [relativePath, inputExpression] of routeInputs) {
    const source = await readFile(path.resolve(process.cwd(), relativePath), 'utf8');
    assert.match(source, /\bvalidateHttpModelOverride\b/, relativePath);
    assert.match(source, /\bgetHttpModelOverrideErrorResponse\b/, relativePath);
    assert.equal(/\bvalidateModelOverride\b/.test(source), false, relativePath);
    assert.ok(
      source.includes(`validateHttpModelOverride(${inputExpression})`),
      relativePath
    );
  }
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
