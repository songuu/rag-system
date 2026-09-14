import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

import { FakeToolCallingModel } from 'langchain';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { traceable } from 'langsmith/traceable';

const { composeEvidenceContextV2 } = await import('../core/context-composer.ts');
const {
  SCOPED_RETRIEVAL_AGENT_PROMPT_VERSION,
  ScopedRetrievalAgentError,
  invokeScopedRetrievalAgent,
} = await import('./scoped-retrieval-agent.ts');

const scope = {
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['trusted', 'reviewed', 'external'],
  enforceIsolation: true,
};

function contextPack(includedEvidence, excludedEvidenceIds = []) {
  const pack = composeEvidenceContextV2(includedEvidence, {
    maxTokens: 4_000,
    includeScores: true,
    includeStructure: true,
    order: 'retrieval',
    scope,
  });
  return {
    ...pack,
    excludedEvidenceIds,
    truncated: excludedEvidenceIds.length > 0,
  };
}

function evidence(id, content, score) {
  return {
    id,
    tenantId: scope.tenantId,
    corpusId: scope.corpusId,
    documentId: `doc-${id}`,
    documentVersion: 'v1',
    content,
    source: `${id}.md`,
    retrievalScore: score,
    trustLevel: 'reviewed',
    laneId: 'dense-vector-required',
  };
}

function fakeModel(toolCalls) {
  return new FakeToolCallingModel({ toolCalls });
}


function answerModel(answer, usageByResponse = []) {
  const model = fakeModel([
    [{ name: 'read_scoped_rag_context', args: {}, id: 'call-answer' }],
    [],
  ]);
  model.bindTools = () => model;
  const generate = model._generate.bind(model);
  let responseIndex = 0;
  model._generate = async (...args) => {
    const result = await generate(...args);
    const message = result.generations[0].message;
    message.usage_metadata = usageByResponse[responseIndex];
    if (responseIndex > 0) {
      message.content = answer;
      result.generations[0].text = answer;
    }
    responseIndex += 1;
    return result;
  };
  return model;
}

function invokeAnswer(answer, usageByResponse = [], pack = contextPack([
  evidence('evidence-1', 'First fact.', 0.9),
  evidence('evidence-2', 'Second fact.', 0.8),
])) {
  return invokeScopedRetrievalAgent({
    model: answerModel(answer, usageByResponse),
    question: 'Answer from scoped evidence',
    contextPack: pack,
    scope,
    traceId: 'trace-diagnostics',
  });
}

test('createAgent versions the numbered citation prompt and measures returned model responses', async () => {
  const result = await invokeAnswer('First fact. [1]', [
    { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
    { input_tokens: 70, output_tokens: 12, total_tokens: 82 },
  ]);
  assert.equal(SCOPED_RETRIEVAL_AGENT_PROMPT_VERSION, 'scoped-rag-answer-v3');
  assert.equal(result.runtime, 'langchain-create-agent-v1');
  assert.deepEqual(result.diagnostics, {
    version: 'scoped-agent-diagnostics-v1',
    modelResponseCount: 2,
    usage: {
      measurement: 'provider',
      measuredModelResponses: 2,
      inputTokenCount: 100,
      outputTokenCount: 20,
    },
    citations: {
      validation: 'reference-only',
      status: 'valid',
      citationCount: 1,
      invalidCitationCount: 0,
      citedEvidenceIds: ['evidence-1'],
    },
  });
});

for (const [name, answer, expected] of [
  ['missing', 'The current knowledge base cannot answer.', {
    status: 'missing', citationCount: 0, invalidCitationCount: 0, citedEvidenceIds: [],
  }],
  ['invalid', 'Invented references. [0] [3] [9999999999999999999999999]', {
    status: 'invalid', citationCount: 3, invalidCitationCount: 3, citedEvidenceIds: [],
  }],
  ['repeated and grouped', 'Both facts. [1, 2] Again. [1，2] Once more. [1]', {
    status: 'valid', citationCount: 5, invalidCitationCount: 0,
    citedEvidenceIds: ['evidence-1', 'evidence-2'],
  }],
  ['mixed', 'First fact and an unsupported source. [1, 90] [2]', {
    status: 'invalid', citationCount: 3, invalidCitationCount: 1,
    citedEvidenceIds: ['evidence-1', 'evidence-2'],
  }],
]) {
  test(`createAgent reports ${name} citation references without blocking the answer`, async () => {
    const result = await invokeAnswer(answer);
    assert.equal(result.answer, answer);
    assert.deepEqual(result.diagnostics.citations, {
      validation: 'reference-only',
      ...expected,
    });
    assert.equal(JSON.stringify(result.diagnostics).includes(answer), false);
  });
}

test('createAgent excludes Markdown code, links, images and escaped brackets from citation references', async () => {
  const answer = [
    'Actual fact. [1]',
    '`[9]` and ``code `[8]` code``',
    '```javascript',
    'const values = [7];',
    '```',
    '~~~text',
    '[6]',
    '~~~',
    '    [5]',
    '[4](https://example.test) ![3](image.png) [2][source] ![2][source]',
    '[source]: https://example.test',
    '[2]: https://example.test',
    '\\[9] and \\[8\\]',
  ].join('\n');
  const result = await invokeAnswer(answer);
  assert.deepEqual(result.diagnostics.citations, {
    validation: 'reference-only', status: 'valid', citationCount: 1,
    invalidCitationCount: 0, citedEvidenceIds: ['evidence-1'],
  });
});


for (const [name, answer, count, ids] of [
  ['adjacent numeric citations', 'Facts. [1][2]', 2, ['evidence-1', 'evidence-2']],
  ['undefined reference labels', 'First fact. [1] Another. [1][ref] Second. [2]', 3, ['evidence-1', 'evidence-2']],
  ['defined reference links', 'Fact. [1] Links. [1][ref] [1][2]\n\n[ref]: https://example.test\n[2]: https://example.test', 1, ['evidence-1']],
  ['ordinary Markdown link URLs', 'See [details](https://example.test/search?q=[99]). Known fact. [1]', 1, ['evidence-1']],
  ['unterminated inline code', 'A literal \x60 remains unclosed. Known fact. [1]\nSecond fact. [2]', 2, ['evidence-1', 'evidence-2']],
  ['multiline inline code', 'Code \x60[99]\n[88]\x60. Known fact. [1]', 1, ['evidence-1']],
  ['definitions inside fenced code', 'Facts. [1][2]\n\x60\x60\x60\n[2]: https://example.test\n\x60\x60\x60', 2, ['evidence-1', 'evidence-2']],
]) {
  test(`createAgent distinguishes ${name} when counting citation references`, async () => {
    const result = await invokeAnswer(answer);
    assert.deepEqual(result.diagnostics.citations, {
      validation: 'reference-only', status: 'valid', citationCount: count,
      invalidCitationCount: 0, citedEvidenceIds: ids,
    });
  });
}

test('createAgent counts citations in indented nested Markdown list items', async () => {
  const result = await invokeAnswer('- Parent\n    - Known fact. [99]\n    - Scoped fact. [1]');
  assert.deepEqual(result.diagnostics.citations, {
    validation: 'reference-only', status: 'invalid', citationCount: 2,
    invalidCitationCount: 1, citedEvidenceIds: ['evidence-1'],
  });
});


test('createAgent keeps standalone indented list-shaped code out of citation diagnostics', async () => {
  const result = await invokeAnswer('Known fact. [1]\n\n    - literal array [99]');
  assert.deepEqual(result.diagnostics.citations, {
    validation: 'reference-only', status: 'valid', citationCount: 1,
    invalidCitationCount: 0, citedEvidenceIds: ['evidence-1'],
  });
});

test('createAgent maps citations to the composed order and excludes truncated evidence', async () => {
  const laterPage = { ...evidence('page-2', 'Later page.', 0.99), documentId: 'doc', page: 2 };
  const firstPage = { ...evidence('page-1', 'First page.', 0.7), documentId: 'doc', page: 1 };
  const excludedPage = { ...evidence('page-3', 'Excluded page.', 0.6), documentId: 'doc', page: 3 };
  const expectedPack = composeEvidenceContextV2([firstPage, laterPage], { order: 'document', scope });
  const pack = composeEvidenceContextV2([laterPage, excludedPage, firstPage], {
    order: 'document', scope, maxTokens: expectedPack.context.length,
    estimateTokens: text => text.length,
  });
  assert.equal(pack.truncated, true);
  assert.deepEqual(pack.includedEvidenceIds, ['page-1', 'page-2']);
  const result = await invokeAnswer('Later page. [2] First page. [1] Missing page. [3]', [], pack);
  assert.deepEqual(result.diagnostics.citations, {
    validation: 'reference-only', status: 'invalid', citationCount: 3,
    invalidCitationCount: 1, citedEvidenceIds: ['page-2', 'page-1'],
  });
});

for (const [name, usage, expected] of [
  ['no provider usage', [], { measurement: 'unavailable', measuredModelResponses: 0 }],
  ['one measured response', [{ input_tokens: 10, output_tokens: 0 }], {
    measurement: 'partial', measuredModelResponses: 1, inputTokenCount: 10, outputTokenCount: 0,
  }],
  ['one missing dimension', [{ input_tokens: 10 }, { input_tokens: 20, output_tokens: 3 }], {
    measurement: 'partial', measuredModelResponses: 2, inputTokenCount: 30, outputTokenCount: 3,
  }],
  ['invalid provider values', [
    { input_tokens: -1, output_tokens: Number.NaN },
    { input_tokens: Number.POSITIVE_INFINITY, output_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ], { measurement: 'unavailable', measuredModelResponses: 0 }],
  ['unsafe total', [
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 2 },
  ], { measurement: 'partial', measuredModelResponses: 2, outputTokenCount: 3 }],
]) {
  test(`createAgent reports ${name} without inventing complete token totals`, async () => {
    const result = await invokeAnswer('First fact. [1]', usage);
    assert.equal(result.diagnostics.modelResponseCount, 2);
    assert.deepEqual(result.diagnostics.usage, expected);
  });
}

test('createAgent executes the scoped evidence tool and feeds its result back to the model', async () => {
  const result = await invokeScopedRetrievalAgent({
    model: fakeModel([
      [{
        name: 'read_scoped_rag_context',
        args: {},
        id: 'call-1',
      }],
      [],
    ]),
    question: 'What is alpha?',
    contextPack: contextPack(
      [evidence('evidence-1', 'Alpha is the first letter.', 0.91)],
      ['evidence-2']
    ),
    scope,
    traceId: 'trace-1',
    threadId: 'thread-1',
  });

  assert.equal(result.toolCallCount, 1);
  assert.deepEqual(result.servedEvidenceIds, ['evidence-1']);
  assert.match(result.answer, /Alpha is the first letter/);
  assert.deepEqual(
    result.messages.map(message => message.getType()),
    ['human', 'ai', 'tool', 'ai']
  );
  assert.deepEqual(
    result.workflowSteps.map(step => [step.step, step.type, step.status]),
    [
      ['agent_model_request_tool', 'llm', 'completed'],
      ['read_scoped_rag_context', 'tool', 'completed'],
      ['agent_model_answer', 'llm', 'completed'],
    ]
  );
  assert.equal(result.totalDuration >= 0, true);
  const toolMessage = result.messages.find(message => message.getType() === 'tool');
  assert.match(String(toolMessage?.content), /evidence-1/);
  assert.doesNotMatch(String(toolMessage?.content), /evidence-2/);
});

test('createAgent replaces an upload-capable tracer while retaining local callbacks', async () => {
  let externalCreateCalls = 0;
  let externalUpdateCalls = 0;
  let localChainStarts = 0;
  const enclosingRuns = [];
  const externalTracer = new LangChainTracer({
    projectName: 'must-not-receive-private-agent-runs',
    client: {
      async createRun() { externalCreateCalls += 1; },
      async updateRun() { externalUpdateCalls += 1; },
    },
  });
  const localCallback = {
    name: 'local-agent-capture',
    handleChainStart() { localChainStarts += 1; },
  };

  const invokeInsideUploadCapableParent = traceable(
    () => invokeScopedRetrievalAgent({
      model: fakeModel([
        [{
          name: 'read_scoped_rag_context',
          args: {},
          id: 'call-private-tracer',
        }],
        [],
      ]),
      question: 'Keep this evidence private',
      contextPack: contextPack([
        evidence('evidence-private', 'Tenant-private evidence.', 0.95),
      ]),
      scope,
      traceId: 'trace-private-tracer',
      callbacks: [externalTracer, localCallback],
    }),
    {
      name: 'upload-capable-direct-agent-parent',
      tracingEnabled: true,
      client: {
        async createRun(run) { enclosingRuns.push(structuredClone(run)); },
        async updateRun() {},
      },
      processInputs: () => ({}),
      processOutputs: () => ({}),
    }
  );
  const result = await invokeInsideUploadCapableParent();

  assert.equal(result.toolCallCount, 1);
  assert.equal(externalCreateCalls, 0);
  assert.equal(externalUpdateCalls, 0);
  assert.equal(localChainStarts > 0, true);
  assert.equal(enclosingRuns.length, 1);
  assert.equal(
    JSON.stringify(enclosingRuns).includes('Tenant-private evidence.'),
    false
  );
});

test('createAgent serves the validated snapshot even if the caller mutates its pack in flight', async () => {
  const pack = contextPack([evidence('evidence-1', 'Original scoped fact.', 0.9)]);
  const model = fakeModel([
    [{ name: 'read_scoped_rag_context', args: {}, id: 'call-snapshot' }],
    [],
  ]);
  const originalBindTools = model.bindTools.bind(model);
  let notifyModelStarted;
  let releaseModel;
  const modelStarted = new Promise(resolve => { notifyModelStarted = resolve; });
  const modelReleased = new Promise(resolve => { releaseModel = resolve; });
  model.bindTools = tools => {
    const bound = originalBindTools(tools);
    const originalGenerate = bound._generate.bind(bound);
    let generationCount = 0;
    bound._generate = async (...args) => {
      if (generationCount === 0) {
        notifyModelStarted();
        await modelReleased;
      }
      generationCount += 1;
      return originalGenerate(...args);
    };
    return bound;
  };

  const pending = invokeScopedRetrievalAgent({
    model,
    question: 'Read the immutable snapshot',
    contextPack: pack,
    scope,
    traceId: 'trace-snapshot-race',
  });
  await modelStarted;
  pack.context += '\n\nInjected after validation.';
  pack.includedEvidenceIds[0] = 'mutated-evidence';
  pack.includedEvidenceIds.push('injected-evidence');
  releaseModel();

  const result = await pending;
  const toolMessage = result.messages.find(message => message.getType() === 'tool');
  assert.match(String(toolMessage?.content), /Original scoped fact/);
  assert.doesNotMatch(String(toolMessage?.content), /Injected after validation/);
  assert.doesNotMatch(String(toolMessage?.content), /injected-evidence/);
  assert.deepEqual(result.diagnostics.citations.citedEvidenceIds, ['evidence-1']);
  assert.deepEqual(result.servedEvidenceIds, ['evidence-1']);
});

test('createAgent fails closed when the model skips the required retrieval tool', async () => {
  await assert.rejects(
    () => invokeScopedRetrievalAgent({
      model: fakeModel([[]]),
      question: 'Answer without evidence',
      contextPack: contextPack([evidence('evidence-1', 'Scoped fact.', 0.9)]),
      scope,
      traceId: 'trace-no-tool',
    }),
    error => {
      assert(error instanceof ScopedRetrievalAgentError);
      assert.equal(error.code, 'RAG_AGENT_TOOL_REQUIRED');
      return true;
    }
  );
});

test('createAgent fails before invocation when the model adapter lacks tool calling', async () => {
  const model = fakeModel([[]]);
  model.bindTools = undefined;

  await assert.rejects(
    () => invokeScopedRetrievalAgent({
      model,
      question: 'Use an unsupported model adapter',
      contextPack: contextPack([evidence('evidence-1', 'Scoped fact.', 0.9)]),
      scope,
      traceId: 'trace-no-bind-tools',
    }),
    error => {
      assert(error instanceof ScopedRetrievalAgentError);
      assert.equal(error.code, 'RAG_AGENT_MODEL_TOOL_CALLING_REQUIRED');
      return true;
    }
  );
});

test('createAgent rejects a second retrieval tool call in the same run', async () => {
  await assert.rejects(
    () => invokeScopedRetrievalAgent({
      model: fakeModel([
        [{
          name: 'read_scoped_rag_context',
          args: {},
          id: 'call-1',
        }],
        [{
          name: 'read_scoped_rag_context',
          args: {},
          id: 'call-2',
        }],
      ]),
      question: 'Keep searching forever',
      contextPack: contextPack([evidence('evidence-1', 'Scoped fact.', 0.9)]),
      scope,
      traceId: 'trace-limit',
    }),
    error => {
      assert(error instanceof ScopedRetrievalAgentError);
      assert.equal(error.code, 'RAG_AGENT_TOOL_LIMIT');
      return true;
    }
  );
});

test('createAgent rejects a valid and unknown tool requested in the same model turn', async () => {
  await assert.rejects(
    () => invokeScopedRetrievalAgent({
      model: fakeModel([[
        { name: 'read_scoped_rag_context', args: {}, id: 'call-valid' },
        { name: 'unknown_tool', args: {}, id: 'call-unknown' },
      ]]),
      question: 'Call extra tools',
      contextPack: contextPack([evidence('evidence-1', 'Scoped fact.', 0.9)]),
      scope,
      traceId: 'trace-mixed-tools',
    }),
    error => {
      assert(error instanceof ScopedRetrievalAgentError);
      assert.equal(error.code, 'RAG_AGENT_TOOL_LIMIT');
      return true;
    }
  );
});

test('createAgent counts unknown tool requests against the single-tool budget', async () => {
  await assert.rejects(
    () => invokeScopedRetrievalAgent({
      model: fakeModel([
        [{ name: 'unknown_tool', args: {}, id: 'unknown-1' }],
        [{ name: 'unknown_tool', args: {}, id: 'unknown-2' }],
      ]),
      question: 'Use a tool that is not registered',
      contextPack: contextPack([evidence('evidence-1', 'Scoped fact.', 0.9)]),
      scope,
      traceId: 'trace-max-steps',
    }),
    error => {
      assert(error instanceof ScopedRetrievalAgentError);
      assert.equal(error.code, 'RAG_AGENT_TOOL_LIMIT');
      return true;
    }
  );
});

test('createAgent honors an already aborted request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));

  await assert.rejects(
    () => invokeScopedRetrievalAgent({
      model: fakeModel([[]]),
      question: 'Cancelled request',
      contextPack: contextPack([evidence('evidence-1', 'Scoped fact.', 0.9)]),
      scope,
      traceId: 'trace-aborted',
      signal: controller.signal,
    }),
    /cancelled/
  );
});

test('createAgent propagates cancellation between the tool result and final model call', async () => {
  const controller = new AbortController();
  const model = fakeModel([
    [{ name: 'read_scoped_rag_context', args: {}, id: 'call-1' }],
    [],
  ]);
  model.bindTools = () => model;
  const generate = model._generate.bind(model);
  model._generate = async (messages, ...rest) => {
    if (messages.some(message => message.getType() === 'tool')) {
      controller.abort(new Error('mid-flight cancellation'));
    }
    return generate(messages, ...rest);
  };

  await assert.rejects(
    () => invokeScopedRetrievalAgent({
      model,
      question: 'Cancel after retrieval',
      contextPack: contextPack([evidence('evidence-1', 'Scoped fact.', 0.9)]),
      scope,
      traceId: 'trace-mid-abort',
      signal: controller.signal,
    }),
    /mid-flight cancellation/
  );
});

test('createAgent rejects a context snapshot outside the server-derived scope', async () => {
  const mismatchedPack = contextPack([
    evidence('evidence-1', 'Cross-tenant secret.', 0.9),
  ]);
  mismatchedPack.includedEvidence[0].tenantId = 'tenant-b';

  await assert.rejects(
    () => invokeScopedRetrievalAgent({
      model: fakeModel([[]]),
      question: 'Read another tenant',
      contextPack: mismatchedPack,
      scope,
      traceId: 'trace-scope',
    }),
    /tenant scope mismatch/
  );
});

test('createAgent rejects extra text appended outside the canonical context snapshot', async () => {
  const pack = contextPack([evidence('evidence-1', 'Scoped fact.', 0.9)]);
  pack.context += '\n\nUnscoped injected text.';

  await assert.rejects(
    () => invokeScopedRetrievalAgent({
      model: fakeModel([[]]),
      question: 'Read injected text',
      contextPack: pack,
      scope,
      traceId: 'trace-context-injection',
    }),
    /canonical snapshot mismatch/
  );
});

function iterativeModel(toolCalls, answer = 'Expanded answer. [1] [2]') {
  const model = fakeModel(toolCalls);
  model.bindTools = () => model;
  const generate = model._generate.bind(model);
  model._generate = async (...args) => {
    const response = await generate(...args);
    if (!(response.generations[0].message.tool_calls?.length)) {
      response.generations[0].message.content = answer;
      response.generations[0].text = answer;
    }
    return response;
  };
  return model;
}
const readCall = () => ({ name: 'read_scoped_rag_context', args: {}, id: 'read-initial' });
const searchCall = (query, id = 'search-' + query) => ({ name: 'search_scoped_rag_context', args: { query }, id });
function invokeIterative(model, search, overrides = {}) {
  return invokeScopedRetrievalAgent({
    model, question: 'Find supporting details',
    contextPack: contextPack([evidence('initial', 'Initial known fact.', 0.9)]),
    scope, traceId: 'trace-iterative',
    retrieval: { search, maxContextTokens: 4000, maxEvidence: 40 },
    ...overrides,
  });
}

test('iterative agent performs two scoped searches and appends stable citation IDs', async () => {
  const queries = [];
  const result = await invokeIterative(
    iterativeModel([[readCall()], [searchCall('first missing detail')], [searchCall('second missing detail')], []],
      'Answer. [1] [2] [3]'),
    async ({ query, signal }) => {
      assert(signal instanceof AbortSignal);
      queries.push(query);
      return [evidence('new-' + queries.length, 'New detail ' + queries.length, 0.8)];
    }
  );
  assert.deepEqual(queries, ['first missing detail', 'second missing detail']);
  assert.equal(result.searchCallCount, 2);
  assert.equal(result.toolCallCount, 3);
  assert.equal(result.searchStopReason, 'budget');
  assert.deepEqual(result.contextPack.includedEvidenceIds, ['initial', 'new-1', 'new-2']);
  assert.deepEqual(result.servedEvidenceIds, ['initial', 'new-1', 'new-2']);
  assert.deepEqual(result.diagnostics.citations.citedEvidenceIds, ['initial', 'new-1', 'new-2']);
  assert.deepEqual(result.workflowSteps.map(step => step.type), ['llm', 'tool', 'llm', 'tool', 'llm', 'tool', 'llm']);
  assert.deepEqual(result.workflowSteps.filter(step => step.type === 'tool').map(step => step.step),
    ['read_scoped_rag_context', 'search_scoped_rag_context', 'search_scoped_rag_context']);
  assert.equal(JSON.stringify(result.workflowSteps).includes('missing detail'), false);
});

for (const scenario of ['duplicate query', 'no new evidence']) {
  test('iterative agent stops provider calls after ' + scenario, async () => {
    let calls = 0;
    const result = await invokeIterative(
      iterativeModel([[readCall()], [searchCall('detail', 'first')], [searchCall(scenario === 'duplicate query' ? ' detail ' : 'other', 'second')], []]),
      async () => {
        calls += 1;
        return scenario === 'no new evidence' ? [] : [evidence('added', 'Added fact.', 0.8)];
      }
    );
    assert.equal(calls, 1);
    assert.equal(result.searchCallCount, 1);
    assert.equal(result.searchStopReason, 'no_gain');
    const lastTool = result.messages.filter(message => message.getType() === 'tool').at(-1);
    assert.deepEqual(JSON.parse(lastTool.content), { status: 'no_gain', action: 'answer_or_abstain' });
  });
}

test('iterative agent stops provider calls when evidence budget is already full', async () => {
  let calls = 0;
  const result = await invokeIterative(iterativeModel([[readCall()], [searchCall('first')], [searchCall('again')], []]),
    async () => { calls += 1; return []; },
    { retrieval: { search: async () => { calls += 1; return []; }, maxContextTokens: 4000, maxEvidence: 1 } });
  assert.equal(calls, 0);
  assert.equal(result.searchStopReason, 'budget');
});

test('iterative agent returns stable unavailable status without provider error contents', async () => {
  let calls = 0;
  const result = await invokeIterative(iterativeModel([[readCall()], [searchCall('detail')], [searchCall('retry')], []]),
    async () => { calls += 1; throw new Error('private provider endpoint and secret'); });
  assert.equal(calls, 1);
  assert.equal(result.searchStopReason, 'capability_unavailable');
  assert.equal(JSON.stringify(result.messages).includes('private provider'), false);
  const lastTool = result.messages.filter(message => message.getType() === 'tool').at(-1);
  assert.deepEqual(JSON.parse(lastTool.content), { status: 'capability_unavailable', action: 'answer_or_abstain' });
});

for (const code of ['RAG_EVIDENCE_SCOPE_VIOLATION', 'RAG_REQUEST_ABORTED', 'RAG_REQUEST_DEADLINE_EXCEEDED']) {
  test('iterative agent propagates fatal provider code ' + code, async () => {
    const fatal = Object.assign(new Error('fatal lane failure'), { name: 'RagLaneExecutionError', code });
    await assert.rejects(
      () => invokeIterative(iterativeModel([[readCall()], [searchCall('detail')], []]), async () => { throw fatal; }),
      error => error === fatal
    );
  });
}

test('iterative agent rejects same-ID replacement and mutable caller scope races', async () => {
  const callerScope = structuredClone(scope);
  const initial = contextPack([evidence('initial', 'Initial known fact.', 0.9)]);
  await assert.rejects(
    () => invokeIterative(iterativeModel([[readCall()], [searchCall('detail')], []]), async () => {
      callerScope.tenantId = 'tenant-b';
      initial.includedEvidence[0].content = 'Conflicting fact.';
      return [{ ...evidence('initial', 'Conflicting fact.', 0.9), tenantId: 'tenant-b' }];
    }, { scope: callerScope, contextPack: initial }),
    error => error.code === 'RAG_EVIDENCE_SCOPE_VIOLATION'
  );
});

test('iterative agent propagates cancellation during search without a final model response', async () => {
  const controller = new AbortController();
  const model = iterativeModel([[readCall()], [searchCall('detail')], []]);
  let generated = 0;
  const generate = model._generate.bind(model);
  model._generate = async (...args) => { generated += 1; return generate(...args); };
  await assert.rejects(() => invokeIterative(model, async ({ signal }) => {
    controller.abort(new Error('cancel search now'));
    signal.throwIfAborted();
    return [];
  }, { signal: controller.signal }), /cancel search now/);
  assert.equal(generated, 2);
});

for (const [name, calls, code] of [
  ['search before snapshot', [[searchCall('early')], []], 'RAG_AGENT_TOOL_REQUIRED'],
  ['parallel read and search', [[readCall(), searchCall('parallel')], []], 'RAG_AGENT_TOOL_LIMIT'],
  ['parallel searches', [[readCall()], [searchCall('first'), searchCall('second')], []], 'RAG_AGENT_TOOL_LIMIT'],
  ['repeated snapshot read', [[readCall()], [readCall()], []], 'RAG_AGENT_TOOL_LIMIT'],
]) {
  test('iterative agent rejects ' + name + ' before provider execution', async () => {
    let searches = 0;
    await assert.rejects(() => invokeIterative(iterativeModel(calls),
      async () => { searches += 1; return []; }), error => error.code === code);
    assert.equal(searches, 0);
  });
}

test('iterative agent hard-stops repeated tool violations after no gain', async () => {
  let calls = 0;
  await assert.rejects(() => invokeIterative(iterativeModel([
    [readCall()], [searchCall('first')], [searchCall('second')], [searchCall('third')], [],
  ]), async () => { calls += 1; return []; }), error => error.code === 'RAG_AGENT_TOOL_LIMIT');
  assert.equal(calls, 1);
});

test('static snapshot mode returns final context and zero iterative-search counts', async () => {
  const result = await invokeAnswer('Known fact. [1]');
  assert.equal(result.searchCallCount, 0);
  assert.equal(result.searchStopReason, 'sufficient');
  assert.deepEqual(result.contextPack.includedEvidenceIds, result.servedEvidenceIds);
  assert.equal(Object.isFrozen(result.contextPack.includedEvidence[0]), true);
});

test('iterative agent can stop after one useful search with sufficient evidence', async () => {
  const result = await invokeIterative(iterativeModel([[readCall()], [searchCall('detail')], []]),
    async () => [evidence('added', 'Useful extra fact.', 0.8)]);
  assert.equal(result.searchCallCount, 1);
  assert.equal(result.searchStopReason, 'sufficient');
  assert.equal(result.workflowSteps.length, 5);
});

for (const args of [{ query: '' }, { query: 'x'.repeat(1025) }, { query: 'detail', tenantId: 'other' }]) {
  test('iterative agent rejects invalid search arguments before calling the provider ' + JSON.stringify(Object.keys(args)) + String(args.query.length), async () => {
    let calls = 0;
    await assert.rejects(() => invokeIterative(iterativeModel([
      [readCall()], [{ ...searchCall('invalid'), args }], [],
    ]), async () => { calls += 1; return []; }), error => error.code === 'RAG_AGENT_TOOL_REQUIRED');
    assert.equal(calls, 0);
  });
}

for (const configured of [1, 99]) {
  test('iterative search budget clamps configured maxSearches ' + configured, async () => {
    let calls = 0;
    const result = await invokeIterative(iterativeModel([[readCall()], [searchCall('first')], [searchCall('second')], []]),
      async () => [],
      { retrieval: {
        search: async () => { calls += 1; return [evidence('extra-' + calls, 'Extra fact.', 0.8)]; },
        maxSearches: configured, maxContextTokens: 4000, maxEvidence: 40,
      } });
    assert.equal(calls, Math.min(configured, 2));
    assert.equal(result.searchStopReason, 'budget');
  });
}

test('iterative provider timeout returns budget without forwarding its error text', async () => {
  const result = await invokeIterative(iterativeModel([[readCall()], [searchCall('detail')], []]), async () => {
    throw Object.assign(new Error('private timeout endpoint'), { code: 'RAG_LANE_TIMEOUT' });
  });
  assert.equal(result.searchStopReason, 'budget');
  assert.equal(JSON.stringify(result.messages).includes('private timeout endpoint'), false);
});

test('iterative agent rejects parallel calls before any tool execution starts', async () => {
  let toolsStarted = 0;
  await assert.rejects(() => invokeIterative(iterativeModel([[readCall(), searchCall('parallel')], []]),
    async () => [], { callbacks: [{ name: 'local-tool-counter', handleToolStart() { toolsStarted += 1; } }] }),
  error => error.code === 'RAG_AGENT_TOOL_LIMIT');
  assert.equal(toolsStarted, 0);
});

test('iterative cancellation stops a signal-ignoring provider from appending a late result', async () => {
  const controller = new AbortController();
  let announceSearch;
  let releaseSearch;
  const searchStarted = new Promise(resolve => { announceSearch = resolve; });
  const deferred = new Promise(resolve => { releaseSearch = resolve; });
  const model = iterativeModel([[readCall()], [searchCall('detail')], []]);
  let modelResponses = 0;
  const generate = model._generate.bind(model);
  model._generate = async (...args) => { modelResponses += 1; return generate(...args); };
  const pending = invokeIterative(model, async () => {
    announceSearch();
    await deferred;
    return [evidence('late', 'Must not append after cancellation.', 0.8)];
  }, { signal: controller.signal });
  await searchStarted;
  controller.abort(new Error('cancel pending search'));
  let timeout;
  try {
    const outcome = await Promise.race([
      pending.then(() => 'completed', error => /cancel pending search/.test(error.message) ? 'cancelled' : error),
      new Promise(resolve => { timeout = setTimeout(() => resolve('timeout'), 500); }),
    ]);
    assert.equal(outcome, 'cancelled');
  } finally {
    clearTimeout(timeout);
    releaseSearch();
    await pending.catch(() => {});
  }
  assert.equal(modelResponses, 2);
});

function structuredModel(decisions, options = {}) {
  const model = fakeModel([[readCall()], ...decisions.map(() => [])]);
  const bindings = [];
  const requests = [];
  let generated = 0;
  if (options.ollama) model._llmType = () => 'ollama';
  model.bindTools = (tools, settings) => {
    bindings.push({ tools, settings });
    return model;
  };
  const generate = model._generate.bind(model);
  model._generate = async (messages, ...args) => {
    requests.push(messages);
    const response = await generate(messages, ...args);
    const message = response.generations[0].message;
    message.usage_metadata = { input_tokens: 10 + generated, output_tokens: 5, total_tokens: 15 + generated };
    message.response_metadata = { provider: 'fixture', request: generated };
    if (generated > 0) {
      const decision = decisions[generated - 1];
      message.content = typeof decision === 'string' ? decision : JSON.stringify(decision);
      response.generations[0].text = message.content;
      if (options.extraToolCalls) message.tool_calls = options.extraToolCalls;
      if (options.invalidToolCalls) message.invalid_tool_calls = options.invalidToolCalls;
      if (options.additionalKwargs) message.additional_kwargs = options.additionalKwargs;
    }
    generated += 1;
    return response;
  };
  return { model, bindings, requests, generated: () => generated };
}
const answerDecision = (answer = 'Known fact.', evidenceNumbers = [1]) => ({ action: 'answer', query: '', answer, evidenceNumbers });
const searchDecision = query => ({ action: 'search', query, answer: '', evidenceNumbers: [] });
const abstainDecision = () => ({ action: 'abstain', query: '', answer: 'The current knowledge base cannot answer the missing fact.', evidenceNumbers: [] });
function invokeStructured(model, search = async () => [], overrides = {}) {
  return invokeIterative(model, search, {
    ...overrides,
    retrieval: { search, maxContextTokens: 4000, maxEvidence: 40, ...overrides.retrieval, decisionMode: 'structured' },
  });
}

test('structured ChatOllama sends native tools first and an actual JSON schema after reading context', async () => {
  const { ChatOllama } = await import('@langchain/ollama');
  const requests = [];
  const model = new ChatOllama({
    model: 'scoped-agent-wire-fixture',
    baseUrl: 'http://127.0.0.1:11434',
    maxRetries: 0,
    checkOrPullModel: false,
    fetch: async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:11434/api/chat');
      const request = JSON.parse(init.body);
      requests.push(request);
      assert.ok(requests.length <= 2, 'The adapter must not retry or add model calls.');
      const message = requests.length === 1
        ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_scoped_rag_context', arguments: {} } }] }
        : { role: 'assistant', content: JSON.stringify(answerDecision()) };
      return new Response(JSON.stringify({
        model: 'scoped-agent-wire-fixture',
        created_at: '2026-09-07T00:00:00.000Z',
        message,
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 10,
        eval_count: 5,
      }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
    },
  });

  const result = await invokeStructured(model);
  assert.equal(result.answer, 'Known fact.\n\n[1]');
  assert.equal(result.answerDisposition, 'answer');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'read_scoped_rag_context'));
  assert.equal(requests[0].format, undefined);
  assert.equal(requests[1].tools, undefined);
  assert.equal(requests[1].format?.oneOf?.length, 3);
  const branches = Object.fromEntries(requests[1].format.oneOf.map(branch => {
    assert.equal(branch.type, 'object');
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(branch.required, ['action', 'query', 'answer', 'evidenceNumbers']);
    return [branch.properties.action.const, branch.properties];
  }));
  assert.equal(branches.search.query.minLength, 1);
  assert.equal(branches.search.answer.const, '');
  assert.deepEqual(branches.search.evidenceNumbers.const, []);
  assert.equal(branches.answer.query.const, '');
  assert.equal(branches.answer.evidenceNumbers.minItems, 1);
  assert.equal(branches.abstain.query.const, '');
  assert.equal(branches.abstain.evidenceNumbers.minItems, 0);
  assert.ok(requests[1].messages.some(message => message.role === 'tool'));
});

test('structured agent answers complete evidence without search and preserves provider usage metadata', async () => {
  const fixture = structuredModel([answerDecision()], { ollama: true });
  const result = await invokeStructured(fixture.model);
  const { SCOPED_STRUCTURED_AGENT_PROMPT_VERSION } = await import('./scoped-retrieval-agent.ts');
  assert.equal(SCOPED_STRUCTURED_AGENT_PROMPT_VERSION, 'scoped-rag-structured-answer-v5');
  assert.equal(result.answer, 'Known fact.\n\n[1]');
  assert.equal(result.answerDisposition, 'answer');
  assert.equal(result.decisionMode, 'structured');
  assert.equal(result.searchCallCount, 0);
  assert.equal(result.toolCallCount, 1);
  assert.equal(fixture.generated(), 2);
  assert.equal(result.diagnostics.usage.inputTokenCount, 21);
  assert.equal(result.diagnostics.usage.outputTokenCount, 10);
  assert.deepEqual(result.messages.at(-1).response_metadata, { provider: 'fixture', request: 1 });
  assert(fixture.bindings[0].tools.length > 0);
  assert.equal(fixture.bindings[0].settings.format, undefined);
  assert.equal(fixture.bindings.at(-1).tools.length, 0);
  assert.deepEqual(fixture.bindings.at(-1).settings.format.oneOf.map(branch => branch.properties.action.const),
    ['search', 'answer', 'abstain']);
  const rules = fixture.requests.at(-1).find(message => message.getType() === 'system').content;
  assert.match(rules, /JSON/);
  assert.match(rules, /lookup lead/);
});

for (const [label, decision] of [
  ['undeclared visible citation', answerDecision('Fact [2]', [1])],
  ['invented inline citation', answerDecision('Fact [99]', [1])],
  ['inline citation on source-free abstention', { ...abstainDecision(), answer: 'The requested fact is missing [1]' }],
]) {
  test('structured source selection rejects ' + label + ' before exposing a final answer', async () => {
    const fixture = structuredModel([decision]);
    await assert.rejects(() => invokeStructured(fixture.model, async () => [], {
      contextPack: contextPack([evidence('first', 'First.', 0.9), evidence('second', 'Second.', 0.8)]),
    }), error => error instanceof ScopedRetrievalAgentError && error.code === 'RAG_AGENT_INVALID_DECISION');
    assert.equal(fixture.generated(), 2);
  });
}

test('structured source selection renders an escaped trailing number as a real citation separately', async () => {
  const original = 'A literal escaped marker \\[1]';
  const fixture = structuredModel([answerDecision(original, [1])]);
  const result = await invokeStructured(fixture.model);
  assert.equal(result.answer, original + '\n\n[1]');
  assert.deepEqual(result.diagnostics.citations.citedEvidenceIds, ['initial']);
});

test('structured source selection renders only declared evidence without rewriting the answer', async () => {
  const original = 'The supporting fact is confirmed.';
  const fixture = structuredModel([answerDecision(original, [2])]);
  const result = await invokeStructured(fixture.model, async () => [], {
    contextPack: contextPack([
      evidence('bridge', 'Unrelated visible fact.', 0.9),
      evidence('selected', 'The supporting fact is confirmed.', 0.8),
    ]),
  });
  assert.equal(result.answer, original + '\n\n[2]');
  assert.equal(result.messages.at(-1).content, result.answer);
  assert.deepEqual(result.diagnostics.citations.citedEvidenceIds, ['selected']);
  assert.deepEqual(result.servedEvidenceIds, ['bridge', 'selected']);
  assert.equal(result.answer.includes('[1]'), false);
});

test('structured source selection renders both explicitly declared links in a fact chain', async () => {
  const fixture = structuredModel([searchDecision('record'), answerDecision('The subject maps to the record. The record confirms the fact.', [2, 1])]);
  const result = await invokeStructured(fixture.model, async () => [evidence('record', 'Confirmed fact.', 0.8)]);
  assert.equal(result.answer, 'The subject maps to the record. The record confirms the fact.\n\n[1, 2]');
  assert.deepEqual(result.diagnostics.citations.citedEvidenceIds, ['initial', 'record']);
});

test('structured source selection keeps existing text and avoids a duplicate identical trailing source set', async () => {
  const original = 'Original claim. [2, 1]';
  const fixture = structuredModel([answerDecision(original, [1, 2])]);
  const result = await invokeStructured(fixture.model, async () => [], {
    contextPack: contextPack([evidence('first', 'First.', 0.9), evidence('second', 'Second.', 0.8)]),
  });
  assert.equal(result.answer, original);
});

test('structured source selection preserves inline text when appending a different selected source set', async () => {
  const original = 'Original claim. [1]';
  const fixture = structuredModel([answerDecision(original, [1, 2])]);
  const result = await invokeStructured(fixture.model, async () => [], {
    contextPack: contextPack([evidence('first', 'First.', 0.9), evidence('second', 'Second.', 0.8)]),
  });
  assert.equal(result.answer, original + '\n\n[1, 2]');
});

test('structured abstention with no declared sources does not automatically cite visible evidence', async () => {
  const fixture = structuredModel([abstainDecision()]);
  const result = await invokeStructured(fixture.model);
  assert.equal(result.answer, abstainDecision().answer);
  assert.deepEqual(result.diagnostics.citations.citedEvidenceIds, []);
});

test('structured agent does not pass Ollama-specific schema settings to other adapters', async () => {
  const fixture = structuredModel([abstainDecision()]);
  const result = await invokeStructured(fixture.model);
  assert.equal(result.answerDisposition, 'abstain');
  assert.equal(fixture.bindings.at(-1).settings.format, undefined);
  assert.equal(fixture.bindings.at(-1).tools.length, 0);
});

for (const count of [1, 2]) {
  test('structured agent executes ' + count + ' scoped lookup hops using the existing registered tool', async () => {
    const decisions = Array.from({ length: count }, (_, index) => searchDecision('missing-' + index));
    const fixture = structuredModel([...decisions, answerDecision('Facts.', Array.from({ length: count + 1 }, (_, index) => index + 1))]);
    const queries = [];
    const result = await invokeStructured(fixture.model, async ({ query, signal }) => {
      assert(signal instanceof AbortSignal);
      queries.push(query);
      return [evidence('added-' + queries.length, 'New fact ' + queries.length, 0.8)];
    });
    assert.equal(result.searchCallCount, count);
    assert.equal(result.toolCallCount, 1 + count);
    assert.equal(fixture.generated(), 2 + count);
    assert.equal(result.answerDisposition, 'answer');
    assert.deepEqual(queries, Array.from({ length: count }, (_, index) => 'missing-' + index));
    const calls = result.messages.flatMap(message => message.tool_calls ?? []);
    assert.equal(new Set(calls.map(call => call.id)).size, calls.length);
    assert.equal(result.diagnostics.usage.measuredModelResponses, 2 + count);
    assert.deepEqual(result.servedEvidenceIds, ['initial', ...Array.from({ length: count }, (_, index) => 'added-' + (index + 1))]);
    assert.equal(result.messages.filter(message => message.tool_calls?.[0]?.name === 'search_scoped_rag_context').every(message => message.content === ''), true);
  });
}

for (const [label, search, overrides] of [
  ['no_gain', async () => [], {}],
  ['capability_unavailable', async () => { throw new Error('provider-secret-body'); }, {}],
  ['budget', async () => [evidence('added', 'New fact', 0.8)], { retrieval: { maxSearches: 1 } }],
]) {
  test('structured agent accepts explicit abstention after ' + label, async () => {
    const fixture = structuredModel([searchDecision('missing'), abstainDecision()]);
    const result = await invokeStructured(fixture.model, search, overrides);
    assert.equal(result.searchStopReason, label);
    assert.equal(result.answerDisposition, 'abstain');
    assert.equal(result.searchCallCount, 1);
    assert.equal(JSON.stringify(result.messages).includes('provider-secret-body'), false);
  });

  test('structured agent fails closed on another search after ' + label + ' without another provider call', async () => {
    let calls = 0;
    const fixture = structuredModel([searchDecision('missing'), searchDecision('again'), answerDecision()]);
    await assert.rejects(() => invokeStructured(fixture.model, async input => { calls += 1; return search(input); }, overrides),
      error => error instanceof ScopedRetrievalAgentError && error.code === 'RAG_AGENT_INVALID_DECISION');
    assert.equal(calls, 1);
    assert.equal(fixture.generated(), 3);
  });
}

for (const [label, decision] of [
  ['invalid JSON', '{provider-secret-body'],
  ['missing source selection', { action: 'answer', query: '', answer: 'fact' }],
  ['empty source selection on answer', answerDecision('fact', [])],
  ['duplicate source selection', answerDecision('fact', [1, 1])],
  ['non-integer source selection', answerDecision('fact', [1.5])],
  ['out-of-context source selection', answerDecision('fact', [2])],
  ['sources attached to search', { ...searchDecision('missing'), evidenceNumbers: [1] }],
  ['duplicate source JSON key', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[1],"evidenceNumbers":[1]}'],
  ['extra property', { ...answerDecision(), tenantId: 'private-tenant' }],
  ['ambiguous search and answer', { ...searchDecision('missing'), answer: 'provider-secret-body' }],
  ['ambiguous answer and query', { ...answerDecision(), query: 'missing' }],
  ['unknown action', { ...answerDecision(), action: 'delegate' }],
  ['empty answer', answerDecision('   ')],
  ['oversized query', searchDecision('x'.repeat(1025))],
  ['oversized answer', answerDecision('x'.repeat(16001))],
  ['duplicate JSON key', '{"action":"search","query":"secret","answer":"","evidenceNumbers":[],"action":"answer","query":"","answer":"fact"}'],
  ['Markdown JSON wrapper', '~~~json\n{"action":"answer","query":"","answer":"fact"}\n~~~'],
  ['nested action', { action: { name: 'answer' }, query: '', answer: 'fact' }],
]) {
  test('structured agent rejects ' + label + ' without leaking content or retrying', async () => {
    const fixture = structuredModel([decision]);
    let calls = 0;
    await assert.rejects(() => invokeStructured(fixture.model, async () => { calls += 1; return []; }),
      error => {
        assert(error instanceof ScopedRetrievalAgentError);
        assert.equal(error.code, 'RAG_AGENT_INVALID_DECISION');
        assert.equal(String(error).includes('provider-secret-body'), false);
        assert.equal(JSON.stringify(error).includes('private-tenant'), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    assert.equal(calls, 0);
    assert.equal(fixture.generated(), 2);
  });
}

for (const options of [
  { extraToolCalls: [searchCall('mixed')] },
  { invalidToolCalls: [{ name: 'search_scoped_rag_context', args: 'invalid', id: 'mixed' }] },
  { additionalKwargs: { function_call: { name: 'search_scoped_rag_context', arguments: '{}' } } },
]) {
  test('structured agent rejects native tool calls mixed with a JSON decision ' + Object.keys(options)[0], async () => {
    const fixture = structuredModel([answerDecision()], options);
    let calls = 0;
    await assert.rejects(() => invokeStructured(fixture.model, async () => { calls += 1; return []; }),
      error => error.code === 'RAG_AGENT_INVALID_DECISION');
    assert.equal(calls, 0);
  });
}

test('structured search preserves fatal scope failures', async () => {
  const fixture = structuredModel([searchDecision('detail'), answerDecision()]);
  await assert.rejects(() => invokeStructured(fixture.model, async () => [
    { ...evidence('forbidden', 'Private document', 0.9), tenantId: 'tenant-b' },
  ]), error => error.code === 'RAG_EVIDENCE_SCOPE_VIOLATION');
  assert.equal(fixture.generated(), 2);
});

test('structured search cancellation prevents a subsequent decision call', async () => {
  const controller = new AbortController();
  const fixture = structuredModel([searchDecision('detail'), answerDecision()]);
  await assert.rejects(() => invokeStructured(fixture.model, async ({ signal }) => {
    controller.abort(new Error('structured cancelled'));
    signal.throwIfAborted();
    return [];
  }, { signal: controller.signal }), /structured cancelled/);
  assert.equal(fixture.generated(), 2);
});

test('structured model cannot exceed two search calls or four model responses', async () => {
  let calls = 0;
  const fixture = structuredModel([searchDecision('one'), searchDecision('two'), searchDecision('three'), answerDecision()]);
  await assert.rejects(() => invokeStructured(fixture.model, async () => {
    calls += 1;
    return [evidence('added-' + calls, 'Fact ' + calls, 0.8)];
  }), error => error.code === 'RAG_AGENT_INVALID_DECISION');
  assert.equal(calls, 2);
  assert.equal(fixture.generated(), 4);
});


test('structured mode still requires the first native snapshot read before any JSON decision', async () => {
  let calls = 0;
  const model = iterativeModel([[]], JSON.stringify(answerDecision()));
  await assert.rejects(() => invokeStructured(model, async () => { calls += 1; return []; }),
    error => error.code === 'RAG_AGENT_TOOL_REQUIRED');
  assert.equal(calls, 0);
});

test('structured mode rejects a search when the configured budget is zero before calling the provider', async () => {
  const fixture = structuredModel([searchDecision('detail')]);
  let calls = 0;
  await assert.rejects(() => invokeStructured(fixture.model, async () => { calls += 1; return []; },
    { retrieval: { maxSearches: 0 } }), error => error.code === 'RAG_AGENT_INVALID_DECISION');
  assert.equal(calls, 0);
  assert.equal(fixture.generated(), 2);
});

test('explicit native-tools mode retains the existing iterative workflow without disposition metadata', async () => {
  const result = await invokeIterative(iterativeModel([[readCall()], []], 'Known fact. [1]'),
    async () => [],
    { retrieval: { search: async () => [], maxContextTokens: 4000, maxEvidence: 40, decisionMode: 'native-tools' } });
  assert.equal(result.answer, 'Known fact. [1]');
  assert.equal(result.decisionMode, undefined);
  assert.equal(result.answerDisposition, undefined);
});

test('invalid decision mode is rejected before the first model request', async () => {
  const fixture = structuredModel([answerDecision()]);
  await assert.rejects(() => invokeIterative(fixture.model, async () => [],
    { retrieval: { search: async () => [], maxContextTokens: 4000, maxEvidence: 40, decisionMode: 'unsafe' } }),
    error => error.code === 'RAG_AGENT_INVALID_DECISION');
  assert.equal(fixture.generated(), 0);
});
