import assert from 'node:assert/strict';
import test from 'node:test';
const { bindPreparedProfilesToGraph: bind, bindPreparedProfileConfig: configFor } = await import('./profile-bindings.ts');
const nodes = [{ uuid: 'node-a', name: 'Student' }];
const old = { entity_id: 'Student', entity_name: 'Student', background: 'keep', custom: { saved: true } };

test('legacy name IDs upgrade only to an unambiguous one-to-one graph identity without mutating persona content', () => {
  const result = bind([old], nodes);
  assert.deepEqual(result, [{ ...old, entity_id: 'node-a' }]);
  assert.equal(old.entity_id, 'Student');
  assert.equal(result[0].custom, old.custom);
  const canonical = { ...old, entity_id: 'node-a' };
  assert.equal(bind([canonical], nodes)[0], canonical);
});
test('stale UUIDs, duplicate names and duplicate persona targets are never guessed', () => {
  const stale = { ...old, entity_id: 'old-uuid' };
  assert.equal(bind([stale], nodes)[0], stale);
  assert.equal(bind([old], [...nodes, { uuid: 'node-b', name: 'Student' }])[0], old);
  assert.deepEqual(bind([old, { ...old, entity_id: 'node-a' }], nodes).map(p => p.entity_id), ['Student', 'node-a']);
  assert.deepEqual(bind([old, old], nodes).map(p => p.entity_id), ['Student', 'Student']);
});
test('saved activity and event references upgrade with the persona while canonical settings win conflicts', () => {
  const config = { round_count: 10, policy: { agents: { Student: { activity_level: .8 } },
    events: [{ id: 'opening', agent_id: 'Student', content: 'keep' }], generation_reasoning: 'keep' } };
  const bound = bind([old], nodes);
  const result = configFor(config, [old], bound);
  assert.deepEqual(result.policy.agents, { 'node-a': { activity_level: .8 } });
  assert.equal(result.policy.events[0].agent_id, 'node-a');
  assert.equal(result.policy.events[0].content, 'keep');
  assert.equal(result.round_count, 10);
  assert.equal(config.policy.events[0].agent_id, 'Student');
  const explicit = { policy: { agents: { Student: { activity_level: .8 }, 'node-a': { activity_level: .2 } } } };
  assert.deepEqual(configFor(explicit, [old], bound).policy.agents, { 'node-a': { activity_level: .2 } });
});
