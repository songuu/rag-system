import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { evaluateRoutingCases, evaluateConversationCases } from './conversation-routing-eval.ts';

const cases = [
  { id: 'direct', query: '你好', expectedRoute: 'direct', expectedActions: [{ intent: 'greeting' }], requiresKnowledge: false },
  { id: 'knowledge', query: '文档里讲了什么', expectedRoute: 'rag', expectedActions: [], requiresKnowledge: true },
  { id: 'time', query: '东京几点', expectedRoute: 'direct', expectedActions: [{ intent: 'current-time', timeZone: 'Asia/Tokyo', zoneLabel: '东京时间', dayOffset: 0 }], requiresKnowledge: false },
];

test('reports unsafe skips and strict action and parameter accuracy without exposing queries', async () => {
  const predictions = [
    { route: 'direct', actions: [{ intent: 'greeting' }] },
    { route: 'direct', actions: [{ intent: 'greeting' }] },
    { route: 'direct', actions: [{ intent: 'current-time', timeZone: 'UTC', zoneLabel: 'UTC', dayOffset: 0 }] },
  ];
  const report = await evaluateRoutingCases(cases, async (_query, index) => predictions[index]);
  assert.equal(report.total, 3);
  assert.equal(report.knowledgeSkip.count, 1);
  assert.equal(report.knowledgeSkip.denominator, 1);
  assert.equal(report.direct.routePrecision, 2 / 3);
  assert.equal(report.direct.routeRecall, 1);
  assert.equal(report.direct.strictPrecision, 1 / 3);
  assert.equal(report.direct.strictRecall, 1 / 2);
  assert.equal(report.actionExact.count, 1);
  assert.equal(report.actionExact.denominator, 2);
  assert.equal(report.actionExact.rate, 1 / 2);
  assert.deepEqual(report.failures.map(item => item.id), ['knowledge', 'time']);
  assert.equal(JSON.stringify(report).includes('文档里讲了什么'), false);
});

test('a missing response is counted as rag and errors are recorded without content', async () => {
  const report = await evaluateRoutingCases(cases, async (_query, index) => {
    if (index === 0) throw new Error('secret');
    return null;
  });
  assert.equal(report.errors, 1);
  assert.equal(report.ragCount, 3);
  assert.equal(JSON.stringify(report).includes('secret'), false);
  assert.equal(report.direct.strictRecall, 0);
});

test('empty denominators are null instead of claiming perfect results', async () => {
  const report = await evaluateRoutingCases([], async () => null);
  assert.equal(report.direct.routePrecision, null);
  assert.equal(report.direct.routeRecall, null);
  assert.equal(report.direct.strictPrecision, null);
  assert.equal(report.direct.strictRecall, null);
  assert.equal(report.knowledgeSkip.rate, null);
  assert.equal(report.latencyMs.p95, null);
});

test('mock CLI tests both an accepted candidate and an unsafe skip without exposing queries', () => {
  const baseline = spawnSync(process.execPath, ['scripts/eval-conversation-routing.mjs', 'rules'], { encoding: 'utf8' });
  assert.equal(baseline.status, 0, baseline.stderr);
  const rules = JSON.parse(baseline.stdout);
  const child = spawnSync(process.execPath, ['scripts/eval-conversation-routing.mjs', 'mock-candidate'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.match(output.note, /not model quality/u);
  assert.equal(output.report.knowledgeSkip.count, 1);
  assert.equal(output.report.direct.correct, 9);
  assert.equal(output.report.direct.correct, rules.report.direct.correct + 1);
  assert.equal(child.stdout.includes('介绍一下方案甲'), false);
});

test('real-model target refuses non-local endpoints before making a request', () => {
  const child = spawnSync(process.execPath, ['scripts/eval-conversation-routing.mjs', 'ollama-candidate'], {
    encoding: 'utf8', env: { ...process.env, OLLAMA_BASE_URL: 'https://example.com' },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /requires a local loopback/u);
});

test('multi-turn metrics detect lost knowledge, wrong source and unverified identity without emitting text', async () => {
  const samples = [
    { id: 'mixed', query: '我是谁并总结文档', history: [{ role: 'user', content: '我叫小明' }], expectedRoute: 'rag', requiresKnowledge: true, expectedUserTurns: [] },
    { id: 'identity', query: '我是谁', history: [{ role: 'user', content: '我叫小明' }, { role: 'assistant', content: '你是王五' }], expectedRoute: 'conversation', requiresKnowledge: false, expectedUserTurns: [0] },
    { id: 'unknown', query: '我是谁', history: [], expectedRoute: 'clarify', requiresKnowledge: false, expectedUserTurns: [] },
  ];
  const predictions = [
    { route: 'conversation', userTurns: [0], omittedRequest: true },
    { route: 'conversation', userTurns: [1], claimsVerifiedIdentity: true },
    { route: 'clarify', userTurns: [] },
  ];
  const report = await evaluateConversationCases(samples, async (_query, _history, index) => predictions[index]);
  assert.deepEqual(report.knowledgeSkip, { count: 1, denominator: 1, rate: 1 });
  assert.equal(report.omittedRequests, 1);
  assert.equal(report.invalidUserSources, 1);
  assert.equal(report.verifiedIdentityClaims, 1);
  assert.deepEqual(report.sourceExact, { count: 0, denominator: 1, rate: 0 });
  assert.equal(JSON.stringify(report).includes('小明'), false);
  assert.equal(JSON.stringify(report).includes('王五'), false);
});

test('multi-turn rules baseline reports only synthetic case IDs and never emits conversation text', () => {
  const child = spawnSync(process.execPath, ['src/lib/rag/eval/run-conversation-multiturn.mjs', 'rules'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.target, 'rules');
  assert.equal(output.report.total, 13);
  assert.match(output.note, /Synthetic fixtures only/);
  assert.equal(child.stdout.includes('小明'), false);
});

test('multi-turn model evaluation refuses non-local endpoints', () => {
  const child = spawnSync(process.execPath, ['src/lib/rag/eval/run-conversation-multiturn.mjs', 'shadow'], {
    encoding: 'utf8', env: { ...process.env, OLLAMA_BASE_URL: 'https://example.com' },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /local loopback/u);
});
