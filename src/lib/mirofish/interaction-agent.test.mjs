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

const { InteractionAgent } = await import('./interaction-agent.ts');

const SAFE_ANSWER = '抱歉，我现在无法回答这个问题。';
const PROFILE = {
  entity_id: 'agent-1',
  entity_name: 'Agent One',
  entity_type: 'person',
  full_name: 'Agent One',
  personality_traits: ['careful'],
  speaking_style: 'plain',
  social_media_style: 'brief',
  typical_posts: [],
  viewpoints: {},
  background: '',
  generated_at: '2026-08-11T00:00:00.000Z',
};

test('accepts exact and reasoning-wrapped interview objects', async () => {
  const fixtures = [
    {
      response: '{"answer":"Exact answer","sentiment":"positive","confidence":0.9}',
      answer: 'Exact answer',
      sentiment: 'positive',
      confidence: 0.9,
    },
    {
      response: '<think>discard {"answer":"draft"}</think>\n{"answer":"Final answer","sentiment":"negative","confidence":0.7}',
      answer: 'Final answer',
      sentiment: 'negative',
      confidence: 0.7,
    },
  ];

  for (const fixture of fixtures) {
    const result = await createAgent(fixture.response).interview(PROFILE, 'Question?', []);

    assert.equal(result.answer, fixture.answer);
    assert.equal(result.sentiment, fixture.sentiment);
    assert.equal(result.confidence, fixture.confidence);
  }
});

test('normalizes invalid confidence values while preserving inclusive bounds', async () => {
  const fixtures = [
    { response: '{"answer":"Overflow","sentiment":"neutral","confidence":1e400}', confidence: 0.5 },
    { response: '{"answer":"Negative","sentiment":"neutral","confidence":-0.1}', confidence: 0.5 },
    { response: '{"answer":"Too high","sentiment":"neutral","confidence":1.1}', confidence: 0.5 },
    { response: '{"answer":"Lower bound","sentiment":"neutral","confidence":0}', confidence: 0 },
    { response: '{"answer":"Upper bound","sentiment":"neutral","confidence":1}', confidence: 1 },
  ];

  for (const fixture of fixtures) {
    const result = await createAgent(fixture.response).interview(PROFILE, 'Question?', []);

    assert.equal(result.confidence, fixture.confidence);
  }
});

test('uses the fixed safe answer for missing answers or rejected responses without leaking raw model text', async () => {
  const secret = 'INTERACTION-RAW-SECRET-811';
  const rejectedResponses = [
    `{"answer":"${secret}"}{"answer":"second"}`,
    `[{"answer":"${secret}"}]`,
    `{"answer":"${secret}"`,
    `{"sentiment":"negative","confidence":1,"private":"${secret}"}`,
  ];

  for (const response of rejectedResponses) {
    const result = await createAgent(response).interview(PROFILE, 'Question?', []);

    assert.equal(result.answer, SAFE_ANSWER);
    assert.equal(result.sentiment, 'neutral');
    assert.equal(result.confidence, 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

function createAgent(response) {
  const agent = Object.create(InteractionAgent.prototype);
  agent.llm = { invoke: async () => ({ content: response }) };
  return agent;
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
