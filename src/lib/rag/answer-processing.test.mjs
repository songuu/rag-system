import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyDirectConversation,
  createDirectConversationReply,
  createPendingAnswerProcessing,
  createRagAnswerProcessing,
  resolveAnswerProcessing,
} from './answer-processing.ts';

test('classifies only self-contained conversational turns for direct replies', () => {
  const cases = [
    ['你好！', 'greeting'],
    ['你好吗？', 'greeting'],
    ['how are you', 'greeting'],
    ['在吗', 'presence'],
    ['谢谢你', 'thanks'],
    ['拜拜～', 'farewell'],
    ['你是谁？', 'identity'],
    ['你能做什么', 'capability'],
  ];

  for (const [query, intent] of cases) {
    assert.equal(classifyDirectConversation(query)?.intent, intent, query);
  }
});

test('does not swallow knowledge questions that merely start with a greeting', () => {
  for (const query of [
    '你好，请解释黑死病为何改变欧洲社会结构',
    '您好，文档里提到的工资涨幅是多少？',
    '谢谢，再帮我总结第三章',
  ]) {
    assert.equal(classifyDirectConversation(query), null, query);
  }
});

test('direct replies declare retrieval skipping and expose auditable stages', () => {
  const result = createDirectConversationReply('你好');

  assert.ok(result);
  assert.match(result.answer, /知识库助手/);
  assert.equal(result.processing.mode, 'direct');
  assert.equal(result.processing.retrievalSkipped, true);
  assert.deepEqual(
    result.processing.steps.map(step => [step.id, step.status]),
    [
      ['classify', 'completed'],
      ['route', 'skipped'],
      ['respond', 'completed'],
    ]
  );
  assert.doesNotMatch(JSON.stringify(result), /chain.of.thought|hidden reasoning/i);
});

test('pending processing distinguishes direct chat from knowledge retrieval', () => {
  assert.deepEqual(
    createPendingAnswerProcessing('你好').steps.map(step => step.status),
    ['completed', 'skipped', 'active']
  );
  assert.deepEqual(
    createPendingAnswerProcessing('黑死病造成了哪些社会影响？').steps.map(step => step.status),
    ['active', 'pending', 'pending']
  );
});

test('projects RAG transitions without exposing internal transition reasons', () => {
  const processing = createRagAnswerProcessing({
    transitions: [
      { from: 'planned', to: 'retrieving', at: '2026-09-14T08:00:00.000Z', reason: 'PRIVATE_ROUTE_REASON' },
      { from: 'retrieving', to: 'evidence_ready', at: '2026-09-14T08:00:00.120Z', reason: 'PRIVATE_RETRIEVAL_REASON' },
      { from: 'evidence_ready', to: 'generating', at: '2026-09-14T08:00:00.130Z', reason: 'PRIVATE_GENERATION_REASON' },
      { from: 'generating', to: 'completed', at: '2026-09-14T08:00:00.280Z', reason: 'PRIVATE_COMPLETION_REASON' },
    ],
    laneExecutions: [{
      laneId: 'dense-primary',
      retriever: 'milvus-dense-v1',
      status: 'completed',
      retrievedEvidenceIds: ['evidence-1'],
      latencyMs: 120,
    }],
    evidenceCount: 1,
  });

  assert.equal(processing.mode, 'rag');
  assert.equal(processing.retrievalSkipped, false);
  assert.deepEqual(processing.steps.map(step => step.durationMs), [undefined, 120, 150]);
  assert.equal(JSON.stringify(processing).includes('PRIVATE_'), false);
});

test('uses server processing first and safely projects legacy workflow steps', () => {
  const direct = createDirectConversationReply('你好');
  assert.deepEqual(resolveAnswerProcessing({ processing: direct.processing }), direct.processing);

  const projected = resolveAnswerProcessing({
    workflow: {
      totalDuration: 42,
      steps: [
        { step: 'retrieve_original', status: 'completed', duration: 12 },
        { step: 'agent_model_answer', status: 'completed', duration: 30 },
      ],
    },
  });
  assert.equal(projected?.mode, 'rag');
  assert.deepEqual(projected?.steps.map(step => step.label), [
    '检索候选文档',
    '生成基于证据的回答',
  ]);
});
