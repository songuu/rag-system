import assert from 'node:assert/strict';
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
  OPENMAIC_LATEST_MODEL_NOTES,
  categorizeModelName,
  getModelCapabilityProfile,
} = await import('./model-catalog.ts');

test('categorizeModelName recognizes OpenMAIC latest reasoning model families', () => {
  assert.equal(categorizeModelName('deepseek/deepseek-v4-pro'), 'reasoning');
  assert.equal(categorizeModelName('Qwen3.5-4B-GGUF'), 'reasoning');
  assert.equal(categorizeModelName('gpt-oss:20b'), 'reasoning');
  assert.equal(categorizeModelName('claude-opus-4-8'), 'reasoning');
  assert.equal(categorizeModelName('qwen3.7-max'), 'reasoning');
  assert.equal(categorizeModelName('glm-5.2'), 'reasoning');
  assert.equal(categorizeModelName('kimi-k2.7-code'), 'reasoning');
  assert.equal(categorizeModelName('MiniMax-M3'), 'reasoning');
  assert.equal(categorizeModelName('claude-opus-5'), 'reasoning');
  assert.equal(categorizeModelName('claude-sonnet-5'), 'reasoning');
  assert.equal(categorizeModelName('claude-fable-5'), 'reasoning');
  assert.equal(categorizeModelName('gemini-3.6-flash'), 'reasoning');
  assert.equal(categorizeModelName('gemini-3.5-flash-lite'), 'reasoning');
  assert.equal(categorizeModelName('kimi-k3'), 'reasoning');
  assert.equal(categorizeModelName('grok-4.5'), 'reasoning');
  assert.equal(categorizeModelName('grok-4.3'), 'reasoning');
  assert.equal(categorizeModelName('grok-build-0.1'), 'reasoning');
  assert.equal(categorizeModelName('gemini-3.5-flash-embedding'), 'embedding');
  assert.equal(categorizeModelName('text-embedding-3-small'), 'embedding');
  assert.equal(categorizeModelName('llama3.1:latest'), 'llm');
});

test('categorizeModelName gives every embedding marker precedence over reasoning and llm bases', () => {
  const embeddingMarkers = ['embed', 'embedding', 'bge', 'gte', 'jina', 'e5', 'instructor'];
  const conflictingBases = [
    ['reasoning', 'claude-opus-5'],
    ['llm', 'llama3.1'],
  ];
  const conflictCases = embeddingMarkers.flatMap(marker =>
    conflictingBases.map(([baseCategory, baseName]) => ({
      marker,
      baseCategory,
      modelName: `${baseName}-${marker}`,
    }))
  );

  // Mutation guard: an embed-only shortcut must not satisfy this regression matrix.
  const legacyEmbedOnlyPredicate = modelName => modelName.toLowerCase().includes('embed');
  const markersMissedByLegacyPredicate = embeddingMarkers.filter(marker =>
    !legacyEmbedOnlyPredicate(`model-${marker}`)
  );
  assert.deepEqual(
    markersMissedByLegacyPredicate,
    ['bge', 'gte', 'jina', 'e5', 'instructor'],
    'fixtures must kill an embed-only categorization regression'
  );

  for (const { marker, baseCategory, modelName } of conflictCases) {
    assert.equal(
      categorizeModelName(modelName),
      'embedding',
      `${marker} must override the ${baseCategory} base in ${modelName}`
    );
  }
});

test('getModelCapabilityProfile exposes OpenRouter and Lemonade thinking hints', () => {
  assert.deepEqual(getModelCapabilityProfile('openrouter', 'deepseek/deepseek-v4-pro'), {
    supportsThinking: true,
    thinkingControl: 'reasoning.effort',
    openMaicLatest: true,
    status: 'supported',
  });

  assert.deepEqual(getModelCapabilityProfile('lemonade', 'custom-gpt-oss-20b-q4'), {
    supportsThinking: true,
    thinkingControl: 'chat_template_kwargs.enable_thinking',
    openMaicLatest: false,
  });
});

test('OpenMAIC latest notes keep provider-only increments documented', () => {
  assert.ok(OPENMAIC_LATEST_MODEL_NOTES.some(item => item.provider === 'bocha'));
  assert.ok(OPENMAIC_LATEST_MODEL_NOTES.some(item => item.provider === 'happyhorse'));
});

test('OpenMAIC notes document Azure STT without adding runtime ASR wiring (upstream 07115df)', () => {
  const entry = OPENMAIC_LATEST_MODEL_NOTES.find(
    item => item.provider === 'azure' && item.model === 'azure-asr-fast-transcription'
  );
  assert.ok(entry, 'Azure STT Fast Transcription should be tracked as an upstream capability');
  assert.equal(entry.category, 'audio');
  assert.equal(entry.status, 'documented');
});

// === Sprint 2026-05-25: latest parity v2 — 上游 6522780/679130a/b29efe1 同步 ===

test('OpenMAIC notes document Gemini 3.5 Flash until a Google LLM adapter exists', () => {
  const entry = OPENMAIC_LATEST_MODEL_NOTES.find(
    item => item.provider === 'google' && item.model === 'gemini-3.5-flash'
  );
  assert.ok(entry, 'gemini-3.5-flash should be in OPENMAIC_LATEST_MODEL_NOTES');
  assert.equal(entry.category, 'reasoning');
  assert.equal(entry.supportsThinking, true);
  assert.equal(entry.thinkingControl, 'thinking.level');
  assert.equal(entry.status, 'documented');
});

test('Xiaomi MiMo full model lineup matches upstream Token Plan (679130a)', () => {
  const xiaomiEntries = OPENMAIC_LATEST_MODEL_NOTES.filter(item => item.provider === 'xiaomi');
  const ids = xiaomiEntries.map(item => item.model).sort();
  assert.deepEqual(ids, [
    'mimo-v2-flash',
    'mimo-v2-omni',
    'mimo-v2-pro',
    'mimo-v2.5',
    'mimo-v2.5-pro',
  ]);
  for (const entry of xiaomiEntries) {
    assert.equal(entry.status, 'documented', `${entry.model} should remain documented`);
    assert.equal(entry.supportsThinking, true);
  }
});

test('Lemonade curated to Gemma-4 only (upstream b29efe1 removed weak models)', () => {
  const lemonadeEntries = OPENMAIC_LATEST_MODEL_NOTES.filter(item => item.provider === 'lemonade');
  assert.equal(lemonadeEntries.length, 1, 'exactly one curated lemonade model expected');
  assert.equal(lemonadeEntries[0].model, 'Gemma-4-26B-A4B-it-GGUF');
  assert.ok(
    !OPENMAIC_LATEST_MODEL_NOTES.some(item => item.model === 'Qwen3.5-4B-GGUF'),
    'weak Qwen3.5-4B-GGUF lemonade entry should be removed'
  );
});

// === Sprint 2026-06-26: OpenMAIC latest sync — upstream v0.2.2+/a88ee3d ===

test('OpenMAIC notes include v0.2.2+ model registry increments', () => {
  const expected = [
    ['anthropic', 'claude-opus-4-8'],
    ['minimax', 'MiniMax-M3'],
    ['qwen', 'qwen3.7-plus'],
    ['qwen', 'qwen3.7-max'],
    ['glm', 'glm-5.2'],
    ['kimi', 'kimi-k2.7-code'],
    ['kimi', 'kimi-k2.7-code-highspeed'],
  ];

  for (const [provider, model] of expected) {
    const entry = OPENMAIC_LATEST_MODEL_NOTES.find(item => item.provider === provider && item.model === model);
    assert.ok(entry, `${provider}:${model} should be tracked`);
    assert.equal(entry.category, 'reasoning');
    assert.equal(entry.status, 'documented');
  }
});

test('OpenMAIC notes include MiniMax web search without adding runtime search wiring', () => {
  const entry = OPENMAIC_LATEST_MODEL_NOTES.find(
    item => item.provider === 'minimax' && item.model === 'web-search'
  );
  assert.ok(entry, 'MiniMax web search should be tracked as upstream capability');
  assert.equal(entry.category, 'search');
  assert.equal(entry.status, 'documented');
});

// === Sprint 2026-07-14: OpenMAIC main 40ff80a portable increments ===

test('OpenMAIC notes document GPT-5.6 Sol, Terra, and Luna without claiming live availability', () => {
  const expectedModels = ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'];

  for (const model of expectedModels) {
    const entry = OPENMAIC_LATEST_MODEL_NOTES.find(
      item => item.provider === 'openai' && item.model === model
    );
    assert.ok(entry, `openai:${model} should be tracked`);
    assert.equal(entry.category, 'reasoning');
    assert.equal(entry.supportsThinking, true);
    assert.equal(entry.thinkingControl, 'reasoning_effort');
    assert.equal(entry.status, 'documented');
  }

  assert.deepEqual(getModelCapabilityProfile('openai', 'gpt-5.6-terra'), {
    supportsThinking: true,
    thinkingControl: 'reasoning_effort',
    openMaicLatest: true,
    status: 'documented',
  });
});

test('OpenMAIC notes document SearXNG without adding runtime search wiring', () => {
  const entry = OPENMAIC_LATEST_MODEL_NOTES.find(
    item => item.provider === 'searxng' && item.model === 'web-search'
  );
  assert.ok(entry, 'SearXNG web search should be tracked as an upstream capability');
  assert.equal(entry.category, 'search');
  assert.equal(entry.status, 'documented');
});

// === 2026-08-11: OpenMAIC #993 model registry refresh ===

test('OpenMAIC notes document the #993 reasoning models with their upstream controls', () => {
  const expected = [
    ['anthropic', 'claude-opus-5', 'effort'],
    ['anthropic', 'claude-sonnet-5', 'effort'],
    ['anthropic', 'claude-fable-5', 'effort'],
    ['google', 'gemini-3.6-flash', 'thinking.level'],
    ['google', 'gemini-3.5-flash-lite', 'thinking.level'],
    ['kimi', 'kimi-k3', 'reasoning_effort'],
    ['grok', 'grok-4.5', 'reasoning_effort'],
    ['grok', 'grok-4.3', 'reasoning_effort'],
    ['grok', 'grok-build-0.1', 'fixed'],
  ];

  for (const [provider, model, thinkingControl] of expected) {
    const entry = OPENMAIC_LATEST_MODEL_NOTES.find(
      item => item.provider === provider && item.model === model
    );
    assert.ok(entry, `${provider}:${model} should be tracked`);
    assert.equal(entry.category, 'reasoning');
    assert.equal(entry.supportsThinking, true);
    assert.equal(entry.thinkingControl, thinkingControl);
    assert.equal(entry.status, 'documented');
  }
});

test('OpenMAIC provider:model keys are unique case-insensitively', () => {
  const keys = OPENMAIC_LATEST_MODEL_NOTES.map(
    item => `${item.provider.toLowerCase()}:${item.model.toLowerCase()}`
  );
  assert.equal(new Set(keys).size, keys.length);
});

test('OpenMAIC reasoning notes always expose explicit thinking metadata', () => {
  const reasoningEntries = OPENMAIC_LATEST_MODEL_NOTES.filter(
    item => item.category === 'reasoning'
  );

  for (const entry of reasoningEntries) {
    assert.equal(entry.supportsThinking, true, `${entry.provider}:${entry.model} supportsThinking`);
    assert.equal(
      typeof entry.thinkingControl,
      'string',
      `${entry.provider}:${entry.model} thinkingControl`
    );
    assert.ok(entry.thinkingControl.length > 0, `${entry.provider}:${entry.model} thinkingControl`);
  }
});

test('every OpenMAIC reasoning note is categorized as reasoning', () => {
  const mismatches = OPENMAIC_LATEST_MODEL_NOTES
    .filter(item => item.category === 'reasoning')
    .map(item => ({
      key: `${item.provider}:${item.model}`,
      category: categorizeModelName(item.model),
    }))
    .filter(item => item.category !== 'reasoning');

  assert.deepEqual(mismatches, []);
});

const RUNTIME_SUPPORTED_MODEL_KEYS = new Set([
  'lemonade:gemma-4-26b-a4b-it-gguf',
  'openai:gpt-5.5',
  'openrouter:deepseek/deepseek-v4-flash',
  'openrouter:deepseek/deepseek-v4-pro',
]);

test('supported catalog status matches the exact runtime-verified model allowlist', () => {
  assertRuntimeSupportedCatalogEntries(OPENMAIC_LATEST_MODEL_NOTES);
});

test('runtime status guard rejects an unverified model under a supported provider', () => {
  assert.throws(
    () => assertRuntimeSupportedCatalogEntries([
      ...OPENMAIC_LATEST_MODEL_NOTES,
      {
        provider: 'OPENAI',
        model: 'future-unverified-model',
        displayName: 'Future Unverified Model',
        category: 'reasoning',
        supportsThinking: true,
        thinkingControl: 'reasoning_effort',
        status: 'supported',
      },
    ]),
    /runtime-supported model catalog drift/u
  );
});

test('catalog capability profiles expose documented versus runtime-supported status', () => {
  assert.deepEqual(getModelCapabilityProfile('google', 'gemini-3.6-flash'), {
    supportsThinking: true,
    thinkingControl: 'thinking.level',
    openMaicLatest: true,
    status: 'documented',
  });
  assert.deepEqual(getModelCapabilityProfile('openai', 'gpt-5.5'), {
    supportsThinking: true,
    thinkingControl: 'reasoning_effort',
    openMaicLatest: true,
    status: 'supported',
  });
});
function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function assertRuntimeSupportedCatalogEntries(entries) {
  const supportedModelKeys = new Set(
    entries
      .filter(item => item.status === 'supported')
      .map(item => `${item.provider.toLowerCase()}:${item.model.toLowerCase()}`)
  );
  assert.deepEqual(
    supportedModelKeys,
    RUNTIME_SUPPORTED_MODEL_KEYS,
    'runtime-supported model catalog drift'
  );
}
