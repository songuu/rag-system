import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { readSandboxConfig } from '../deploy/publication-sandbox/sandbox.mjs';
import { inventoryScope } from './publication-migration-inventory.mjs';

const sandboxId=process.env.PUBLICATION_INVENTORY_SANDBOX_ID;
test('isolated database inventories actual scoped hashes without returning content',
  {skip:!sandboxId && 'Requires an explicitly selected isolated publication sandbox.'},async()=>{
    const cfg=readSandboxConfig(sandboxId);
    const db=new pg.Client({host:'127.0.0.1',port:cfg.ports.postgres,database:'publication_sandbox',
      user:'pub_migration',password:cfg.credentials.dbMigration});
    const suffix=randomUUID(), tenant='inventory-t-'+suffix, corpus='inventory-c-'+suffix;
    const source=Buffer.from('inventory fixture source'), version='sha256:'+createHash('sha256').update(source).digest('hex');
    await db.connect();
    try {
      await db.query('insert into public.tenants(id,name) values($1,$2)',[tenant,'fixture']);
      await db.query("insert into public.corpora(tenant_id,id,name,source_kind) values($1,$2,$3,'test')",[tenant,corpus,'fixture']);
      await db.query("insert into public.object_blobs(tenant_id,corpus_id,kind,filename,data) values($1,$2,'raw','fixture.bin',$3)",[tenant,corpus,source]);
      await db.query(`insert into public.document_assets(tenant_id,corpus_id,external_document_id,original_name,content_type,source_hash,raw_blob_filename,metadata)
        values($1,$2,'fixture-doc','fixture.bin','application/octet-stream',$3,'fixture.bin',$4::jsonb)`,
        [tenant,corpus,version,JSON.stringify({persistence_status:'ready',document:{documentVersion:version,trustLevel:'trusted'}})]);
      const result=await inventoryScope(db,tenant,corpus);
      assert.equal(result.items.length,1); assert.equal(result.items[0].status,'candidate');
      assert.deepEqual(result.items[0].versionVerifiedAgainst,['raw']);
      assert.equal(result.items[0].publicationAuthorized,false);
      assert.ok(!JSON.stringify(result).includes(source.toString()));
      const parsed=Buffer.from('different newer parsed source');
      const nextVersion='sha256:'+createHash('sha256').update(parsed).digest('hex');
      await db.query("insert into public.object_blobs(tenant_id,corpus_id,kind,filename,data) values($1,$2,'parsed','new.txt',$3)",[tenant,corpus,parsed]);
      await db.query(`update public.document_assets set source_hash=$3,parsed_blob_filename='new.txt',metadata=$4::jsonb
        where tenant_id=$1 and corpus_id=$2 and external_document_id='fixture-doc'`,[tenant,corpus,nextVersion,
        JSON.stringify({persistence_status:'ready',document:{documentVersion:nextVersion,trustLevel:'trusted'}})]);
      const after=await inventoryScope(db,tenant,corpus);
      assert.deepEqual(after.items[0].versionVerifiedAgainst,['parsed']);
      assert.equal(after.items[0].status,'needs_review');
      assert.ok(after.items[0].reasons.includes('raw_version_unverified'));
    } finally {
      await db.query('delete from public.tenants where id=$1',[tenant]);
      await db.end();
    }
  });
