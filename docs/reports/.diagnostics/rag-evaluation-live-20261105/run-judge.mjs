import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applySandboxEnvironment } from './sandbox-environment.mjs';

const { root } = await applySandboxEnvironment();
const { importRuntimeModule } = await import(new URL('src/lib/rag/eval/runtime-module-import.mjs', root));
const [{ createPublicationEvalRuntime }, { createModelSemanticJudge, SEMANTIC_JUDGE_RUBRIC_VERSION },
  { evaluateSemanticQuality }, { parseCitationReferences }, { canonicalJsonSha256 }] = await Promise.all([
  importRuntimeModule(new URL('src/lib/rag/eval/publication-eval-runtime.ts', root).href),
  importRuntimeModule(new URL('src/lib/rag/eval/quality-scoring-model.ts', root).href),
  importRuntimeModule(new URL('src/lib/rag/eval/quality-scoring.ts', root).href),
  importRuntimeModule(new URL('src/lib/rag/citations/reference-parser.ts', root).href),
  importRuntimeModule(new URL('src/lib/rag/eval/canonical-json.ts', root).href),
]);
const runtime = createPublicationEvalRuntime({ projectRoot: fileURLToPath(root), model: 'llama3.1',
  judgeModel: 'llama3.1', topK: 3 });
const before = await runtime.observeRuntime();
const judge = createModelSemanticJudge({ modelName: 'llama3.1', timeoutMs: 120000 });
const report = { schemaVersion: 'rag-live-judge-smoke/v1', startedAt: new Date().toISOString(),
  configuration: before, rubricVersion: SEMANTIC_JUDGE_RUBRIC_VERSION,
  judgeCalibrated: false, humanReviewed: false, productionQualityMeasured: false, cases: [],
  notes: ['No reviewed reference facts or business truth supplied: factual correctness, key point coverage and business correctness remain unmeasured.',
    'The judge and answer generator share a model; these are interface/grounding smoke checks, not independent human validation.'] };
for (const id of ['publication-atomic-switch', 'publication-no-refund']) {
  const sample = JSON.parse(await readFile(new URL('published-' + id + '.json', import.meta.url), 'utf8'));
  const evidence = sample.body.evidence.map(item => ({ evidenceId: item.id, content: item.content }));
  const references = parseCitationReferences(sample.answer, evidence.length);
  const citations = [...new Set(references.ranges.flatMap(range => range.numbers))]
    .filter(number => number >= 1 && number <= evidence.length).map(number => ({ evidenceId: evidence[number - 1].evidenceId }));
  const started = performance.now();
  let result;
  try {
    const semantic = await evaluateSemanticQuality({ caseId: id, question: sample.question,
      answer: sample.answer, evidence, citations }, judge);
    result = { id, status: 'completed', elapsedMs: performance.now() - started, semantic };
  } catch (error) {
    // Provider error causes may contain private request data; retain a static outcome only.
    result = { id, status: 'failed', elapsedMs: performance.now() - started,
      error: error instanceof Error && error.message.startsWith('[rag-eval quality]')
        ? error.message : 'semantic judge invocation or validation failed' };
  }
  report.cases.push(result);
  console.log(JSON.stringify(result));
  if (result.status === 'failed') break;
}
report.configurationUnchanged = canonicalJsonSha256(await runtime.observeRuntime()) === canonicalJsonSha256(before);
report.completedAt = new Date().toISOString();
await writeFile(new URL('judge-report.json', import.meta.url), JSON.stringify(report, null, 2), { flag: 'wx' });
process.exit(report.configurationUnchanged && report.cases.every(item => item.status === 'completed') ? 0 : 1);
