import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
const moduleText=source=>({shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(source)});
registerHooks({resolve(specifier,context,next){
  if(specifier==='../postgres/client')return moduleText('export const getPostgresClient=()=>({});export const queryPostgres=()=>{throw new Error("Legacy catalog was accessed");};');
  if(specifier==='../postgres/env')return moduleText('export const getPostgresRuntimeConfig=()=>({});export const shouldUsePostgresPersistence=()=>true;export const assertPostgresPersistenceConfigured=()=>{};');
  if(specifier==='./publication-reader-capability')return moduleText('export const assertPublicationReaderPostgresCapability=(...args)=>globalThis.catalogCapability(...args);');
  if(specifier==='./publication-view')return moduleText('export const readPublicationView=(...args)=>globalThis.catalogView(...args);');
  try{return next(specifier,context);}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!specifier.endsWith('.ts'))return next(specifier+'.ts',context);throw error;}
}});
const {listDocumentCatalog}=await import('./document-catalog.ts');
const scope={tenantId:'t',corpusId:'c',enforceIsolation:true,allowedTrustLevels:['external']};
async function active(run){const previous=process.env.RAG_UNIFIED_PUBLICATION_MODE;process.env.RAG_UNIFIED_PUBLICATION_MODE='active';
  try{await run();}finally{if(previous===undefined)delete process.env.RAG_UNIFIED_PUBLICATION_MODE;else process.env.RAG_UNIFIED_PUBLICATION_MODE=previous;}}

test('active catalog reads only the published view with enforced scope',()=>active(async()=>{
  let calls=0;globalThis.catalogCapability=async()=>{calls++;};globalThis.catalogView=async(received)=>{assert.deepEqual(received,scope);return {documents:[]};};
  assert.deepEqual(await listDocumentCatalog({scope:{...scope,enforceIsolation:false}}),[]);assert.equal(calls,1);
}));

test('cancelled capability observation cannot start a late catalog read',()=>active(async()=>{
  const controller=new AbortController();let complete;let viewCalls=0;
  globalThis.catalogCapability=()=>new Promise(resolve=>{complete=resolve;});globalThis.catalogView=async()=>{viewCalls++;return {documents:[]};};
  const pending=listDocumentCatalog({scope,signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));
  controller.abort(new Error('Catalog cancelled'));await assert.rejects(pending,/cancelled/);complete();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(viewCalls,0);
}));

test('cancelled catalog observation never returns late data',()=>active(async()=>{
  const controller=new AbortController();let complete;
  globalThis.catalogCapability=async()=>{};globalThis.catalogView=()=>new Promise(resolve=>{complete=resolve;});
  const pending=listDocumentCatalog({scope,signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));
  controller.abort(new Error('Catalog cancelled'));await assert.rejects(pending,/cancelled/);complete({documents:[]});
}));
