import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context);}catch(error){
  if(error?.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!specifier.endsWith('.ts'))return next(`${specifier}.ts`,context);
  throw error;
}}});
const {assertPublicationReaderPostgresCapability,assertPublicationQueuePostgresCapability,assertPublicationGraphPostgresCapability}=await import('./publication-reader-capability.ts');

test('reader and queue profiles require only their exact fixed function sets',async()=>{
  const calls=[];const client={async query(sql,args){calls.push({sql,args});return {rows:[{ready:true}]};}};
  await assertPublicationReaderPostgresCapability(client);await assertPublicationQueuePostgresCapability(client);
  await assertPublicationGraphPostgresCapability(client);
  assert.deepEqual(calls[0].args[0],['public.rag_read_publication_view(text,text,text[])','public.rag_read_publication_source(text,text,text,bigint,bigint,uuid,text,text[],text)']);
  assert.deepEqual(calls[1].args[0],['public.rag_enqueue_publication_request(uuid,text,text,text,text,bytea,bytea,jsonb)','public.rag_read_publication_request_state(uuid,text,text,text)','public.rag_read_publication_request_result(uuid,text,text,text)']);
  assert.deepEqual(calls[2].args[0],['public.rag_read_document_graph_view(text,text,text[])','public.rag_read_document_graph_snapshot(text,text,text,text[])']);
  assert.equal(calls.every(call=>call.sql.includes('has_any_column_privilege')&&call.sql.includes('pg_auth_members')&&call.sql.includes('rag_publish_document_generation')),true);
});

test('missing capability or malformed verification fails closed',async()=>{
  for(const rows of [[],[{ready:false}],[{ready:true},{ready:true}],[{ready:'true'}]]){
    const client={async query(){return {rows};}};
    await assert.rejects(assertPublicationReaderPostgresCapability(client),/capability/);
    await assert.rejects(assertPublicationQueuePostgresCapability(client),/capability/);
    await assert.rejects(assertPublicationGraphPostgresCapability(client),/capability/);
  }
});
