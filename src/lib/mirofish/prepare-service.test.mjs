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
  createPrepareFingerprint,
  prepareMiroFishSimulation,
} = await import('./prepare-service.ts');

test('prepareMiroFishSimulation reuses an existing prepared project when fingerprint matches', async () => {
  const config = {
    platforms: ['twitter'],
    round_count: 5,
    posts_per_round: 2,
    agents_per_round: 2,
    temperature: 0.7,
    seed_topics: ['policy'],
    time_interval: 1,
  };
  const fingerprint = createPrepareFingerprint({
    projectId: 'proj_1',
    simulationRequirement: 'simulate policy reaction',
    selectedEntityIds: ['node_1', 'node_2'],
    config,
  });
  const profiles = [profile('node_1'), profile('node_2')];

  const result = await prepareMiroFishSimulation({
    project: {
      ...project(),
      agent_profiles: profiles,
      simulation_config: config,
      prepare_id: 'prep_existing',
      prepare_fingerprint: fingerprint,
      prepared_at: '2026-05-11T00:00:00.000Z',
    },
    graphNodes: [node('node_1'), node('node_2')],
    selectedEntityIds: ['node_2', 'node_1'],
    config,
  }, {
    async generateProfiles() {
      throw new Error('should not regenerate');
    },
  });

  assert.equal(result.already_prepared, true);
  assert.equal(result.prepare_id, 'prep_existing');
  assert.deepEqual(result.profiles, profiles);
});

test('prepareMiroFishSimulation uses provided profiles and creates a fresh prepare result', async () => {
  const result = await prepareMiroFishSimulation({
    project: project(),
    graphNodes: [node('node_1'), node('node_2')],
    selectedEntityIds: ['node_1'],
    providedProfiles: [profile('node_1')],
    config: { posts_per_round: 9, agents_per_round: 9, seed_topics: ['launch'] },
  }, {
    now: () => new Date('2026-05-11T08:00:00.000Z'),
    createId: () => 'prep_new',
  });

  assert.equal(result.already_prepared, false);
  assert.equal(result.prepare_id, 'prep_new');
  assert.equal(result.prepared_at, '2026-05-11T08:00:00.000Z');
  assert.deepEqual(result.profiles.map(item => item.entity_id), ['node_1']);
  assert.equal(result.config.agents_per_round, 1);
  assert.equal(result.config.posts_per_round, 9);
});

test('prepareMiroFishSimulation can force regeneration through injected profile generation', async () => {
  const result = await prepareMiroFishSimulation({
    project: {
      ...project(),
      agent_profiles: [profile('old')],
      simulation_config: {
        platforms: ['twitter'],
        round_count: 5,
        posts_per_round: 1,
        agents_per_round: 1,
        temperature: 0.7,
        seed_topics: ['old'],
        time_interval: 1,
      },
      prepare_id: 'prep_old',
      prepare_fingerprint: 'old',
      prepared_at: '2026-05-10T00:00:00.000Z',
    },
    graphNodes: [node('node_1')],
    selectedEntityIds: ['node_1'],
    forceRegenerate: true,
    config: { seed_topics: ['new'] },
  }, {
    createId: () => 'prep_forced',
    async generateProfiles(entities) {
      return entities.map(entity => profile(entity.id));
    },
  });

  assert.equal(result.already_prepared, false);
  assert.equal(result.prepare_id, 'prep_forced');
  assert.deepEqual(result.profiles.map(item => item.entity_id), ['node_1']);
});

function project() {
  return {
    id: 'proj_1',
    name: 'Project',
    description: '',
    status: 'created',
    current_step: 0,
    simulation_requirement: 'simulate policy reaction',
    texts: [],
    created_at: '2026-05-11T00:00:00.000Z',
    updated_at: '2026-05-11T00:00:00.000Z',
  };
}

function node(id) {
  return {
    uuid: id,
    name: `Entity ${id}`,
    labels: ['Person'],
    summary: `Summary ${id}`,
    attributes: {},
  };
}

function profile(id) {
  return {
    entity_id: id,
    entity_name: `Entity ${id}`,
    entity_type: 'Person',
    full_name: `Entity ${id}`,
    personality_traits: [],
    speaking_style: '',
    social_media_style: '',
    typical_posts: [],
    viewpoints: {},
    background: '',
    generated_at: '2026-05-11T00:00:00.000Z',
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
