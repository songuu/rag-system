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

const { SimulationEngine } = await import('./simulation-engine.ts');

const PROFILE = {
  entity_id: 'agent-1',
  entity_name: 'Agent One',
  entity_type: 'person',
  full_name: 'Agent One',
  personality_traits: ['careful'],
  speaking_style: 'plain',
  social_media_style: 'brief',
  typical_posts: ['SAFE-FALLBACK-POST'],
  viewpoints: {},
  background: '',
  generated_at: '2026-08-11T00:00:00.000Z',
};

test('accepts exact and reasoning-wrapped simulation decision objects', async () => {
  const fixtures = [
    {
      response: '{"action":"comment","content":"Exact action","target_id":"post-1","sentiment":"positive","topics":["one"]}',
      content: 'Exact action',
      action: 'comment',
    },
    {
      response: '<reasoning>draft {"action":"like"}</reasoning>\n{"action":"quote","content":"Final action","target_id":"post-2","sentiment":"negative","topics":["two"]}',
      content: 'Final action',
      action: 'quote',
    },
  ];

  for (const fixture of fixtures) {
    const post = await createEngine(fixture.response).generateAgentAction(
      PROFILE,
      'twitter',
      ['topic'],
      [],
      1,
      'simulation-1',
    );

    assert.equal(post.content, fixture.content);
    assert.equal(post.action, fixture.action);
  }
});

test('preserves empty content for valid target-only actions', async () => {
  for (const action of ['like', 'repost', 'follow', 'upvote', 'downvote']) {
    const response = JSON.stringify({
      action,
      content: '',
      target_id: 'post-1',
      sentiment: 'neutral',
      topics: [],
    });
    const post = await generateAction(response);

    assert.equal(post.action, action);
    assert.equal(post.content, '');
    assert.equal(post.target_id, 'post-1');
  }
});

test('strict decision parsing rejects multiple objects, arrays, and truncation with a redacted error', () => {
  const secret = 'SIMULATION-RAW-SECRET-811';
  const engine = createEngine('unused');

  for (const response of [
    `{"action":"post","content":"${secret}"}{"action":"post","content":"second"}`,
    `[{"action":"post","content":"${secret}"}]`,
    `{"action":"post","content":"${secret}"`,
  ]) {
    assert.throws(
      () => engine.parseDecision(response),
      error => {
        assert.equal(error.code, 'MIROFISH_JSON_OBJECT_RESPONSE_INVALID');
        assert.doesNotMatch(String(error), new RegExp(secret));
        assert.doesNotMatch(error.stack ?? '', new RegExp(secret));
        return true;
      },
    );
  }
});

test('generateAgentAction preserves the existing fallback post semantics after strict parse failure', async () => {
  const secret = 'SIMULATION-FALLBACK-SECRET-811';

  for (const response of [
    `{"action":"post","content":"${secret}"}{"action":"post","content":"second"}`,
    `[{"action":"post","content":"${secret}"}]`,
    `{"action":"post","content":"${secret}"`,
  ]) {
    const post = await createEngine(response).generateAgentAction(
      PROFILE,
      'twitter',
      ['topic'],
      [],
      1,
      'simulation-1',
    );

    assert.equal(post.action, 'post');
    assert.equal(post.content, 'SAFE-FALLBACK-POST');
    assert.equal(post.sentiment, 'neutral');
    assert.deepEqual(post.topics, ['topic']);
    assert.doesNotMatch(JSON.stringify(post), new RegExp(secret));
  }
});

test('generateAgentAction rejects invalid decision schemas with a redacted safe fallback', async () => {
  const secret = 'SIMULATION-SCHEMA-SECRET-811';
  const baseDecision = {
    action: 'post',
    content: secret,
    target_id: null,
    sentiment: 'neutral',
    topics: [],
  };
  const invalidResponses = [
    '{}',
    JSON.stringify({ ...baseDecision, content: { secret } }),
    JSON.stringify({ ...baseDecision, action: 'comment', target_id: { secret } }),
    JSON.stringify({ ...baseDecision, content: 811 }),
    JSON.stringify({ ...baseDecision, sentiment: false }),
    JSON.stringify({ ...baseDecision, topics: [{ secret }] }),
    JSON.stringify({ ...baseDecision, topics: secret }),
    JSON.stringify({ ...baseDecision, action: 811 }),
    JSON.stringify({ ...baseDecision, action: 'delete' }),
    JSON.stringify({ ...baseDecision, sentiment: 'excited' }),
    ...['post', 'comment', 'quote', 'debate'].map(action => JSON.stringify({
      ...baseDecision,
      action,
      content: '   ',
      target_id: action === 'post' ? null : 'post-1',
      topics: [secret],
    })),
    ...['comment', 'like', 'repost', 'quote', 'follow', 'debate', 'upvote', 'downvote'].map(action => JSON.stringify({
      ...baseDecision,
      action,
      content: ['comment', 'quote', 'debate'].includes(action) ? secret : '',
      target_id: '',
    })),
  ];

  for (const response of invalidResponses) {
    const engine = createEngine(response);
    assert.throws(
      () => engine.parseDecision(response),
      error => {
        assert.doesNotMatch(String(error), new RegExp(secret));
        assert.doesNotMatch(error.stack ?? '', new RegExp(secret));
        return true;
      },
    );

    const post = await engine.generateAgentAction(
      PROFILE,
      'twitter',
      ['topic'],
      [],
      1,
      'simulation-1',
    );

    assert.equal(post.action, 'post');
    assert.equal(post.content, 'SAFE-FALLBACK-POST');
    assert.equal(post.sentiment, 'neutral');
    assert.deepEqual(post.topics, ['topic']);
    assert.doesNotMatch(JSON.stringify(post), new RegExp(secret));
  }
});

function createEngine(response) {
  const engine = Object.create(SimulationEngine.prototype);
  engine.llm = { invoke: async () => ({ content: response }) };
  return engine;
}

function generateAction(response) {
  return createEngine(response).generateAgentAction(
    PROFILE,
    'twitter',
    ['topic'],
    [],
    1,
    'simulation-1',
  );
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
