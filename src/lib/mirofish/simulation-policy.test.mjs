import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { normalizeSimulationPolicy, rankSimulationFeed, applySimulationAction, createPlatformState, selectScheduledAgents } = await import('./simulation-policy.ts');
const profile = { entity_id: 'agent-a', entity_name: 'Alice', entity_type: 'Person' };
const post = (id, overrides = {}) => ({ id, simulation_id: 'sim', platform: 'twitter', round: 1, author_id: 'agent-a', author_name: 'Alice', author_type: 'Person', action: 'post', content: 'policy', likes: 0, replies_count: 0, reposts: 0, sentiment: 'neutral', topics: ['policy'], timestamp: '2026-11-05T08:00:00Z', ...overrides });

test('actions update historical targets, follow/mute state and remain platform isolated', () => {
  const state = createPlatformState();
  const posts = [post('old'), post('reddit', { platform: 'reddit' })];
  const like = post('like', { author_id: 'agent-b', action: 'like', target_id: 'old', content: '' });
  const first = applySimulationAction(posts, like, state);
  assert.equal(first.success, true);
  assert.equal(first.posts.find(item => item.id === 'old').likes, 1);
  assert.equal(posts[0].likes, 0);
  assert.equal(applySimulationAction(posts, { ...like, target_id: 'reddit' }, state).success, false);
  applySimulationAction(posts, { ...like, action: 'follow', target_id: 'agent-a' }, state, ['agent-a', 'agent-b']);
  assert.deepEqual(state.follows['agent-b'], ['agent-a']);
  applySimulationAction(posts, { ...like, action: 'mute', target_id: 'agent-a', platform: 'reddit' }, state, ['agent-a', 'agent-b']);
  assert.deepEqual(state.mutes['agent-b'], ['agent-a']);
});

test('configured feed weights change actual ranking and hide muted authors', () => {
  const policy = normalizeSimulationPolicy({ platform: { twitter: { recency: 0, popularity: 1, relevance: 0 } } });
  const posts = [post('new', { timestamp: '2026-11-05T09:00:00Z' }), post('popular', { likes: 20 })];
  assert.equal(rankSimulationFeed(posts, 'twitter', profile, policy, createPlatformState())[0].id, 'popular');
  const state = createPlatformState(); state.mutes[profile.entity_id] = ['agent-a'];
  assert.equal(rankSimulationFeed(posts, 'twitter', profile, policy, state).length, 0);
});

test('agent activity uses simulated hours rather than machine wall time', () => {
  const policy = normalizeSimulationPolicy({ agents: { 'agent-a': { active_hours: [8], activity_level: 1 } } });
  assert.equal(selectScheduledAgents([profile], policy, 8, 5, () => 0).length, 1);
  assert.equal(selectScheduledAgents([profile], policy, 3, 5, () => 0).length, 0);
});
test('user search resolves real names and returns original UUIDs even for silent participants',()=>{const profiles=[{entity_id:'uuid-alice',entity_name:'Alice',full_name:'Alice Smith'},{entity_id:'uuid-bob',entity_name:'Bob',full_name:'Robert'}];const result=applySimulationAction([],post('search',{platform:'reddit',action:'search_user',content:'Alice'}),createPlatformState(),profiles.map(profile=>profile.entity_id),profiles);assert.equal(result.success,true);assert.equal(result.observation,'[uuid-alice] Alice');assert.equal(result.posts.length,0);});
