
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks } from 'node:module';
import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const patches={};
const key=Symbol.for('rag.closed-test-observer/v1'),als=new AsyncLocalStorage(),nativeErrors=new WeakMap();
const records=[],totals=Object.create(null);let sequence=0,ioOrdinal=0,requestOrdinal=0,writerOrdinal=0,overflow=false,observerFailures=0,current=null;
const promiseProto=Promise.prototype,then=Promise.prototype.then,apply=Reflect.apply;
const ctor=Object.getOwnPropertyDescriptor(promiseProto,'constructor'),species=Object.getOwnPropertyDescriptor(Promise,Symbol.species);
const allowedCodes=['invalid-config','invalid-request','busy','already-sealed','halted','publication-mismatch','invalid-clock','invalid-key','invalid-readback','operation-failed','operation-timeout','provider-contract-invalid'];
const allowedPhases=['configuration','preflight','publication-read','clock','encrypt','seal','readback','decrypt','final-validation'];
const fsCodes=['EPERM','EACCES','ENOENT','EEXIST','ENOTDIR','EISDIR','EBUSY','EMFILE','ENFILE','ENOSPC','EIO','EINVAL','ENOTEMPTY','UNKNOWN'];
const methods=['readPostgres','readNeo4j','readMilvusPage','readTime','encryptArtifact','sealEncryptedArtifact','readExact','decryptArtifact','open','rename','link','unlink','writeFile','sync','close','read','stat'];
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const value=(o,k)=>{if(!o||typeof o!=='object'||types.isProxy(o))return undefined;const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
const closed=(v,list)=>list.includes(v)?v:null;
const bool=v=>typeof v==='boolean'?v:null;
const tag=v=>typeof v==='string'&&/^[a-f0-9]{16}$/.test(v)?v:null;
const append=r=>{try{if(records.length>=4096){overflow=true;return;}records.push({sequence:++sequence,...r});}catch{observerFailures++;}};
const safe=e=>({code:closed(value(e,'code'),allowedCodes),phase:closed(value(e,'phase'),allowedPhases),
 pending:bool(value(e,'pendingCompletionUnknown')),mutation:bool(value(e,'mutationMayHaveOccurred')),
 retry:bool(value(e,'automaticRetryAllowed')),production:bool(value(e,'productionAccepted')),frozen:!!e&&typeof e==='object'&&!types.isProxy(e)?Object.isFrozen(e):null});
const counts=f=>{const out=Object.fromEntries(methods.slice(0,8).map(m=>[m,0]));const calls=value(f,'calls');
 const readable=!types.isProxy(calls)&&Array.isArray(calls),length=readable?value(calls,'length'):null;
 if(readable){if(length>4096)overflow=true;for(let i=0;i<Math.min(length,4096);i++){const c=value(calls,String(i)),m=value(c,'method');if(typeof m==='string'&&Object.hasOwn(out,m))out[m]++;}}
 return {...out,total:readable?length:null};};
const summarize=c=>c?{caseTag:tag(value(c,'caseTag')),kind:closed(value(c,'kind'),['whole-seal','cpu-overrun','late-clock']),method:closed(value(c,'method'),methods),expectedMutation:bool(value(c,'expectedMutation')),
 held:bool(value(c,'held')),actualReturned:bool(value(c,'actualReturned')),spinStarted:bool(value(c,'spinStarted')),spinCompleted:bool(value(c,'spinCompleted'))}:{caseTag:null,kind:null};
function observe(p,onGood,onBad){try{
 const same=(a,b)=>!!a&&!!b&&['value','get','set','writable','enumerable','configurable'].every(k=>Object.hasOwn(a,k)===Object.hasOwn(b,k)&&(!Object.hasOwn(a,k)||a[k]===b[k]));
 if(types.isProxy(p)||!types.isPromise(p)||Object.getPrototypeOf(p)!==promiseProto||Object.hasOwn(p,'constructor')
 ||!same(Object.getOwnPropertyDescriptor(promiseProto,'constructor'),ctor)||!same(Object.getOwnPropertyDescriptor(Promise,Symbol.species),species)){observerFailures++;return;}
 apply(then,p,[v=>{try{onGood?.(v);}catch{observerFailures++;}},e=>{try{onBad?.(e);}catch{observerFailures++;}}]);
}catch{observerFailures++;}}
let responseState;
try{responseState=Reflect.ownKeys(new Response()).find(k=>typeof k==='symbol'&&k.description==='state');}catch{}
function status(r){const s=responseState?value(r,responseState):null;const n=value(s,'status');return Number.isInteger(n)&&n>=100&&n<=599?n:null;}
const controller={
 factory(f,execute){if(current&&value(current,'f')!==f)current=null;return execute();},
 context(f,kind,caseTag,method=null,expectedMutation=null){const c={f,kind,caseTag,method,expectedMutation,held:false,actualReturned:false,spinStarted:false,spinCompleted:false};current=c;return c;},
 checkpoint(c,point){try{append({type:'deadline-checkpoint',...summarize(c),point:closed(point,['before-predicate','after-release','after-close','cpu-terminal']),counts:counts(value(c,'f'))});}catch{observerFailures++;}},
 validator(original){const c=current;return e=>{let passed;try{passed=original(e);}catch(error){
   // Diagnostic failure must not replace the original predicate's Error identity.
   try{append({type:'deadline-validator',...summarize(c),predicateThrown:true,...safe(e),counts:counts(value(c,'f'))});}catch{observerFailures++;}throw error;}
  if(c)try{append({type:'deadline-validator',...summarize(c),predicatePassed:passed===true,...safe(e),counts:counts(value(c,'f'))});}catch{observerFailures++;}return passed;};},
 conformance(c,result,clockEntries,point){try{const ps=value(result,'probes'),first=!types.isProxy(ps)&&Array.isArray(ps)?value(ps,'0'):null,f=value(c,'f'),selections=value(f,'selections');append({type:'conformance',...summarize(c),point:closed(point,['run-return','released']),
  verdict:closed(value(result,'verdict'),['passed','failed','incomplete']),pending:bool(value(result,'pendingCompletionUnknown')),
  firstOutcome:closed(value(first,'outcome'),['passed','failed','not-run']),clockEntries:number(clockEntries),sourceCount:counts(f).total,
  selectionCount:!types.isProxy(selections)&&Array.isArray(selections)?number(value(selections,'length')):null,fifthClockHeld:bool(value(c,'held'))});}catch{observerFailures++;}},
 post(caseTag,site,execute){const ctx={caseTag:tag(caseTag),postSite:number(site),requestOrdinal:++requestOrdinal,category:null,writerOrdinal:null};return als.run(ctx,()=>{
  let result;try{result=execute();}catch(e){append({type:'post-throw',...ctx});throw e;}
  observe(result,r=>append({type:'post-response',...ctx,status:status(r)}),()=>append({type:'post-rejected',...ctx}));return result;
 });},
 category(category,execute){const c=als.getStore();return c?als.run({...c,category:closed(category,['root-ledger','scope-ledger','scope-marker','store-marker','cursor','reservation','rebuild-marker']),writerOrdinal:++writerOrdinal},execute):execute();},
 io(moduleId,site,method,native,execute){const c=als.getStore();if(!c)return execute();const id=++ioOrdinal;moduleId=closed(moduleId,['checkpoint','result']);method=closed(method,methods);site=number(site);native=bool(native);const slot=moduleId+':'+method;
  totals[slot]=(totals[slot]??0)+1;const meta={...c,moduleId,ioSite:site,ioOrdinal:id,method,native};
  const bad=e=>{if(e&&typeof e==='object'&&!types.isProxy(e)){const r={type:'native-failure',...meta,fsCode:closed(value(e,'code'),fsCodes),
    syscall:closed(value(e,'syscall'),['rename','link','open','unlink','write','read','stat','fsync','close'])};
    // Error identity may be reused; never overwrite evidence and invent uniqueness.
    let association=nativeErrors.get(e);if(!association){association={rows:[],overflow:false};nativeErrors.set(e,association);}
    if(association.rows.length<8)association.rows.push(r);else{association.overflow=true;overflow=true;}append(r);}};
  let p;try{p=execute();}catch(e){try{bad(e);}catch{observerFailures++;}throw e;}observe(p,null,bad);return p;
 },
 cause(error){try{const c=als.getStore();if(!c)return;const seen=new Set(),hits=[];let e=error,termination='end',associationOverflow=false;
  for(let d=0;d<8;d++){if(!e||typeof e!=='object'){termination='end';break;}if(types.isProxy(e)){termination='proxy';break;}if(seen.has(e)){termination='cycle';break;}
   seen.add(e);const association=nativeErrors.get(e);if(association){hits.push(...association.rows);associationOverflow ||= association.overflow;}const own=Object.getOwnPropertyDescriptor(e,'cause');
   if(!own){termination='end';break;}if(!Object.hasOwn(own,'value')){termination='accessor';break;}e=own.value;if(d===7)termination='depth-limit';
  }
  const unique=[...new Map(hits.map(h=>[h.ioOrdinal,h])).values()],hit=unique[0];
  // Only a complete, single-candidate, same-request chain proves this association.
  const match=termination!=='end'||associationOverflow?'incomplete':unique.length>1?'ambiguous':unique.length===0?'unmatched':hit.requestOrdinal!==c.requestOrdinal?'cross-request':'matched';
  append({type:'native-cause-match',...c,match,termination,associationOverflow,candidateCount:unique.length,
   currentRequestCandidateCount:unique.filter(h=>h.requestOrdinal===c.requestOrdinal).length,
   ioOrdinal:match==='matched'?hit.ioOrdinal:null,nativeContext:match==='matched'?{caseTag:hit.caseTag,postSite:hit.postSite,ioSite:hit.ioSite,requestOrdinal:hit.requestOrdinal,
    category:hit.category,writerOrdinal:hit.writerOrdinal,moduleId:hit.moduleId,method:hit.method,native:hit.native,fsCode:hit.fsCode,syscall:hit.syscall}:null});
 }catch{observerFailures++;}}
};
Object.defineProperty(globalThis,key,{value:Object.freeze(controller),configurable:false,writable:false});
registerHooks({load(url,context,next){const r=next(url,context);if(!url.startsWith('file:'))return r;
 const p=fileURLToPath(url).replaceAll('\\','/');const entry=Object.entries(patches).find(([path])=>p.endsWith('/'+path));if(!entry)return r;
 let source=typeof r.source==='string'?r.source:Buffer.from(r.source).toString('utf8');const data=entry[1];
 if(createHash('sha256').update(source).digest('hex')!==data.sha256)throw new Error('[closed diagnostic] source identity mismatch');
 for(const patch of data.patches)source=source.slice(0,patch.start)+patch.text+source.slice(patch.end);
 return {...r,source};
}});
process.on('exit',()=>{if(records.length||overflow||observerFailures)console.log('RAG_CLOSED_TRACE '+JSON.stringify({
 schemaVersion:'rag-closed-test-trace/v1',productionAccepted:false,overflow,observerFailures,ioCalls:ioOrdinal,totals,records}));});

