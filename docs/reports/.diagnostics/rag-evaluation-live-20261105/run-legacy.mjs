import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';

const directory = new URL('./', import.meta.url);
const snapshot = JSON.parse(await readFile(new URL('legacy-corpus.json', directory), 'utf8'));
// Milvus can vary object field insertion order without changing record values.
function stableValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}
const corpusHash = rows => createHash('sha256').update(JSON.stringify(stableValue(
  [...rows].sort((a, b) => a.id.localeCompare(b.id))))).digest('hex');
const cases = [
  { id: 'black-death-year', question: '根据知识库文档，黑死病于哪一年经由地中海商船传播到欧洲？', facts: [['1347']], source: 'codex-local-graph-black-death-e2e-20260908.txt' },
  { id: 'black-death-pathogen', question: '根据知识库文档，黑死病的病原体是什么，主要通过什么动物身上的什么媒介传播？', facts: [['鼠疫杆菌'], ['黑鼠'], ['跳蚤']], source: 'codex-local-graph-black-death-e2e-20260908.txt' },
  { id: 'great-expectations-benefactor', question: '根据知识库中《远大前程》的摘要，皮普最终发现自己的资助者是谁？', facts: [['马格韦契', '马格维奇', 'Magwitch']], source: 'sample7.txt' },
  { id: 'unanswerable-contract', question: '仅依据知识库，不补充外部信息：项目 LIVE-RAG-NO-ANSWER-20261105 的合同金额和签订日期是多少？', expectedDisposition: 'abstain' },
  { id: 'ambiguous-version', question: '知识库里“这个版本”的生效日期是哪天？', expectedDisposition: 'clarify-or-abstain' },
];
const report = { schemaVersion: 'rag-live-verification/v1', transport: 'existing-main-http',
  startedAt: new Date().toISOString(), endpoint: 'http://127.0.0.1:3000/rag-api/ask',
  referenceStatus: 'agent-derived-from-versioned-source-not-human-reviewed', productionQualityMeasured: false,
  corpusBeforeSha256: corpusHash(snapshot.rows), cases: [], notes: [
    'Substring checks are smoke assertions, not factual/semantic accuracy or calibrated business truth.',
    'Public HTTP response does not expose request-local provider usage; missing counts are unavailable, not zero.',
  ] };
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
    const evidence = body.evidence || body.rag?.evidence || [];
    const answer = typeof body.answer === 'string' ? body.answer : '';
    observation = { id: sample.id, question: sample.question, httpStatus: response.status,
      elapsedMs: performance.now() - started, answer,
      observedSources: [...new Set(evidence.map(item => item.source))], evidenceCount: evidence.length,
      expectedSourcePresent: sample.source ? evidence.some(item => item.source === sample.source) : null,
      literalFactChecks: sample.facts?.map(alternatives => ({ alternatives, found: alternatives.some(value => answer.toLowerCase().includes(value.toLowerCase())) })),
      expectedDisposition: sample.expectedDisposition || 'answer', citationStatus: body.citations?.status || 'unavailable',
      inlineCitationCount: [...answer.matchAll(/\[\d+\]/g)].length, providerUsage: 'unavailable-over-public-http', body };
  } catch (error) {
    observation = { id: sample.id, question: sample.question, elapsedMs: performance.now() - started,
      status: 'failed', error: error.name };
  }
  report.cases.push(observation);
  await writeFile(new URL('legacy-' + sample.id + '.json', directory), JSON.stringify(observation, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ id: observation.id, httpStatus: observation.httpStatus, elapsedMs: observation.elapsedMs,
    answer: observation.answer, citationStatus: observation.citationStatus, evidenceCount: observation.evidenceCount,
    expectedSourcePresent: observation.expectedSourcePresent, literalFactChecks: observation.literalFactChecks, error: observation.error }));
  if (observation.status === 'failed' || observation.httpStatus !== 200) break;
}
const client = new MilvusClient({ address: process.env.MILVUS_ADDRESS || 'localhost:19530', token: process.env.MILVUS_TOKEN || undefined });
try {
  const result = await client.query({ collection_name: 'rag_documents',
    filter: 'tenant_id == "local-dev-tenant" && corpus_id == "local-dev-corpus"',
    output_fields: ['id','content','source','tenant_id','corpus_id','document_id','document_version','trust_level','chunk_index','total_chunks'],
    limit: 1000, consistency_level: 'Strong' });
  if (result.status.error_code !== 'Success') throw new Error('Snapshot read failed');
  report.corpusAfterSha256 = corpusHash(result.data);
  report.corpusUnchanged = report.corpusAfterSha256 === report.corpusBeforeSha256;
} catch { report.corpusUnchanged = null; }
finally { client.closeConnection(); }
report.completedAt = new Date().toISOString();
report.completedSuccessfully = report.corpusUnchanged === true && report.cases.length === cases.length
  && report.cases.every(item => item.httpStatus >= 200 && item.httpStatus < 300 && item.status !== 'failed');
await writeFile(new URL('legacy-report.json', directory), JSON.stringify(report,null,2), {flag:'wx'});
process.exitCode = report.completedSuccessfully ? 0 : 1;
