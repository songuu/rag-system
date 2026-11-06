import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e?.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!s.endsWith('.ts'))return n(s+'.ts',c);throw e;}}});
const { reserveDocumentGraphDispatch, stageReservedDocumentGraph }=await import('./document-generation-reservation.ts');
const { createDocumentGraphIdentity }=await import('./document-generation.ts');
const identity={tenantId:'t',corpusId:'c',documentId:'d',generation:'1',contentVersion:'sha256:'+'a'.repeat(64),manifestDigest:'sha256:'+'b'.repeat(64)};
const attempt={...identity,revision:'1',leaseToken:'ea645767-18d3-4198-a353-8d6c0901da27',physicalCollection:'ignored'};
const scope={tenantId:'t',corpusId:'c',enforceIsolation:true,allowedTrustLevels:['reviewed']};
const snapshot={tenantId:'t',corpusId:'c',graphVersion:createDocumentGraphIdentity(identity).graphVersion,graphId:'g',status:'staging',artifactDigest:'sha256:'+'c'.repeat(64),createdAt:'2024-01-01T00:00:00.000Z',documents:[{documentId:'d',documentVersion:identity.contentVersion,trustLevel:'reviewed'}],passages:[],entities:[],claims:[],communities:[]};
test('rejects mismatched attempt identity before database I/O',async()=>{
 let calls=0; const db={query:async()=>{calls++;return {rows:[]};}};
 await assert.rejects(reserveDocumentGraphDispatch(db,{...attempt,documentId:'other'},identity));
 assert.equal(calls,0);
});
test('connection failure is unknown and does not dispatch a graph write',async()=>{
 let writes=0;const config={host:'127.0.0.1',port:1,user:'no-access',database:'none'};
 await assert.rejects(stageReservedDocumentGraph(config,attempt,identity,scope,snapshot,
  {stageSnapshot:async()=>{writes++;},getSnapshot:async()=>null},async()=>[]),e=>e.code==='DOCUMENT_GRAPH_UNKNOWN'&&e.identity.graphVersion===snapshot.graphVersion);
 assert.equal(writes,0);
});
