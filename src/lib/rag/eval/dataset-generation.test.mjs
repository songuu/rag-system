import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../../model-config' && context.parentURL.endsWith('/dataset-generation.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export function createLLM(...args) { return globalThis.__datasetModel(...args); } export function getCurrentProvider() { return "ollama"; }') };
    }
    if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.resolve('src', specifier.slice(2) + '.ts')).href, context);
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = new URL(specifier, context.parentURL);
      if (!existsSync(target) && existsSync(new URL(target.href + '.ts'))) return nextResolve(target.href + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const { validateDatasetGenerationRequest, buildGeneratedDataset, generateRagEvalDataset, generateRagEvalDatasetFromCorpus } = await import('./dataset-generation.ts');
const request = () => ({ datasetId: '产品知识测试', datasetVersion: '1.0', count: 1,
  sources: [{ source: '手册.md', content: '  蓝鲸平台支持中文。蓝鲸平台支持中文。\n默认上限为20。  ' }] });
const candidates = () => ({ cases: [{ query: '平台支持什么语言？', referenceAnswer: '蓝鲸平台支持中文。',
  requiredFacts: [['中文', '汉语']], evidence: [{ sourceIndex: 0, quote: '蓝鲸平台支持中文。', relevance: 3 }] }] });

test('request validation preserves exact source content and accepts Chinese dataset names', () => {
  const input = request();
  assert.deepEqual(validateDatasetGenerationRequest(input), input);
  for (const mutate of [v => { v.count = 0; }, v => { v.count = 21; }, v => { v.sources = []; },
    v => { v.sources = Array(9).fill(v.sources[0]); }, v => { v.sources[0].source = 'a'.repeat(201); },
    v => { v.datasetId = 'a'.repeat(81); }, v => { v.datasetVersion = ''; },
    v => { v.sources[0].content = 'a'.repeat(24001); }, v => { v.model = 'untrusted'; },
    v => { v.sources[0].content = ' '; }, v => { v.sources[0].url = 'http://example.com'; }]) {
    const invalid = request(); mutate(invalid);
    assert.throws(() => validateDatasetGenerationRequest(invalid));
  }
  const combined = request(); combined.sources = [{ source: 'a', content: 'a'.repeat(12001) }, { source: 'b', content: 'b'.repeat(12000) }];
  assert.throws(() => validateDatasetGenerationRequest(combined), /24000/);
});

test('generated dataset retains reference answers, fact alternatives, stable identities and exact quote spans', () => {
  const input = validateDatasetGenerationRequest(request());
  const dataset = buildGeneratedDataset(input, candidates());
  assert.deepEqual(dataset, buildGeneratedDataset(input, candidates()));
  assert.equal(dataset.schemaVersion, 'rag-eval-dataset/v1');
  assert.equal(dataset.corpus[0].content, input.sources[0].content);
  const item = dataset.cases[0];
  assert.equal(item.expectedAnswer.referenceAnswer, '蓝鲸平台支持中文。');
  assert.deepEqual(item.expectedAnswer.requiredFacts, [['中文', '汉语']]);
  assert.deepEqual(item.tags, ['ai-generated', 'needs-review']);
  assert.equal(item.expectedAbstain, false);
  assert.equal(item.goldEvidence[0].evidenceId, dataset.corpus[0].evidenceId);
  // Repeated quotes deliberately resolve to the first exact occurrence.
  assert.deepEqual(item.goldEvidence[0].spans, [{ startOffset: 2, endOffset: 11 }]);
  assert.equal(input.sources[0].content.slice(2, 11), '蓝鲸平台支持中文。');
});

test('multiple quotes for one source merge into one gold evidence entry', () => {
  const output = candidates();
  output.cases[0].evidence.push({ sourceIndex: 0, quote: '默认上限为20。', relevance: 2 });
  const dataset = buildGeneratedDataset(validateDatasetGenerationRequest(request()), output);
  assert.equal(dataset.cases[0].goldEvidence.length, 1);
  assert.equal(dataset.cases[0].goldEvidence[0].relevance, 3);
  assert.equal(dataset.cases[0].goldEvidence[0].spans.length, 2);
});

test('a wrong or out-of-range source number is recovered only from one exact matching source', () => {
  const input = validateDatasetGenerationRequest({ ...request(), sources: [
    { source: 'unrelated.txt', content: '另一份资料没有相同内容。' }, request().sources[0],
  ] });
  for (const sourceIndex of [0, 2, 47]) {
    const output = candidates(); output.cases[0].evidence[0].sourceIndex = sourceIndex;
    const dataset = buildGeneratedDataset(input, output);
    assert.equal(dataset.cases[0].goldEvidence[0].evidenceId, dataset.corpus[1].evidenceId);
    const span = dataset.cases[0].goldEvidence[0].spans[0];
    assert.equal(dataset.corpus[1].content.slice(span.startOffset, span.endOffset), '蓝鲸平台支持中文。');
  }
});

test('ambiguous quote matches cannot repair an invalid source number', () => {
  const input = validateDatasetGenerationRequest({ ...request(), sources: [request().sources[0],
    { source: 'duplicate.txt', content: request().sources[0].content }] });
  const output = candidates(); output.cases[0].evidence[0].sourceIndex = 47;
  assert.throws(() => buildGeneratedDataset(input, output), /无法确定来源/);
});

test('untrusted model output rejects missing cases, unsupported sources, fabricated quotes and duplicate questions', () => {
  for (const mutate of [v => { v.cases = []; }, v => { v.cases[0].referenceAnswer = ''; },
    v => { v.cases[0].requiredFacts = []; }, v => { v.cases[0].evidence = []; },
    v => { v.cases[0].evidence[0].sourceIndex = -1; },
    v => { v.cases[0].evidence[0].sourceIndex = 0.5; }, v => { v.cases[0].evidence[0].quote = ''; },
    v => { v.cases[0].evidence[0].quote = '模型虚构的原文'; }, v => { v.cases[0].evidence[0].relevance = 4; }]) {
    const invalid = candidates(); mutate(invalid);
    assert.throws(() => buildGeneratedDataset(validateDatasetGenerationRequest(request()), invalid));
  }
  const input = request(); input.count = 2;
  const duplicate = candidates(); duplicate.cases.push({ ...duplicate.cases[0], query: '平台支持什么语言?' });
  assert.throws(() => buildGeneratedDataset(validateDatasetGenerationRequest(input), duplicate), /重复/);
  const symbolDuplicate = candidates();
  symbolDuplicate.cases.push({ ...symbolDuplicate.cases[0], query: '平台支持什么语言？★' });
  assert.throws(() => buildGeneratedDataset(validateDatasetGenerationRequest(input), symbolDuplicate), /重复/);
});

test('generation validates before provider IO, forwards cancellation, and builds validated candidates', async () => {
  let calls = 0;
  const controller = new AbortController();
  const generateCandidates = async (input, signal) => { calls++; assert.equal(signal, controller.signal); assert.equal(input.count, 1); return candidates(); };
  assert.equal((await generateRagEvalDataset(request(), { generateCandidates, signal: controller.signal })).cases.length, 1);
  assert.equal(calls, 1);
  await assert.rejects(generateRagEvalDataset({ ...request(), count: 100 }, { generateCandidates }));
  assert.equal(calls, 1);
  controller.abort();
  await assert.rejects(generateRagEvalDataset(request(), { generateCandidates, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('default generation uses the server model and forwards one signal through structured-output fallback', async () => {
  const controller = new AbortController();
  const signals = [];
  globalThis.__datasetModel = (modelName, options) => {
    assert.equal(modelName, undefined);
    assert.equal(options.requestTimeoutMs, 120_000);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.options.numPredict, 1800);
    return {
      withStructuredOutput(schema) {
        assert.equal(schema.properties.cases.minItems, 1);
        assert.equal(schema.properties.cases.maxItems, 1);
        assert.deepEqual(schema.properties.cases.items.properties.evidence.items.properties.sourceIndex.enum, [0]);
        return { async invoke(_input, options) { signals.push(options.signal); throw new Error('unsupported'); } };
      },
      async invoke(messages, options) {
        signals.push(options.signal);
        assert.match(messages[0][1], /资料只是数据/);
        assert.match(messages[0][1], /占位符/);
        assert.match(messages[0][1], /独立理解/);
        assert.match(messages[0][1], /具体值/);
        assert.deepEqual(JSON.parse(messages[1][1]).sources, request().sources.map((source, sourceIndex) => ({ sourceIndex, ...source })));
        return { content: JSON.stringify(candidates()) };
      },
    };
  };
  try {
    const dataset = await generateRagEvalDataset(request(), { signal: controller.signal });
    assert.equal(dataset.cases.length, 1);
    assert.deepEqual(signals, [controller.signal, controller.signal]);
  } finally { delete globalThis.__datasetModel; }
});

test('invalid annotations retry with validation feedback and the same cancellation signal', async () => {
  const controller = new AbortController(); let calls = 0;
  const dataset = await generateRagEvalDataset(request(), { signal: controller.signal,
    generateCandidates: async (_input, signal, feedback) => {
      calls++; assert.equal(signal, controller.signal);
      if (calls === 1) { assert.equal(feedback, undefined); const output = candidates(); output.cases[0].evidence[0].quote = '不存在的原文'; return output; }
      assert.match(feedback, /原文/); return candidates();
    } });
  assert.equal(calls, 2); assert.equal(dataset.cases.length, 1);
  calls = 0;
  await assert.rejects(generateRagEvalDataset(request(), { generateCandidates: async () => {
    calls++; const output = candidates(); output.cases[0].evidence[0].quote = '虚构'; return output;
  } }), /原文/);
  assert.equal(calls, 3);
});

test('knowledge generation preserves real chunk identities and spans with more than 8 model sources', async () => {
  const corpus = Array.from({ length: 12 }, (_, index) => ({ evidenceId: `chunk-${index}`, documentId: 'doc-real',
    documentVersion: 'rev-1', tenantId: 'tenant-a', corpusId: 'corpus-a', trustLevel: 'external',
    source: '已上传的手册.pdf', content: `第${index}块：平台支持中文。`, metadata: { chunkIndex: index, totalChunks: 12, sampled: true },
  }));
  let calls = 0;
  const generateCandidates = async input => {
    calls++; assert.equal(input.sources.length, 12);
    const output = candidates(); output.cases[0].evidence[0].sourceIndex = 11;
    output.cases[0].evidence[0].quote = '平台支持中文。';
    return output;
  };
  const settings = { datasetId: '已上传资料', datasetVersion: '1', count: 1 };
  const dataset = await generateRagEvalDatasetFromCorpus(settings, corpus, { generateCandidates });
  assert.equal(calls, 1);
  assert.deepEqual(dataset.corpus, corpus);
  assert.equal(dataset.cases[0].goldEvidence[0].evidenceId, 'chunk-11');
  assert.equal(corpus[11].content.slice(...Object.values(dataset.cases[0].goldEvidence[0].spans[0])), '平台支持中文。');
  await assert.rejects(generateRagEvalDatasetFromCorpus({ ...settings, count: 0 }, corpus, { generateCandidates }));
  await assert.rejects(generateRagEvalDatasetFromCorpus(settings, [...corpus, corpus[0]], { generateCandidates }));
  await assert.rejects(generateRagEvalDatasetFromCorpus(settings, [{ ...corpus[0], content: 'a'.repeat(24001) }], { generateCandidates }));
  assert.equal(calls, 1);
});

test('default generation distributes questions across sources with local indexes and restores global provenance', async () => {
  const input = { ...request(), count: 2, sources: [
    { source: 'first.txt', content: '甲平台支持中文。' }, { source: 'second.txt', content: '乙平台支持英文。' },
  ] };
  const seen = [];
  const generate = async messages => {
    const body = JSON.parse(messages[1][1]);
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].sourceIndex, 0);
    seen.push(body.sources[0].source);
    const content = body.sources[0].content;
    return { cases: [{ query: content + '支持什么？', referenceAnswer: content,
      requiredFacts: [[content]], evidence: [{ sourceIndex: 0, quote: content, relevance: 3 }] }] };
  };
  globalThis.__datasetModel = () => ({
    withStructuredOutput: () => ({ invoke: generate }),
    invoke: async (...args) => ({ content: JSON.stringify(await generate(...args)) }),
  });
  try {
    const dataset = await generateRagEvalDataset(input);
    assert.deepEqual(seen, ['first.txt', 'second.txt']);
    assert.equal(dataset.cases.length, 2);
    assert.equal(dataset.cases[0].goldEvidence[0].evidenceId, dataset.corpus[0].evidenceId);
    assert.equal(dataset.cases[1].goldEvidence[0].evidenceId, dataset.corpus[1].evidenceId);
  } finally { delete globalThis.__datasetModel; }
});

test('a failed model batch stops after three no-progress attempts', async () => {
  let calls = 0;
  globalThis.__datasetModel = () => ({ withStructuredOutput: () => ({ async invoke() {
    calls++; const output = candidates(); output.cases[0].evidence[0].quote = '无法定位的引文'; return output;
  } }) });
  try {
    await assert.rejects(generateRagEvalDataset({ ...request(), count: 2,
      sources: [request().sources[0], { source: 'other', content: '另一份资料。' }],
    }), /原文/);
    assert.equal(calls, 3);
  } finally { delete globalThis.__datasetModel; }
});

function candidate(number, patch = {}) {
  return { ...candidates().cases[0], query: `平台资料问题${number}？`, ...patch };
}

test('retains seven valid questions from a mixed batch and requests only the missing three', async () => {
  const input = { ...request(), count: 10 };
  const snapshots = []; const requested = []; let calls = 0;
  const result = await generateRagEvalDataset(input, {
    onProgress(dataset, progress) { snapshots.push({ dataset, progress }); },
    generateCandidates: async (remaining, _signal, feedback) => {
      requested.push(remaining.count); calls++;
      if (calls === 1) return { cases: [...Array.from({ length: 7 }, (_, i) => candidate(i + 1)),
        candidate(1), candidate('bad', { evidence: [{ sourceIndex: 0, quote: '虚构引文', relevance: 3 }] })] };
      assert.match(feedback, /已保留\s*7.*10/);
      assert.match(feedback, /问题1/);
      return { cases: [candidate(8), candidate(9), candidate(10)] };
    },
  });
  assert.deepEqual(requested, [10, 3]);
  assert.equal(result.cases.length, 10);
  assert.deepEqual(result.cases.slice(0, 7).map(item => item.query), Array.from({ length: 7 }, (_, i) => candidate(i + 1).query));
  assert.equal(new Set(result.cases.map(item => item.id)).size, 10);
  assert.ok(snapshots.some(item => item.dataset.cases.length === 7));
  assert.equal(snapshots.at(-1).progress.generatedCount, 10);
  assert.equal(snapshots.at(-1).progress.requestedCount, 10);
  assert.equal(snapshots.at(-1).progress.attempts, 2);
  assert.equal(snapshots.find(item => item.dataset.cases.length === 7).dataset.cases.length, 7, 'prior snapshots remain unchanged');
});

test('overproduction keeps the first requested valid unique questions without another model call', async () => {
  let calls = 0;
  const result = await generateRagEvalDataset({ ...request(), count: 2 }, { generateCandidates: async () => {
    calls++; return { cases: [candidate(1), candidate(1), candidate(2), candidate(3)] };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.cases.map(item => item.query), [candidate(1).query, candidate(2).query]);
});

test('incomplete generation preserves progress and reports target, retained and missing counts', async () => {
  const snapshots = []; let calls = 0;
  await assert.rejects(generateRagEvalDataset({ ...request(), count: 3 }, {
    onProgress(dataset, progress) { snapshots.push({ dataset, progress }); },
    generateCandidates: async () => { calls++; return { cases: [candidate(1)] }; },
  }), error => error.code === 'DATASET_GENERATION_INCOMPLETE' && /3.*1.*2/.test(error.message));
  assert.equal(calls, 4);
  assert.equal(snapshots.at(-1).dataset.cases.length, 1);
  assert.equal(snapshots.at(-1).progress.attempts, 4);
});

test('empty and malformed responses are bounded, and candidate arrays only inspect a bounded prefix', async () => {
  for (const response of [{ cases: [] }, {}, { cases: 'wrong' }, null]) {
    let calls = 0;
    await assert.rejects(generateRagEvalDataset(request(), { generateCandidates: async () => { calls++; return response; } }));
    assert.equal(calls, 3);
  }
  const tooMany = Array(41).fill(null);
  Object.defineProperty(tooMany, 40, { get() { throw new Error('unbounded model candidate traversal'); } });
  let calls = 0;
  await assert.rejects(generateRagEvalDataset(request(), { generateCandidates: async () => { calls++; return { cases: tooMany }; } }),
    error => !error.message.includes('unbounded'));
  assert.equal(calls, 3);
});

test('abort stops top-up without discarding the last accepted progress snapshot', async () => {
  const controller = new AbortController(); let calls = 0; let retained;
  await assert.rejects(generateRagEvalDataset({ ...request(), count: 2 }, { signal: controller.signal,
    onProgress(dataset) { retained = dataset; controller.abort(); },
    generateCandidates: async () => { calls++; return { cases: [candidate(1)] }; },
  }), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(retained.cases.length, 1);
});

test('default model batches keep accepted questions, use small dynamic schemas and restore source identities', async () => {
  const input = { ...request(), count: 4, sources: [
    { source: 'first.txt', content: '甲平台支持中文。' }, { source: 'second.txt', content: '乙平台支持英文。' },
  ] };
  const seen = []; let calls = 0;
  globalThis.__datasetModel = (_name, options) => ({ withStructuredOutput: schema => ({ async invoke(messages) {
    calls++; const body = JSON.parse(messages[1][1]); const source = body.sources[0];
    seen.push({ source: source.source, requested: schema.properties.cases.minItems, previous: body.previousValidationError });
    assert.ok(schema.properties.cases.maxItems <= 2);
    assert.equal(options.options.numPredict, schema.properties.cases.minItems * 1800);
    const caseAt = number => ({ query: `${source.source}第${number}问？`, referenceAnswer: source.content,
      requiredFacts: [[source.content]], evidence: [{ sourceIndex: 0, quote: source.content, relevance: 3 }] });
    return { cases: calls === 1 ? [caseAt(1), { ...caseAt(99), referenceAnswer: '' }] : [caseAt(1), caseAt(2)] };
  } }) });
  try {
    const dataset = await generateRagEvalDataset(input);
    assert.equal(dataset.cases.length, 4);
    assert.deepEqual(seen.map(item => item.source), ['first.txt', 'second.txt', 'first.txt']);
    assert.deepEqual(seen.map(item => item.requested), [2, 2, 1]);
    assert.equal(dataset.cases[0].goldEvidence[0].evidenceId, dataset.corpus[0].evidenceId);
    assert.equal(dataset.cases[1].goldEvidence[0].evidenceId, dataset.corpus[1].evidenceId);
    assert.equal(dataset.cases[3].goldEvidence[0].evidenceId, dataset.corpus[0].evidenceId);
  } finally { delete globalThis.__datasetModel; }
});

test('default generation visits every scheduled source before stopping for no progress', async () => {
  const input = { ...request(), count: 4, sources: Array.from({ length: 4 }, (_, index) => ({
    source: `source-${index}.txt`, content: `平台${index}支持中文。`,
  })) };
  const visited = []; let calls = 0;
  globalThis.__datasetModel = () => ({ withStructuredOutput: () => ({ async invoke(messages) {
    calls++;
    const source = JSON.parse(messages[1][1]).sources[0];
    visited.push(source.source);
    if (calls <= 3) return { cases: [] };
    return { cases: [{ query: `${source.source}支持什么语言？`, referenceAnswer: source.content,
      requiredFacts: [[source.content]], evidence: [{ sourceIndex: 0, quote: source.content, relevance: 3 }] }] };
  } }) });
  try {
    const dataset = await generateRagEvalDataset(input);
    assert.equal(dataset.cases.length, 4);
    assert.equal(calls, 7);
    assert.deepEqual(visited, ['source-0.txt', 'source-1.txt', 'source-2.txt', 'source-3.txt',
      'source-0.txt', 'source-1.txt', 'source-2.txt']);
    assert.deepEqual(dataset.cases.map(item => item.goldEvidence[0].evidenceId),
      [3, 0, 1, 2].map(index => dataset.corpus[index].evidenceId));
  } finally { delete globalThis.__datasetModel; }
});

test('a placeholder answer is skipped while its valid batch peer is retained and the gap is filled', async () => {
  const input = { ...request(), count: 2 };
  const requested = []; const snapshots = []; let calls = 0;
  const result = await generateRagEvalDataset(input, {
    onProgress(dataset) { snapshots.push(dataset); },
    generateCandidates: async (remaining, _signal, feedback) => {
      requested.push(remaining.count); calls++;
      if (calls === 1) return { cases: [candidate(1), candidate(9, {
        query: '《重构契丹早期史》的出版时间是什么？', referenceAnswer: '这本书的出版时间是某一年。',
      })] };
      assert.match(feedback, /占位/);
      return { cases: [candidate(2)] };
    },
  });
  assert.deepEqual(requested, [2, 1]);
  assert.equal(calls, 2);
  assert.deepEqual(result.cases.map(item => item.query), [candidate(1).query, candidate(2).query]);
  assert.ok(snapshots.some(dataset => dataset.cases.length === 1));
});

test('obvious placeholders in reference answers and required facts cannot become valid cases', () => {
  const input = validateDatasetGenerationRequest(request());
  for (const marker of ['这本书的出版时间是某一年。', '出版年份为某年。', '待补充', '待填写', 'TODO', '日期：TBD', '答案占位符']) {
    const reference = candidates(); reference.cases[0].referenceAnswer = marker;
    assert.throws(() => buildGeneratedDataset(input, reference), error => error.code === 'INVALID_DATASET_GENERATION_OUTPUT' && /参考答案.*占位/.test(error.message));
    const facts = candidates(); facts.cases[0].requiredFacts = [[marker]];
    assert.throws(() => buildGeneratedDataset(input, facts), error => error.code === 'INVALID_DATASET_GENERATION_OUTPUT' && /答案要点.*占位/.test(error.message));
  }
});

test('substantive uncertainty supported by the source is not treated as a placeholder', () => {
  const content = '未知病原体尚未命名，研究团队正在分析其传播特征。';
  const input = validateDatasetGenerationRequest({ ...request(), sources: [{ source: '研究记录.txt', content }] });
  const output = { cases: [{ query: '研究记录中的病原体是否已经命名？', referenceAnswer: content,
    requiredFacts: [['未知病原体尚未命名']], evidence: [{ sourceIndex: 0, quote: content, relevance: 3 }] }] };
  assert.equal(buildGeneratedDataset(input, output).cases[0].expectedAnswer.referenceAnswer, content);
});

test('substantive age descriptions do not match the temporal placeholder marker', () => {
  const content = '某年轻学者提出用考古证据补正文献记载。';
  const input = validateDatasetGenerationRequest({ ...request(), sources: [{ source: '研究记录.txt', content }] });
  const output = { cases: [{ query: '研究记录中的学者提出了什么方法？', referenceAnswer: content,
    requiredFacts: [['用考古证据补正文献记载']], evidence: [{ sourceIndex: 0, quote: content, relevance: 3 }] }] };
  assert.equal(buildGeneratedDataset(input, output).cases[0].expectedAnswer.referenceAnswer, content);
});
