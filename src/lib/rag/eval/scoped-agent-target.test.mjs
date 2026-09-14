import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { FakeToolCallingModel } from 'langchain';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
}});
const { createScopedAgentEvalTarget } = await import('./scoped-agent-target.ts');
const { runRagEval } = await import('./runner.ts');
const { evaluateRagEvalGate } = await import('./gate.ts');
const scope = { tenantId: 'acme', corpusId: 'manual', allowedTrustLevels: ['reviewed'] };
const document = { evidenceId: 'a', documentId: 'doc-a', documentVersion: '1', ...scope,
  trustLevel: 'reviewed', source: 'a.md', content: 'Alpha is blue. '.repeat(80) };
const evidence = { ...document, id: 'a', retrievalScore: 0.9, laneId: 'scoped-fixture-lexical' };
const input = { evalCase: { query: 'Alpha color?', scope }, corpus: [document], topK: 5 };
function model(answer = 'Alpha is blue. [1]', usage = []) {
  const fake = new FakeToolCallingModel({ toolCalls: [[{ name: 'read_scoped_rag_context', args: {}, id: 'read' }], []] });
  fake.bindTools = () => fake;
  const generate = fake._generate.bind(fake);
  let index = 0;
  fake._generate = async (...args) => {
    const result = await generate(...args);
    const message = result.generations[0].message;
    message.usage_metadata = usage[index];
    if (index++ > 0) { message.content = answer; result.generations[0].text = answer; }
    return result;
  };
  return fake;
}
function target(overrides = {}) {
  return createScopedAgentEvalTarget({ id: 'scoped-agent-snapshot', mode: 'snapshot',
    retrieve: async () => [evidence], modelFactory: () => model(), ...overrides });
}

test('structured decisions preserve explicit abstention independently of text heuristics', async () => {
  const result = await target({ mode: 'iterative', decisionMode: 'structured',
    modelFactory: () => model(JSON.stringify({ action: 'abstain', query: '', answer: 'Missing the required fact.', evidenceNumbers: [] })),
  }).run(input);
  assert.equal(result.abstained, true);
  assert.equal(result.trajectory.abstainDecision, 'structured-decision');
  assert.equal(result.trajectory.decisionMode, 'structured');
  assert.equal(result.trajectory.modelCallCount, 2);
  assert.equal(result.trajectory.searchCallCount, 0);
  assert.deepEqual(result.trajectory.budgetViolations, []);
});

test('structured answer disposition overrides refusal words quoted within a factual answer', async () => {
  const result = await target({ mode: 'iterative', decisionMode: 'structured',
    modelFactory: () => model(JSON.stringify({ action: 'answer', query: '', answer: 'The phrase "current knowledge base cannot answer" is a refusal example. Alpha is blue.', evidenceNumbers: [1] })),
  }).run(input);
  assert.equal(result.abstained, false);
  assert.equal(result.trajectory.abstainDecision, 'not-abstained');
});

test('invalid structured decisions retain safe code and decision mode in failed trajectories', async () => {
  await assert.rejects(target({ mode: 'iterative', decisionMode: 'structured',
    modelFactory: () => model('malformed private content'),
  }).run(input), error => {
    assert.equal(error.code, 'RAG_AGENT_INVALID_DECISION');
    assert.equal(error.trajectory.decisionMode, 'structured');
    assert.equal(error.trajectory.modelCallCount, 2);
    assert.doesNotMatch(error.message, /malformed private/);
    return true;
  });
});

test('empty retrieval abstains without constructing or calling a model', async () => {
  const result = await target({ retrieve: async () => [], modelFactory() { throw new Error('must not construct'); } }).run(input);
  assert.equal(result.abstained, true);
  assert.equal(result.usage.generationCalls, 0);
  assert.equal(result.trajectory.abstainDecision, 'empty-context');
});
test('canonical evidence remains full while citation offsets stop at delivered prefix', async () => {
  const result = await target({ budget: { maxContextTokens: 80 } }).run(input);
  assert.equal(result.evidence[0].content, document.content);
  assert.equal(result.citations[0].startOffset, 0);
  assert.ok(result.citations[0].endOffset < document.content.length);
  assert.equal(result.trajectory.citationValidation, 'reference-only');
  assert.equal(result.trajectory.modelCallCount, 2);
  assert.equal(result.trajectory.modelResponseCount, 2);
  assert.equal(result.usage.costUsd, undefined);
});
test('unknown citations are retained as invalid metrics inputs and trajectory survives runner', async () => {
  const dataset = { schemaVersion: 'rag-eval-dataset/v2', datasetId: 'test', datasetVersion: '1', corpus: [document],
    cases: [{ id: 'case', query: input.evalCase.query, scope, tags: [], expectedAbstain: false,
      goldEvidence: [{ evidenceId: 'a', relevance: 3, spans: [{ startOffset: 0, endOffset: 14 }] }],
      expectedAnswer: { requiredFacts: [['blue']] }, allowedPolicies: ['scoped-agent-snapshot'],
      allowedLanes: ['scoped-fixture-lexical'], securityExpectations: { forbiddenEvidenceIds: [], forbiddenAnswerPatterns: ['CANARY'] } }] };
  const report = await runRagEval(dataset, target({ modelFactory: () => model('Alpha is blue. [1, 99]') }));
  assert.equal(report.cases[0].status, 'completed');
  assert.equal(report.cases[0].citations.validity, 0.5);
  assert.equal(report.cases[0].trajectory.modelResponseCount, 2);
});
test('partial token measurements are not presented as complete usage totals', async () => {
  const result = await target({ modelFactory: () => model('Alpha is blue. [1]', [{ input_tokens: 10, output_tokens: 2, total_tokens: 12 }]) }).run(input);
  assert.equal(result.usage.tokenMeasurement, 'partial');
  assert.equal(result.usage.inputTokens, undefined);
  assert.equal(result.usage.partialInputTokens, 10);
  assert.equal(result.usage.partialOutputTokens, 2);
});
test('scope and canonical identity violations fail before model use', async () => {
  await assert.rejects(target({ retrieve: async () => [{ ...evidence, tenantId: 'other' }] }).run(input), /scope/);
  await assert.rejects(target({ retrieve: async () => [{ ...evidence, content: 'forged' }] }).run(input), /canonical/);
});
test('deadline aborts non-cooperative retrieval and circuit prevents overlapping retries', async () => {
  let calls = 0;
  let receivedSignal;
  const timed = target({ budget: { maxDurationMs: 30 }, retrieve: ({ signal }) => {
    calls++; receivedSignal = signal; return new Promise(() => {});
  } });
  await assert.rejects(timed.run(input), /deadline/);
  assert.equal(receivedSignal.aborted, true);
  await assert.rejects(timed.run(input), /circuit/);
  assert.equal(calls, 1);
});
test('only explicit refusal text marks nonempty context as abstained', async () => {
  const refused = await target({ modelFactory: () => model('根据当前知识库无法回答该问题。') }).run(input);
  assert.equal(refused.abstained, true);
  assert.equal(refused.trajectory.abstainDecision, 'explicit-text-rule');
  assert.equal((await target({ modelFactory: () => model('Unrelated answer [1]') }).run(input)).abstained, false);
});

test('provider failure preserves observed call trajectory and safe runtime error code', async () => {
  const noToolModel = new FakeToolCallingModel({ toolCalls: [[]] });
  await assert.rejects(target({ modelFactory: () => noToolModel }).run(input), error => {
    assert.match(error.message, /RAG_AGENT_TOOL_REQUIRED/);
    assert.equal(error.trajectory.modelCallCount, 1);
    assert.equal(error.trajectory.modelResponseCount, 1);
    assert.equal(error.trajectory.toolCallCount, 0);
    assert.equal(error.trajectory.retrievalCallCount, 1);
    return true;
  });
});
test('reranker must retain canonical retrieved identities and complete within total deadline', async () => {
  await assert.rejects(target({ mode: 'rerank', rerank: async ({ evidence }) => [{ ...evidence[0], content: 'altered' }] }).run(input), /canonical/);
  let factoryCalls = 0;
  const hanging = target({ mode: 'rerank', budget: { maxDurationMs: 30 },
    rerank: () => new Promise(() => {}), modelFactory() { factoryCalls++; return model(); } });
  await assert.rejects(hanging.run(input), error => {
    assert.equal(error.trajectory.rerankCallCount, 1);
    assert.deepEqual(error.trajectory.budgetViolations, ['deadline']);
    return true;
  });
  assert.equal(factoryCalls, 0);
});
test('shared outer deadline aborts model construction without leaving a reusable target', async () => {
  let calls = 0;
  const controller = new AbortController();
  const hanging = target({ signal: controller.signal, modelFactory: () => { calls++; return new Promise(() => {}); } });
  const pending = hanging.run(input);
  const timer = setTimeout(() => controller.abort(new Error('[scoped-agent eval] total CLI deadline exceeded')), 20);
  try { await assert.rejects(pending, /deadline/); } finally { clearTimeout(timer); }
  await assert.rejects(hanging.run(input), /circuit/);
  assert.equal(calls, 1);
});

function iterativeModel() {
  const fake = new FakeToolCallingModel({ toolCalls: [
    [{ name: 'read_scoped_rag_context', args: {}, id: 'read' }],
    [{ name: 'search_scoped_rag_context', args: { query: 'Alpha details' }, id: 'search' }],
    [],
  ] });
  fake.bindTools = () => fake;
  const generate = fake._generate.bind(fake);
  fake._generate = async (...args) => {
    const result = await generate(...args);
    if (!result.generations[0].message.tool_calls?.length) {
      result.generations[0].message.content = 'Alpha is blue. [1]';
      result.generations[0].text = 'Alpha is blue. [1]';
    }
    return result;
  };
  return fake;
}

for (const [label, followup] of [
  ['cross-scope identity', [{ ...evidence, tenantId: 'other' }]],
  ['forged canonical content', [{ ...evidence, content: 'FORGED_CANONICAL_CONTENT' }]],
  ['duplicate IDs', [evidence, { ...evidence }]],
]) {
  test('iterative eval fails closed on follow-up ' + label, async () => {
    const create = () => {
      let retrievalCalls = 0;
      return target({ mode: 'iterative', modelFactory: iterativeModel,
        retrieve: async () => ++retrievalCalls === 1 ? [evidence] : followup });
    };
    await assert.rejects(create().run(input), error => {
      assert.equal(error.code, 'RAG_EVIDENCE_SCOPE_VIOLATION');
      assert.equal(error.trajectory.searchStopReason, 'RAG_EVIDENCE_SCOPE_VIOLATION');
      assert.equal(error.trajectory.retrievalCallCount, 2);
      assert.equal(error.trajectory.modelCallCount, 2);
      assert.equal(error.trajectory.modelResponseCount, 2);
      assert.doesNotMatch(error.message, /FORGED_CANONICAL_CONTENT/);
      return true;
    });

    const dataset = { schemaVersion: 'rag-eval-dataset/v2', datasetId: 'integrity', datasetVersion: '1',
      corpus: [document], cases: [{ id: 'followup-integrity', query: input.evalCase.query, scope, tags: [],
        expectedAbstain: false, goldEvidence: [{ evidenceId: 'a', relevance: 3,
          spans: [{ startOffset: 0, endOffset: 14 }] }], expectedAnswer: { requiredFacts: [['blue']] },
        allowedPolicies: ['scoped-agent-iterative'], allowedLanes: ['scoped-fixture-lexical'],
        securityExpectations: { forbiddenEvidenceIds: [], forbiddenAnswerPatterns: ['FORGED_CANONICAL_CONTENT'] } }] };
    const report = await runRagEval(dataset, create());
    assert.equal(report.cases[0].status, 'failed');
    assert.equal(report.summary.failedCases, 1);
    assert.equal(report.summary.completedCases, 0);
    assert.equal(report.cases[0].trajectory.searchStopReason, 'RAG_EVIDENCE_SCOPE_VIOLATION');
    const gate = evaluateRagEvalGate(report, 'e1b');
    assert.equal(gate.passed, false);
    assert.ok(gate.findings.some(finding => finding.code === 'FAILED_CASES'));
  });
}
