import { readFile, writeFile } from 'node:fs/promises';

const directory = new URL('./', import.meta.url);
const referenceFile = 'visible-khitan-reference-extract-9d2667ab-3e2a-4d6f-92be-fe4736c03b19.json';
await readFile(new URL(referenceFile, directory), 'utf8');
const cases = [
  { id: 'visible-author', question: '《重构契丹早期史》版权页的作者字段写的是谁？请依据知识库作答。', facts: [['苗润博']] },
  { id: 'visible-publication', question: '《重构契丹早期史》版权页写的出版社和出版时间分别是什么？请依据知识库作答。', facts: [['北京大学出版社'], ['2024年2月', '2024 年 2 月', '2024年02月']] },
  { id: 'visible-isbn', question: '《重构契丹早期史》版权页给出的 ISBN 是多少？请依据知识库作答。', facts: [['9787301347492']] },
];
const report = { schemaVersion: 'rag-live-verification/v1', startedAt: new Date().toISOString(),
  transport: 'existing-main-http', endpoint: 'http://127.0.0.1:3000/rag-api/ask',
  referenceStatus: 'current-visible-source-derived-not-human-reviewed', referenceFile,
  productionQualityMeasured: false, configurationFrozen: false, cases: [] };
for (const sample of cases) {
  const headers = { 'content-type': 'application/json' };
  const token = process.env.RAG_EVAL_TOKEN || process.env.RAG_SINGLE_TENANT_TOKEN;
  if (token) headers.authorization = 'Bearer ' + token;
  const started = performance.now();
  let observation;
  try {
    const response = await fetch(report.endpoint, { method: 'POST', headers, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ question: sample.question, executionMode: 'sync', storageBackend: 'milvus',
        llmModel: 'llama3.1', embeddingModel: 'nomic-embed-text', topK: 5, similarityThreshold: 0.1 }) });
    const body = await response.json();
    const evidence = body.evidence || [];
    const answer = typeof body.answer === 'string' ? body.answer : '';
    observation = { id: sample.id, question: sample.question, httpStatus: response.status,
      elapsedMs: performance.now() - started, answer, evidenceCount: evidence.length,
      goldEvidencePresent: evidence.some(item => item.id === 'chunk-98c7d5684e90b1beb8e010473f74b745e75f4a0ae991494922728d26a06d93d6'
        && item.documentVersion === 'sha256:be1fd85afe4b4911429dda3bca6b5a6d6a51d2b8e151b27967b39ed1528a8147'),
      literalFactChecks: sample.facts.map(alternatives => ({ alternatives,
        found: alternatives.some(value => answer.toLowerCase().includes(value.toLowerCase())) })),
      citationStatus: body.citations?.status || 'unavailable', providerUsage: 'unavailable-over-public-http', body };
  } catch (error) {
    observation = { id: sample.id, status: 'failed', elapsedMs: performance.now() - started, error: error.name };
  }
  report.cases.push(observation);
  await writeFile(new URL(sample.id + '.json', directory), JSON.stringify(observation, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ id: observation.id, httpStatus: observation.httpStatus, elapsedMs: observation.elapsedMs,
    answer: observation.answer, evidenceCount: observation.evidenceCount, goldEvidencePresent: observation.goldEvidencePresent,
    literalFactChecks: observation.literalFactChecks, citationStatus: observation.citationStatus, error: observation.error }));
  if (!(observation.httpStatus >= 200 && observation.httpStatus < 300)) break;
}
report.completedAt = new Date().toISOString();
report.completedSuccessfully = report.cases.length === cases.length
  && report.cases.every(item => item.httpStatus >= 200 && item.httpStatus < 300);
await writeFile(new URL('visible-main-report.json', directory), JSON.stringify(report, null, 2), { flag: 'wx' });
process.exitCode = report.completedSuccessfully ? 0 : 1;
