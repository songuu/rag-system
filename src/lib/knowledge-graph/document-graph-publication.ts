import { createHash } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { createNeo4jClient, type Neo4jClient } from '../neo4j/driver';
import { canonicalJson } from '../rag/eval/canonical-json';
import type { RagRetrievalScope, RagTrustLevel } from '../security/retrieval-scope';
import { validatePublicationAsset, PostgresPublicationAssetStore, type PreparedPublicationAsset } from '../documents/publication-asset-store';
import type { PublicationAttempt } from '../documents/publication-control-cas';
import { queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { Neo4jKnowledgeGraphCommandStore } from './neo4j-command-store';
import { createDocumentGraphIdentity } from './document-generation';
import { assertDocumentGraphAsset } from './document-generation-asset';
import { expectedDocumentGraphEdges, readDocumentGraphEdges } from './document-generation-edges';
import { reserveDocumentGraphDispatch } from './document-generation-reservation';
import type { KnowledgeGraphSnapshot, KnowledgeGraphEntity, KnowledgeGraphClaim } from './contracts';

const digest=(value:string)=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const id=(kind:string,value:string)=>`${kind}:${createHash('sha256').update(value).digest('hex')}`;
const seals=new WeakSet<object>();
type LocalPg={host:string;port:number;database:string;user:string;password:string};
type GraphConfig={uri:string;username:string;password:string};
export interface DocumentGraphPublicationSeal { graphVersion:string; manifestJson:string; snapshotJson:string; configurationDigest:string; evidenceDigest:string }

/** Reproducible source graph: keyword co-occurrence is stated as such, never
 * presented as an extracted factual/causal relation. All citations originate
 * from the authoritative lease-bound chunk descriptors. */
export function compileDocumentPublicationGraph(attempt:PublicationAttempt,asset:PreparedPublicationAsset):KnowledgeGraphSnapshot {
  validatePublicationAsset(attempt,asset);
  const identity=createDocumentGraphIdentity({...attempt,contentVersion:asset.contentVersion});
  const chunks=JSON.parse(asset.chunksJson) as Array<{chunkIndex:number;content:string;descriptorJson:string;metadataJson:string}>;
  const entities=new Map<string,KnowledgeGraphEntity>();const claims:KnowledgeGraphClaim[]=[];
  const passages=chunks.map(chunk=>{
    const d=JSON.parse(chunk.descriptorJson) as {trustLevel:RagTrustLevel;source:string|null;page:number|null;startOffset?:number;endOffset?:number};
    if(!Number.isSafeInteger(d.startOffset)||!Number.isSafeInteger(d.endOffset))throw new Error('Graph publication requires authoritative chunk offsets.');
    const metadata=JSON.parse(chunk.metadataJson) as Record<string,unknown>;
    const passageId=id('graph-passage',canonicalJson([identity.graphVersion,chunk.chunkIndex,JSON.parse(chunk.descriptorJson)]));
    const passage={id:passageId,documentId:attempt.documentId,documentVersion:asset.contentVersion,trustLevel:d.trustLevel,
      content:chunk.content,index:chunk.chunkIndex,startOffset:d.startOffset!,endOffset:d.endOffset!,metadata,
      ...(d.source!==null?{source:d.source}:{}),...(d.page!==null?{page:d.page}:{}),
      ...(Array.isArray(metadata.sectionPath)?{sectionPath:metadata.sectionPath as string[]}:{} )};
    const words=[...new Map((chunk.content.match(/[A-Za-z][A-Za-z0-9_-]{2,40}|[\u3400-\u9fff]{2,8}/g)??[])
      .map(word=>[word.toLocaleLowerCase('en-US'),word])).values()].slice(0,2);
    const local:KnowledgeGraphEntity[]=[];
    for(const word of words){const key=id('graph-keyword',word.toLocaleLowerCase('en-US'));let entity=entities.get(key);
      if(!entity&&entities.size<128){entity={id:key,name:word,normalizedName:word.toLocaleLowerCase('en-US'),labels:['Keyword'],summary:'',aliases:[],passageIds:[],attributes:{method:'source-keyword/v1'}};entities.set(key,entity);}
      if(entity){entity.passageIds.push(passageId);local.push(entity);}}
    if(local.length===2)claims.push({id:id('graph-cooccurrence',canonicalJson([passageId,...local.map(e=>e.id)])),predicate:'CO_OCCURS',
      fact:`${local[0].name} / ${local[1].name}`,factType:'source-cooccurrence',sourceEntityId:local[0].id,targetEntityId:local[1].id,
      sourceEntityName:local[0].name,targetEntityName:local[1].name,episodes:[],passageIds:[passageId],confidence:1,status:'active',attributes:{method:'source-keyword/v1'}});
    return passage;
  });
  const snapshot:KnowledgeGraphSnapshot={tenantId:attempt.tenantId,corpusId:attempt.corpusId,graphVersion:identity.graphVersion,
    graphId:identity.graphVersion,status:'staging',createdAt:'1970-01-01T00:00:00.000Z',artifactDigest:'',
    documents:[{documentId:attempt.documentId,documentVersion:asset.contentVersion,trustLevel:passages[0].trustLevel}],
    passages,entities:[...entities.values()].sort((a,b)=>a.id.localeCompare(b.id)),claims:claims.sort((a,b)=>a.id.localeCompare(b.id)),communities:[]};
  snapshot.artifactDigest=digest(serializeDocumentPublicationGraph(snapshot));
  assertDocumentGraphAsset(attempt,asset,snapshot);expectedDocumentGraphEdges(snapshot);
  return snapshot;
}

// Canonicalize individual nodes within the bounded profile rather than placing
// the whole document body under canonicalJson's per-value 256 KiB limit.
export function serializeDocumentPublicationGraph(snapshot:KnowledgeGraphSnapshot):string {
  const {documents,passages,entities,claims,communities,...header}=snapshot;
  return `[${canonicalJson(header)},${[documents,passages,entities,claims,communities].map(rows=>`[${rows.map(row=>canonicalJson(row)).join(',')}]`).join(',')}]`;
}

export function documentGraphManifest(attempt:PublicationAttempt,asset:PreparedPublicationAsset,snapshot:KnowledgeGraphSnapshot):string {
  assertDocumentGraphAsset(attempt,asset,snapshot);
  const expected=compileDocumentPublicationGraph(attempt,asset);
  if(serializeDocumentPublicationGraph(expected)!==serializeDocumentPublicationGraph(snapshot))throw new Error('Graph differs from its deterministic authoritative compilation.');
  const root=JSON.parse(asset.manifestJson) as {chunks:Array<{chunkIndex:number;descriptorDigest:string}>};
  const edges=expectedDocumentGraphEdges(snapshot).map(e=>JSON.stringify(e)).sort();
  const manifest={profile:'neo4j-exclusive-asset-graph/v1',tenantId:attempt.tenantId,corpusId:attempt.corpusId,documentId:attempt.documentId,
    generation:attempt.generation,contentVersion:asset.contentVersion,manifestDigest:asset.manifestDigest,graphVersion:snapshot.graphVersion,
    snapshotDigest:digest(serializeDocumentPublicationGraph(snapshot)),edgesDigest:digest(JSON.stringify(edges)),
    passages:root.chunks.map((chunk,i)=>({...chunk,passageId:snapshot.passages[i].id}))};
  const json=JSON.stringify(manifest);if(Buffer.byteLength(json)>4194304)throw new Error('Graph manifest capacity exceeded.');return json;
}

/** Dedicated trusted local publisher only. The OS/Docker administrator is
 * trusted and this process exclusively holds the Neo4j write credential.
 * Successful write RPCs are awaited; any unknown generation remains reserved.
 * The class deliberately accepts no injected driver or graph snapshot. */
export class TrustedDocumentGraphPublisher {
  #client:Neo4jClient;#config:GraphConfig;#dispatched=new Set<string>();
  constructor(config:GraphConfig){
    if(!config||Object.keys(config).some(k=>!['uri','username','password'].includes(k))||!config.username||!config.password)throw new Error('Invalid trusted graph configuration.');
    const uri=new URL(config.uri);
    if(uri.protocol!=='bolt:'||!['127.0.0.1','[::1]'].includes(uri.hostname)||!uri.port||Number(uri.port)<1||Number(uri.port)>65535||uri.username||uri.password||uri.search||uri.hash||(uri.pathname&&uri.pathname!=='/'))throw new Error('Trusted graph publisher requires an explicit local bolt endpoint.');
    this.#config={uri:config.uri,username:config.username,password:config.password};
    this.#client=createNeo4jClient({...this.#config,database:'neo4j',connectionTimeoutMs:5000,queryTimeoutMs:30000,writeTimeoutMs:30000,maxTransactionRetryTimeMs:0,maxConnectionPoolSize:1});
  }
  async preflight():Promise<void>{
    await this.#client.verifyConnectivity();
    const edition=await this.#client.executeRead('check graph deployment edition',tx=>tx.run('CALL dbms.components() YIELD edition RETURN edition'));
    if(edition.records.length!==1||edition.records[0].get('edition')!=='community')throw new Error('Unexpected Neo4j deployment edition.');
    // SHOW USERS is an administration statement; Neo4j rejects mixing it with
    // a data/procedure statement in the same transaction.
    const result=await this.#client.executeRead('check private graph writer identity',tx=>tx.run('SHOW USERS YIELD user, passwordChangeRequired, suspended RETURN user,passwordChangeRequired,suspended'));
    // Community edition has no suspension/role feature and reports null.
    if(result.records.length!==1||result.records[0].get('user')!==this.#config.username||result.records[0].get('passwordChangeRequired')!==false||![false,null].includes(result.records[0].get('suspended')))throw new Error('Neo4j user inventory is not isolated.');
  }
  async stage(pg:LocalPg,attempt:PublicationAttempt,check:()=>Promise<void>):Promise<DocumentGraphPublicationSeal>{
    attempt={...attempt};
    assertLocalPg(pg);await check();await this.preflight();await check();
    const db=new PgClient({...pg,connectionTimeoutMillis:5000,query_timeout:30000,statement_timeout:30000});
    let graphVersion='';let closeStarted=false;
    try{
      await db.connect();const asset=await new PostgresPublicationAssetStore(db).readStaged(attempt);
      const snapshot=compileDocumentPublicationGraph(attempt,asset);graphVersion=snapshot.graphVersion;
      if(this.#dispatched.has(graphVersion))throw new Error('Graph generation was already dispatched.');
      this.#dispatched.add(graphVersion);
      await reserveDocumentGraphDispatch(db,attempt,{...attempt,contentVersion:asset.contentVersion});
      // This private auto-commit connection is not exposed to callers; reserve
      // response means the permanent reservation committed before external IO.
      closeStarted=true;await closePg(db);await check();
      const store=new Neo4jKnowledgeGraphCommandStore(this.#client);
      await store.stageSnapshot(snapshot);await check();
      const scope:RagRetrievalScope={tenantId:attempt.tenantId,corpusId:attempt.corpusId,enforceIsolation:true,allowedTrustLevels:[snapshot.documents[0].trustLevel]};
      await this.#client.executeRead('verify complete document generation graph',async tx=>{
        const inventory = await tx.run(`MATCH (n) WHERE n.tenantId=$tenantId AND n.corpusId=$corpusId AND n.graphVersion=$graphVersion
          RETURN labels(n) AS labels, count(*) AS total LIMIT 8`, { tenantId:attempt.tenantId,corpusId:attempt.corpusId,graphVersion });
        const expectedCounts = new Map(Object.entries({GraphSnapshot:1,DocumentVersion:snapshot.documents.length,Passage:snapshot.passages.length,
          Entity:snapshot.entities.length,Claim:snapshot.claims.length,Community:snapshot.communities.length}).filter(([,count])=>count>0));
        if (inventory.records.length !== expectedCounts.size) throw new Error('Neo4j node inventory differs.');
        for (const row of inventory.records) {
          const labels = row.get('labels');
          if (!Array.isArray(labels) || labels.length !== 1 || expectedCounts.get(labels[0]) !== Number(row.get('total'))) {
            throw new Error('Neo4j node labels or counts differ.');
          }
          expectedCounts.delete(labels[0]);
        }
        const inTransaction:Neo4jClient={verifyConnectivity:async()=>{},executeRead:async(_operation,work)=>work(tx),executeWrite:async()=>{throw new Error('Read-only verification.');},close:async()=>{}};
        const actual=await new Neo4jKnowledgeGraphCommandStore(inTransaction).getSnapshot({tenantId:attempt.tenantId,corpusId:attempt.corpusId,graphVersion},scope);
        if(!actual||serializeDocumentPublicationGraph(actual)!==serializeDocumentPublicationGraph(snapshot))throw new Error('Neo4j node readback differs.');
        const edges=await readDocumentGraphEdges(inTransaction,{tenantId:attempt.tenantId,corpusId:attempt.corpusId,graphVersion});
        if(JSON.stringify(edges.map(e=>JSON.stringify(e)).sort())!==JSON.stringify(expectedDocumentGraphEdges(snapshot).map(e=>JSON.stringify(e)).sort()))throw new Error('Neo4j relationship readback differs.');
      });
      await check();await this.preflight();await check();
      const manifestJson=documentGraphManifest(attempt,asset,snapshot);
      const configurationDigest=digest(JSON.stringify({uri:this.#config.uri,username:this.#config.username,database:'neo4j',profile:'neo4j-exclusive-asset-graph/v1'}));
      const seal=Object.freeze({graphVersion,manifestJson,snapshotJson:serializeDocumentPublicationGraph(snapshot),configurationDigest,evidenceDigest:digest(manifestJson)});seals.add(seal);return seal;
    }catch(error){if(!closeStarted)await closePg(db).catch(()=>{});throw Object.assign(new Error('Document graph publication outcome is unknown; never reuse the generation.',{cause:error}),
      {code:'DOCUMENT_GRAPH_UNKNOWN',identity:{tenantId:attempt.tenantId,corpusId:attempt.corpusId,documentId:attempt.documentId,generation:attempt.generation,...(graphVersion?{graphVersion}:{})}});}
  }
  async close(){await this.#client.close();}
}
function assertLocalPg(config:LocalPg){if(!config||Object.keys(config).some(k=>!['host','port','database','user','password'].includes(k))||!['127.0.0.1','::1'].includes(config.host)||!Number.isInteger(config.port)||config.port<1||config.port>65535||!config.database||!config.user||!config.password)throw new Error('Graph reservation requires an explicit private local database connection.');}
async function closePg(db:PgClient){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([db.end(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Graph database close timed out.')),5000);})]);}finally{if(timer)clearTimeout(timer);}}

/** Only the private verifier's object identity is accepted; an observation or
 * caller-built manifest cannot be promoted by stripping a diagnostic flag. */
export async function recordDocumentGraphPublicationSeal(db:PostgresQueryClient,attempt:PublicationAttempt,seal:DocumentGraphPublicationSeal):Promise<void>{
  if(!seals.has(seal))throw new Error('Graph seal was not produced by the private verifier.');
  const result=await queryPostgres<{recorded:boolean}>(db,'select public.rag_record_document_graph_seal($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9,$10,$11) as recorded',
    [attempt.tenantId,attempt.corpusId,attempt.documentId,attempt.generation,attempt.revision,attempt.leaseToken,seal.graphVersion,seal.configurationDigest,seal.evidenceDigest,seal.manifestJson,seal.snapshotJson],'record private graph publication seal');
  if(result.rows.length!==1||result.rows[0].recorded!==true)throw new Error('Graph publication seal was not recorded.');
}
