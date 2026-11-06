import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveDigest, validateArchiveSnapshot, planArchiveMigration } from './publication-archive-migration.mjs';

function fixture() {
  const scope={tenant_id:'t',corpus_id:'c'};
  return {tenants:[{id:'t',name:'Tenant',metadata:'{}',created_at:'2026-01-01 00:00:00+00',updated_at:'2026-01-01 00:00:00+00'}],
    corpora:[{id:'c',tenant_id:'t',name:'Corpus',source_kind:'text',metadata:'{}',created_by:null,created_at:'2026-01-01 00:00:00+00',updated_at:'2026-01-01 00:00:00+00'}],
    assets:[{id:'00000000-0000-4000-8000-000000000001',...scope,external_document_id:'doc',original_name:'a.txt',content_type:'text/plain',byte_size:'3',source_hash:'v1',
      raw_blob_filename:'a.txt',parsed_blob_filename:null,parse_method:null,metadata:'{"retrieval_enabled":false,"lifecycle":"active","document":{"trustLevel":"external"}}',created_by:null,created_at:'2026-01-01 00:00:00+00',updated_at:'2026-01-01 00:00:00+00'}],
    blobs:[{id:'00000000-0000-4000-8000-000000000002',...scope,kind:'raw',filename:'a.txt',data:Buffer.from('abc'),content_type:'text/plain',metadata:'{}',created_at:'2026-01-01 00:00:00+00',updated_at:'2026-01-01 00:00:00+00'}]};
}
test('archive hash binds all metadata, timestamps and exact source bytes without returning contents',()=>{
  const value=fixture();validateArchiveSnapshot(value);const before=archiveDigest(value);
  const reordered=structuredClone(value);reordered.assets[0]=Object.fromEntries(Object.entries(reordered.assets[0]).reverse());
  assert.equal(archiveDigest(reordered),before);
  reordered.blobs[0].data=Buffer.from('abd');assert.notEqual(archiveDigest(reordered),before);
  const altered=structuredClone(value);altered.assets[0].metadata=altered.assets[0].metadata.replace('false','true');assert.notEqual(archiveDigest(altered),before);
});
test('archive rejects enabled documents, duplicate identities and unbound blobs',()=>{
  const enabled=fixture();enabled.assets[0].metadata=enabled.assets[0].metadata.replace('false','true');assert.throws(()=>validateArchiveSnapshot(enabled),/inactive/);
  const duplicate=fixture();duplicate.assets.push({...duplicate.assets[0]});assert.throws(()=>validateArchiveSnapshot(duplicate),/duplicate/i);
  const unbound=fixture();unbound.blobs[0].filename='other';assert.throws(()=>validateArchiveSnapshot(unbound),/unreferenced/i);
});
test('missing source references remain metadata and cannot be fabricated by migration',()=>{
  const value=fixture();value.blobs=[];validateArchiveSnapshot(value);assert.match(archiveDigest(value),/^sha256:[a-f0-9]{64}$/);
  assert.equal(value.assets[0].raw_blob_filename,'a.txt');assert.equal(JSON.parse(value.assets[0].metadata).retrieval_enabled,false);
});
test('metadata precision is part of the exact text fingerprint',()=>{
  const left=fixture(),right=fixture();left.assets[0].metadata='{"retrieval_enabled":false,"large":9007199254740992,"fraction":0.123456789012345678901234567890}';
  right.assets[0].metadata=left.assets[0].metadata.replace('9007199254740992','9007199254740993');
  validateArchiveSnapshot(left);validateArchiveSnapshot(right);assert.notEqual(archiveDigest(left),archiveDigest(right));
});
test('same database name is rejected even when reported IPv4 and IPv6 addresses differ',async()=>{
  const queries=[];const client=address=>({async query(sql){queries.push(sql);return {rows:[{database:'same',address,port:5432}]};}});
  await assert.rejects(planArchiveMigration(client('127.0.0.1'),client('::1')),/different databases/);
  assert.equal(queries.length,2,'must reject before any transaction or data query');
});
