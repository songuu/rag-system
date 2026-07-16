import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') {
      return nextResolve('next/server.js', context);
    }
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
  createLLMFromOverride,
  getHttpModelOverrideErrorResponse,
  validateHttpModelOverride,
  validateModelOverride,
  validatePersistedModelOverride,
  createPublicProjectProjection,
  maskModelOverride,
} = await import('./model-override.ts');
const { getProjectStore } = await import('./project-store.ts');
const { ProfileGenerator } = await import('./profile-generator.ts');
const { ChatOpenAI } = await import('@langchain/openai');
const { ChatOllama } = await import('@langchain/ollama');
const { getModelFactory } = await import('../model-config.ts');
const { NextRequest } = await import('next/server');
const { POST: prepareSimulation } = await import('../../app/api/mirofish/simulation/prepare/route.ts');
const { GET: listProjects } = await import('../../app/api/mirofish/project/route.ts');
const { GET: getProject } = await import('../../app/api/mirofish/project/[id]/route.ts');

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

test('untrusted HTTP and persisted model selectors reject malformed or ambiguous values instead of falling back', () => {
  const invalidInputs = [
    {},
    'gpt-safe',
    [],
    { provider: 'unknown', modelName: 'test' },
    { provider: 'openai', modelName: '' },
    { provider: 'openai', modelName: 'x'.repeat(201) },
    { provider: 'openai', modelName: 'safe\nforged' },
    { provider: 'openai', modelName: 'safe\u007fforged' },
    { provider: 'openai', modelName: 'safe\u0085forged' },
    { provider: 'openai', modelName: 'safe\u2028forged' },
    { provider: 'openai', modelName: 'test', temperature: Number.NaN },
    { provider: 'openai', modelName: 'test', temperature: 3 },
    { provider: 'openai', modelName: 'test', model_name: 'typo' },
  ];

  for (const input of invalidInputs) {
    for (const validate of [validateHttpModelOverride, validatePersistedModelOverride]) {
      assert.throws(
        () => validate(input),
        error => {
          const response = getHttpModelOverrideErrorResponse(error);
          assert.equal(response?.status, 400);
          assert.equal(response?.body.code, 'MIROFISH_HTTP_MODEL_OVERRIDE_INVALID');
          assert.doesNotMatch(JSON.stringify(response), /safe|forged|unknown|typo/);
          return true;
        }
      );
    }
  }
});

test('public project projection never reflects endpoint or credential fields from historical records', () => {
  const secretUrl = 'http://169.254.169.254/latest/meta-data';
  const projection = createPublicProjectProjection({
    id: 'project_legacy',
    name: 'Legacy',
    description: '',
    status: 'created',
    current_step: 0,
    simulation_requirement: 'test',
    texts: [],
    model_config: {
      provider: 'custom',
      modelName: 'legacy',
      baseUrl: secretUrl,
      apiKey: 'historical-secret',
    },
    created_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(projection.model_config, undefined);
  assert.doesNotMatch(JSON.stringify(projection), /169\.254\.169\.254|historical-secret/);
});

test('prepare HTTP boundary rejects poisoned historical model config before provider or generator use', async t => {
  const store = getProjectStore();
  const secretUrl = 'http://169.254.169.254/latest/meta-data';
  const project = store.create({
    name: 'Legacy project',
    simulation_requirement: 'simulate reaction',
  });

  let generatorCalls = 0;
  let providerCalls = 0;
  const logs = [];
  const originalGenerateProfiles = ProfileGenerator.prototype.generateProfiles;
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  ProfileGenerator.prototype.generateProfiles = async () => {
    generatorCalls += 1;
    return [];
  };
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('provider must not run');
  };
  console.error = (...args) => logs.push(args.map(String).join(' '));
  console.warn = (...args) => logs.push(args.map(String).join(' '));
  t.after(() => {
    store.delete(project.id);
    ProfileGenerator.prototype.generateProfiles = originalGenerateProfiles;
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  const invalidResponse = await prepareSimulation(new NextRequest(
    'http://localhost/api/mirofish/simulation/prepare',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        modelOverride: { provider: 'openai', modelName: 'safe\nforged' },
        graphNodes: [{
          uuid: 'node_1',
          name: 'Entity 1',
          labels: ['Person'],
          summary: 'Entity 1',
          attributes: {},
        }],
      }),
    }
  ));
  const invalidPayload = await invalidResponse.json();
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalidPayload.code, 'MIROFISH_HTTP_MODEL_OVERRIDE_INVALID');
  assert.equal(generatorCalls, 0);
  assert.equal(providerCalls, 0);
  assert.doesNotMatch(JSON.stringify(invalidPayload), /safe|forged/);

  store.update(project.id, {
    model_config: {
      provider: 'custom',
      modelName: 'legacy-model',
      baseUrl: secretUrl,
      apiKey: 'historical-secret',
    },
  });

  const response = await prepareSimulation(new NextRequest(
    'http://localhost/api/mirofish/simulation/prepare',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        graphNodes: [{
          uuid: 'node_1',
          name: 'Entity 1',
          labels: ['Person'],
          summary: 'Entity 1',
          attributes: {},
        }],
      }),
    }
  ));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.code, 'MIROFISH_HTTP_MODEL_OVERRIDE_FORBIDDEN');
  assert.equal(generatorCalls, 0);
  assert.equal(providerCalls, 0);
  assert.doesNotMatch(JSON.stringify(payload), /169\.254\.169\.254|historical-secret/);
  assert.doesNotMatch(logs.join('\n'), /169\.254\.169\.254|historical-secret/);

  const [detailResponse, listResponse] = await Promise.all([
    getProject(new NextRequest(`http://localhost/api/mirofish/project/${project.id}`), {
      params: Promise.resolve({ id: project.id }),
    }),
    listProjects(),
  ]);
  const detailPayload = await detailResponse.json();
  const listPayload = await listResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(listResponse.status, 200);
  assert.equal(detailPayload.project.model_config, undefined);
  assert.equal(
    listPayload.projects.find(candidate => candidate.id === project.id)?.model_config,
    undefined
  );
  assert.doesNotMatch(
    JSON.stringify({ detailPayload, listPayload }),
    /169\.254\.169\.254|historical-secret/
  );
});

test('trusted internal model normalization still supports server-managed endpoints and credentials', () => {
  const trustedOverride = validateModelOverride({
    provider: 'custom',
    modelName: 'internal-model',
    baseUrl: 'https://server-configured.example/v1',
    apiKey: 'server-managed-secret',
  });
  assert.deepEqual(trustedOverride, {
    provider: 'custom',
    modelName: 'internal-model',
    baseUrl: 'https://server-configured.example/v1',
    apiKey: 'server-managed-secret',
  });
  assert.deepEqual(maskModelOverride(trustedOverride ?? undefined), {
    provider: 'custom',
    modelName: 'internal-model',
    hasApiKey: true,
    hasBaseUrl: true,
  });
  assert.doesNotMatch(
    JSON.stringify(maskModelOverride(trustedOverride ?? undefined)),
    /server-configured\.example|server-managed-secret/
  );
});

test('safe selectors construct real provider clients from server configuration while trusted overrides remain explicit', () => {
  const environmentKeys = [
    'MODEL_PROVIDER',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CUSTOM_API_KEY',
    'CUSTOM_BASE_URL',
    'OLLAMA_BASE_URL',
  ];
  const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  const originalConsoleLog = console.log;
  const logs = [];
  const factory = getModelFactory();

  try {
    process.env.MODEL_PROVIDER = 'ollama';
    process.env.OPENAI_API_KEY = 'server-openai-secret';
    process.env.OPENAI_BASE_URL = 'https://server-openai.example/v1';
    process.env.CUSTOM_API_KEY = 'server-custom-secret';
    process.env.CUSTOM_BASE_URL = 'https://server-custom.example/v1';
    process.env.OLLAMA_BASE_URL = 'http://server-ollama.internal:11434';
    console.log = (...args) => logs.push(args.map(String).join(' '));
    factory.reloadConfig();

    const openAiSelector = validateHttpModelOverride({
      provider: 'openai',
      modelName: 'server-selected-openai',
      temperature: 0.2,
    });
    const customSelector = validateHttpModelOverride({
      provider: 'custom',
      modelName: 'server-selected-custom',
    });
    const ollamaSelector = validateHttpModelOverride({
      provider: 'ollama',
      modelName: 'server-selected-ollama',
    });
    assert.ok(openAiSelector && customSelector && ollamaSelector);

    const openAiModel = createLLMFromOverride(openAiSelector);
    const customModel = createLLMFromOverride(customSelector);
    const ollamaModel = createLLMFromOverride(ollamaSelector, {
      ollamaOptions: { num_ctx: 4096 },
    });
    const trustedModel = createLLMFromOverride({
      provider: 'openai',
      modelName: 'trusted-openai',
      apiKey: 'trusted-explicit-secret',
      baseUrl: 'https://trusted-explicit.example/v1',
    });

    assert.ok(openAiModel instanceof ChatOpenAI);
    assert.equal(openAiModel.model, 'server-selected-openai');
    assert.equal(openAiModel.clientConfig.apiKey, 'server-openai-secret');
    assert.equal(openAiModel.clientConfig.baseURL, 'https://server-openai.example/v1');
    assert.ok(customModel instanceof ChatOpenAI);
    assert.equal(customModel.model, 'server-selected-custom');
    assert.equal(customModel.clientConfig.apiKey, 'server-custom-secret');
    assert.equal(customModel.clientConfig.baseURL, 'https://server-custom.example/v1');
    assert.ok(ollamaModel instanceof ChatOllama);
    assert.equal(ollamaModel.model, 'server-selected-ollama');
    assert.equal(ollamaModel.baseUrl, 'http://server-ollama.internal:11434');
    assert.equal(ollamaModel.numCtx, 4096);
    assert.ok(trustedModel instanceof ChatOpenAI);
    assert.equal(trustedModel.clientConfig.apiKey, 'trusted-explicit-secret');
    assert.equal(trustedModel.clientConfig.baseURL, 'https://trusted-explicit.example/v1');
    assert.doesNotMatch(
      logs.join('\n'),
      /server-openai-secret|server-custom-secret|trusted-explicit-secret|server-custom\.example/
    );
  } finally {
    console.log = originalConsoleLog;
    for (const key of environmentKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    factory.reloadConfig();
  }
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

  const prepareRoute = await readFile(
    path.resolve(process.cwd(), 'src/app/api/mirofish/simulation/prepare/route.ts'),
    'utf8'
  );
  const prepareService = await readFile(
    path.resolve(process.cwd(), 'src/lib/mirofish/prepare-service.ts'),
    'utf8'
  );
  assert.match(prepareRoute, /validatePersistedModelOverride\(project\.model_config\)/);
  assert.match(prepareService, /validatePersistedModelOverride\(input\.project\.model_config\)/);
  assert.doesNotMatch(prepareRoute, /\?\?\s*project\.model_config/);
  assert.doesNotMatch(prepareService, /\?\?\s*input\.project\.model_config/);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
