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
  createMaicSourceHash,
  getMaicPrepareCacheIdentity,
} = await import('./prepare-cache.ts');
const { getMaicStageRoute } = await import('./model-routes.ts');

test('MAIC source hash preserves slide page boundaries', () => {
  const sourceText = '第一页内容\n\n第二页内容';
  const splitPagesHash = createMaicSourceHash({
    sourceText,
    pages: [
      { index: 0, raw_text: '第一页内容', description: '', key_points: [] },
      { index: 1, raw_text: '第二页内容', description: '', key_points: [] },
    ],
  });
  const mergedPageHash = createMaicSourceHash({
    sourceText,
    pages: [{ index: 0, raw_text: sourceText, description: '', key_points: [] }],
  });

  assert.notEqual(splitPagesHash, mergedPageHash);
});

test('MAIC source hash includes explicit PPT animation metadata', () => {
  const basePage = { index: 0, raw_text: '动画页', description: '', key_points: [] };
  const withoutAnimations = createMaicSourceHash({
    sourceText: '动画页',
    pages: [basePage],
  });
  const withAnimations = createMaicSourceHash({
    sourceText: '动画页',
    pages: [
      {
        ...basePage,
        animations: [
          {
            id: 'anim_1',
            elId: 'pptx-sp-4',
            effect: 'fade',
            type: 'in',
            duration: 700,
            trigger: 'click',
          },
        ],
        turning_mode: 'fade',
      },
    ],
  });

  assert.notEqual(withoutAnimations, withAnimations);
});

test('MAIC prepare cache identity is stable for the same source and model config', () => {
  const input = {
    sourceText: '稳定缓存内容',
    pages: [{ index: 0, raw_text: '稳定缓存内容', description: '', key_points: [] }],
  };

  const first = getMaicPrepareCacheIdentity(input);
  const second = getMaicPrepareCacheIdentity(input);

  assert.equal(first.cache_key, second.cache_key);
  assert.equal(first.source_hash, second.source_hash);
  assert.equal(first.source_hash, createMaicSourceHash(input));
  assert.match(first.cache_file, /maic-cache[/\\][a-f0-9]{32}\.json$/);
});

test('MAIC model routes resolve stage-specific provider/model overrides', () => {
  const previous = process.env.MAIC_MODEL_ROUTES;
  try {
    process.env.MAIC_MODEL_ROUTES = JSON.stringify({
      describe: 'ollama:qwen3.7-max',
      'maic:focus': { model: 'openrouter:deepseek/deepseek-v4-pro' },
    });

    assert.deepEqual(getMaicStageRoute('describe'), {
      raw: 'ollama:qwen3.7-max',
      provider: 'ollama',
      modelName: 'qwen3.7-max',
    });
    assert.deepEqual(getMaicStageRoute('focus'), {
      raw: 'openrouter:deepseek/deepseek-v4-pro',
      provider: 'openrouter',
      modelName: 'deepseek/deepseek-v4-pro',
    });
  } finally {
    restoreEnv('MAIC_MODEL_ROUTES', previous);
  }
});

test('MAIC prepare cache identity changes when per-stage model routes change', () => {
  const previous = process.env.MAIC_MODEL_ROUTES;
  const input = {
    sourceText: 'route sensitive content',
    pages: [{ index: 0, raw_text: 'route sensitive content', description: '', key_points: [] }],
  };

  try {
    delete process.env.MAIC_MODEL_ROUTES;
    const base = getMaicPrepareCacheIdentity(input);

    process.env.MAIC_MODEL_ROUTES = JSON.stringify({ script: 'ollama:qwen3.7-max' });
    const routed = getMaicPrepareCacheIdentity(input);

    assert.notEqual(base.cache_key, routed.cache_key);
    assert.deepEqual(routed.model_signature.stage_routes, { script: 'ollama:qwen3.7-max' });
  } finally {
    restoreEnv('MAIC_MODEL_ROUTES', previous);
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
