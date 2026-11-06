import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { readSandboxConfig } from '../../../deploy/publication-sandbox/sandbox.mjs';
registerHooks({ resolve(s,c,n) { try { return n(s,c); } catch(e) { if(e?.code==='ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return n(s+'.ts',c); throw e; } } });
const sandbox=process.env.PUBLICATION_SANDBOX_ID;
test('isolated Neo4j keeps two document generations separate', {skip:process.env.PUBLICATION_SANDBOX_ALLOW_MUTATIONS!=='1'||!/^[a-f0-9]{24}$/.test(sandbox??''),timeout:60000},async()=>{
 const {createNeo4jClient}=await import('../neo4j/driver.ts');
 const {Neo4jKnowledgeGraphCommandStore}=await import('./neo4j-command-store.ts');
 const {createDocumentGraphIdentity,stageDocumentGraph}=await import('./document-generation.ts');
 const {readDocumentGraphEdges,assertDocumentGraphEdges}=await import('./document-generation-edges.ts');
 const cfg=readSandboxConfig(sandbox); const client=createNeo4jClient({uri:`neo4j://127.0.0.1:${cfg.ports.neo4j}`,username:'neo4j',password:cfg.credentials.neo4j,database:'neo4j',connectionTimeoutMs:5000,queryTimeoutMs:10000,writeTimeoutMs:15000,maxTransactionRetryTimeMs:0,maxConnectionPoolSize:4});
 const tenantId=`graph-test-${randomUUID()}`,corpusId='corpus',documentId='doc';
 const scope={tenantId,corpusId,allowedTrustLevels:['reviewed'],enforceIsolation:true};
 const base={tenantId,corpusId,documentId,contentVersion:'sha256:'+'a'.repeat(64),manifestDigest:'sha256:'+'b'.repeat(64)};
 const store=new Neo4jKnowledgeGraphCommandStore(client); let finished=false;
 try { await client.verifyConnectivity();
  const make=(generation)=>{const identity={...base,generation};const {graphVersion}=createDocumentGraphIdentity(identity);return {identity,snapshot:{tenantId,corpusId,graphVersion,graphId:'test',status:'staging',artifactDigest:'sha256:'+'c'.repeat(64),createdAt:'2024-01-01T00:00:00.000Z',documents:[{documentId,documentVersion:base.contentVersion,trustLevel:'reviewed'}],passages:[{id:'passage',documentId,documentVersion:base.contentVersion,trustLevel:'reviewed',content:`Generation ${generation}`,index:0,startOffset:0,endOffset:12,metadata:{}}],entities:[{id:'entity-a',name:'Alice',normalizedName:'alice',labels:['Person'],summary:'',aliases:[],passageIds:['passage'],attributes:{}},{id:'entity-b',name:'Acme',normalizedName:'acme',labels:['Organization'],summary:'',aliases:[],passageIds:['passage'],attributes:{}}],claims:[{id:'claim',predicate:'founded',fact:'Alice founded Acme',factType:'relationship',sourceEntityId:'entity-a',targetEntityId:'entity-b',sourceEntityName:'Alice',targetEntityName:'Acme',episodes:[],passageIds:['passage'],confidence:0.98,status:'active',attributes:{}}],communities:[]}};};
  const one=make('1'),two=make('2'); const reader=id=>readDocumentGraphEdges(client,id); const first=await stageDocumentGraph(one.identity,scope,one.snapshot,store,reader),second=await stageDocumentGraph(two.identity,scope,two.snapshot,store,reader);
  assert.notEqual(first.graphVersion,second.graphVersion);assert.equal(first.productionAuthorized,false);
  await assert.rejects(store.getSnapshot({tenantId,corpusId,graphVersion:first.graphVersion},{...scope,tenantId:'other'}));
  assert.equal((await store.getSnapshot({tenantId,corpusId,graphVersion:first.graphVersion},scope)).graphVersion,first.graphVersion);
  assert.equal((await store.getSnapshot({tenantId,corpusId,graphVersion:first.graphVersion},scope)).passages[0].content,'Generation 1');
  assert.equal((await store.getSnapshot({tenantId,corpusId,graphVersion:second.graphVersion},scope)).passages[0].content,'Generation 2');
  assert.equal((await store.getSnapshot({tenantId,corpusId,graphVersion:second.graphVersion},scope)).claims[0].fact,'Alice founded Acme');
  const relationships=await client.executeRead('check isolated generation edges',tx=>tx.run(`MATCH (a:Entity)-[:SUBJECT_OF]->(c:Claim)-[:OBJECT]->(b:Entity)
    WHERE a.tenantId=$tenantId AND a.corpusId=$corpusId AND a.graphVersion IN $versions
    RETURN a.graphVersion AS sourceVersion,c.graphVersion AS claimVersion,b.graphVersion AS targetVersion`,
    {tenantId,corpusId,versions:[first.graphVersion,second.graphVersion]}));
  assert.equal(relationships.records.length,2);
  for(const row of relationships.records){assert.equal(row.get('sourceVersion'),row.get('claimVersion'));assert.equal(row.get('claimVersion'),row.get('targetVersion'));}
  const params={tenantId,corpusId,first:first.graphVersion,second:second.graphVersion};
  const write=(cypher)=>client.executeWrite('modify isolated fixture relationship',tx=>tx.run(cypher,params));
  const subject=`MATCH (a:Entity {tenantId:$tenantId,corpusId:$corpusId,graphVersion:$first,entityKey:'entity-a'}), (c:Claim {tenantId:$tenantId,corpusId:$corpusId,graphVersion:$first,claimId:'claim'}) `;
  const verifyTamper=async(generation,mutate)=>{const item=make(generation);const result=await stageDocumentGraph(item.identity,scope,item.snapshot,store,reader);params.first=result.graphVersion;await mutate();await assert.rejects(assertDocumentGraphEdges(item.snapshot,reader));};
  await verifyTamper('3',()=>write(subject+'MATCH (a)-[r:SUBJECT_OF]->(c) DELETE r'));
  await verifyTamper('4',()=>write(subject+'MATCH (a)-[r:SUBJECT_OF]->(c) DELETE r CREATE (a)-[:WRONG_RELATION]->(c)'));
  await verifyTamper('5',()=>write(subject+'CREATE (a)-[:SUBJECT_OF]->(c)'));
  await verifyTamper('6',()=>write(`MATCH (a:Entity {tenantId:$tenantId,corpusId:$corpusId,graphVersion:$first,entityKey:'entity-a'}), (c:Claim {tenantId:$tenantId,corpusId:$corpusId,graphVersion:$second,claimId:'claim'}) CREATE (a)-[:SUBJECT_OF]->(c)`));
  finished=true;
 } finally { if(finished) await client.executeWrite('remove exact isolated generation test',tx=>tx.run('MATCH (n) WHERE n.tenantId=$tenantId AND n.corpusId=$corpusId DETACH DELETE n',{tenantId,corpusId})); await client.close(); }
});
