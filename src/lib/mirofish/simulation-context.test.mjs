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
  buildRoundContext,
  selectPostingAgents,
  summarizeSimulationSnapshot,
} = await import('./simulation-context.ts');

test('selectPostingAgents applies posts_per_round as a per-platform cap', () => {
  const activeAgents = ['a', 'b', 'c', 'd'];

  assert.deepEqual(selectPostingAgents(activeAgents, { posts_per_round: 2 }), ['a', 'b']);
  assert.deepEqual(selectPostingAgents(activeAgents, { posts_per_round: 9 }), activeAgents);
});

test('buildRoundContext summarizes recent posts, topics, sentiment and agent activity', () => {
  const posts = [
    post('p1', 'a1', ['policy'], 'positive'),
    post('p2', 'a2', ['policy', 'market'], 'negative'),
    post('p3', 'a1', ['market'], 'neutral'),
  ];

  const context = buildRoundContext(posts, [post('p4', 'a3', ['policy'], 'positive')], {
    maxRecentPosts: 2,
  });

  assert.deepEqual(context.recentPosts.map(item => item.id), ['p3', 'p4']);
  assert.deepEqual(context.hotTopics, ['policy', 'market']);
  assert.deepEqual(context.sentimentDistribution, { positive: 2, neutral: 1, negative: 1 });
  assert.deepEqual(context.agentActionCounts, { a1: 2, a2: 1, a3: 1 });
});

test('summarizeSimulationSnapshot returns a lightweight SSE-friendly summary', () => {
  const snapshot = {
    info: {
      agent_profiles: [{ entity_id: 'a1' }, { entity_id: 'a2' }],
    },
    posts: [post('p1', 'a1')],
    timeline: [
      {
        round: 1,
        stats: {
          total_posts: 1,
          sentiment_distribution: { positive: 1, neutral: 0, negative: 0 },
          hot_topics: ['policy'],
          active_agents: 1,
        },
      },
    ],
  };

  assert.deepEqual(summarizeSimulationSnapshot(snapshot), {
    total_posts: 1,
    timeline_count: 1,
    agent_count: 2,
    latest_round: 1,
    latest_stats: snapshot.timeline[0].stats,
  });
});

function post(id, authorId, topics = [], sentiment = 'neutral') {
  return {
    id,
    simulation_id: 'sim_1',
    platform: 'twitter',
    round: 1,
    author_id: authorId,
    author_name: authorId,
    author_type: 'Person',
    action: 'post',
    content: id,
    likes: 0,
    replies_count: 0,
    reposts: 0,
    sentiment,
    topics,
    timestamp: '2026-05-11T00:00:00.000Z',
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
