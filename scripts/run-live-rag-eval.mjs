#!/usr/bin/env node
import { access, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { importRuntimeModule } from '../src/lib/rag/eval/runtime-module-import.mjs';

registerHooks({ resolve(s,c,next) { try { return next(s,c); } catch(e) {
  if(e.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(s+'.ts',c); throw e;
} } });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function parseLiveEvalArguments(args) {
  const result = { variablePaths: [], topK: undefined };
  const switches = new Set(['--help','--freeze','--validate-only','--check-runtime']);
  const valued = new Set(['--dataset','--contract','--output','--review','--model','--top-k','--vary','--quality','--quality-context','--judge-model','--pricing']);
  const seen = new Set();
  for (let index=0; index<args.length; index++) {
    const flag=args[index]; if(seen.has(flag)) throw new Error('Duplicate option: '+flag); seen.add(flag);
    if(switches.has(flag)) { result[flag.slice(2)]=true; continue; }
    if(!valued.has(flag)) throw new Error('Unknown option: '+flag);
    const value=args[++index]; if(!value || value.startsWith('--')) throw new Error('Missing value for '+flag);
    if(flag==='--vary') result.variablePaths=value.split(',');
    else if(flag==='--top-k') { if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>1000) throw new Error('Invalid top K'); result.topK=Number(value); }
    else result[flag.slice(2)]=value;
  }
  if([result.freeze,result['validate-only'],result['check-runtime']].filter(Boolean).length>1) throw new Error('Choose freeze, validate-only or check-runtime');
  if(!result.freeze && result.variablePaths.length) throw new Error('--vary is only valid during freeze');
  if(result['quality-context'] && !result.quality && !result['judge-model']) throw new Error('--quality-context requires --quality or --judge-model');
  return result;
}
async function readJson(file) {
  const text=await readFile(file,'utf8'); if(Buffer.byteLength(text)>32*1024*1024) throw new Error('Evaluation input exceeds 32 MiB'); return JSON.parse(text);
}
async function assertNewOutput(output) {
  if(!(await stat(path.dirname(path.resolve(output)))).isDirectory()) throw new Error('Output parent must be an existing directory');
  try { await access(output); } catch(e) { if(e.code==='ENOENT') return; throw e; }
  throw new Error('Output already exists; choose a new file');
}
async function evaluatorIdentity() {
  const files=['types.ts','dataset.ts','dataset-parser.ts','metrics.ts','runner.ts','retrieval-stage-metrics.ts','quality-scoring.ts',
    'quality-scoring-model.ts','usage-metering.ts','report-presentation.ts','experiment-schema.ts','experiment-contract.ts',
    'live-ask-target.ts','publication-eval-runtime.ts'].map(file=>'src/lib/rag/eval/'+file).concat('scripts/run-live-rag-eval.mjs','src/lib/rag/eval/runtime-module-import.mjs');
  const digests=await Promise.all(files.map(async file=>({file,sha256:createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')})));
  return createHash('sha256').update(JSON.stringify(digests)).digest('hex');
}
export async function runLiveRagEval(args, dependencies={}) {
  const options=parseLiveEvalArguments(args);
  if(options.help) return { help: true };
  if(options['check-runtime']) {
    if(!options.model) throw new Error('--model is required');
    const load=dependencies.loadRuntime ?? (async input => (await importRuntimeModule(new URL('../src/lib/rag/eval/publication-eval-runtime.ts',import.meta.url))).createPublicationEvalRuntime(input));
    const runtime=await load({projectRoot:root,model:options.model,topK:options.topK??5,similarityThreshold:0,judgeModel:options['judge-model']});
    const configuration=await runtime.observeRuntime();
    return {ready:true,indexRevision:configuration.index.revision,modelRevision:configuration.model.revision};
  }
  if(!options.dataset) throw new Error('--dataset is required');
  const [{parseRagEvalDataset,createRagEvalDatasetHash},{createExperimentContract,validateExperimentContract}] = await Promise.all([
    importRuntimeModule(new URL('../src/lib/rag/eval/dataset.ts',import.meta.url)),importRuntimeModule(new URL('../src/lib/rag/eval/experiment-contract.ts',import.meta.url))]);
  const dataset=parseRagEvalDataset(await readJson(options.dataset));
  if(options['validate-only']) {
    if(!options.contract) throw new Error('--contract is required');
    const contract=validateExperimentContract(dataset,await readJson(options.contract));
    return { validated:true,datasetSha256:contract.datasetSha256,cases:dataset.cases.length };
  }
  if(!options.output) throw new Error('--output is required');
  await assertNewOutput(options.output);
  let contract;
  if(!options.freeze) {
    if(!options.contract) throw new Error('--contract is required');
    contract=validateExperimentContract(dataset,await readJson(options.contract));
    if(options.topK!==undefined && options.topK!==contract.configuration.retrieval.topK) throw new Error('Top K differs from contract');
  } else if(!options.review || !options.model) throw new Error('--freeze requires --review and --model');
  const model=contract?.configuration.model.name ?? options.model;
  if(options.model && options.model!==model) throw new Error('Model differs from contract');
  const topK=contract?.configuration.retrieval.topK ?? options.topK ?? 5;
  const loadRuntime=dependencies.loadRuntime ?? (async input => {
    const {createPublicationEvalRuntime}=await importRuntimeModule(new URL('../src/lib/rag/eval/publication-eval-runtime.ts',import.meta.url));
    return createPublicationEvalRuntime(input);
  });
  const runtime=await loadRuntime({projectRoot:root,model,topK,similarityThreshold:0,judgeModel:options['judge-model']});
  if(options.freeze) {
    contract=createExperimentContract(dataset,{review:await readJson(options.review),configuration:await runtime.observeRuntime(),variablePaths:options.variablePaths});
    await writeFile(options.output,JSON.stringify(contract,null,2)+'\n',{flag:'wx'});
    return {frozen:true,output:options.output,datasetSha256:contract.datasetSha256};
  }
  const [{createLiveAskEvalTarget},{runRagEval}] = await Promise.all([
    importRuntimeModule(new URL('../src/lib/rag/eval/live-ask-target.ts',import.meta.url)),importRuntimeModule(new URL('../src/lib/rag/eval/runner.ts',import.meta.url))]);
  let assessment;
  if(options.quality || options['judge-model']) {
    const {parseQualitySidecar}=await importRuntimeModule(new URL('../src/lib/rag/eval/quality-scoring.ts',import.meta.url));
    const sidecar=parseQualitySidecar(options.quality ? await readJson(options.quality) : {
      schemaVersion:'rag-eval-quality/v1',datasetSha256:createRagEvalDatasetHash(dataset),cases:{}
    },{datasetSha256:createRagEvalDatasetHash(dataset),caseIds:dataset.cases.map(item=>item.id)});
    const context=options['quality-context'] ? await readJson(options['quality-context']) : {};
    let judge,judgeIdentity;
    if(options['judge-model']) {
      const observed=await runtime.observeRuntime(); const judgeObservation=observed.model.parameters.evalJudge;
      if(!judgeObservation || judgeObservation.name!==options['judge-model'] || typeof judgeObservation.revision!=='string') throw new Error('Judge revision is unverified');
      const {createModelSemanticJudge,SEMANTIC_JUDGE_RUBRIC_VERSION}=await importRuntimeModule(new URL('../src/lib/rag/eval/quality-scoring-model.ts',import.meta.url));
      judge=createModelSemanticJudge({modelName:options['judge-model']});
      judgeIdentity={id:options['judge-model'],revision:judgeObservation.revision,rubricVersion:SEMANTIC_JUDGE_RUBRIC_VERSION};
    }
    assessment={sidecar,context,judge,judgeIdentity};
  }
  const target=createLiveAskEvalTarget({dataset,experiment:contract,observeRuntime:runtime.observeRuntime,invokeAsk:runtime.invokeAsk});
  const evaluatorImplementationSha256=await evaluatorIdentity();
  const usagePricing=options.pricing ? await readJson(options.pricing) : undefined;
  const report=await runRagEval(dataset,target,{topK,experiment:contract,assessment,usagePricing,evaluatorImplementationSha256,stopOnFailure:true,
    metadata:{runner:'in-process-ask/v1',retrieval:'published-live',productionQualityMeasured:false,humanReview:'declared',judgeCalibrated:false}});
  const {canonicalJsonSha256}=await importRuntimeModule(new URL('../src/lib/rag/eval/canonical-json.ts',import.meta.url));
  if(canonicalJsonSha256(await runtime.observeRuntime())!==contract.configurationHash
    || await evaluatorIdentity()!==evaluatorImplementationSha256) throw new Error('[rag-eval live] runtime or evaluator changed during assessment');
  report.metadata.productionQualityMeasured=report.summary.failedCases===0;
  await writeFile(options.output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return {output:options.output,completed:report.summary.completedCases,failed:report.summary.failedCases};
}
const help=[
  'Usage: node --env-file=.env.local --import tsx scripts/run-live-rag-eval.mjs',
  '  --check-runtime --model MODEL',
  '  --freeze --dataset reviewed-v2.json --review review.json --model MODEL --output experiment.json [--top-k 5] [--vary model,promptSha256]',
  '  --validate-only --dataset reviewed-v2.json --contract experiment.json',
  '  --dataset reviewed-v2.json --contract experiment.json --output run.json [--quality quality.json] [--quality-context context.json] [--judge-model MODEL] [--pricing pricing.json]',
  'Freeze and run require active unified publication and pinned local Ollama models. --judge-model must match during freeze and run.',
  'Pricing estimates generation only. No output is overwritten. Validation performs no service calls.',
].join('\n');
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { const result=await runLiveRagEval(process.argv.slice(2)); console.log(result.help ? help : JSON.stringify(result)); if(result.failed) process.exitCode=2; }
  catch(error) { const reason=error instanceof Error && /^(\[publication-eval runtime\]|\[rag-eval live)/.test(error.message)
    ? error.message : 'validation or execution failed; check dataset, review, contract, runtime readiness and output path.';
    console.error('[rag-eval live]',reason); process.exitCode=1; }
}
