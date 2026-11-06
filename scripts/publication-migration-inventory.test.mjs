import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInventoryRow, inventoryScope } from './publication-migration-inventory.mjs';
const digest = 'sha256:' + 'a'.repeat(64);
const row = () => ({ asset_id:'00000000-0000-0000-0000-000000000001', external_document_id:'doc',
  source_hash:digest, metadata:{persistence_status:'ready',document:{documentVersion:digest,trustLevel:'trusted'}},
  raw_kind:'raw', parsed_kind:'parsed', raw_digest:digest, parsed_digest:'sha256:'+'b'.repeat(64), chunk_count:'2' });
test('candidate is only evidence; no payload or automatic publication is returned', () => {
  const value=classifyInventoryRow({...row(), content:'sensitive', raw_bytes:'secret'});
  assert.equal(value.status,'candidate'); assert.equal(value.publicationAuthorized,false);
  assert.equal(value.reembeddingRequired,true); assert.deepEqual(value.versionVerifiedAgainst,['raw']);
  assert.ok(!JSON.stringify(value).includes('sensitive')); assert.ok(!JSON.stringify(value).includes('secret'));
});
test('missing source, conflicting version and restricted lifecycle require review', () => {
  const input=row(); input.raw_kind=null; input.source_hash='sha256:'+'c'.repeat(64);
  input.metadata.lifecycle='deleted'; input.metadata.retrieval_enabled=false;
  const value=classifyInventoryRow(input);
  for (const reason of ['raw_source_missing','version_unverified','version_conflict','inactive_lifecycle','retrieval_disabled']) assert.ok(value.reasons.includes(reason));
  assert.equal(value.status,'needs_review');
});
test('a parsed version match does not prove an older raw blob is the same source', () => {
  const input=row(); input.raw_digest='sha256:'+'d'.repeat(64); input.parsed_digest=digest;
  const value=classifyInventoryRow(input);
  assert.deepEqual(value.versionVerifiedAgainst,['parsed']);
  assert.ok(value.reasons.includes('raw_version_unverified'));
  assert.equal(value.status,'needs_review');
});
test('read-only repeatable snapshot is scoped and rolls back on over-limit', async () => {
  const calls=[]; let pages=0;
  const client={async query(sql,args) { calls.push([sql,args]); if (args) { pages++; return {rows:[row()]}; } return {rows:[]}; }};
  await assert.rejects(inventoryScope(client,'tenant','corpus',{pageSize:1,maxRows:1}),/limit exceeded/);
  assert.match(calls[0][0],/repeatable read read only/); assert.deepEqual(calls[1][1].slice(0,2),['tenant','corpus']);
  assert.equal(calls.at(-1)[0],'rollback'); assert.equal(pages,2);
});
test('empty inventory commits without emitting document data', async () => {
  const calls=[]; const client={async query(sql,args){ calls.push(sql); return {rows:[]}; }};
  const value=await inventoryScope(client,'tenant','corpus');
  assert.deepEqual(value.items,[]); assert.equal(value.publicationAuthorized,false); assert.equal(calls.at(-1),'commit');
});
