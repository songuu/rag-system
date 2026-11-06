import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const TABLES = {
  tenants: {name:'tenants', columns:['id','name','metadata','created_at','updated_at']},
  corpora: {name:'corpora', columns:['id','tenant_id','name','source_kind','metadata','created_by','created_at','updated_at']},
  blobs: {name:'object_blobs', columns:['id','tenant_id','corpus_id','kind','filename','data','content_type','metadata','created_at','updated_at']},
  assets: {name:'document_assets', columns:['id','tenant_id','corpus_id','external_document_id','original_name','content_type','byte_size','source_hash',
    'raw_blob_filename','parsed_blob_filename','parse_method','metadata','created_by','created_at','updated_at']},
};
const ORDER=['tenants','corpora','blobs','assets'];
const MAX_DOCUMENTS=10000, MAX_BYTES=128*1024*1024;
function projection(table, alias='') {
  const prefix=alias?`${alias}.`:'';
  // JSONB must stay text: pg's normal JSON parser rounds numeric values that
  // exceed JavaScript precision before an otherwise exact copy can occur.
  return table.columns.map(column=>['created_at','updated_at','byte_size','metadata'].includes(column)?`${prefix}${column}::text as ${column}`:`${prefix}${column}`).join(',');
}
function canonical(value) {
  if(value instanceof Uint8Array)return {$bytes:Buffer.from(value).toString('base64')};
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
const hash=value=>`sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
function metadataForClassification(row) {
  if(typeof row.metadata!=='string')throw new Error('Archive metadata must be lossless database text.');
  const metadata=JSON.parse(row.metadata);
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw new Error('Archive metadata must be a JSON object.');
  // This parsed copy is used only to inspect booleans/lifecycle. It is never
  // fingerprinted or serialized back to PostgreSQL.
  return metadata;
}
function inactive(asset) {
  const metadata=metadataForClassification(asset);
  return metadata.retrieval_enabled===false||metadata.retrieval_enabled==='false'||['deleting','deleted'].includes(metadata.lifecycle);
}
const blobKey=row=>JSON.stringify([row.tenant_id,row.corpus_id,row.filename]);
const scopeKey=row=>JSON.stringify([row.tenant_id,row.corpus_id]);

/** Archive only: this never creates a publication request, head or projection. */
export function validateArchiveSnapshot(snapshot) {
  if(!snapshot||ORDER.some(kind=>!Array.isArray(snapshot[kind]))||snapshot.assets.length>MAX_DOCUMENTS)throw new Error('Invalid archive snapshot capacity.');
  let size=0;
  for(const kind of ORDER) {
    const seen=new Set();
    for(const row of snapshot[kind]) {
      if(!row||typeof row!=='object'||typeof row.id!=='string'||!row.id||seen.has(row.id))throw new Error('Invalid or duplicate archive identity.');
      seen.add(row.id);
      if(Object.keys(row).length!==TABLES[kind].columns.length||TABLES[kind].columns.some(key=>!Object.hasOwn(row,key)))throw new Error('Archive schema mismatch.');
      metadataForClassification(row);
      size+=Buffer.byteLength(JSON.stringify(canonical(row)));
      if(size>MAX_BYTES)throw new Error('Archive byte capacity exceeded.');
    }
  }
  const tenants=new Set(snapshot.tenants.map(row=>row.id));
  const corpora=new Set(snapshot.corpora.map(row=>JSON.stringify([row.tenant_id,row.id])));
  for(const corpus of snapshot.corpora)if(!tenants.has(corpus.tenant_id))throw new Error('Archive corpus scope missing.');
  const referenced=new Set();
  for(const asset of snapshot.assets) {
    if(!inactive(asset))throw new Error('Archive requires explicitly inactive or retrieval-disabled documents.');
    if(!corpora.has(scopeKey(asset)))throw new Error('Archive asset scope missing.');
    for(const filename of [asset.raw_blob_filename,asset.parsed_blob_filename])if(filename!==null)referenced.add(blobKey({...asset,filename}));
  }
  for(const blob of snapshot.blobs)if(!(blob.data instanceof Uint8Array)||!referenced.has(blobKey(blob))||!corpora.has(scopeKey(blob)))throw new Error('Invalid or unreferenced archive blob.');
}

export function archiveDigest(snapshot) {
  return hash(ORDER.map(kind=>[kind,snapshot[kind].map(row=>[row.id,hash(row)]).sort((a,b)=>a[0].localeCompare(b[0]))]));
}

async function databaseIdentity(client) {
  const result=await client.query('select current_database() as database,inet_server_addr()::text as address,inet_server_port() as port');
  if(result.rows.length!==1)throw new Error('Cannot establish archive database identity.');
  return result.rows[0];
}
async function assertSeparate(source,target) {
  const [from,to]=await Promise.all([databaseIdentity(source),databaseIdentity(target)]);
  // Equal database names are deliberately refused even across endpoints: IPv4,
  // IPv6 or a proxy can describe the same server differently.
  if(typeof from.database!=='string'||typeof to.database!=='string'||from.database===to.database)throw new Error('Archive source and target must be different databases.');
}

async function capture(source) {
  await source.query('begin isolation level repeatable read read only');
  try {
    await source.query("set local time zone 'UTC'");
    const assets=(await source.query(`select ${projection(TABLES.assets,'a')} from public.document_assets a order by a.id limit 10001`)).rows;
    if(assets.length>MAX_DOCUMENTS)throw new Error('Archive document capacity exceeded.');
    const corpora=(await source.query(`select ${projection(TABLES.corpora,'c')} from public.corpora c where exists
      (select 1 from public.document_assets a where a.tenant_id=c.tenant_id and a.corpus_id=c.id) order by c.id`)).rows;
    const tenants=(await source.query(`select ${projection(TABLES.tenants,'t')} from public.tenants t where exists
      (select 1 from public.document_assets a where a.tenant_id=t.id) order by t.id`)).rows;
    const bytes=(await source.query(`select coalesce(sum(octet_length(b.data)),0)::text as bytes from public.object_blobs b where exists
      (select 1 from public.document_assets a where a.tenant_id=b.tenant_id and a.corpus_id=b.corpus_id
        and (a.raw_blob_filename=b.filename or a.parsed_blob_filename=b.filename))`)).rows[0]?.bytes;
    if(!/^\d+$/.test(bytes??'')||BigInt(bytes)>BigInt(MAX_BYTES))throw new Error('Archive blob capacity exceeded.');
    const blobs=(await source.query(`select ${projection(TABLES.blobs,'b')} from public.object_blobs b where exists
      (select 1 from public.document_assets a where a.tenant_id=b.tenant_id and a.corpus_id=b.corpus_id
        and (a.raw_blob_filename=b.filename or a.parsed_blob_filename=b.filename)) order by b.id`)).rows;
    const snapshot={tenants,corpora,blobs,assets};validateArchiveSnapshot(snapshot);
    await source.query('commit');return snapshot;
  } catch(error) {await source.query('rollback').catch(()=>{});throw error;}
}

async function findExisting(target,kind,row,lock=false) {
  const table=TABLES[kind];let where='id=$1',args=[row.id];
  if(kind==='assets') {
    where='id=$1::uuid or (tenant_id=$2 and corpus_id=$3 and source_hash=$4) or ($5::text is not null and tenant_id=$2 and corpus_id=$3 and external_document_id=$5)';
    args=[row.id,row.tenant_id,row.corpus_id,row.source_hash,row.external_document_id];
  } else if(kind==='blobs') {where='id=$1::uuid or (tenant_id=$2 and corpus_id=$3 and filename=$4)';args=[row.id,row.tenant_id,row.corpus_id,row.filename];}
  return (await target.query(`select ${projection(table)} from public.${table.name} where ${where}${lock?' for update':''}`,args)).rows;
}
async function inspect(target,snapshot,lock=false) {
  const inserts={},reused={},conflicts=[];
  for(const kind of ORDER) {
    inserts[kind]=0;reused[kind]=0;
    for(const row of snapshot[kind]) {
      const existing=await findExisting(target,kind,row,lock);
      if(existing.length===0)inserts[kind]++;
      else if(existing.length===1&&hash(existing[0])===hash(row))reused[kind]++;
      else conflicts.push({kind,id:row.id});
    }
  }
  return {inserts,reused,conflicts};
}
function summary(snapshot,inspection) {
  const blobKeys=new Set(snapshot.blobs.map(blobKey));let missingBlobReferences=0;
  for(const asset of snapshot.assets)for(const filename of [asset.raw_blob_filename,asset.parsed_blob_filename])if(filename!==null&&!blobKeys.has(blobKey({...asset,filename})))missingBlobReferences++;
  return {status:inspection.conflicts.length?'conflict':'ready',snapshotDigest:archiveDigest(snapshot),
    counts:Object.fromEntries(ORDER.map(kind=>[kind,snapshot[kind].length])),missingBlobReferences,
    ...inspection,publicationAuthorized:false};
}

export async function planArchiveMigration(source,target) {
  await assertSeparate(source,target);const snapshot=await capture(source);
  await target.query('begin isolation level repeatable read read only');
  try {await target.query("set local time zone 'UTC'");const result=summary(snapshot,await inspect(target,snapshot));await target.query('commit');return result;}
  catch(error){await target.query('rollback').catch(()=>{});throw error;}
}

/** The caller supplies the reviewed dry-run digest. Identical retries are
 * accepted; any conflict or source drift rolls back the entire target write. */
export async function applyArchiveMigration(source,target,expectedDigest) {
  if(!/^sha256:[a-f0-9]{64}$/.test(expectedDigest??''))throw new Error('A reviewed archive digest is required.');
  await assertSeparate(source,target);const snapshot=await capture(source);
  if(archiveDigest(snapshot)!==expectedDigest)throw new Error('Archive source changed after the reviewed plan.');
  await target.query('begin isolation level serializable');
  try {
    await target.query("set local time zone 'UTC'");
    await target.query("select pg_advisory_xact_lock(hashtext('publication-disabled-archive/v1'))");
    const inspection=await inspect(target,snapshot,true);
    if(inspection.conflicts.length)throw new Error('Archive target conflicts with existing data; nothing was changed.');
    const verified={};
    for(const kind of ORDER) {
      const table=TABLES[kind];verified[kind]=[];
      for(const row of snapshot[kind]) {
        const values=table.columns.map(column=>row[column]);
        await target.query(`insert into public.${table.name} (${table.columns.join(',')}) values (${table.columns.map((_,i)=>`$${i+1}`).join(',')}) on conflict do nothing`,values);
        const found=await findExisting(target,kind,row,true);
        if(found.length!==1||hash(found[0])!==hash(row))throw new Error('Archive readback differs; nothing was committed.');
        verified[kind].push(found[0]);
      }
    }
    const targetDigest=archiveDigest(verified);
    if(targetDigest!==expectedDigest)throw new Error('Archive complete readback differs.');
    await target.query('commit');return {...summary(snapshot,inspection),status:'archived',targetDigest};
  } catch(error) {await target.query('rollback').catch(()=>{});throw error;}
}

async function main() {
  const sourceUrl=process.env.PUBLICATION_ARCHIVE_SOURCE_URL,targetUrl=process.env.PUBLICATION_ARCHIVE_TARGET_URL;
  if(!sourceUrl||!targetUrl)throw new Error('Archive source and target connections are required.');
  const source=new pg.Client({connectionString:sourceUrl,connectionTimeoutMillis:5000,query_timeout:30000});
  const target=new pg.Client({connectionString:targetUrl,connectionTimeoutMillis:5000,query_timeout:30000});
  try {
    await source.connect();await target.connect();
    const result=process.env.PUBLICATION_ARCHIVE_APPLY==='1'
      ?await applyArchiveMigration(source,target,process.env.PUBLICATION_ARCHIVE_EXPECTED_DIGEST)
      :await planArchiveMigration(source,target);
    process.stdout.write(JSON.stringify(result)+'\n');
  } finally {await Promise.allSettled([source.end(),target.end()]);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
  process.stderr.write('Archive migration did not complete; verify the dry-run, source state and target conflicts.\n');process.exitCode=1;
});
