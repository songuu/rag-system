import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('./') && !specifier.endsWith('.ts')) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
} });

const {
  classifyDirectConversation,
  createDirectConversationReply,
  createPendingAnswerProcessing,
  createRagAnswerProcessing,
  resolveAnswerProcessing,
} = await import('./answer-processing.ts');

test('classifies only self-contained conversational turns for direct replies', () => {
  const cases = [
    ['你好！', 'greeting'],
    ['你好吗？', 'greeting'],
    ['how are you', 'greeting'],
    ['在吗', 'presence'],
    ['谢谢你', 'thanks'],
    ['拜拜～', 'farewell'],
    ['你是谁？', 'identity'],
    ['介绍你自己', 'identity'],
    ['介绍一下你自己', 'identity'],
    ['请介绍一下自己', 'identity'],
    ['今天的日期', 'current-date'],
    ['今天是几月几号？', 'current-date'],
    ['今天的时间', 'current-time'],
    ['当前时间', 'current-time'],
    ['现在几点？', 'current-time'],
    ['请问现在是几点钟？', 'current-time'],
    ['北京时间几点', 'current-time'],
    ['What time is it?', 'current-time'],
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
    '介绍你自己并总结文档',
    '文档中提到的今天的日期是什么',
    '文档中提到的时间是什么',
    '现在几点，并总结文档',
  ]) {
    assert.equal(classifyDirectConversation(query), null, query);
  }
});

test('current date comes from the application clock in Shanghai rather than model knowledge', () => {
  const reply = createDirectConversationReply('今天的日期', new Date('2026-10-08T16:05:00Z'));
  assert.ok(reply);
  assert.equal(reply.intent, 'current-date');
  assert.match(reply.answer, /2026年10月9日/);
  assert.match(reply.answer, /北京时间/);
  assert.equal(reply.processing.retrievalSkipped, true);
});

test('current time uses the same Shanghai clock and skips retrieval in completed and pending processing', () => {
  const now = new Date('2026-10-08T16:05:06Z');
  for (const query of ['今天的时间', 'What time is it?']) {
    const reply = createDirectConversationReply(query, now);
    assert.ok(reply);
    assert.equal(reply.intent, 'current-time');
    assert.match(reply.answer, /00:05:06/);
    assert.match(reply.answer, /北京时间|China Standard Time/);
    assert.equal(reply.processing.retrievalSkipped, true);
    assert.match(reply.processing.steps.at(-1).detail, /当前时间/);
    assert.equal(createPendingAnswerProcessing(query).mode, 'direct');
  }
  assert.match(createDirectConversationReply('今天的时间', now).answer, /2026年10月9日/);
});

test('tool responses carry clock, calculator and selected-model provenance', () => {
  const reply = createDirectConversationReply('现在几点，3+2是多少，你用的是什么模型',
    new Date('2026-10-08T16:05:06Z'), { llmModel: 'glm-4.7-flash:latest' });
  assert.match(reply.answer, /00:05:06/);
  assert.match(reply.answer, /3\+2 = 5/);
  assert.match(reply.answer, /glm-4.7-flash:latest/);
  assert.match(reply.answer, /未调用该模型/);
  assert.deepEqual(reply.answerSources, ['system-clock', 'local-calculator', 'runtime-config']);
  assert.equal(reply.routing.actions.length, 3);
  assert.match(createDirectConversationReply('1/0').answer, /不能除以零/);
  assert.match(createDirectConversationReply('0.1+0.2').answer, /= 0.3$/);
  assert.match(createDirectConversationReply('123456789012345+1').answer, /= 123456789012346$/);
});

test('clock tools honor requested zones, relative dates and DST calendar boundaries', () => {
  const now = new Date('2026-10-08T16:05:06Z');
  assert.match(createDirectConversationReply('东京现在几点', now).answer, /01:05:06.*东京时间/);
  assert.match(createDirectConversationReply('UTC现在几点', now).answer, /16:05:06.*UTC/);
  assert.match(createDirectConversationReply('今天星期几', now).answer, /星期五/);
  // Relative calendar dates must remain correct across DST transitions.
  assert.match(createDirectConversationReply('纽约明天几号', new Date('2026-03-08T04:30:00Z')).answer,
    /2026年3月8日/);
});

test('live-data questions disclose missing data capability without inventing facts', () => {
  const reply = createDirectConversationReply('今天上海天气怎么样');
  assert.deepEqual(reply.answerSources, ['capability-notice']);
  assert.match(reply.answer, /尚未接入实时互联网数据源/);
  assert.doesNotMatch(reply.answer, /晴|雨|\d+度/);
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
