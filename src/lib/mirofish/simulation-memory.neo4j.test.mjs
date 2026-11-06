import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context);}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!specifier.endsWith('.ts'))return next(specifier+'.ts',context);throw error;}}});
const {getNeo4jRuntimeConfig}=await import('../neo4j/config.ts');
const {getNeo4jClient,closeNeo4jDriver}=await import('../neo4j/driver.ts');
const {createNeo4jSimulationMemoryPort}=await import('./simulation-memory.ts');

test('real local Neo4j memory replay is idempotent, scoped and isolated from canonical graph labels',{
 skip:process.env.RAG_MIROFISH_LOCAL_TEST!=='1'?'Explicit local integration mode is required':false,
 timeout:30000,
},async t=>{
 const config=getNeo4jRuntimeConfig();const target=new URL(config.uri);
 assert(['127.0.0.1','localhost','::1','[::1]'].includes(target.hostname),'Integration test only accepts loopback Neo4j');
 const suffix=randomUUID();const scope={tenantId:`memorytest-tenant-${suffix}`,corpusId:`memorytest-corpus-${suffix}`};
 const simulationId=`memorytest-sim-${suffix}`,runId=`memorytest-run-${suffix}`;
 const selector={...scope,simulationId,runId};assert(Object.values(selector).every(value=>value.startsWith('memorytest-')&&value.endsWith(suffix)));
 const client=getNeo4jClient(config);assert(client);const port=createNeo4jSimulationMemoryPort();
 const snapshot=()=>client.executeRead('inspect isolated memory integration fixture',async tx=>{
  const result=await tx.run(`MATCH (node) WHERE node.tenantId=$tenantId AND node.corpusId=$corpusId AND node.simulationId=$simulationId AND node.runId=$runId
   RETURN labels(node) AS labels,properties(node) AS properties ORDER BY node.eventSequence`,selector);
  return result.records.map(record=>({labels:record.get('labels'),properties:record.get('properties')}));
 });
 const canonical=()=>client.executeRead('inspect canonical namespace isolation',async tx=>{
  const result=await tx.run(`MATCH (node) WHERE node.tenantId=$tenantId AND node.corpusId=$corpusId
   AND (node:Entity OR node:Claim OR node:KnowledgeGraph OR node:DocumentVersion OR node:KGEntity OR node:KGEvidence)
   RETURN count(node) AS count`,scope);return result.records[0].get('count').toNumber();
 });
 try{
  await client.verifyConnectivity();assert.equal((await snapshot()).length,0);const beforeCanonical=await canonical();assert.equal(beforeCanonical,0);
  const events=[{id:`event-a-${suffix}`,sequence:1,round:1,simulatedMinute:60,platform:'twitter',agentId:`agent-a-${suffix}`,action:'post',content:'Synthetic isolated integration statement',timestamp:new Date().toISOString(),success:true},
   {id:`event-b-${suffix}`,sequence:2,round:1,simulatedMinute:60,platform:'twitter',agentId:`agent-b-${suffix}`,targetId:`agent-a-${suffix}`,action:'follow',content:'',observation:'Synthetic test follow',timestamp:new Date().toISOString(),success:true}];
  assert.equal(await port.project(scope,simulationId,events,runId),2);assert.equal(await port.project(scope,simulationId,events,runId),2);
  const rows=await snapshot();const facts=rows.filter(row=>row.labels.includes('MiroFishSimulationFact'));const runs=rows.filter(row=>row.labels.includes('MiroFishSimulationRun'));
  assert.equal(rows.length,3);assert.equal(facts.length,2);assert.equal(runs.length,1);assert.equal(Number(runs[0].properties.lastEventSequence),2);
  for(const fact of facts){assert.deepEqual(fact.labels,['MiroFishSimulationFact']);assert.equal(fact.properties.canonical,false);assert.equal(fact.properties.provenance,'simulation');assert.equal(fact.properties.tenantId,scope.tenantId);assert.equal(fact.properties.corpusId,scope.corpusId);assert.equal(fact.properties.simulationId,simulationId);assert.equal(fact.properties.runId,runId);}
  assert.equal(facts.find(row=>row.properties.action==='follow').properties.targetId,events[1].targetId);
  const foreign=await client.executeRead('inspect foreign memory namespace',async tx=>{const result=await tx.run('MATCH (node:MiroFishSimulationFact {tenantId:$tenantId,corpusId:$corpusId,simulationId:$simulationId,runId:$runId}) RETURN count(node) AS count',{...selector,corpusId:`foreign-${suffix}`});return result.records[0].get('count').toNumber();});
  assert.equal(foreign,0);assert.equal(await canonical(),beforeCanonical);t.diagnostic('Replay verified: 1 isolated run, 2 unique facts; foreign namespace 0; canonical test-scope entities 0.');
 }finally{
  try{
   await client.executeWrite('clean exact random simulation memory fixture',async tx=>{await tx.run(`MATCH (node) WHERE (node:MiroFishSimulationRun OR node:MiroFishSimulationFact)
    AND node.tenantId=$tenantId AND node.corpusId=$corpusId AND node.simulationId=$simulationId AND node.runId=$runId DETACH DELETE node`,selector);});
   assert.equal((await snapshot()).length,0);assert.equal(await canonical(),0);t.diagnostic('Cleanup verified: exact random scope/simulation/run namespace has 0 remaining nodes; canonical test-scope entities remain 0.');
  }finally{await closeNeo4jDriver();}
 }
});
