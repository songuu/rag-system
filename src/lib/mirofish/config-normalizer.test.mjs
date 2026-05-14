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
  buildSimulationConfig,
  getRoundPostLimit,
  normalizeSimulationConfig,
} = await import('./config-normalizer.ts');

test('normalizeSimulationConfig clamps resource-heavy values and filters platforms', () => {
  const config = normalizeSimulationConfig({
    platforms: ['twitter', 'invalid', 'reddit', 'twitter'],
    round_count: 999,
    posts_per_round: 0,
    agents_per_round: 99,
    temperature: 9,
    seed_topics: ['  price  ', '', 'price', 'policy'],
    time_interval: 999,
  }, { profileCount: 3 });

  assert.deepEqual(config.platforms, ['twitter', 'reddit']);
  assert.equal(config.round_count, 30);
  assert.equal(config.posts_per_round, 1);
  assert.equal(config.agents_per_round, 3);
  assert.equal(config.temperature, 2);
  assert.deepEqual(config.seed_topics, ['price', 'policy']);
  assert.equal(config.time_interval, 60);
});

test('normalizeSimulationConfig provides safe defaults for empty drafts', () => {
  const config = normalizeSimulationConfig(undefined, { profileCount: 0 });

  assert.deepEqual(config.platforms, ['twitter']);
  assert.equal(config.round_count, 10);
  assert.equal(config.posts_per_round, 5);
  assert.equal(config.agents_per_round, 1);
  assert.equal(config.temperature, 0.8);
  assert.deepEqual(config.seed_topics, ['当前话题']);
  assert.equal(config.time_interval, 2);
});

test('buildSimulationConfig attaches project and simulation ids after normalization', () => {
  const config = buildSimulationConfig({ agents_per_round: 7 }, {
    projectId: 'proj_1',
    simulationId: 'sim_1',
    profileCount: 2,
  });

  assert.equal(config.project_id, 'proj_1');
  assert.equal(config.simulation_id, 'sim_1');
  assert.equal(config.agents_per_round, 2);
});

test('getRoundPostLimit keeps posts_per_round as the per-platform content cap', () => {
  assert.equal(getRoundPostLimit({ posts_per_round: 4 }, 10), 4);
  assert.equal(getRoundPostLimit({ posts_per_round: 10 }, 3), 3);
  assert.equal(getRoundPostLimit({ posts_per_round: 1 }, 0), 0);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
