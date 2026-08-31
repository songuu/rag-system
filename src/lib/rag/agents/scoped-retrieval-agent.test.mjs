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
  pack.includedEvidenceIds.push('injected-evidence');
  releaseModel();

  const result = await pending;
  const toolMessage = result.messages.find(message => message.getType() === 'tool');
  assert.match(String(toolMessage?.content), /Original scoped fact/);
  assert.doesNotMatch(String(toolMessage?.content), /Injected after validation/);
  assert.doesNotMatch(String(toolMessage?.content), /injected-evidence/);
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
