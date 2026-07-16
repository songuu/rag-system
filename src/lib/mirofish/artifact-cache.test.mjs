import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  getMiroFishGraphCacheIdentity,
  getMiroFishOntologyCacheIdentity,
  getMiroFishProfileCacheIdentity,
  purgeMiroFishLegacyGraphCache,
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

test('MiroFish graph cache identity includes normalized text and extraction settings', () => {
  const ontology = {
    entity_types: [
      {
        name: 'Person',
        description: 'Any person',
        attributes: [{ name: 'full_name', type: 'text', description: 'Full name' }],
        examples: ['Alice'],
      },
    ],
    edge_types: [],
    analysis_summary: 'ignored for graph cache identity',
  };
  const first = getMiroFishGraphCacheIdentity({
    request: {
      text: '第一段\r\n第二段',
      ontology,
      chunkSize: 5000,
      chunkOverlap: 300,
      batchSize: 1,
    },
    modelOverride,
  });
  const same = getMiroFishGraphCacheIdentity({
    request: {
      text: '第一段\n第二段',
      ontology,
      chunkSize: 5000,
      chunkOverlap: 300,
      batchSize: 1,
    },
    modelOverride,
  });
  const changedChunking = getMiroFishGraphCacheIdentity({
    request: {
      text: '第一段\n第二段',
      ontology,
      chunkSize: 1000,
      chunkOverlap: 100,
      batchSize: 1,
    },
    modelOverride,
  });

  assert.equal(first.cache_key, same.cache_key);
  assert.notEqual(first.cache_key, changedChunking.cache_key);
});

test('legacy graph cache cleanup removes raw graph records and preserves model caches', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mirofish-legacy-cache-'));
  const cacheDirectory = path.join(root, 'uploads', 'mirofish-cache');
  await mkdir(cacheDirectory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const graphCacheFile = path.join(cacheDirectory, 'graph.json');
  const graphTempFile = path.join(cacheDirectory, 'graph.json.123.tmp');
  const ontologyCacheFile = path.join(cacheDirectory, 'ontology.json');
  await writeFile(graphCacheFile, legacyCacheRecord('graph', {
    graph_id: 'graph-private',
    passages: [{ content: 'raw private source' }],
  }));
  await writeFile(graphTempFile, legacyCacheRecord('graph', {
    graph_id: 'graph-incomplete',
    passages: [{ content: 'raw temp source' }],
  }));
  await writeFile(ontologyCacheFile, legacyCacheRecord('ontology', {
    entity_types: [],
    edge_types: [],
    analysis_summary:
      '{"model_signature":{"version":"mirofish-llm-artifact-v1","artifact":"graph"}}',
  }));

  const result = await purgeMiroFishLegacyGraphCache(cacheDirectory);
  const repeatedResult = await purgeMiroFishLegacyGraphCache(cacheDirectory);

  assert.deepEqual(result, { scanned: 3, removed: 2 });
  assert.deepEqual(repeatedResult, result);
  await assert.rejects(readFile(graphCacheFile), { code: 'ENOENT' });
  await assert.rejects(readFile(graphTempFile), { code: 'ENOENT' });
  assert.match(await readFile(ontologyCacheFile, 'utf8'), /"artifact": "ontology"/);
});

function legacyCacheRecord(artifact, value) {
  return JSON.stringify({
    version: 'mirofish-llm-artifact-v1',
    cache_key: `${artifact}-key`,
    source_hash: `${artifact}-source`,
    model_signature: {
      version: 'mirofish-llm-artifact-v1',
      artifact,
      provider: 'ollama',
      model_name: 'test',
      base_url: '',
      temperature: 0.1,
    },
    created_at: '2026-07-15T00:00:00.000Z',
    artifact: value,
  }, null, 2);
}

test('MiroFish graph cache identity tolerates incomplete LLM-generated ontology fields', () => {
  assert.doesNotThrow(() => getMiroFishGraphCacheIdentity({
    request: {
      text: 'University incident',
      ontology: {
        entity_types: [
          {
            name: 'Student',
            description: 'Current student',
            attributes: [{ name: 'full_name' }],
            examples: ['Alice'],
          },
        ],
        edge_types: [],
        analysis_summary: '',
      },
    },
    modelOverride,
  }));
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
