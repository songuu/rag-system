import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import test from 'node:test';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e?.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!s.endsWith('.ts'))return n(s+'.ts',c);throw e;}}});
const {readPublishedDocumentGraph,readPublishedDocumentGraphs}=await import('./document-graph-reader.ts');
const scope={tenantId:'t',corpusId:'c',enforceIsolation:true,allowedTrustLevels:['reviewed']};
const hash=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
function fixture(){
 const graph='doc-generation-'+'a'.repeat(64),version=hash('source');
 const snapshotJson=JSON.stringify([{tenantId:'t',corpusId:'c',graphVersion:graph,graphId:graph,status:'staging'},
 [{documentId:'d',documentVersion:version,trustLevel:'reviewed'}],
 [{id:'p',documentId:'d',documentVersion:version,trustLevel:'reviewed',content:'Alice Acme',index:0,startOffset:0,endOffset:10,source:'a.txt'}],
 [{id:'e1',name:'Alice',passageIds:['p']},{id:'e2',name:'Acme',passageIds:['p']}],
 [{id:'claim',predicate:'CO_OCCURS',sourceEntityId:'e1',targetEntityId:'e2',passageIds:['p']}],[]]);
 const graphManifestJson=JSON.stringify({profile:'neo4j-exclusive-asset-graph/v1',tenantId:'t',corpusId:'c',documentId:'d',generation:'1',contentVersion:version,manifestDigest:hash('root'),graphVersion:graph,snapshotDigest:hash(snapshotJson),passages:[{chunkIndex:0,passageId:'p'}]});
 return {documentId:'d',generation:'1',revision:'2',contentVersion:version,manifestDigest:hash('root'),graphVersion:graph,graphManifestJson,graphManifestDigest:hash(graphManifestJson),snapshotJson};
}
function db(values){let i=0;return {query:async(sql,args)=>{assert.deepEqual(args.slice(0,2),['t','c']);return {rows:[{result:values[Math.min(i++,values.length-1)]}],rowCount:1};}};}
test('lists current graph heads and reads a digest-bound snapshot with source passages',async()=>{
 const f=fixture();assert.equal((await readPublishedDocumentGraphs(scope,db([[f]])))[0].documentId,'d');
 const result=await readPublishedDocumentGraph(scope,'d',db([f]));assert.equal(result.entities[0].name,'Alice');assert.equal(result.passages[0].content,'Alice Acme');
});
test('rejects changed or unavailable graph before returning evidence',async()=>{
 const f=fixture();await assert.rejects(readPublishedDocumentGraph(scope,'d',db([f,null])),/changed/);
 assert.equal(await readPublishedDocumentGraph(scope,'d',db([null])),null);
});
test('rejects tampered snapshots, manifests and scope',async()=>{
 for(const mutate of [f=>f.snapshotJson+=' ',f=>f.graphManifestJson+=' ',f=>f.documentId='other',f=>f.contentVersion=hash('other')]){
  const f=fixture();mutate(f);await assert.rejects(readPublishedDocumentGraph(scope,'d',db([f])));
 }
 await assert.rejects(readPublishedDocumentGraphs({...scope,enforceIsolation:false},db([[]])));
});
test('rejects a digest-valid snapshot containing unscoped or dangling evidence',async()=>{
 for(const mutate of [p=>p[2][0].trustLevel='external',p=>p[2][0].documentId='other',p=>p[4][0].passageIds=['unknown']]){
 const f=fixture(),p=JSON.parse(f.snapshotJson);mutate(p);f.snapshotJson=JSON.stringify(p);const m=JSON.parse(f.graphManifestJson);m.snapshotDigest=hash(f.snapshotJson);f.graphManifestJson=JSON.stringify(m);f.graphManifestDigest=hash(f.graphManifestJson);
 await assert.rejects(readPublishedDocumentGraph(scope,'d',db([f])));
 }
});
test('cancels hanging graph reads without starting a later read when the first query completes late',async()=>{
 const controller=new AbortController();let calls=0,complete;
 const client={query:()=>{calls++;return new Promise(resolve=>{complete=resolve;});}};
 const pending=readPublishedDocumentGraph(scope,'d',client,controller.signal);
 await new Promise(resolve=>setImmediate(resolve));
 controller.abort(new Error('Graph request cancelled.'));
 await assert.rejects(pending,/cancelled/);complete({rows:[{result:fixture()}]});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 await assert.rejects(readPublishedDocumentGraphs(scope,client,controller.signal),/cancelled/);assert.equal(calls,1);
});
test('deadline abort between snapshot reads prevents the second query',async()=>{
 const controller=new AbortController();let calls=0;
 const client={query:async()=>{calls++;controller.abort(new Error('Graph deadline exceeded.'));return {rows:[{result:fixture()}]};}};
 await assert.rejects(readPublishedDocumentGraph(scope,'d',client,controller.signal),/deadline/);assert.equal(calls,1);
});
