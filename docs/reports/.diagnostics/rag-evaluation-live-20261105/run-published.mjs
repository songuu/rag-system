import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {applySandboxEnvironment} from './sandbox-environment.mjs';
const {root,sandboxId}=await applySandboxEnvironment();
const {importRuntimeModule}=await import(new URL('src/lib/rag/eval/runtime-module-import.mjs',root));
const [{createPublicationEvalRuntime},{readAskProviderUsage},{canonicalJsonSha256}]=await Promise.all([
  importRuntimeModule(new URL('src/lib/rag/eval/publication-eval-runtime.ts',root).href),
  importRuntimeModule(new URL('src/lib/rag/core/provider-usage-observer.ts',root).href),
  importRuntimeModule(new URL('src/lib/rag/eval/canonical-json.ts',root).href),
]);
const runtime=createPublicationEvalRuntime({projectRoot:fileURLToPath(root),model:'llama3.1',topK:3});
const before=await runtime.observeRuntime();
const corpus=JSON.parse(await readFile(new URL('published-corpus.json',import.meta.url),'utf8'));
if(before.index.revision!==corpus.viewDigest)throw new Error('Published source snapshot changed before validation');
const cases=[
  {id:'publication-stores',question:'《统一发布验收说明.txt》中提到需要写入和完整读取核对的三个数据库分别是什么？',facts:[['Elasticsearch'],['Milvus'],['Neo4j']]},
  {id:'publication-atomic-switch',question:'根据《统一发布验收说明.txt》，哪个数据库负责原子切换已发布版本？',facts:[['PostgreSQL']]},
  {id:'publication-order',question:'根据《统一发布验收说明.txt》，向量化和三库写入哪个在前？请简短说明。',facts:[['向量化'],['三库','Elasticsearch']]},
  {id:'publication-two-stores',question:'根据《统一发布验收说明.txt》，如果三库只有两库核对通过，资料是否可以对用户可见？',facts:[['不能','不可以','不可见','不应','不对用户可见','只有','三库全部']]},
  {id:'publication-no-refund',question:'《统一发布验收说明.txt》规定的退款金额和退款期限分别是多少？只能根据这份资料作答。',expectedDisposition:'abstain'},
  {id:'raw-conversation',question:'我今天很开心',expectedDisposition:'conversation'},
];
const report={schemaVersion:'rag-live-verification/v1',sandboxId,
  referenceStatus:'source-derived-smoke-not-human-reviewed',productionQualityMeasured:false,
  startedAt:new Date().toISOString(),configuration:before,corpusViewDigest:corpus.viewDigest,cases:[]};
for(const sample of cases){
  const current=await runtime.observeRuntime();if(canonicalJsonSha256(current)!==canonicalJsonSha256(before))throw new Error('Configuration changed between cases');
  const response=await runtime.invokeAsk({question:sample.question,scope:corpus.scope,topK:3,similarityThreshold:0,
    llmModel:'llama3.1',embeddingModel:before.embedding.name});
  const body=await response.json();
  const answer=typeof body.answer==='string'?body.answer:'';
  const result={id:sample.id,question:sample.question,httpStatus:response.status,answer,evidenceCount:body.evidence?.length??null,
    citationStatus:body.citations?.status??'unavailable',citationDiagnostics:body.citations?.diagnostics??null,
    literalFactChecks:sample.facts?.map(alternatives=>({alternatives,found:alternatives.some(value=>answer.toLowerCase().includes(value.toLowerCase()))})),
    expectedDisposition:sample.expectedDisposition??'answer',usage:readAskProviderUsage(response),body};
  report.cases.push(result);
  await writeFile(new URL('published-'+sample.id+'.json',import.meta.url),JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify({id:result.id,httpStatus:result.httpStatus,answer:result.answer,evidenceCount:result.evidenceCount,
    citationStatus:result.citationStatus,usage:result.usage,literalFactChecks:result.literalFactChecks}));
  if(!response.ok)break;
}
const after=await runtime.observeRuntime();report.configurationUnchanged=canonicalJsonSha256(after)===canonicalJsonSha256(before);
report.completedSuccessfully=report.configurationUnchanged && report.cases.length===cases.length
  && report.cases.every(item=>item.httpStatus>=200 && item.httpStatus<300);
report.completedAt=new Date().toISOString();
await writeFile(new URL('published-report.json',import.meta.url),JSON.stringify(report,null,2),{flag:'wx'});
process.exit(report.completedSuccessfully?0:1);
