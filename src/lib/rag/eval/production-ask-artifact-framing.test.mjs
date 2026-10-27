import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[cm]?[jt]s$/.test(s))return n(s+'.ts',c);throw e;}}});
const {fixture,rebindExecution}=await import('./production-ask-dataset-fixtures.test-support.mjs');
const {createReferenceProductionAskDatasetBinding}=await import('./production-ask-dataset-binding.ts');
const {canonicalJsonSha256:hash}=await import('./canonical-json.ts');
const {validateArtifactAad,validateControlledArtifactIndex,createReferenceKmsEnvelope,createReferenceArtifactStore}=await import('./production-controlled-artifacts.ts');
let subject;try{subject=await import('./production-ask-artifact-framing.ts');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;subject={};}
const sha=b=>createHash('sha256').update(b).digest('hex');
const clone=x=>structuredClone(x);
const binding=f=>createReferenceProductionAskDatasetBinding(f.options,f.rawDatasetJson);
const request=(f,c={})=>({caseId:f.dataset.cases[0].id,rolloutMode:'off',phase:'trial',ordinal:0,...c});
const payload=(f,bytes=Buffer.from('RAW_SECRET_BODY'),changes={})=>({schemaVersion:'kg-reference-ask-artifact-payload/v1',request:request(f),artifactType:'response',payloadBase64url:bytes.toString('base64url'),...changes});
const create=f=>subject.createReferenceProductionAskArtifactFramer(f.options,f.rawDatasetJson);
const frame=(f,p=payload(f))=>create(f).frame(JSON.stringify(p));
const parts=x=>x.layout.parts.map((p,i)=>({partIndex:i,aad:clone(p.aad),plaintextBase64url:x.forEncryption(i).plaintextBase64url}));
const readback=(x,ps=parts(x))=>JSON.stringify({schemaVersion:'kg-ask-decrypted-body-parts/v1',layoutHash:x.layout.layoutHash,parts:ps});
const failure=code=>e=>typeof subject.ProductionAskArtifactFramingError==='function'
 &&e instanceof subject.ProductionAskArtifactFramingError&&e.code===code&&e.productionAuthorized===false&&e.automaticRetryAllowed===false
 &&Object.isFrozen(e)&&!Object.hasOwn(e,'cause')&&!/RAW_|secret-token|PRIVATE/.test(e.message);
function freeze(x){if(x&&typeof x==='object'){assert.ok(Object.isFrozen(x));for(const v of Object.values(x))freeze(v);}}
function artifactOptions(f){return {executionProfile:'local-reference',binding:binding(f).bindingProof.binding,
 actors:{executorId:'executor',readOnlyId:'independent-reader'},validFrom:'2026-10-09T04:00:00.000Z',
 validUntil:'2026-10-09T05:00:00.000Z',maxObjects:1000};}
const kmsOptions=f=>({...artifactOptions(f),keyPolicyRef:{objectId:'key-policy',objectVersion:'v1',sha256:hash('key-policy')},maxPlaintextBytes:65536});
function context(f,actor='executor'){return {executionProfile:'local-reference',binding:binding(f).bindingProof.binding,
 actorId:actor,authorizationDigest:hash('synthetic-shape-only'),observedAt:'2026-10-09T04:01:00.000Z'};}

test('existing binding and actual AEAD fixture are sound without the new framer',async()=>{
 const f=fixture(),options=artifactOptions(f),kms=createReferenceKmsEnvelope(kmsOptions(f)),b=options.binding;
 const aad=validateArtifactAad({...b,artifactType:'response',artifactId:'fixture-part',caseId:f.dataset.cases[0].id,ordinal:0,schemaVersion:'kg-ask-body-fragment/v1'});
 const text=Buffer.from('RAW_SECRET_BODY').toString('base64url'),envelope=await kms.encryptArtifact({context:context(f),aad,plaintextBase64url:text});
 assert.equal(await kms.decryptArtifact({context:context(f,'independent-reader'),aad,envelope}),text);
});

test('new framer holds plaintext only behind the explicit encryption handoff',()=>{
 const f=fixture();assert.equal(typeof subject.createReferenceProductionAskArtifactFramer,'function');const x=frame(f);freeze(x);
 assert.equal(x.layout.schemaVersion,'kg-ask-artifact-layout/v1');assert.equal(x.layout.productionAuthorized,false);
 assert.equal(x.layout.bodySha256,sha(Buffer.from('RAW_SECRET_BODY')));
 assert.equal(JSON.stringify(x).includes('RAW_SECRET_BODY'),false);
 assert.equal(JSON.stringify(x).includes(Buffer.from('RAW_SECRET_BODY').toString('base64url')),false);
 assert.equal(x.forEncryption(0).plaintextBase64url,payload(f).payloadBase64url);
 assert.equal(x.verifyDecryptedParts(readback(x)).readbackMatched,true);
});

test('large complete bytes are split within original 64KiB and fully verified without decoding split UTF8',()=>{
 const f=fixture(),bytes=Buffer.from('中'.repeat(100000));const x=frame(f,payload(f,bytes));
 assert.ok(bytes.length>256*1024);assert.equal(x.layout.bodyByteLength,bytes.length);
 assert.equal(x.layout.parts.length,Math.ceil(bytes.length/65536));assert.equal(x.layout.bodySha256,sha(bytes));
 assert.equal(Buffer.concat(parts(x).map(p=>Buffer.from(p.plaintextBase64url,'base64url'))).equals(bytes),true);
 const proof=x.verifyDecryptedParts(readback(x));assert.equal(proof.bodySha256,sha(bytes));assert.equal(proof.byteLength,bytes.length);
 assert.equal(JSON.stringify(proof).includes('中'),false);
});

test('empty and exact part boundaries have complete deterministic layouts',()=>{
 const f=fixture();
 for(const size of [0,1,65535,65536,65537]){
  const x=frame(f,payload(f,Buffer.alloc(size,0xa5)));assert.equal(x.layout.parts.length,Math.max(1,Math.ceil(size/65536)));
  assert.equal(x.verifyDecryptedParts(readback(x)).byteLength,size);
  assert.deepEqual(frame(f,payload(f,Buffer.alloc(size,0xa5))).layout,x.layout);
 }
});

test('different arm phase ordinal part and artifact type cannot alias semantic slots',()=>{
 const f=fixture('T17');f.options.manifest.t17.sampling={trialCount:100,warmupCount:1000};rebindExecution(f);
 const all=[],slots=new Set();
 for(const mode of ['off','active'])for(const phase of ['warmup','trial']){
  const ord=phase==='warmup'?999:99;
  for(const type of ['request','gold','response','error','telemetry']){
   const x=frame(f,payload(f,Buffer.from('x'),{request:request(f,{rolloutMode:mode,phase,ordinal:ord}),artifactType:type}));
   const p=x.layout.parts[0];const slot=JSON.stringify([p.aad.artifactType,p.aad.caseId,p.aad.ordinal]);
   assert.equal(slots.has(slot),false);slots.add(slot);assert.ok(p.aad.ordinal<=1000000);
   all.push({artifactId:p.aad.artifactId,artifactType:type,caseId:p.aad.caseId,ordinal:p.aad.ordinal,schemaVersion:p.aad.schemaVersion,
    objectRef:{objectId:p.aad.artifactId,objectVersion:'v1',sha256:hash(p.aad)},keyRef:{objectId:'key-one',objectVersion:'v1',sha256:hash('key')},aadSha256:hash(p.aad)});
  }
 }
 assert.equal(validateControlledArtifactIndex({schemaVersion:'kg-controlled-artifact-index/v1',classification:'confidential',binding:binding(f).bindingProof.binding,entries:all}).productionAccepted,false);
});

test('actual per-fragment KMS seal exact-read decrypt pipeline verifies complete original body',async()=>{
 const f=fixture(),bytes=Buffer.alloc(160000,0x3a),x=frame(f,payload(f,bytes)),options=artifactOptions(f),kms=createReferenceKmsEnvelope(kmsOptions(f));
 const store=createReferenceArtifactStore({...options,storeIdentityRef:{objectId:'store',objectVersion:'v1',sha256:hash('store')},maxObjectBytes:256*1024}),ps=[],envelopes=[];
 for(const [i,p]of x.layout.parts.entries()){
  const envelope=await kms.encryptArtifact({context:context(f),...x.forEncryption(i)});
  envelopes.push(envelope);
  const ref=await store.sealEncryptedArtifact({context:context(f),aad:p.aad,envelope,retainUntil:'2026-10-09T06:00:00.000Z'});
  const read=await store.readExact({context:context(f,'independent-reader'),ref});
  ps.push({partIndex:i,aad:read.object.aad,plaintextBase64url:await kms.decryptArtifact({context:context(f,'independent-reader'),aad:read.object.aad,envelope:read.object.envelope})});
 }
 assert.equal(x.verifyDecryptedParts(readback(x,ps)).bodySha256,sha(bytes));
 await assert.rejects(kms.decryptArtifact({context:context(f,'independent-reader'),aad:x.layout.parts[1].aad,
  envelope:envelopes[0]}));
});

test('missing duplicate extra reordered wrong offset bytes and AAD swaps never verify',()=>{
 const f=fixture(),x=frame(f,payload(f,Buffer.alloc(140000,0x2a)));
 for(const change of [ps=>ps.pop(),ps=>ps.push(clone(ps[0])),ps=>ps.reverse(),ps=>{ps[1].partIndex=0;},
  ps=>{ps[0].plaintextBase64url=Buffer.from('RAW_TAMPER').toString('base64url');},ps=>{ps[0].aad.ordinal++;},ps=>{ps[0].aad.artifactId='forged';}]){
  const ps=parts(x);change(ps);assert.throws(()=>x.verifyDecryptedParts(readback(x,ps)),failure('invalid-readback'));
 }
 const ps=parts(x);ps[0].plaintextBase64url+='=';assert.throws(()=>x.verifyDecryptedParts(readback(x,ps)),failure('invalid-readback'));
});

test('two complete layouts cannot be spliced across body case arm or configuration',()=>{
 const f=fixture('T17'),x=frame(f),y=frame(f,payload(f,Buffer.from('OTHER_PRIVATE_BODY')));
 assert.notEqual(x.layout.layoutHash,y.layout.layoutHash);assert.throws(()=>x.verifyDecryptedParts(readback(x,parts(y))),failure('invalid-readback'));
 const z=frame(f,payload(f,Buffer.from('RAW_SECRET_BODY'),{request:request(f,{rolloutMode:'active'})}));
 assert.throws(()=>x.verifyDecryptedParts(readback(x,parts(z))),failure('invalid-readback'));
});

test('frozen limits reject oversized request gold and response without truncation',()=>{
 const f=fixture();for(const [artifactType,size]of [['request',65537],['gold',8*1024*1024+1],['response',2*1024*1024+1]]){
  assert.throws(()=>frame(f,payload(f,Buffer.alloc(size),{artifactType})),failure('invalid-payload'));
 }
});

test('maximum legal response uses 256 distinct original-AAD-compatible pieces',()=>{
 const f=fixture();const r=f.options.deploymentPolicy.registrations.find(v=>v.purpose==='ask');
 r.networkPolicy.maxResponseBytes=16*1024*1024;rebindExecution(f);const bytes=Buffer.alloc(16*1024*1024,0x9f),x=frame(f,payload(f,bytes));
 assert.equal(x.layout.parts.length,256);assert.equal(new Set(x.layout.parts.map(p=>p.aad.ordinal)).size,256);
 for(const p of x.layout.parts){assert.equal(p.byteLength,65536);assert.deepEqual(validateArtifactAad(p.aad),p.aad);}
 assert.equal(x.verifyDecryptedParts(readback(x)).bodySha256,sha(bytes));
});

test('unknown fields broken base64 invalid type or request identities fail closed',()=>{
 const f=fixture();for(const change of [p=>{p.extra='secret-token';},p=>{p.payloadBase64url='////';},
 p=>{p.payloadBase64url='YQ==';},p=>{p.artifactType='receipt-core';},p=>{p.request.caseId='f'.repeat(32);},p=>{p.request.ordinal=9999;}]){
  const p=payload(f);change(p);assert.throws(()=>frame(f,p),failure('invalid-payload'));
 }
});

test('primitive JSON boundaries and extra arguments execute no carrier hooks',()=>{
 const f=fixture(),framer=create(f),x=framer.frame(JSON.stringify(payload(f)));let hooks=0;const hook=()=>{hooks++;throw Error('secret-token');};
 const object={toJSON:hook,then:hook,get body(){return hook();}},proxy=new Proxy({}, {get:hook,ownKeys:hook,getOwnPropertyDescriptor:hook,getPrototypeOf:hook});
 for(const v of [object,proxy,new String(JSON.stringify(payload(f))),null])assert.throws(()=>framer.frame(v),failure('invalid-payload'));
 assert.throws(()=>framer.frame(JSON.stringify(payload(f)),hook),failure('invalid-payload'));
 assert.throws(()=>x.forEncryption(0,hook),failure('invalid-payload'));
 assert.throws(()=>x.verifyDecryptedParts(readback(x),hook),failure('invalid-readback'));
 assert.throws(()=>subject.createReferenceProductionAskArtifactFramer(f.options,f.rawDatasetJson,hook),failure('invalid-config'));
 assert.equal(hooks,0);
});

test('mutable handoff objects cannot change private layout or snapshot',()=>{
 const f=fixture(),framer=create(f),raw=JSON.stringify(payload(f)),x=framer.frame(raw),first=clone(x.layout);
 const handoff=x.forEncryption(0);assert.ok(Object.isFrozen(handoff));freeze(handoff.aad);
 f.options.manifest.base.runNonce='f'.repeat(32);f.dataset.cases[0].query='RAW_MUTATED';
 assert.deepEqual(framer.frame(raw).layout,first);
 assert.equal(x.verifyDecryptedParts(readback(x)).readbackMatched,true);
});

test('readback proof hashes only fixed complete metadata and never claims encryption or production',()=>{
 const f=fixture(),x=frame(f),p=x.verifyDecryptedParts(readback(x));const {proofHash,...core}=p;assert.equal(proofHash,hash(core));
 assert.equal(p.productionAuthorized,false);assert.equal(p.encryptionAuthenticated,false);assert.equal(p.stageAcceptanceComplete,false);freeze(p);
 assert.equal(JSON.stringify(p).includes('RAW_SECRET_BODY'),false);
});
