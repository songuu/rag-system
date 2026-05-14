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
  getMiroFishOntologyCacheIdentity,
  getMiroFishProfileCacheIdentity,
} = await import('./artifact-cache.ts');

const modelOverride = {
  provider: 'ollama',
  modelName: 'qwen2.5',
  baseUrl: 'http://localhost:11434',
  temperature: 0.3,
};

test('MiroFish ontology cache identity is stable for equivalent request content', () => {
  const first = getMiroFishOntologyCacheIdentity({
    request: {
      texts: ['第一段\r\n第二段'],
      simulationRequirement: '模拟社交舆论',
      additionalContext: '额外说明',
    },
    modelOverride,
  });
  const second = getMiroFishOntologyCacheIdentity({
    request: {
      texts: ['第一段\n第二段'],
      simulationRequirement: '模拟社交舆论',
      additionalContext: '额外说明',
    },
    modelOverride,
  });

  assert.equal(first.cache_key, second.cache_key);
  assert.match(first.cache_file, /mirofish-cache[/\\][a-f0-9]{32}\.json$/);
});

test('MiroFish profile cache identity changes with model selection', () => {
  const request = {
    entity: {
      name: '张三',
      type: 'Person',
      description: '参与讨论的普通用户',
    },
    simulationContext: '围绕公共事件展开讨论',
    options: { includePosts: true },
  };
  const first = getMiroFishProfileCacheIdentity({ request, modelOverride });
  const second = getMiroFishProfileCacheIdentity({
    request,
    modelOverride: { ...modelOverride, modelName: 'qwen3' },
  });

  assert.notEqual(first.cache_key, second.cache_key);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
