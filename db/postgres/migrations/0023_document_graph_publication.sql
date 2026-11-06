-- Neo4j is a third required projection when the attempt requests it. The
-- trusted, local publisher owns its only write credential and verifies the
-- complete asset-bound graph in one transaction before recording this seal.
create table public.document_graph_publication_seals (
  tenant_id text not null, corpus_id text not null, document_id text not null,
  generation bigint not null, graph_version text not null unique,
  manifest_digest text not null, content_version text not null,
  configuration_digest text not null, evidence_digest text not null,
  graph_manifest_json text not null, graph_manifest_digest text not null,
  verified_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id,corpus_id,document_id,generation),
  foreign key (tenant_id,corpus_id,document_id,generation)
    references public.document_publication_attempts(tenant_id,corpus_id,document_id,generation) on delete cascade,
  foreign key (graph_version) references public.document_graph_dispatches(graph_version),
  check (graph_version ~ '^doc-generation-[a-f0-9]{64}$'),
  check (manifest_digest ~ '^sha256:[a-f0-9]{64}$' and content_version ~ '^sha256:[a-f0-9]{64}$'
    and configuration_digest ~ '^sha256:[a-f0-9]{64}$' and evidence_digest ~ '^sha256:[a-f0-9]{64}$'
    and graph_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (octet_length(graph_manifest_json) between 2 and 4194304)
);
revoke all on public.document_graph_publication_seals from public;

create function public.rag_record_document_graph_seal(
  tenant text, corpus text, document text, gen bigint, revision bigint, token uuid,
  graph text, configuration text, evidence text, manifest text
) returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare h public.document_publication_heads%rowtype; a public.document_publication_attempts%rowtype;
  asset public.document_publication_assets%rowtype; prior public.document_graph_publication_seals%rowtype;
  parsed jsonb; root jsonb; item jsonb; i integer; manifest_hash text;
begin
  if tenant is null or corpus is null or document is null or gen is null or revision is null or token is null
    or graph is null or configuration is null or evidence is null or manifest is null
    or configuration !~ '^sha256:[a-f0-9]{64}$' or evidence !~ '^sha256:[a-f0-9]{64}$'
    or octet_length(manifest) not between 2 and 4194304 then
    raise exception 'invalid graph seal request' using errcode='22023';
  end if;
  select * into h from public.document_publication_heads
    where tenant_id=tenant and corpus_id=corpus and document_id=document for update;
  if not found or h.revoked or h.generation is distinct from gen or h.revision is distinct from revision then
    raise exception 'graph seal head changed' using errcode='P0001';
  end if;
  select * into a from public.document_publication_attempts
    where tenant_id=tenant and corpus_id=corpus and document_id=document and generation=gen for update;
  if not found or a.status <> 'staging' or a.expected_revision is distinct from revision
    or a.lease_token is distinct from token or a.lease_expires_at <= clock_timestamp()
    or not ('neo4j'=any(a.required_providers)) then
    raise exception 'graph seal lease unavailable' using errcode='P0001';
  end if;
  if not exists (select 1 from public.document_graph_dispatches d where d.graph_version=graph
    and d.tenant_id=tenant and d.corpus_id=corpus and d.document_id=document and d.generation=gen
    and d.manifest_digest=a.manifest_digest and d.content_version=a.content_version) then
    raise exception 'graph dispatch identity mismatch' using errcode='P0001';
  end if;
  select * into asset from public.document_publication_assets
    where tenant_id=tenant and corpus_id=corpus and document_id=document and generation=gen;
  if not found or asset.manifest_digest is distinct from a.manifest_digest or asset.content_version is distinct from a.content_version then
    raise exception 'graph source unavailable' using errcode='P0001';
  end if;
  parsed := manifest::jsonb; root := asset.manifest_json::jsonb;
  if parsed->>'profile' is distinct from 'neo4j-exclusive-asset-graph/v1'
    or parsed->>'tenantId' is distinct from tenant or parsed->>'corpusId' is distinct from corpus
    or parsed->>'documentId' is distinct from document or parsed->>'generation' is distinct from gen::text
    or parsed->>'graphVersion' is distinct from graph or parsed->>'contentVersion' is distinct from a.content_version
    or parsed->>'manifestDigest' is distinct from a.manifest_digest
    or coalesce(parsed->>'snapshotDigest','') !~ '^sha256:[a-f0-9]{64}$'
    or coalesce(parsed->>'edgesDigest','') !~ '^sha256:[a-f0-9]{64}$'
    or jsonb_typeof(parsed->'passages') is distinct from 'array'
    or jsonb_array_length(parsed->'passages') <> jsonb_array_length(root->'chunks') then
    raise exception 'graph seal manifest mismatch' using errcode='P0001';
  end if;
  for i in 0..jsonb_array_length(root->'chunks')-1 loop
    item := parsed->'passages'->i;
    if item->>'chunkIndex' is distinct from i::text
      or item->>'descriptorDigest' is distinct from root->'chunks'->i->>'descriptorDigest'
      or coalesce(item->>'passageId','') !~ '^graph-passage:[a-f0-9]{64}$' then
      raise exception 'graph passage binding mismatch' using errcode='P0001';
    end if;
  end loop;
  if (select count(distinct e->>'passageId') from jsonb_array_elements(parsed->'passages') e) <> jsonb_array_length(parsed->'passages') then
    raise exception 'duplicate graph passage' using errcode='P0001';
  end if;
  manifest_hash := 'sha256:' || encode(sha256(convert_to(manifest,'UTF8')),'hex');
  insert into public.document_graph_publication_seals
    (tenant_id,corpus_id,document_id,generation,graph_version,manifest_digest,content_version,
      configuration_digest,evidence_digest,graph_manifest_json,graph_manifest_digest)
    values (tenant,corpus,document,gen,graph,a.manifest_digest,a.content_version,configuration,evidence,manifest,manifest_hash)
    on conflict (tenant_id,corpus_id,document_id,generation) do nothing;
  select * into prior from public.document_graph_publication_seals
    where tenant_id=tenant and corpus_id=corpus and document_id=document and generation=gen;
  if prior.graph_version is distinct from graph or prior.manifest_digest is distinct from a.manifest_digest
    or prior.content_version is distinct from a.content_version or prior.configuration_digest is distinct from configuration
    or prior.evidence_digest is distinct from evidence or prior.graph_manifest_json is distinct from manifest
    or a.lease_expires_at <= clock_timestamp() then
    raise exception 'graph seal changed or expired' using errcode='P0001';
  end if;
  return true;
end;
$$;
revoke all on function public.rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text) from public;

create or replace function public.rag_publish_document_generation(
  p_tenant text, p_corpus text, p_document text, p_generation bigint, p_revision bigint,
  p_lease uuid, p_collection text, p_manifest_digest text
) returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare
  h public.document_publication_heads%rowtype;
  a public.document_publication_attempts%rowtype;
  asset public.document_publication_assets%rowtype;
  op public.elasticsearch_publication_operations%rowtype;
  m public.document_publication_provider_seals%rowtype;
  e public.document_publication_provider_seals%rowtype;
  g public.document_graph_publication_seals%rowtype;
  existing public.document_assets%rowtype;
  receipt public.document_publication_receipts%rowtype;
  manifest jsonb;
  source_data jsonb;
  descriptor jsonb;
  trust text;
  source_name text;
  result_asset uuid;
  result_asset_revision text;
  next_revision bigint;
begin
  if p_tenant is null or length(p_tenant) not between 1 and 128
    or p_corpus is null or length(p_corpus) not between 1 and 128
    or p_document is null or length(p_document) not between 1 and 256
    or p_generation is null or p_generation < 1 or p_revision is null or p_revision < 1
    or p_lease is null or p_collection is null or p_manifest_digest is null
    or p_manifest_digest !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'invalid publication identity' using errcode='22023';
  end if;
  -- All publication operations lock head then attempt, so revoke/supersede
  -- and the final source switch cannot commit concurrently.
  select * into h from public.document_publication_heads
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document for update;
  if not found then
    raise exception 'publication head changed' using errcode='P0001';
  end if;
  -- Replay is allowed only while this exact publication and source row remain
  -- current. xmin prevents a disable/enable or metadata-change ABA replay.
  if not h.revoked and h.generation = p_generation and h.active_generation = p_generation
    and p_revision < 9223372036854775807 and h.revision = p_revision + 1 then
    select * into receipt from public.document_publication_receipts
      where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation;
    if found and receipt.expected_revision=p_revision and receipt.published_revision=h.revision
      and receipt.manifest_digest=p_manifest_digest and receipt.physical_collection=p_collection
      and receipt.lease_digest='sha256:' || encode(sha256(convert_to(p_lease::text,'UTF8')),'hex')
      and exists (select 1 from public.document_publication_attempts current_attempt
        where current_attempt.tenant_id=p_tenant and current_attempt.corpus_id=p_corpus and current_attempt.document_id=p_document
          and current_attempt.generation=p_generation and current_attempt.status='published'
          and current_attempt.content_version=receipt.content_version and current_attempt.manifest_digest=p_manifest_digest)
      and exists (select 1 from public.document_assets current_asset
        where current_asset.tenant_id=p_tenant and current_asset.corpus_id=p_corpus and current_asset.external_document_id=p_document
          and current_asset.id=receipt.asset_id and current_asset.xmin::text=receipt.asset_revision
          and current_asset.source_hash=receipt.content_version
          and current_asset.metadata->>'retrieval_enabled' is distinct from 'false'
          and coalesce(current_asset.metadata->>'lifecycle','active')='active') then
      return jsonb_build_object('tenantId',p_tenant,'corpusId',p_corpus,'documentId',p_document,
        'generation',p_generation::text,'revision',receipt.published_revision::text,'manifestDigest',p_manifest_digest,
        'physicalCollection',p_collection,'assetId',receipt.asset_id::text);
    end if;
    raise exception 'publication receipt unavailable or changed' using errcode='P0001';
  end if;
  if h.revoked or h.generation is distinct from p_generation or h.revision is distinct from p_revision then
    raise exception 'publication head changed' using errcode='P0001';
  end if;
  select * into a from public.document_publication_attempts
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation for update;
  if not found or a.status <> 'staging' or a.expected_revision is distinct from p_revision
    or a.lease_token is distinct from p_lease or a.lease_expires_at <= clock_timestamp()
    or a.physical_collection is distinct from p_collection or a.manifest_digest is distinct from p_manifest_digest
    or cardinality(a.required_providers) not in (2,3)
    or (cardinality(a.required_providers)=3 and not ('neo4j'=any(a.required_providers)))
    or not (array['milvus','elasticsearch']::text[] <@ a.required_providers) then
    raise exception 'publication attempt unavailable' using errcode='P0001';
  end if;
  select * into asset from public.document_publication_assets
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation for share;
  if not found or asset.manifest_digest is distinct from a.manifest_digest
    or asset.content_version is distinct from a.content_version
    or asset.manifest_digest is distinct from 'sha256:' || encode(sha256(convert_to(asset.manifest_json,'UTF8')),'hex')
    or asset.content_version is distinct from 'sha256:' || encode(sha256(asset.source_identity_bytes),'hex') then
    raise exception 'publication source unavailable' using errcode='P0001';
  end if;
  manifest := asset.manifest_json::jsonb;
  source_data := manifest->'source';
  if manifest->>'profile' is distinct from 'rag-publication-asset/v1'
    or manifest->>'tenantId' is distinct from p_tenant or manifest->>'corpusId' is distinct from p_corpus
    or manifest->>'documentId' is distinct from p_document or manifest->>'contentVersion' is distinct from a.content_version
    or source_data->>'rawDigest' is distinct from 'sha256:' || encode(sha256(asset.source_bytes),'hex')
    or source_data->>'identityDigest' is distinct from a.content_version
    or coalesce(length(source_data->>'originalName') not between 1 and 512, true)
    or coalesce(length(source_data->>'contentType') not between 1 and 256, true)
    or coalesce(length(source_data->>'sourceKind') not between 1 and 64, true)
    or jsonb_typeof(manifest->'chunks') is distinct from 'array'
    or jsonb_array_length(manifest->'chunks') not between 1 and 1000 then
    raise exception 'publication manifest invalid' using errcode='P0001';
  end if;
  select * into op from public.elasticsearch_publication_operations
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation for share;
  if not found or op.state <> 'bound' or op.revision is distinct from p_revision
    or op.manifest_digest is distinct from a.manifest_digest or op.content_version is distinct from a.content_version
    or op.physical_collection is distinct from p_collection or op.index_uuid is null then
    raise exception 'publication Elasticsearch identity unavailable' using errcode='P0001';
  end if;
  select * into m from public.document_publication_provider_seals
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation and provider='milvus' for share;
  if not found or m.manifest_digest is distinct from a.manifest_digest or m.resource_name is distinct from p_collection
    or m.verification_profile is distinct from 'milvus-exclusive-strong-v1' then
    raise exception 'publication Milvus seal unavailable' using errcode='P0001';
  end if;
  select * into e from public.document_publication_provider_seals
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation and provider='elasticsearch' for share;
  if not found or e.manifest_digest is distinct from a.manifest_digest or e.resource_name is distinct from op.index_name
    or e.resource_id is distinct from op.index_uuid or e.verification_profile is distinct from 'elasticsearch-write-block-pit-v1' then
    raise exception 'publication Elasticsearch seal unavailable' using errcode='P0001';
  end if;
  if 'neo4j'=any(a.required_providers) then
    select * into g from public.document_graph_publication_seals
      where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation for share;
    if not found or g.manifest_digest is distinct from a.manifest_digest or g.content_version is distinct from a.content_version
      or not exists (select 1 from public.document_graph_dispatches d where d.graph_version=g.graph_version
        and d.tenant_id=p_tenant and d.corpus_id=p_corpus and d.document_id=p_document and d.generation=p_generation
        and d.manifest_digest=a.manifest_digest and d.content_version=a.content_version)
      or g.graph_manifest_digest is distinct from 'sha256:' || encode(sha256(convert_to(g.graph_manifest_json,'UTF8')),'hex')
      or jsonb_array_length(g.graph_manifest_json::jsonb->'passages') <> jsonb_array_length(manifest->'chunks') then
      raise exception 'publication Neo4j seal unavailable' using errcode='P0001';
    end if;
  end if;
  if jsonb_array_length(m.provider_manifest_json::jsonb) <> jsonb_array_length(manifest->'chunks')
    or jsonb_array_length(e.provider_manifest_json::jsonb) <> jsonb_array_length(manifest->'chunks')
    or exists (select 1 from jsonb_array_elements(m.provider_manifest_json::jsonb) with ordinality mm(value, n)
      join jsonb_array_elements(e.provider_manifest_json::jsonb) with ordinality ee(value, n) on mm.n=ee.n
      where mm.value->>'chunkId' is distinct from ee.value->>'chunkId') then
    raise exception 'publication provider manifests disagree' using errcode='P0001';
  end if;
  perform 1 from public.document_publication_asset_chunks c where c.tenant_id=p_tenant and c.corpus_id=p_corpus
    and c.document_id=p_document and c.generation=p_generation for share;
  if (select count(*) from public.document_publication_asset_chunks c where c.tenant_id=p_tenant and c.corpus_id=p_corpus
      and c.document_id=p_document and c.generation=p_generation) <> jsonb_array_length(manifest->'chunks') then
    raise exception 'publication chunk manifest incomplete' using errcode='P0001';
  end if;
  select (payload->>'descriptorJson')::jsonb into descriptor from public.document_publication_asset_chunks
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation and chunk_index=0;
  trust := descriptor->>'trustLevel';
  source_name := coalesce(nullif(descriptor->>'source',''), source_data->>'originalName');
  if trust not in ('trusted','reviewed','external','quarantined') or trust is null
    or exists (select 1 from public.document_publication_asset_chunks c where c.tenant_id=p_tenant and c.corpus_id=p_corpus
      and c.document_id=p_document and c.generation=p_generation
      and ((c.payload->>'descriptorJson')::jsonb->>'trustLevel') is distinct from trust) then
    raise exception 'publication trust scope inconsistent' using errcode='P0001';
  end if;
  select * into existing from public.document_assets
    where tenant_id=p_tenant and corpus_id=p_corpus and external_document_id=p_document for update;
  if found and (existing.metadata->>'retrieval_enabled' = 'false'
    or coalesce(existing.metadata->>'lifecycle','active') <> 'active') then
    raise exception 'publication source is not enabled' using errcode='P0001';
  end if;
  if existing.id is not null then
    -- Capture the pre-switch source pointers and all metadata before they are
    -- replaced. The row is held under lock and committed with the switch.
    insert into public.document_publication_prior_assets
      (tenant_id,corpus_id,document_id,generation,asset_snapshot)
    values (p_tenant,p_corpus,p_document,p_generation,to_jsonb(existing));
  end if;
  if a.lease_expires_at <= clock_timestamp() then raise exception 'publication lease expired' using errcode='P0001'; end if;
  -- Never silently deduplicate/delete a different document with the same
  -- content. The existing source_hash unique constraint makes that a conflict.
  insert into public.document_assets (tenant_id, corpus_id, external_document_id, original_name, content_type,
    byte_size, source_hash, raw_blob_filename, parsed_blob_filename, metadata)
  values (p_tenant,p_corpus,p_document,source_data->>'originalName',source_data->>'contentType',
    octet_length(asset.source_bytes),a.content_version,null,null,
    jsonb_build_object('source_kind',source_data->>'sourceKind','persistence_status','ready','retrieval_enabled',true,
      'lifecycle','active','chunks',jsonb_array_length(manifest->'chunks'),
      'document',jsonb_build_object('documentId',p_document,'documentVersion',a.content_version,'source',source_name,'trustLevel',trust)))
  on conflict (tenant_id,corpus_id,external_document_id) do update set
    original_name=excluded.original_name,content_type=excluded.content_type,byte_size=excluded.byte_size,
    source_hash=excluded.source_hash,raw_blob_filename=null,parsed_blob_filename=null,
    metadata=excluded.metadata,updated_at=clock_timestamp()
  where public.document_assets.metadata->>'retrieval_enabled' is distinct from 'false'
    and coalesce(public.document_assets.metadata->>'lifecycle','active')='active'
  returning id,xmin::text into result_asset,result_asset_revision;
  if result_asset is null or a.lease_expires_at <= clock_timestamp() then
    raise exception 'publication source changed or lease expired' using errcode='P0001';
  end if;
  update public.document_publication_attempts set status='published',lease_token=null,lease_expires_at=null,updated_at=clock_timestamp()
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation
      and status='staging' and lease_token=p_lease and lease_expires_at > clock_timestamp();
  if not found then raise exception 'publication attempt changed' using errcode='P0001'; end if;
  update public.document_publication_heads set active_generation=p_generation,revision=revision+1,updated_at=clock_timestamp()
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation and revision=p_revision and not revoked
    returning revision into next_revision;
  if not found then raise exception 'publication head changed' using errcode='P0001'; end if;
  insert into public.document_publication_receipts
    (tenant_id,corpus_id,document_id,generation,expected_revision,published_revision,manifest_digest,
      physical_collection,lease_digest,asset_id,asset_revision,content_version)
    values (p_tenant,p_corpus,p_document,p_generation,p_revision,next_revision,p_manifest_digest,p_collection,
      'sha256:' || encode(sha256(convert_to(p_lease::text,'UTF8')),'hex'),result_asset,result_asset_revision,a.content_version);
  return jsonb_build_object('tenantId',p_tenant,'corpusId',p_corpus,'documentId',p_document,
    'generation',p_generation::text,'revision',next_revision::text,'manifestDigest',p_manifest_digest,
    'physicalCollection',p_collection,'assetId',result_asset::text);
end;
$$;
revoke all on function public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text) from public;

-- Graph readers select per-document versions from the same active head as
-- text/vector readers, never from the legacy corpus-wide graph pointer.
create function public.rag_read_document_graph_view(tenant text, corpus text, trust text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare verified jsonb; result jsonb;
begin
  verified := public.rag_read_publication_view(tenant,corpus,trust);
  if exists (select 1 from jsonb_array_elements(verified->'documents') d
    join public.document_publication_attempts a on a.tenant_id=tenant and a.corpus_id=corpus
      and a.document_id=d->>'documentId' and a.generation=(d->>'generation')::bigint
    left join public.document_graph_publication_seals g on g.tenant_id=a.tenant_id and g.corpus_id=a.corpus_id
      and g.document_id=a.document_id and g.generation=a.generation
    where 'neo4j'=any(a.required_providers) and (g.graph_version is null
      or g.manifest_digest is distinct from a.manifest_digest or g.content_version is distinct from a.content_version)) then
    raise exception 'published graph unavailable' using errcode='P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('documentId',a.document_id,'generation',a.generation::text,
    'revision',d->>'revision','contentVersion',a.content_version,'manifestDigest',a.manifest_digest,
    'graphVersion',g.graph_version,'graphManifestJson',g.graph_manifest_json,
    'graphManifestDigest',g.graph_manifest_digest,'configurationDigest',g.configuration_digest,
    'evidenceDigest',g.evidence_digest) order by a.document_id),'[]'::jsonb) into result
  from jsonb_array_elements(verified->'documents') d
  join public.document_publication_attempts a on a.tenant_id=tenant and a.corpus_id=corpus
    and a.document_id=d->>'documentId' and a.generation=(d->>'generation')::bigint
  join public.document_graph_publication_seals g on g.tenant_id=a.tenant_id and g.corpus_id=a.corpus_id
    and g.document_id=a.document_id and g.generation=a.generation
  where 'neo4j'=any(a.required_providers);
  if octet_length(result::text)>25165824 then raise exception 'graph view capacity exceeded' using errcode='54000'; end if;
  return result;
end;
$$;
revoke all on function public.rag_read_document_graph_view(text,text,text[]) from public;

