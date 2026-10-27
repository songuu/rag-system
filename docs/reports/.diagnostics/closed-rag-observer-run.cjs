/* eslint-disable @typescript-eslint/no-require-imports -- This isolated diagnostic CLI is intentionally CommonJS; application rules remain unchanged. */
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const nativePromise = Promise, promisePrototype = Promise.prototype, intrinsicThen = Promise.prototype.then;
const getDescriptor = Object.getOwnPropertyDescriptor, getPrototype = Object.getPrototypeOf, hasOwn = Object.hasOwn, apply = Reflect.apply;
const isProxy = types.isProxy, isPromise = types.isPromise, isAsyncFunction = types.isAsyncFunction;
const promiseConstructor = getDescriptor(promisePrototype,'constructor'), promiseSpecies = getDescriptor(nativePromise,Symbol.species);

const METHODS = ['readPostgres','readNeo4j','readMilvusPage','readTime','encryptArtifact','sealEncryptedArtifact','readExact','decryptArtifact','open','rename','link','unlink','writeFile','sync','close','read','stat'];
const CATEGORIES = ['root-ledger','scope-ledger','scope-marker','store-marker','cursor','reservation','rebuild-marker'];
const CODES = ['invalid-config','invalid-request','busy','already-sealed','halted','publication-mismatch','invalid-clock','invalid-key','invalid-readback','operation-failed','operation-timeout','provider-contract-invalid'];
const PHASES = ['configuration','preflight','publication-read','clock','encrypt','seal','readback','decrypt','final-validation'];
const FS_CODES = ['EPERM','EACCES','ENOENT','EEXIST','ENOTDIR','EISDIR','EBUSY','EMFILE','ENFILE','ENOSPC','EIO','EINVAL','ENOTEMPTY','UNKNOWN'];
const SYSCALLS = ['rename','link','open','unlink','write','read','stat','fsync','close'];
const CONTEXT = ['caseTag','postSite','requestOrdinal','category','writerOrdinal'];
const DEADLINE = ['caseTag','kind'];
const OPTIONAL_DEADLINE = ['method','expectedMutation','held','actualReturned','spinStarted','spinCompleted'];
const SAFE_ERROR = ['code','phase','pending','mutation','retry','production','frozen'];
const digest = text => createHash('sha256').update(text).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const nullable = validate => value => value === null || validate(value);
const member = list => value => list.includes(value);
const positive = value => integer(value) && value > 0;
const boolean = value => typeof value === 'boolean';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, required, optional = []) {
  return object(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function counts(value) {
  return keys(value, [...METHODS.slice(0,8), 'total'])
    && METHODS.slice(0,8).every(key => integer(value[key]))
    && nullable(integer)(value.total);
}
const FIELD = {
  sequence: positive, type: value => typeof value === 'string',
  caseTag: nullable(value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value)),
  postSite: nullable(positive), requestOrdinal: positive, writerOrdinal: nullable(positive),
  category: nullable(member(CATEGORIES)), moduleId: nullable(member(['checkpoint','result'])),
  ioSite: nullable(positive), ioOrdinal: nullable(positive), method: nullable(member(METHODS)),
  native: nullable(boolean), fsCode: nullable(member(FS_CODES)), syscall: nullable(member(SYSCALLS)),
  status: nullable(value => integer(value) && value >= 100 && value <= 599),
  kind: nullable(member(['whole-seal','cpu-overrun','late-clock'])),
  expectedMutation: nullable(boolean), held: nullable(boolean), actualReturned: nullable(boolean),
  spinStarted: nullable(boolean), spinCompleted: nullable(boolean),
  point: nullable(member(['before-predicate','after-release','after-close','cpu-terminal','run-return','released'])),
  code: nullable(member(CODES)), phase: nullable(member(PHASES)), pending: nullable(boolean),
  mutation: nullable(boolean), retry: nullable(boolean), production: nullable(boolean),
  frozen: nullable(boolean), predicateThrown: value => value === true, predicatePassed: boolean,
  counts, verdict: nullable(member(['passed','failed','incomplete'])),
  firstOutcome: nullable(member(['passed','failed','not-run'])), clockEntries: nullable(integer),
  sourceCount: nullable(integer), selectionCount: nullable(integer), fifthClockHeld: nullable(boolean),
  match: member(['matched','ambiguous','incomplete','cross-request','unmatched']),
  termination: member(['end','proxy','cycle','accessor','depth-limit']), associationOverflow: boolean,
  candidateCount: value => integer(value) && value <= 64,
  currentRequestCandidateCount: value => integer(value) && value <= 64,
};
function fields(value, required, optional = []) {
  return keys(value, required, optional)
    && Object.entries(value).every(([key, item]) => FIELD[key] && FIELD[key](item));
}
function nativeContext(value) {
  return fields(value, [...CONTEXT,'ioSite','moduleId','method','native','fsCode','syscall']);
}
function record(value) {
  const base = ['sequence','type'];
  if (!object(value)) return false;
  if (['post-throw','post-rejected','post-response'].includes(value.type)) {
    return fields(value, [...base,...CONTEXT,...(value.type === 'post-response' ? ['status'] : [])]);
  }
  if (value.type === 'native-failure') {
    return fields(value, [...base,...CONTEXT,'moduleId','ioSite','ioOrdinal','method','native','fsCode','syscall']);
  }
  if (value.type === 'native-cause-match') {
    const required = [...base,...CONTEXT,'match','termination','associationOverflow','candidateCount','currentRequestCandidateCount','ioOrdinal','nativeContext'];
    if (!keys(value, required)) return false;
    const copy = { ...value }; delete copy.nativeContext;
    if (!fields(copy, required.filter(key => key !== 'nativeContext'))
      || value.currentRequestCandidateCount > value.candidateCount) return false;
    if (value.match !== 'matched') return value.ioOrdinal === null && value.nativeContext === null;
    return value.termination === 'end' && !value.associationOverflow && value.candidateCount === 1
      && value.currentRequestCandidateCount === 1 && positive(value.ioOrdinal)
      && nativeContext(value.nativeContext) && ['caseTag','postSite','requestOrdinal'].every(key => value.nativeContext[key] === value[key]);
  }
  if (value.type === 'deadline-checkpoint') {
    return fields(value, [...base,...DEADLINE,'point','counts'], OPTIONAL_DEADLINE);
  }
  if (value.type === 'deadline-validator') {
    const predicate = Object.hasOwn(value,'predicateThrown') ? 'predicateThrown' : 'predicatePassed';
    return fields(value, [...base,...DEADLINE,...SAFE_ERROR,'counts',predicate], OPTIONAL_DEADLINE);
  }
  if (value.type === 'conformance') {
    return fields(value, [...base,...DEADLINE,'point','verdict','pending','firstOutcome','clockEntries','sourceCount','selectionCount','fifthClockHeld'], OPTIONAL_DEADLINE);
  }
  return false;
}
function validTrace(value) {
  if (!keys(value,['schemaVersion','productionAccepted','overflow','observerFailures','ioCalls','totals','records'])
    || value.schemaVersion !== 'rag-closed-test-trace/v1' || value.productionAccepted !== false
    || !boolean(value.overflow) || !integer(value.observerFailures) || !integer(value.ioCalls)
    || !object(value.totals) || !Array.isArray(value.records) || value.records.length > 4096) return false;
  const slots = ['checkpoint','result','null'].flatMap(module => [...METHODS,'null'].map(method => module + ':' + method));
  if (!Object.entries(value.totals).every(([key,count]) => slots.includes(key) && integer(count))
    || Object.values(value.totals).reduce((sum,count) => sum + count,0) !== value.ioCalls) return false;
  const failures = new Map();
  return value.records.every((item,index) => {
    if (!record(item) || item.sequence !== index + 1
      || Object.hasOwn(item,'ioOrdinal') && item.ioOrdinal !== null && item.ioOrdinal > value.ioCalls) return false;
    if (item.type === 'native-failure') {
      if (failures.has(item.ioOrdinal)) return false;
      failures.set(item.ioOrdinal,item);
    }
    if (item.type === 'native-cause-match' && item.match === 'matched') {
      const failure = failures.get(item.ioOrdinal);
      if (!failure || !Object.keys(item.nativeContext).every(key => item.nativeContext[key] === failure[key])) return false;
    }
    return true;
  });
}

function parseClosedTraceOutput(stdout) {
  const traces = [], frames = [], rejections = [];
  if (typeof stdout !== 'string') return { complete:false, traceCount:0, traces, frames, rejections:[{reason:'input-contract'}] };
  if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) {
    return { complete:false, traceCount:0, traces, frames, rejections:[{reason:'output-too-large',bytes:Buffer.byteLength(stdout),sha256:digest(stdout)}] };
  }
  const prefix = '# RAG_CLOSED_TRACE ', rows = stdout.split(/\r?\n/);
  let traceCount = 0;
  for (let index = 0; index < rows.length; index++) {
    if (!rows[index].startsWith(prefix)) continue;
    const start = index;
    let payload = rows[index].slice(prefix.length), value, parsed = false, tooManyFragments = false;
    traceCount++;
    if (traceCount > 64) {
      rejections.push({reason:'too-many-traces',lineIndex:start,bytes:Buffer.byteLength(payload),sha256:digest(payload)});
      break;
    }
    // Node's TAP serializer inserts "# " at stdout-chunk boundaries, not JSON newlines.
    // Only consecutive comment fragments may be joined; a new frame/control row stops it.
    while (Buffer.byteLength(payload) <= 4 * 1024 * 1024) {
      try { value = JSON.parse(payload); parsed = true; break; } catch { /* No raw JSON/error in diagnostics. */ }
      // A tiny malformed comment stream must not cause unbounded parse attempts.
      if (index - start + 1 >= 1024) { tooManyFragments = true; break; }
      const next = rows[index + 1];
      if (!next?.startsWith('# ') || next.startsWith(prefix)
        || /^# (Subtest:|tests\b|pass\b|fail\b|cancelled\b|skipped\b|todo\b|duration_ms\b)/.test(next)) break;
      payload += next.slice(2); index++;
    }
    const frame = {lineIndex:start,fragments:index-start+1,bytes:Buffer.byteLength(payload),sha256:digest(payload)};
    if (tooManyFragments) { rejections.push({...frame,reason:'too-many-fragments'}); continue; }
    if (frame.bytes > 4 * 1024 * 1024) { rejections.push({...frame,reason:'oversized'}); continue; }
    if (!parsed) { rejections.push({...frame,reason:'invalid-json'}); continue; }
    if (!validTrace(value)) { rejections.push({...frame,reason:'invalid-schema'}); continue; }
    traces.push(value); frames.push(frame);
  }
  return {complete:traceCount > 0 && rejections.length === 0 && traces.every(value => !value.overflow && value.observerFailures === 0),
    traceCount,traces,frames,rejections};
}


// Mirror the private product diagnostic spelling set at this text-decoding boundary.
// A listed spelling is not issuer authentication; all output remains non-production.
const DIAGNOSTIC_CODES = [
 'DURABLE_CHECKPOINT_CONFLICT','DURABLE_WORKFLOW_NOT_FOUND','DURABLE_CHECKPOINT_CAPACITY_EXCEEDED',
 'DURABLE_WORKFLOW_LEASE_MANAGEMENT_REJECTED','DURABLE_WORKFLOW_BUSY','DURABLE_WORKFLOW_STEP_FAILED','DURABLE_WORKFLOW_CANCELLED',
 'DURABLE_WORKFLOW_TERMINAL_STEP_FAILURE','DURABLE_WORKFLOW_FAILED','WORKFLOW_VERSION_MISMATCH','SCOPE_MISMATCH',
 'DOCUMENT_ID_MISMATCH','DOCUMENT_VERSION_MISMATCH','IDEMPOTENCY_KEY_MISMATCH','JOB_FINGERPRINT_MISMATCH',
 'DURABLE_ASK_RESULT_CAPACITY','DURABLE_ASK_RESULT_CONFLICT','DURABLE_ASK_RESULT_INTEGRITY','DURABLE_CHECKPOINT_INTEGRITY',
 'DURABLE_CHECKPOINT_SCAN_LIMIT','DURABLE_WORKFLOW_CONFIGURATION_INVALID','DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED',
 'DURABLE_ASK_RESULT_UNAVAILABLE','DURABLE_ASK_IDEMPOTENCY_KEY_INVALID','DURABLE_ASK_DISABLED','DURABLE_WORKFLOW_PAUSED',
 'ASK_INTERNAL_ERROR','DURABLE_ASK_INTERNAL_ERROR','AGENTIC_QUERY_FAILED','RAG_AGENT_PROVIDER_FAILED',
 'ENOENT','EPERM','EACCES','EBUSY','EEXIST','ENOTDIR','EISDIR','ENOSPC','EIO','UNCLASSIFIED','PAUSED'
];
const FAILURE_LABELS = new Map([
 ['POST durable execution persists a minimal checkpoint and replays one result','durable-checkpoint-replay'],
 ['whole-seal deadline fences late PG, clock, encryption, seal, readback and decrypt settlement without follow-up dispatch','whole-seal-deadline'],
 ['synchronous CPU overrun cannot bypass the whole-seal deadline or dispatch the next operation','cpu-overrun-deadline'],
 ['late clock completion cannot begin a source after the outer reader deadline','late-clock-deadline'],
]);
function summarizeUnitOutput(stdout) {
  const stats = {}, failedNames = [], failureDetails = [], rejectedLines = [];
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16*1024*1024) {
    return {stats,failedNames,failureDetails,rejectedLines,summaryComplete:false};
  }
  const statKeys = ['tests','pass','fail','cancelled','skipped','todo','duration_ms'];
  let duplicateStat = false, overflow = false;
  for (const row of stdout.split(/\r?\n/)) {
    if (!/^# (tests|pass|fail|cancelled|skipped|todo|duration_ms)\b/.test(row)) continue;
    const parsed = /^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9]+(?:\.[0-9]+)?)$/.exec(row);
    const number = parsed ? Number(parsed[2]) : NaN;
    if (!parsed || !Number.isFinite(number) || number < 0 || parsed[1] !== 'duration_ms' && !integer(number)) {
      if (rejectedLines.length < 64) rejectedLines.push({bytes:Buffer.byteLength(row),sha256:digest(row),reason:'invalid-stat'});
      else overflow = true;
      continue;
    }
    if (Object.hasOwn(stats,parsed[1])) duplicateStat = true;
    else stats[parsed[1]] = number;
  }
  const matches = [...stdout.matchAll(/^not ok ([0-9]+) - ([^\r\n]*)/gm)];
  for (const item of matches.slice(0,2048)) {
    const name = item[2], label = FAILURE_LABELS.get(name) ?? 'unmapped-test';
    const identifier = {caseLabel:label,nameSha256:digest('failed-test-name/v1\0'+name)};
    failedNames.push(identifier);
    const tail = stdout.slice(item.index), boundary = tail.indexOf('\n# Subtest:');
    const block = boundary < 0 ? tail : tail.slice(0,boundary);
    const httpStatus = key => {
      const found = new RegExp('^\\s*'+key+': ([0-9]+)\\s*$','m').exec(block), number = found ? Number(found[1]) : null;
      return number !== null && integer(number) && number >= 100 && number <= 599 ? number : null;
    };
    failureDetails.push({...identifier,expected:httpStatus('expected'),actual:httpStatus('actual')});
  }
  overflow ||= matches.length > 2048;
  return {stats,failedNames,failureDetails,rejectedLines,summaryComplete:!duplicateStat && !overflow
    && rejectedLines.length===0 && statKeys.every(key=>Object.hasOwn(stats,key))
    && stats.tests===stats.pass+stats.fail+stats.cancelled+stats.skipped+stats.todo};
}

function consumeOrdinaryUnsupportedPromise(value) {
  // Do not read an own then getter or invoke a caller-controlled constructor/species.
  // Unsafe/foreign carriers remain unknown; this is not cancellation or a general Promise guarantee.
  try {
    const same = (left,right) => !!left && !!right && ['value','get','set','writable','enumerable','configurable']
      .every(key=>hasOwn(left,key)===hasOwn(right,key)&&(!hasOwn(left,key)||left[key]===right[key]));
    if (isProxy(value) || !isPromise(value) || getPrototype(value)!==promisePrototype || hasOwn(value,'constructor')
      || !same(getDescriptor(promisePrototype,'constructor'),promiseConstructor)
      || !same(getDescriptor(nativePromise,Symbol.species),promiseSpecies)) return;
    apply(intrinsicThen,value,[undefined,()=>{}]);
  } catch { /* Observation never exposes the original rejection or executes an unsafe carrier. */ }
}

function observeWithFinalFreeze(observe, freeze) {
  let observationStatus = 'completed', freezeStatus = 'completed', unsupportedCompletionUnknown = false;
  try {
    // The CLI callbacks are synchronous void operations; unsupported carriers are not adopted.
    if (isProxy(observe) || isAsyncFunction(observe)) { observationStatus='failed'; unsupportedCompletionUnknown=true; }
    else {
      const returned = observe();
      if (returned !== undefined) { observationStatus='failed'; unsupportedCompletionUnknown=true; consumeOrdinaryUnsupportedPromise(returned); }
    }
  } catch { observationStatus = 'failed'; }
  finally {
    try {
      if (isProxy(freeze) || isAsyncFunction(freeze)) { freezeStatus='failed'; unsupportedCompletionUnknown=true; }
      else {
        const returned = freeze();
        if (returned !== undefined) { freezeStatus='failed'; unsupportedCompletionUnknown=true; consumeOrdinaryUnsupportedPromise(returned); }
      }
    }
    catch { freezeStatus = 'failed'; }
  }
  return {observationStatus,freezeStatus,unsupportedCompletionUnknown,productionAccepted:false};
}

module.exports = { parseClosedTraceOutput, observeWithFinalFreeze, summarizeUnitOutput };

function main() {
  const fs = require('node:fs'), ts = require('typescript'), vm = require('node:vm');
  let testDispatchStarted = false;
  try {
    if (process.argv.length !== 2 || process.env.NODE_TEST_CONTEXT) throw new Error('unsupported CLI context');
    const preflight = fs.readFileSync('docs/reports/.diagnostics/closed-rag-observer-preflight.cjs','utf8');
    if (digest(preflight) !== '5145fc6c61c173203cbcb808d158a886353768fceb48fa2ca207b9cf9a88201b') throw new Error('diagnostic source drift');
    const marker = 'process.exitCode=0;';
    if (preflight.indexOf(marker) < 0 || preflight.indexOf(marker) !== preflight.lastIndexOf(marker)) throw new Error('invalid run marker');
    const body = "const cp=require('child_process');\nconst ev='src/lib/rag/eval/',kg='src/lib/knowledge-graph/';\nconst stems=['canonical-json','production-gate-manifest','production-run-journal','production-authorization','production-provider-trust','production-controlled-artifacts','production-receipts','production-authorized-journal','production-artifact-conformance','production-journal-conformance','production-authority-ports','production-authority-approval','production-authority-conformance','bounded-provider-call','production-provider-registry','production-authority-receipts','production-provider-evidence'];\nconst extras=['production-authority-receipt-writer','production-manifest-authority','production-approval-provenance','production-existing-receipt','production-predecessor-receipt','production-authority-bundle-writer'];\nconst originals=['dataset','metrics','gate','matrix','production-policy-contract'].map(x=>ev+x+'.test.mjs').concat(['src/lib/rag/core/context-composer-v2.test.mjs','src/lib/rag/retrieval/legacy-evidence-adapter.test.mjs',kg+'contracts.test.mjs',kg+'postgres-publication-store.test.mjs',kg+'graph-snapshot-recovery.test.mjs','src/app/api/ask/route.test.mjs']);\nconst native=[kg+'build-publication-manifest.ts',kg+'build-publication-manifest.test.mjs',kg+'postgres-publication-readback.ts',kg+'postgres-publication-readback.test.mjs',kg+'postgres-publication-readback.integration.test.mjs',kg+'postgres-graph-build-store.ts',kg+'postgres-graph-build-store.test.mjs','scripts/graph-control-worker.ts','scripts/graph-control-worker.test.mjs','scripts/postgres-integration.test.mjs'];\nconst graph=[kg+'publication-identity.ts',kg+'publication-identity.test.mjs',kg+'neo4j-publication-readback.ts',kg+'neo4j-publication-readback.test.mjs',kg+'neo4j-publication-readback.integration.test.mjs',kg+'milvus-publication-readback.ts',kg+'milvus-publication-readback.test.mjs',kg+'milvus-publication-readback.integration.test.mjs'];\nconst newFiles=['production-publication-conformance','production-publication-state-observer','production-publication-artifact','production-manifest-publication-artifact','production-ask-target','production-ask-dataset-binding'].flatMap(x=>[ev+x+'.ts',ev+x+'.test.mjs']).concat(['src/lib/rag/core/durable-error-diagnostic.ts','src/lib/rag/core/durable-error-diagnostic.test.mjs']).concat([ev+'production-ask-artifact-framing.ts',ev+'production-ask-artifact-framing.test.mjs']);\nnewFiles.push(ev+'production-ask-artifact-writer.ts',ev+'production-ask-artifact-writer.test.mjs');\nconst factory=[kg+'native-publication-sources.ts',kg+'native-publication-sources.test.mjs'];const combo=kg+'native-publication-sources.integration.test.mjs';\nconst additionalEvaluationFiles=[ev+'production-ask-reference-evaluator.test.mjs',ev+'production-ask-dataset-fixtures.test-support.mjs'];\nconst strict=stems.map(x=>ev+x+'.ts').concat(native.filter(x=>x.endsWith('.ts')),graph.filter(x=>x.endsWith('.ts')),factory[0],newFiles.filter(x=>x.endsWith('.ts')));\nconst lint=native.concat(graph,factory,[ev+'bounded-provider-call.ts',ev+'bounded-provider-call.test.mjs',combo],newFiles,['src/app/api/ask/runtime.ts','src/app/api/ask/route.test.mjs']).concat(additionalEvaluationFiles);\nconst tests=originals.concat(stems.map(x=>ev+x+'.test.mjs'),extras.map(x=>ev+x+'.test.mjs'),[kg+'publication-identity.test.mjs',kg+'build-publication-manifest.test.mjs',kg+'postgres-publication-readback.test.mjs',kg+'postgres-graph-build-store.test.mjs','scripts/graph-control-worker.test.mjs',kg+'local-graph-build-executor.test.mjs',kg+'auto-build.test.mjs',kg+'neo4j-publication-readback.test.mjs',kg+'milvus-publication-readback.test.mjs',factory[1]],newFiles.filter(x=>x.endsWith('.mjs'))).concat([additionalEvaluationFiles[0]]);\nconst baseline=fs.readFileSync('docs/reports/2026-10-09-rag-production-baseline.md','utf8');const prior=[...baseline.matchAll(/\\| \\x60([^\\x60]+)\\x60 \\| \\x60[a-f0-9]{64}\\x60 \\|/g)].map(x=>x[1]);\nconst watch=[...new Set(prior.concat(strict,tests,lint,extras.map(x=>ev+x+'.test.mjs'),['production-provider-fixtures','production-manifest-fixtures','production-receipt-fixtures'].map(x=>ev+x+'.test-support.mjs'),[kg+'local-graph-build-executor.ts',kg+'auto-build.ts','src/lib/security/request-validation.ts']))];\nconst hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');watch.push('eslint.config.mjs','docs/reports/.diagnostics/closed-rag-observer-template.mjs','docs/reports/.diagnostics/closed-rag-observer-preflight.cjs','docs/reports/.diagnostics/closed-rag-observer-run.cjs','docs/reports/.diagnostics/closed-rag-trace-parser.test.mjs');const before=Object.fromEntries(watch.map(p=>[p,hash(p)]));\nconsole.log(JSON.stringify({name:'publicationFreezeInventory',strictRoots:strict.length,lintFiles:lint.length,testFiles:tests.length,watched:watch.length,strict,lint,tests}));\nconst diagnosticRecords=(out)=>[...out.matchAll(/# \\[Ask API\\] durable failure diagnostic \\{([\\s\\S]*?)\\n# \\}/g)].map(m=>{const b=m[1];const field=(key)=>{const x=b.match(new RegExp(\"\\\\b\"+key+\": (?:'([^']{0,128})'|(null|[0-9]+))\"));return x?(x[1]??(x[2]==='null'?null:Number(x[2]))):null;};const list=b.match(/codeChain:\\s*\\[([\\s\\S]*?)\\]/);return {requestIdHash:/^[a-f0-9]{64}$/.test(field('requestIdHash')??'')?field('requestIdHash'):null,stage:['durable-catch','durable-return'].includes(field('stage'))?field('stage'):null,status:field('status'),publicCode:typeof field('publicCode')==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(field('publicCode'))?field('publicCode'):null,mappedCode:typeof field('mappedCode')==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(field('mappedCode'))?field('mappedCode'):null,codeChain:list?[...list[1].matchAll(/'([A-Z][A-Z0-9_]{0,63})'/g)].slice(0,8).map(v=>v[1]):[],causeDepth:field('causeDepth'),chainTermination:['end','depth-limit','cycle','accessor','proxy','non-object','uninspectable'].includes(field('chainTermination'))?field('chainTermination'):null,nextFailed:/^not ok/m.test(out.slice(m.index+m[0].length).split(/(?=^# Subtest:)/m)[0])};});\nlet decoded = null;\nfunction run(name,args){testDispatchStarted = true;const started=new Date().toISOString();const r=cp.spawnSync(process.execPath,args,{encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024,env:{...process.env,RAG_SEMANTIC_ROUTER:'off'}});const out=r.stdout??'',err=r.stderr??'',summary=summarizeUnitOutput(out);\nconst diagnostics=diagnosticRecords(out).slice(0,128).map(item=>({...item,status:Number.isSafeInteger(item.status)&&item.status>=100&&item.status<=599?item.status:null,causeDepth:Number.isSafeInteger(item.causeDepth)&&item.causeDepth>=0&&item.causeDepth<=8?item.causeDepth:null,publicCode:DIAGNOSTIC_CODES.includes(item.publicCode)?item.publicCode:null,mappedCode:DIAGNOSTIC_CODES.includes(item.mappedCode)?item.mappedCode:null,codeChain:item.codeChain.map(code=>DIAGNOSTIC_CODES.includes(code)?code:'UNCLASSIFIED')}));\nconsole.log(JSON.stringify({name,started,ended:new Date().toISOString(),status:r.status,error:r.error?.code??null,...summary,stdoutSha:digest(out),stderrSha:digest(err),diagnosticRecords:diagnostics,stderrBytes:Buffer.byteLength(err)}));\ndecoded = parseClosedTraceOutput(out);\nconsole.log(JSON.stringify({name:'closedObservationTraceBatch',complete:decoded.complete,traceCount:decoded.traceCount,frames:decoded.frames,rejections:decoded.rejections,traces:decoded.traces.map(t=>{const statusCounts={},recordTypes={};for(const r of t.records){recordTypes[r.type]=(recordTypes[r.type]??0)+1;if(r.type==='post-response')statusCounts[r.status]=(statusCounts[r.status]??0)+1;}return {schemaVersion:t.schemaVersion,productionAccepted:t.productionAccepted,overflow:t.overflow,observerFailures:t.observerFailures,ioCalls:t.ioCalls,totals:t.totals,recordCount:t.records.length,recordTypes,statusCounts,closedTraceSha:digest(JSON.stringify(t)),records:t.records.filter(r=>r.type!=='post-response'||r.status>=500)};})}));\nreturn r.status===0&&summary.summaryComplete;}\n\nconsole.log(JSON.stringify({name:'closedObservationRunSettings',changedObservation:true,strict34Repeated:false,appLint45Repeated:false,singleImport:true,nodeTestTimeoutMs:30000,parentTimeoutMs:90000,maxBuffer:16*1024*1024,defaultConcurrency:true,router:'off',productionAccepted:false}));\nlet unit = false, drift = null;\nconst finalized = observeWithFinalFreeze(() => {\n  unit = run('closedObservedUnit54',['--import',loader,'--test','--test-timeout=30000',...tests]);\n}, () => {\n  drift = watch.filter(p=>hash(p)!==before[p]);\n  console.log(JSON.stringify({name:'closedObservationFreeze',watched:watch.length,drift,eslintConfigSha:hash('eslint.config.mjs'),diagnosticIdentities:Object.fromEntries(watch.slice(-4).map(p=>[p,hash(p)])),writerIdentities:Object.fromEntries([ev+'production-ask-artifact-writer.ts',ev+'production-ask-artifact-writer.test.mjs'].map(p=>[p,hash(p)])),productionAccepted:false}));\n});\nconsole.log(JSON.stringify({name:'closedObservationFinalization',...finalized,unitSucceeded:unit,transportComplete:decoded?.complete??false,freezeDriftCount:drift?.length??null}));\nprocess.exitCode=unit&&decoded?.complete&&finalized.observationStatus==='completed'&&finalized.freezeStatus==='completed'&&drift?.length===0?0:1;\n";
    // Serialize the same closed catalog into the executable instead of relying on eval-only lexical usage.
    const executable = preflight.replace(marker, () => 'const DIAGNOSTIC_CODES = ' + JSON.stringify(DIAGNOSTIC_CODES) + ';\n' + body);
    const parsed = ts.createSourceFile('closed-observation-parent.cjs',executable,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    if (parsed.parseDiagnostics.length) throw new Error('parent syntax invalid');
    new vm.Script(executable);
    console.log(JSON.stringify({name:'closedObservationParentIdentity',scriptSha:digest(executable),nativeSyntax:true,productionAccepted:false}));
    eval(executable);
  } catch {
    console.log(JSON.stringify({name:'closedObservationParentRejected',testDispatchStarted,code:'diagnostic-parent-failed',productionAccepted:false}));
    process.exitCode = 2;
  }
}
if (require.main === module) main();
