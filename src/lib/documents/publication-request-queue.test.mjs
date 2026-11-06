import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { preparePublicationAsset } = await import('./publication-asset-store.ts');
const { PublicationRequestQueue } = await import('./publication-request-queue.ts');

function asset() { return preparePublicationAsset({ tenantId:'tenant',corpusId:'corpus',documentId:'doc',
  sourceBytes:Buffer.from('raw'),sourceIdentityBytes:Buffer.from('parsed'),originalName:'x.txt',contentType:'text/plain',sourceKind:'text',
  embedding:{model:'model',revision:'1',dimension:2,indexSchema:'milvus-publication/v1'},
  splitter:{name:'text',revision:'1',chunkSize:10,chunkOverlap:0},
  chunks:[{chunkIndex:0,content:'hello',trustLevel:'trusted',embedding:[0.1,0.2]}] }); }

test('enqueue validates and sends a complete independent snapshot', async () => {
  const a=asset(); const id=randomUUID(); let args;
  const queue=new PublicationRequestQueue({query:async (sql,values)=>{args={sql,values};return {rows:[{}]};}});
  await queue.enqueue(id,a);
  assert.match(args.sql,/rag_enqueue_publication_request/);
  assert.equal(args.values[0],id); assert.equal(args.values[4],a.manifestJson);
  assert.notEqual(args.values[5],a.sourceBytes);
  await assert.rejects(queue.enqueue(id,{...a,sourceBytes:Buffer.from('modified')}));
});

test('claim independently validates returned source, manifest, and chunks', async () => {
  const a=asset(); const id=randomUUID();
  const row={request_id:id,tenant_id:a.tenantId,corpus_id:a.corpusId,document_id:a.documentId,
    manifest_json:a.manifestJson,source_bytes:a.sourceBytes,source_identity_bytes:a.sourceIdentityBytes,chunks_json:JSON.parse(a.chunksJson)};
  const queue=new PublicationRequestQueue({query:async()=>({rows:[row]})});
  assert.equal((await queue.claim(randomUUID())).asset.manifestDigest,a.manifestDigest);
  row.source_bytes=Buffer.from('tampered');
  await assert.rejects(queue.claim(randomUUID()));
});

test('claims retain a caller-generated operation id and missing observations remain unknown', async () => {
  let args;
  const queue=new PublicationRequestQueue({query:async (sql,values)=>{args={sql,values}; return {rows:[]};}});
  const operationId=randomUUID();
  await assert.rejects(queue.claim(operationId), error => error.code === 'PUBLICATION_CLAIM_UNKNOWN' && error.operationId === operationId);
  assert.deepEqual(args.values,[operationId]);
  assert.equal(await queue.inspectClaim(operationId),undefined);
  assert.deepEqual(await queue.listClaims(null,10),[]);
  await assert.rejects(queue.claim('invalid'));
});

test('scope-filtered absence remains unknown and never means publication failed', async () => {
  const queue=new PublicationRequestQueue({query:async()=>({rows:[{state:null}]})});
  assert.equal(await queue.state(randomUUID(),{tenantId:'t',corpusId:'c',documentId:'d'}),'not_observed');
});
