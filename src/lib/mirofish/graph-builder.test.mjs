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
  MiroFishGraphBuilder,
  createMiroFishGraphExtractionConfig,
} = await import('./graph-builder.ts');

test('MiroFish graph builder uses a fast extraction profile by default', () => {
  const builder = new MiroFishGraphBuilder();

  assert.equal(builder.config.chunkSize, 5000);
  assert.equal(builder.config.chunkOverlap, 300);
  assert.equal(builder.config.batchSize, 1);
});

test('MiroFish graph extraction disables gleaning to avoid doubling LLM calls', () => {
  const config = createMiroFishGraphExtractionConfig({
    chunkSize: 5000,
    chunkOverlap: 300,
  });

  assert.equal(config.chunkSize, 5000);
  assert.equal(config.chunkOverlap, 300);
  assert.equal(config.enableGleaning, false);
  assert.equal(config.maxChunkTimeout, 45000);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
