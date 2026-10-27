import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[cm]?[jt]s$/.test(s))return n(s+'.ts',c);throw e;}}});
const {fixture,rebindExecution}=await import('./production-ask-dataset-fixtures.test-support.mjs');
const {canonicalJsonSha256:hash}=await import('./canonical-json.ts');
const {createReferenceProductionAskArtifactFramer}=await import('./production-ask-artifact-framing.ts');
const {createReferenceAuthorityClock}=await import('./production-authority-ports.ts');
const {createReferenceKmsEnvelope,createReferenceArtifactStore,validateControlledArtifactIndex}=await import('./production-controlled-artifacts.ts');
let subject;try{subject=await import('./production-ask-artifact-writer.ts');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;subject={};}
const clone=x=>structuredClone(x);
const sha=b=>createHash('sha256').update(b).digest('hex');
const ref=name=>({objectId:name,objectVersion:'v1',sha256:hash(name)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const flags={executionProfile:'local-reference',productionCapable:false};
const make=f=>subject.createReferenceProductionAskArtifactWriter(f.options,f.base.rawDatasetJson,f.ports);
const payload=(f,bytes=Buffer.from('RAW_SECRET_BODY'),changes={})=>JSON.stringify({
 schemaVersion:'kg-reference-ask-artifact-payload/v1',request:{caseId:f.base.dataset.cases[0].id,rolloutMode:'off',phase:'trial',ordinal:0},
 artifactType:'response',payloadBase64url:bytes.toString('base64url'),...changes});
const failure=(code,phase)=>e=>typeof subject.ProductionAskArtifactWriterError==='function'
 &&e instanceof subject.ProductionAskArtifactWriterError&&e.code===code&&(!phase||e.phase===phase)
 &&e.productionAccepted===false&&e.automaticRetryAllowed===false&&Object.isFrozen(e)&&!Object.hasOwn(e,'cause')
 &&!JSON.stringify(e).includes('RAW_SECRET')&&!e.message.includes('secret-token');
function frozen(x){if(x&&typeof x==='object'){assert.ok(Object.isFrozen(x));for(const v of Object.values(x))frozen(v);}}
function ownPort(native,methods,calls){return {...flags,...Object.fromEntries(methods.map(name=>[name,function(request){
 calls.push({name,request});return Reflect.apply(native[name],native,[request]);
}]))};}
async function setup(stage='T16',before){
 const base=fixture(stage);if(before){before(base);rebindExecution(base);}
 const framer=createReferenceProductionAskArtifactFramer(base.options,base.rawDatasetJson);
 const binding=framer.bindingProof.binding,p=base.options.expectedExecutionPayload,participants=p.participants;
 const at=new Date(Date.parse(p.notBefore)+60000).toISOString(),storeRef=ref('ask-store'),clockRef=ref('ask-clock');
 const common={executionProfile:'local-reference',binding,actors:{executorId:participants.executorId,readOnlyId:participants.readOnlyId},
 validFrom:p.notBefore,validUntil:p.expiresAt,maxObjects:1000};
 const kms=createReferenceKmsEnvelope({...common,keyPolicyRef:base.options.manifest.base.artifactPolicy.keyPolicyRef,maxPlaintextBytes:65536});
 const expectedKeyRef=await kms.rotateKey({context:{executionProfile:'local-reference',binding,actorId:participants.executorId,
 authorizationDigest:base.options.executionAuthorizationRef.sha256,observedAt:at}});
 const store=createReferenceArtifactStore({...common,storeIdentityRef:storeRef,maxObjectBytes:256*1024});
 const clock=createReferenceAuthorityClock({executionProfile:'local-reference',scope:p.scope,allowedActorIds:[participants.executorId,participants.readOnlyId],
 sourceIdentityRef:clockRef,initialObservedAt:at,uncertaintyMs:1,maxReadings:10000,maxAdvanceMs:86400000});
 const calls=[],ports={clock:ownPort(clock,['readTime'],calls),kms:ownPort(kms,['encryptArtifact','decryptArtifact'],calls),
 store:ownPort(store,['sealEncryptedArtifact','readExact'],calls)};
 const options={executionProfile:'local-reference',askOptions:clone(base.options),artifacts:{expectedKeyRef:clone(expectedKeyRef),storeIdentityRef:storeRef,
 clockIdentityRef:clockRef,maxClockUncertaintyMs:10,retainUntil:new Date(Date.parse(p.window.endsAt)+3600000).toISOString(),operationTimeoutMs:10000}};
 return {base,framer,binding,kms,store,clock,options,ports,calls,at};
}
const count=(f,name)=>f.calls.filter(v=>v.name===name).length;

test('original complete framer and actual clock KMS store fixture are valid before writer exists',async()=>{
 const f=await setup(),frame=f.framer.frame(payload(f)),part=frame.forEncryption(0);
 const reading=await f.clock.readTime({context:{executionProfile:'local-reference',binding:f.binding,actorId:'executor'},requestNonce:'a'.repeat(32)});
 const ctx=actorId=>({executionProfile:'local-reference',binding:f.binding,actorId,authorizationDigest:f.base.options.executionAuthorizationRef.sha256,observedAt:reading.observedAt});
 const envelope=await f.kms.encryptArtifact({context:ctx('executor'),...part});
 const objectRef=await f.store.sealEncryptedArtifact({context:ctx('executor'),aad:part.aad,envelope,retainUntil:f.options.artifacts.retainUntil});
 const read=await f.store.readExact({context:ctx('independent-reader'),ref:objectRef});
 assert.equal(await f.kms.decryptArtifact({context:ctx('independent-reader'),aad:read.object.aad,envelope:read.object.envelope}),part.plaintextBase64url);
});

test('writer composition is pure until request then completes actual encrypted exact-readback',async()=>{
 const f=await setup();assert.equal(typeof subject.createReferenceProductionAskArtifactWriter,'function');const writer=make(f);
 assert.equal(f.calls.length,0);frozen(writer);
 const result=await writer.sealReadback(payload(f));frozen(result);
 assert.equal(result.schemaVersion,'kg-ask-artifact-observation/v1');assert.equal(result.encryptedReadbackMatched,true);
 for(const key of ['productionAccepted','stageAcceptanceComplete','bodySourceAuthenticated','encryptionAuthenticated','storeAuthenticated','timeAuthenticated'])assert.equal(result[key],false);
 assert.equal(result.bodyByteLength,15);assert.equal(result.bodySha256,sha(Buffer.from('RAW_SECRET_BODY')));
 assert.equal(JSON.stringify(result).includes('RAW_SECRET_BODY'),false);
 assert.equal(JSON.stringify(result).includes(Buffer.from('RAW_SECRET_BODY').toString('base64url')),false);
 assert.equal(count(f,'encryptArtifact'),1);assert.equal(count(f,'sealEncryptedArtifact'),1);assert.equal(count(f,'readExact'),1);assert.equal(count(f,'decryptArtifact'),1);
 assert.equal(count(f,'readTime'),5);const {observationHash,...core}=result;assert.equal(observationHash,hash(core));
});

test('complete multi-byte 300000-byte body traverses every part and uses fresh clock for every dispatch',async()=>{
 const f=await setup(),bytes=Buffer.from('\u4e2d'.repeat(100000)),writer=make(f),result=await writer.sealReadback(payload(f,bytes));
 const n=Math.ceil(bytes.length/65536);assert.equal(result.partCount,n);assert.equal(result.bodySha256,sha(bytes));assert.equal(result.bodyByteLength,bytes.length);
 for(const name of ['encryptArtifact','sealEncryptedArtifact','readExact','decryptArtifact'])assert.equal(count(f,name),n);
 assert.equal(count(f,'readTime'),4*n+1);
 for(const item of f.calls)frozen(item.request);
 const clocks=f.calls.filter(v=>v.name==='readTime');assert.equal(new Set(clocks.map(v=>v.request.requestNonce)).size,clocks.length);
 assert.equal(validateControlledArtifactIndex(result.artifactIndex).indexHash,result.indexHash);
 assert.deepEqual(result.artifactIndex.entries.map(v=>v.objectRef),f.calls.filter(v=>v.name==='readExact').map(v=>v.request.ref));
 assert.deepEqual(clocks.slice(0,-1).map(v=>v.request.context.actorId),Array.from({length:n},()=>['executor','executor','independent-reader','independent-reader']).flat());
});

test('full original 16MiB response is encrypted and read back as all 256 parts, never a smaller budget',async()=>{
 const f=await setup('T17',b=>{const p=b.options.deploymentPolicy.registrations.find(v=>v.purpose==='ask').networkPolicy;p.maxResponseBytes=16*1024*1024;p.maxStreamBytes=16*1024*1024;});
 const bytes=Buffer.alloc(16*1024*1024,0xa5),result=await make(f).sealReadback(payload(f,bytes));
 assert.equal(result.bodyByteLength,bytes.length);assert.equal(result.bodySha256,sha(bytes));assert.equal(result.partCount,256);
 assert.equal(result.artifactIndex.entries.length,256);assert.equal(count(f,'decryptArtifact'),256);assert.equal(count(f,'readTime'),1025);
});

test('all five original body types and valid T17 arms phases share pinned key but distinct semantic slots',async()=>{
 const f=await setup('T17'),writer=make(f),slots=new Set();
 for(const mode of ['off','active'])for(const phase of ['warmup','trial'])for(const type of ['request','gold','response','error','telemetry']){
  const result=await writer.sealReadback(payload(f,Buffer.alloc(0),{artifactType:type,request:{caseId:f.base.dataset.cases[0].id,rolloutMode:mode,phase,ordinal:0}}));
  assert.equal(result.partCount,1);assert.equal(result.bodyByteLength,0);
  const e=result.artifactIndex.entries[0],slot=JSON.stringify([e.artifactType,e.caseId,e.ordinal]);assert.equal(slots.has(slot),false);slots.add(slot);
 }
 assert.equal(slots.size,20);
});

test('a sealed semantic slot cannot be overwritten even with a different body and artifact ID',async()=>{
 const f=await setup(),writer=make(f);await writer.sealReadback(payload(f));
 const before=f.calls.length;await assert.rejects(writer.sealReadback(payload(f,Buffer.from('different'))),failure('already-sealed','preflight'));
 assert.equal(f.calls.length,before);
});

test('caller options dataset and captured methods detach; receiver semantics remain stable',async()=>{
 const f=await setup(),writer=make(f),expected=f.framer.frame(payload(f)).layout.bodySha256;
 f.options.artifacts.expectedKeyRef.sha256='0'.repeat(64);f.options.askOptions.manifest.base.scope.tenantId='other';
 f.base.dataset.cases[0].query='PRIVATE';f.ports.kms.encryptArtifact=()=>{throw new Error('secret-token');};
 const result=await writer.sealReadback(payload(f));assert.equal(result.bodySha256,expected);
});

test('expiration before encryption fails closed and performs no mutation',async()=>{
 const f=await setup();f.clock.advanceTo(f.base.options.expectedExecutionPayload.expiresAt);const writer=make(f);
 await assert.rejects(writer.sealReadback(payload(f)),e=>failure('invalid-clock','clock')(e)&&e.mutationMayHaveOccurred===false);
 assert.equal(count(f,'encryptArtifact'),0);await assert.rejects(writer.sealReadback(payload(f)),failure('halted','preflight'));
});

test('time must be reobserved after encryption and before seal; expiry prevents all later dispatch',async()=>{
 const f=await setup(),old=f.ports.kms.encryptArtifact;
 f.ports.kms.encryptArtifact=function(r){const pending=Reflect.apply(old,this,[r]);f.clock.advanceTo(f.base.options.expectedExecutionPayload.expiresAt);return pending;};
 const writer=make(f);await assert.rejects(writer.sealReadback(payload(f)),e=>failure('invalid-clock','clock')(e)&&e.mutationMayHaveOccurred===true);
 assert.equal(count(f,'encryptArtifact'),1);assert.equal(count(f,'sealEncryptedArtifact'),0);
});

test('global clock sequence reader source uncertainty and uncertainty-window boundaries are checked',async()=>{
 for(const change of [r=>{r.sequence=1;},r=>{r.readerId='other';},r=>{r.sourceIdentityRef.sha256='0'.repeat(64);},
 r=>{r.uncertaintyMs=11;},(r,f)=>{r.observedAt=f.base.options.expectedExecutionPayload.notBefore;}]){
  const f=await setup(),old=f.ports.clock.readTime;let number=0;
  f.ports.clock.readTime=function(req){return Reflect.apply(old,this,[req]).then(r=>{const x=clone(r);if(++number===2)change(x,f);return x;});};
  await assert.rejects(make(f).sealReadback(payload(f)),failure('invalid-clock','clock'));
  assert.equal(count(f,'sealEncryptedArtifact'),0);
 }
});

test('wrong key AAD ciphertext profile and nonce are rejected before storing',async()=>{
 for(const change of [e=>{e.keyRef.sha256='0'.repeat(64);},e=>{e.aadSha256='0'.repeat(64);},e=>{e.algorithm='none';},e=>{e.nonce='invalid';}]){
  const f=await setup(),old=f.ports.kms.encryptArtifact;f.ports.kms.encryptArtifact=function(req){return Reflect.apply(old,this,[req]).then(e=>{const x=clone(e);change(x);return x;});};
  await assert.rejects(make(f).sealReadback(payload(f)),failure('invalid-key','encrypt'));assert.equal(count(f,'sealEncryptedArtifact'),0);
 }
});

test('exact immutable reference and all independent store proof fields must match actual expectations',async()=>{
 for(const change of [r=>{r.proof.readerId='executor';},r=>{r.proof.storeIdentityRef.sha256='0'.repeat(64);},
 r=>{r.object.retainUntil='2026-10-09T07:00:00.000Z';},r=>{r.proof.objectRef.objectVersion='other';},r=>{r.proof.productionTamperResistant=true;}]){
  const f=await setup(),old=f.ports.store.readExact;f.ports.store.readExact=function(req){return Reflect.apply(old,this,[req]).then(r=>{const x=clone(r);change(x);return x;});};
  await assert.rejects(make(f).sealReadback(payload(f)),failure('invalid-readback','readback'));assert.equal(count(f,'decryptArtifact'),0);
 }
 const f=await setup(),old=f.ports.store.sealEncryptedArtifact;f.ports.store.sealEncryptedArtifact=function(req){return Reflect.apply(old,this,[req]).then(r=>({...r,sha256:'0'.repeat(64)}));};
 await assert.rejects(make(f).sealReadback(payload(f)),failure('invalid-readback','seal'));assert.equal(count(f,'readExact'),0);
});

test('decryption must equal complete private original part and any failure stops later parts',async()=>{
 const f=await setup();f.ports.kms.decryptArtifact=async()=>Buffer.from('RAW_SECRET_TAMPER').toString('base64url');
 await assert.rejects(make(f).sealReadback(payload(f,Buffer.alloc(140000,0x2a))),failure('invalid-readback','decrypt'));
 assert.equal(count(f,'encryptArtifact'),1);
});

test('pending encrypt times out UNKNOWN and late settlement cannot seal or restart the closed writer',async()=>{
 const f=await setup();f.options.artifacts.operationTimeoutMs=20;let resolve;
 f.ports.kms.encryptArtifact=function(){return new Promise(r=>{resolve=r;});};
 const writer=make(f);await assert.rejects(writer.sealReadback(payload(f)),e=>failure('operation-timeout','encrypt')(e)&&e.pendingCompletionUnknown&&e.mutationMayHaveOccurred);
 assert.equal(count(f,'sealEncryptedArtifact'),0);resolve({});await sleep(10);assert.equal(count(f,'sealEncryptedArtifact'),0);
 await assert.rejects(writer.sealReadback(payload(f)),failure('halted','preflight'));
});

test('synchronous provider CPU past absolute deadline is a completed timeout with mutation retained',async()=>{
 const f=await setup();f.options.artifacts.operationTimeoutMs=10;const old=f.ports.kms.encryptArtifact;
 f.ports.kms.encryptArtifact=function(req){const at=performance.now();while(performance.now()-at<25){}return Reflect.apply(old,this,[req]);};
 await assert.rejects(make(f).sealReadback(payload(f)),e=>failure('operation-timeout','encrypt')(e)&&!e.pendingCompletionUnknown&&e.mutationMayHaveOccurred);
 assert.equal(count(f,'sealEncryptedArtifact'),0);
});

test('multiple individually bounded calls share one total deadline and no dispatch follows failure',async()=>{
 const f=await setup();f.options.artifacts.operationTimeoutMs=25;
 for(const port of Object.values(f.ports))for(const name of Object.keys(port).filter(k=>typeof port[k]==='function')){
  const old=port[name];port[name]=function(req){return new Promise((resolve,reject)=>setTimeout(()=>Reflect.apply(old,this,[req]).then(resolve,reject),10));};
 }
 const writer=make(f);await assert.rejects(writer.sealReadback(payload(f,Buffer.alloc(70000))),failure('operation-timeout'));
 await sleep(40);const before=f.calls.length;await sleep(30);assert.equal(f.calls.length,before);await assert.rejects(writer.sealReadback(payload(f)),failure('halted','preflight'));
 assert.ok(count(f,'sealEncryptedArtifact')<2);
});

test('malformed return thenables and accessor fulfillments execute no caller hooks and preserve UNKNOWN',async()=>{
 const f=await setup();let hooks=0;f.ports.kms.encryptArtifact=()=>Object.defineProperty({},'then',{get(){hooks++;throw new Error('secret-token');}});
 await assert.rejects(make(f).sealReadback(payload(f)),e=>failure('provider-contract-invalid','encrypt')(e)&&e.pendingCompletionUnknown&&e.mutationMayHaveOccurred);
 assert.equal(hooks,0);assert.equal(count(f,'sealEncryptedArtifact'),0);
 const g=await setup();g.ports.store.readExact=async()=>Object.defineProperty({},'object',{enumerable:true,get(){hooks++;throw new Error('secret-token');}});
 await assert.rejects(make(g).sealReadback(payload(g)),failure('invalid-readback','readback'));assert.equal(hooks,0);
});

test('provider rejection remains static private failure and cannot weaken mutation or UNKNOWN',async()=>{
 const f=await setup();f.ports.kms.encryptArtifact=()=>Promise.reject(new Proxy({},{get(){throw new Error('secret-token');},ownKeys(){throw new Error('secret-token');}}));
 await assert.rejects(make(f).sealReadback(payload(f)),e=>failure('operation-failed','encrypt')(e)&&e.mutationMayHaveOccurred);
});

test('busy guard and explicit close never allow hidden later dispatch or cancel an in-flight promise',async()=>{
 const f=await setup();let resolve,started;const reached=new Promise(r=>{started=r;}),old=f.ports.kms.encryptArtifact;
 f.ports.kms.encryptArtifact=function(req){started();return new Promise(r=>{resolve=()=>Reflect.apply(old,this,[req]).then(r);});};
 const writer=make(f),running=writer.sealReadback(payload(f));await reached;
 await assert.rejects(writer.sealReadback(payload(f)),failure('busy','preflight'));writer.close();resolve();
 await assert.rejects(running,failure('halted'));assert.equal(count(f,'sealEncryptedArtifact'),0);
 await assert.rejects(writer.sealReadback(payload(f)),failure('halted','preflight'));
});

test('closed configuration payload port carriers and extra arguments reject before hooks or operations',async()=>{
 const f=await setup();let hooks=0;
 for(const value of [null,{...f.options,executionProfile:'enterprise'},{...f.options,productionAccepted:true},
 {...f.options,artifacts:{...f.options.artifacts,operationTimeoutMs:30001}},
 Object.defineProperty({},'executionProfile',{enumerable:true,get(){hooks++;return 'local-reference';}}),new Proxy({},{ownKeys(){hooks++;return [];}})]){
  assert.throws(()=>subject.createReferenceProductionAskArtifactWriter(value,f.base.rawDatasetJson,f.ports),failure('invalid-config','configuration'));
 }
 const badPort={...f.ports.kms,encryptArtifact:new Proxy(()=>Promise.resolve({}),{apply(){hooks++;return Promise.resolve({});}})};
 assert.throws(()=>subject.createReferenceProductionAskArtifactWriter(f.options,f.base.rawDatasetJson,{...f.ports,kms:badPort}),failure('invalid-config','configuration'));
 assert.throws(()=>subject.createReferenceProductionAskArtifactWriter(f.options,f.base.rawDatasetJson,f.ports,{}),failure('invalid-config','configuration'));
 const writer=make(f);for(const value of [{},new String(payload(f)),null,JSON.stringify({oops:'RAW_SECRET'})])await assert.rejects(writer.sealReadback(value),failure('invalid-request','preflight'));
 await assert.rejects(writer.sealReadback(payload(f),{}),failure('invalid-request','preflight'));assert.equal(hooks,0);assert.equal(f.calls.length,0);
});

test('ciphertext byte count rejects before any unsafe object seal',async()=>{
 const f=await setup(),old=f.ports.kms.encryptArtifact;
 f.ports.kms.encryptArtifact=function(req){return Reflect.apply(old,this,[req]).then(e=>({...e,ciphertext:''}));};
 await assert.rejects(make(f).sealReadback(payload(f)),failure('invalid-key','encrypt'));assert.equal(count(f,'sealEncryptedArtifact'),0);
});

test('per-key nonce reuse rejects before the second unsafe object seal',async()=>{
 const g=await setup(),encrypt=g.ports.kms.encryptArtifact;let firstNonce;
 g.ports.kms.encryptArtifact=function(req){return Reflect.apply(encrypt,this,[req]).then(e=>{if(firstNonce===undefined){firstNonce=e.nonce;return e;}return {...e,nonce:firstNonce};});};
 await assert.rejects(make(g).sealReadback(payload(g,Buffer.alloc(70000))),failure('invalid-key','encrypt'));
 assert.equal(count(g,'sealEncryptedArtifact'),1);
});

test('owned inner UNKNOWN is conservative and cannot erase an already-dispatched encryption mutation',async()=>{
 const f=await setup();f.ports.kms.encryptArtifact=()=>Promise.reject(new subject.ProductionAskArtifactWriterError('operation-timeout','encrypt',true,false));
 const writer=make(f);await assert.rejects(writer.sealReadback(payload(f)),e=>failure('operation-timeout','encrypt')(e)&&e.pendingCompletionUnknown&&e.mutationMayHaveOccurred);
 assert.equal(count(f,'sealEncryptedArtifact'),0);await assert.rejects(writer.sealReadback(payload(f)),failure('halted','preflight'));
});

test('owned readonly-port failure mutation true is preserved without pretending the writer dispatched encryption',async()=>{
 const f=await setup();f.ports.clock.readTime=function(request){f.calls.push({name:'readTime',request});
  return Promise.reject(new subject.ProductionAskArtifactWriterError('operation-timeout','clock',true,true));};
 const writer=make(f);await assert.rejects(writer.sealReadback(payload(f)),e=>failure('operation-timeout','clock')(e)&&e.pendingCompletionUnknown&&e.mutationMayHaveOccurred);
 assert.equal(count(f,'readTime'),1);for(const name of ['encryptArtifact','sealEncryptedArtifact','readExact','decryptArtifact'])assert.equal(count(f,name),0);
 await assert.rejects(writer.sealReadback(payload(f)),failure('halted','preflight'));
});

test('retention impossible within the entire authorization window is rejected before any provider dispatch',async()=>{
 const f=await setup();f.options.artifacts.retainUntil=new Date(Date.parse(f.base.options.expectedExecutionPayload.window.startsAt)+3655*86400000).toISOString();
 assert.throws(()=>make(f),failure('invalid-config','configuration'));assert.equal(f.calls.length,0);
});

test('fresh observed time must satisfy the original store 3650-day bound before encryption',async()=>{
 const f=await setup();f.options.artifacts.retainUntil=new Date(Date.parse(f.at)+3650*86400000+1).toISOString();
 await assert.rejects(make(f).sealReadback(payload(f)),e=>failure('invalid-clock','clock')(e)&&!e.mutationMayHaveOccurred);
 assert.equal(count(f,'readTime'),1);assert.equal(count(f,'encryptArtifact'),0);assert.equal(count(f,'sealEncryptedArtifact'),0);
});

test('valid later observed time is not rejected using a narrower run-start retention budget',async()=>{
 const f=await setup();f.options.artifacts.retainUntil=new Date(Date.parse(f.at)+3650*86400000+1).toISOString();
 f.clock.advanceTo(new Date(Date.parse(f.at)+2).toISOString());
 const result=await make(f).sealReadback(payload(f));assert.equal(result.encryptedReadbackMatched,true);assert.equal(count(f,'sealEncryptedArtifact'),1);
});

