import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
}});
const { createScopedFixtureRetriever, createScopedFixtureModel, rerankScopedFixtureEvidence } = await import('./scoped-agent-fixture-provider.ts');
const { createScopedAgentEvalTarget } = await import('./scoped-agent-target.ts');
const { parseRagEvalDataset } = await import('./dataset.ts');
const dataset = parseRagEvalDataset(JSON.parse(await readFile(new URL('./fixtures/scoped-agent-v1.json', import.meta.url), 'utf8')));
const retrieve = createScopedFixtureRetriever();
function request(query, scope = dataset.cases[0].scope) { return { query, scope, corpus: dataset.corpus, topK: 2, signal: new AbortController().signal }; }
test('fixture has at least eight scoped answerability, multihop, conflict and security cases', () => {
  assert.ok(dataset.cases.length >= 8);
  for (const tag of ['multi-hop', 'conflict', 'injection', 'tenant-isolation', 'corpus-isolation', 'trust-isolation']) {
    assert.ok(dataset.cases.some(item => item.tags.includes(tag)), tag);
  }
});
test('lexical retrieval is deterministic, query-dependent and filters scope before ranking', async () => {
  const first = await retrieve(request('Aurora 备份保留'));
  assert.deepEqual(first, await retrieve(request('Aurora 备份保留')));
  assert.notDeepEqual(first.map(item => item.id), (await retrieve(request('Orion restart'))).map(item => item.id));
  for (const query of ['OTHER_TENANT_CANARY', 'OTHER_CORPUS_CANARY', 'QUARANTINE_CANARY']) assert.deepEqual(await retrieve(request(query)), []);
});
test('iterative fake follows retrieved bridge query and completes the actual additional-search path', async () => {
  const evalCase = dataset.cases.find(item => item.tags.includes('multi-hop'));
  const input = { evalCase: { query: evalCase.query, scope: evalCase.scope }, corpus: dataset.corpus, topK: 2 };
  const run = (mode, decisionMode = 'native-tools') => createScopedAgentEvalTarget({ id: `scoped-agent-${mode}`, mode, decisionMode, retrieve, rerank: rerankScopedFixtureEvidence,
    modelFactory: () => createScopedFixtureModel(), budget: { maxSearches: 2 } }).run(input);
  const baseline = await run('snapshot');
  const iterative = await run('iterative');
  assert.equal(baseline.answer.includes('林澈'), false);
  assert.equal(iterative.answer.includes('林澈'), true);
  assert.deepEqual(iterative.citations.map(item => item.evidenceId), ['qinglan-bridge', 'ops-42']);
  assert.equal(iterative.trajectory.searchCallCount, 1);
  assert.equal(iterative.trajectory.retrievalCallCount, 2);
  const structured = await run('iterative', 'structured');
  assert.deepEqual(structured.citations.map(item => item.evidenceId), ['qinglan-bridge', 'ops-42']);
  assert.equal(structured.trajectory.searchCallCount, 1);
  assert.equal(structured.trajectory.modelCallCount, 3);
  assert.equal(structured.trajectory.decisionMode, 'structured');
});
