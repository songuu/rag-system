-- Provider seals can only be recorded by a separately provisioned trusted
-- publisher. It must read the complete staged asset under the valid lease,
-- recompute both provider manifests server-side and verify backend readback.
-- Never accept a manifest or digest from an HTTP client or general app role.
-- SQL checks root descriptor binding and identity, but does not reproduce the
-- JS float/vector/ES digest profile. A write acknowledgement or a point-in-time
-- readback alone is insufficient to mint a seal.
create table public.document_publication_provider_seals (
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  generation bigint not null,
  provider text not null,
  manifest_digest text not null,
  resource_name text not null,
  resource_id text not null,
  verification_profile text not null,
  configuration_digest text not null,
  evidence_digest text not null,
  provider_manifest_json text not null,
  provider_manifest_digest text not null,
  verified_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, corpus_id, document_id, generation, provider),
  foreign key (tenant_id, corpus_id, document_id, generation)
    references public.document_publication_attempts (tenant_id, corpus_id, document_id, generation) on delete cascade,
  check (provider in ('milvus','elasticsearch')),
  check ((provider = 'milvus' and verification_profile = 'milvus-exclusive-strong-v1')
      or (provider = 'elasticsearch' and verification_profile = 'elasticsearch-write-block-pit-v1')),
  check (manifest_digest ~ '^sha256:[0-9a-f]{64}$' and configuration_digest ~ '^sha256:[0-9a-f]{64}$'
    and evidence_digest ~ '^sha256:[0-9a-f]{64}$' and provider_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  check (octet_length(provider_manifest_json) between 2 and 4194304),
  check (length(resource_name) between 1 and 255 and length(resource_id) between 1 and 128)
);
revoke all on table public.document_publication_provider_seals from public;

-- This function is deliberately NOT granted to the application role. A
-- deployment must explicitly provision a separate, trusted publisher role
-- that authenticates the verifier and enforces backend write isolation.
create function public.rag_record_publication_seal(
  p_tenant text, p_corpus text, p_document text, p_generation bigint, p_revision bigint,
  p_lease uuid, p_collection text, p_provider text, p_resource_name text, p_resource_id text,
  p_profile text, p_configuration_digest text, p_evidence_digest text, p_provider_manifest text
) returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare
  h public.document_publication_heads%rowtype;
  a public.document_publication_attempts%rowtype;
  existing public.document_publication_provider_seals%rowtype;
  root_manifest jsonb;
  provider_manifest jsonb;
  expected_chunk jsonb;
  entry jsonb;
  descriptor_text text;
  descriptor jsonb;
  v_chunk_index integer;
  v_manifest_digest text;
begin
  select * into h from public.document_publication_heads
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document for update;
  if not found or h.revoked or h.generation is distinct from p_generation or h.revision is distinct from p_revision then
    raise exception 'publication seal head conflict' using errcode='P0001';
  end if;
  select * into a from public.document_publication_attempts
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation for update;
  if not found or a.expected_revision is distinct from p_revision or a.status <> 'staging'
    or a.lease_token is distinct from p_lease or a.lease_expires_at <= clock_timestamp()
    or a.physical_collection is distinct from p_collection or not (p_provider = any(a.required_providers))
    or p_configuration_digest is null or p_configuration_digest !~ '^sha256:[0-9a-f]{64}$'
    or p_evidence_digest is null or p_evidence_digest !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'publication seal attempt conflict' using errcode='P0001';
  end if;
  if p_provider = 'milvus' then
    if p_profile is distinct from 'milvus-exclusive-strong-v1' or p_resource_name is distinct from p_collection
      or p_resource_id is null or p_resource_id !~ '^[1-9][0-9]{0,18}$' then
      raise exception 'invalid Milvus seal' using errcode='22023';
    end if;
  elsif p_provider = 'elasticsearch' then
    if p_profile is distinct from 'elasticsearch-write-block-pit-v1' or not exists (
      select 1 from public.elasticsearch_publication_operations op
      where op.tenant_id=p_tenant and op.corpus_id=p_corpus and op.document_id=p_document
        and op.generation=p_generation and op.revision=p_revision and op.state='bound'
        and op.manifest_digest=a.manifest_digest and op.content_version=a.content_version
        and op.physical_collection=p_collection and op.index_name=p_resource_name and op.index_uuid=p_resource_id
    ) then raise exception 'invalid Elasticsearch seal' using errcode='22023'; end if;
  else raise exception 'invalid publication seal provider' using errcode='22023';
  end if;
  if p_provider_manifest is null or octet_length(p_provider_manifest) not between 2 and 4194304 then
    raise exception 'invalid provider manifest capacity' using errcode='22023';
  end if;
  provider_manifest := p_provider_manifest::jsonb;
  select asset.manifest_json::jsonb into root_manifest from public.document_publication_assets asset
    where asset.tenant_id=p_tenant and asset.corpus_id=p_corpus and asset.document_id=p_document
      and asset.generation=p_generation and asset.manifest_digest=a.manifest_digest and asset.content_version=a.content_version;
  if not found or jsonb_typeof(provider_manifest) <> 'array' or jsonb_typeof(root_manifest->'chunks') <> 'array'
    or jsonb_array_length(provider_manifest) < 1 or jsonb_array_length(provider_manifest) > 1000
    or jsonb_array_length(provider_manifest) <> jsonb_array_length(root_manifest->'chunks') then
    raise exception 'publication provider manifest unavailable' using errcode='P0001';
  end if;
  for v_chunk_index in 0..jsonb_array_length(provider_manifest)-1 loop
    entry := provider_manifest->v_chunk_index;
    expected_chunk := root_manifest->'chunks'->v_chunk_index;
    select c.payload->>'descriptorJson' into descriptor_text from public.document_publication_asset_chunks c
      where c.tenant_id=p_tenant and c.corpus_id=p_corpus and c.document_id=p_document
        and c.generation=p_generation and c.chunk_index=v_chunk_index;
    if descriptor_text is null then raise exception 'publication descriptor unavailable' using errcode='P0001'; end if;
    descriptor := descriptor_text::jsonb;
    if jsonb_typeof(entry) <> 'object' or (entry->>'chunkIndex') is distinct from v_chunk_index::text
      or expected_chunk->>'chunkIndex' is distinct from v_chunk_index::text
      or expected_chunk->>'descriptorDigest' is distinct from 'sha256:' || encode(sha256(convert_to(descriptor_text,'UTF8')),'hex')
      or entry->>'descriptorDigest' is distinct from expected_chunk->>'descriptorDigest'
      or descriptor->>'chunkIndex' is distinct from v_chunk_index::text
      or coalesce((entry->>'chunkId') !~ '^pub:[0-9a-f]{64}$', true) then
      raise exception 'publication provider manifest mismatch' using errcode='P0001';
    end if;
    if p_provider='milvus' then
      if entry->>'id' is distinct from entry->>'chunkId'
        or entry->>'chunkId' is distinct from 'pub:' || coalesce(entry->>'payloadDigest','')
        or coalesce((entry->>'payloadDigest') !~ '^[0-9a-f]{64}$', true)
        or entry->>'contentDigest' is distinct from substring(descriptor->>'contentDigest' from 8)
        or entry->>'trustLevel' is distinct from descriptor->>'trustLevel' then
        raise exception 'invalid Milvus provider manifest' using errcode='P0001';
      end if;
    elsif coalesce((entry->>'digest') !~ '^[0-9a-f]{64}$', true) then
      raise exception 'invalid Elasticsearch provider manifest' using errcode='P0001';
    end if;
  end loop;
  if (select count(distinct value->>'chunkId') from jsonb_array_elements(provider_manifest) value) <> jsonb_array_length(provider_manifest) then
    raise exception 'duplicate provider chunk' using errcode='P0001';
  end if;
  v_manifest_digest := 'sha256:' || encode(sha256(convert_to(p_provider_manifest,'UTF8')),'hex');
  insert into public.document_publication_provider_seals
    (tenant_id,corpus_id,document_id,generation,provider,manifest_digest,resource_name,resource_id,
     verification_profile,configuration_digest,evidence_digest,provider_manifest_json,provider_manifest_digest)
    values (p_tenant,p_corpus,p_document,p_generation,p_provider,a.manifest_digest,p_resource_name,p_resource_id,
      p_profile,p_configuration_digest,p_evidence_digest,p_provider_manifest,v_manifest_digest)
    on conflict (tenant_id,corpus_id,document_id,generation,provider) do nothing;
  select * into existing from public.document_publication_provider_seals
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document
      and generation=p_generation and provider=p_provider;
  if existing.manifest_digest is distinct from a.manifest_digest or existing.resource_name is distinct from p_resource_name
    or existing.resource_id is distinct from p_resource_id or existing.verification_profile is distinct from p_profile
    or existing.configuration_digest is distinct from p_configuration_digest or existing.evidence_digest is distinct from p_evidence_digest
    or existing.provider_manifest_json is distinct from p_provider_manifest or existing.provider_manifest_digest is distinct from v_manifest_digest
    or a.lease_expires_at <= clock_timestamp() then
    raise exception 'publication seal conflict or expired lease' using errcode='P0001';
  end if;
  return true;
end;
$$;
revoke all on function public.rag_record_publication_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text,text,text,text) from public;

-- One STABLE function call provides one PostgreSQL statement snapshot. This
-- is a server-internal read; request-context must authorize scope and trust.
create function public.rag_read_publication_view(p_tenant text, p_corpus text, p_trust text[])
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare
  v_count bigint;
  v_chunks bigint;
  v_bytes bigint;
  v_result jsonb;
begin
  if p_tenant is null or length(p_tenant) not between 1 and 128 or p_corpus is null
    or length(p_corpus) not between 1 and 128 or p_trust is null or cardinality(p_trust) not between 1 and 4
    or not (p_trust <@ array['trusted','reviewed','external','quarantined']::text[]) then
    raise exception 'invalid publication view scope' using errcode='22023';
  end if;
  -- Existing retrievable assets must not disappear silently merely because
  -- they have not yet been migrated into the publication control plane.
  if exists (select 1 from public.document_assets d
    left join public.document_publication_heads h on h.tenant_id=d.tenant_id and h.corpus_id=d.corpus_id
      and h.document_id=d.external_document_id
    where d.tenant_id=p_tenant and d.corpus_id=p_corpus and d.external_document_id is not null
      and d.metadata ? 'source_kind'
      and d.metadata->>'retrieval_enabled' is distinct from 'false' and coalesce(d.metadata->>'lifecycle','active')='active'
      and coalesce(nullif(d.metadata #>> '{document,trustLevel}',''),nullif(d.metadata #>> '{document,trust_level}',''),'external')=any(p_trust)
      and (h.document_id is null or (not h.revoked and
        (h.active_generation is null or d.metadata->>'persistence_status' is distinct from 'ready')))) then
    raise exception 'published view is not ready' using errcode='P0001';
  end if;
  -- Active pointers without their canonical asset cannot be silently omitted.
  if exists (select 1 from public.document_publication_heads h
    left join public.document_assets d on d.tenant_id=h.tenant_id and d.corpus_id=h.corpus_id and d.external_document_id=h.document_id
    where h.tenant_id=p_tenant and h.corpus_id=p_corpus and not h.revoked and h.active_generation is not null and d.id is null) then
    raise exception 'published source unavailable' using errcode='P0001';
  end if;
  if exists (
    select 1 from public.document_publication_heads h
    join public.document_assets d on d.tenant_id=h.tenant_id and d.corpus_id=h.corpus_id and d.external_document_id=h.document_id
    left join public.document_publication_attempts a on a.tenant_id=h.tenant_id and a.corpus_id=h.corpus_id
      and a.document_id=h.document_id and a.generation=h.active_generation
    left join public.document_publication_assets asset on asset.tenant_id=h.tenant_id and asset.corpus_id=h.corpus_id
      and asset.document_id=h.document_id and asset.generation=h.active_generation
    left join public.elasticsearch_publication_operations op on op.tenant_id=h.tenant_id and op.corpus_id=h.corpus_id
      and op.document_id=h.document_id and op.generation=h.active_generation
    left join public.document_publication_provider_seals m on m.tenant_id=h.tenant_id and m.corpus_id=h.corpus_id
      and m.document_id=h.document_id and m.generation=h.active_generation and m.provider='milvus'
    left join public.document_publication_provider_seals e on e.tenant_id=h.tenant_id and e.corpus_id=h.corpus_id
      and e.document_id=h.document_id and e.generation=h.active_generation and e.provider='elasticsearch'
    where h.tenant_id=p_tenant and h.corpus_id=p_corpus and not h.revoked and h.active_generation is not null
      and d.metadata ? 'source_kind' and d.metadata->>'persistence_status'='ready'
      and d.metadata->>'retrieval_enabled' is distinct from 'false' and coalesce(d.metadata->>'lifecycle','active')='active'
      and coalesce(nullif(d.metadata #>> '{document,trustLevel}',''),nullif(d.metadata #>> '{document,trust_level}',''),'external')=any(p_trust)
      and (a.status is distinct from 'published' or not (array['milvus','elasticsearch']::text[] <@ a.required_providers)
        or asset.manifest_digest is distinct from a.manifest_digest or asset.content_version is distinct from a.content_version
        or d.source_hash is distinct from a.content_version or op.state is distinct from 'bound'
        or op.revision is distinct from a.expected_revision or op.manifest_digest is distinct from a.manifest_digest or op.content_version is distinct from a.content_version
        or op.physical_collection is distinct from a.physical_collection
        or m.manifest_digest is distinct from a.manifest_digest or m.resource_name is distinct from a.physical_collection
        or e.manifest_digest is distinct from a.manifest_digest or e.resource_name is distinct from op.index_name
        or e.resource_id is distinct from op.index_uuid
        or exists (select 1 from public.document_publication_asset_chunks c
          where c.tenant_id=h.tenant_id and c.corpus_id=h.corpus_id and c.document_id=h.document_id and c.generation=h.active_generation
            and not coalesce(((c.payload->>'descriptorJson')::jsonb->>'trustLevel')=any(p_trust),false)))
  ) then raise exception 'publication view lacks matching verified seals' using errcode='P0001'; end if;

  select count(*), coalesce(sum(jsonb_array_length(asset.manifest_json::jsonb->'chunks')),0),
    coalesce(sum(octet_length(asset.manifest_json)+octet_length(m.provider_manifest_json)
      +octet_length(e.provider_manifest_json)+coalesce(chunks.bytes,0)),0)
  into v_count,v_chunks,v_bytes
  from public.document_publication_heads h
  join public.document_assets d on d.tenant_id=h.tenant_id and d.corpus_id=h.corpus_id and d.external_document_id=h.document_id
  join public.document_publication_assets asset on asset.tenant_id=h.tenant_id and asset.corpus_id=h.corpus_id
    and asset.document_id=h.document_id and asset.generation=h.active_generation
  join public.document_publication_provider_seals m on m.tenant_id=h.tenant_id and m.corpus_id=h.corpus_id
    and m.document_id=h.document_id and m.generation=h.active_generation and m.provider='milvus'
  join public.document_publication_provider_seals e on e.tenant_id=h.tenant_id and e.corpus_id=h.corpus_id
    and e.document_id=h.document_id and e.generation=h.active_generation and e.provider='elasticsearch'
  left join lateral (select sum(octet_length(c.payload->>'descriptorJson')) bytes from public.document_publication_asset_chunks c
    where c.tenant_id=h.tenant_id and c.corpus_id=h.corpus_id and c.document_id=h.document_id and c.generation=h.active_generation) chunks on true
  where h.tenant_id=p_tenant and h.corpus_id=p_corpus and not h.revoked and h.active_generation is not null
    and d.metadata ? 'source_kind' and d.metadata->>'persistence_status'='ready'
    and d.metadata->>'retrieval_enabled' is distinct from 'false' and coalesce(d.metadata->>'lifecycle','active')='active'
    and coalesce(nullif(d.metadata #>> '{document,trustLevel}',''),nullif(d.metadata #>> '{document,trust_level}',''),'external')=any(p_trust);
  -- This budget excludes retained source, chunk body, metadata and vectors.
  if v_count > 128 or v_chunks > 4096 or v_bytes > 25165824 then
    raise exception 'publication view capacity exceeded' using errcode='54000';
  end if;
  select jsonb_build_object('version',1,'tenantId',p_tenant,'corpusId',p_corpus,'documents',coalesce(jsonb_agg(
    jsonb_build_object('documentId',h.document_id,'generation',h.active_generation::text,'revision',h.revision::text,
      'assetId',d.id::text,'assetRevision',d.xmin::text,'contentVersion',asset.content_version,'manifestDigest',asset.manifest_digest,
      'manifestJson',asset.manifest_json,'descriptors',chunks.items,
      'milvusManifestJson',m.provider_manifest_json,'milvusManifestDigest',m.provider_manifest_digest,
      'elasticsearchManifestJson',e.provider_manifest_json,'elasticsearchManifestDigest',e.provider_manifest_digest,
      'collection',m.resource_name,'collectionId',m.resource_id,'milvusConfigurationDigest',m.configuration_digest,
      'milvusEvidenceDigest',m.evidence_digest,'milvusVerifiedAt',m.verified_at,
      'indexName',op.index_name,'indexUuid',op.index_uuid,'ownerMarker',op.owner_marker,
      'elasticsearchConfigurationDigest',e.configuration_digest,'elasticsearchEvidenceDigest',e.evidence_digest,
      'elasticsearchVerifiedAt',e.verified_at) order by h.document_id), '[]'::jsonb))
  into v_result
  from public.document_publication_heads h
  join public.document_assets d on d.tenant_id=h.tenant_id and d.corpus_id=h.corpus_id and d.external_document_id=h.document_id
  join public.document_publication_assets asset on asset.tenant_id=h.tenant_id and asset.corpus_id=h.corpus_id
    and asset.document_id=h.document_id and asset.generation=h.active_generation
  join public.elasticsearch_publication_operations op on op.tenant_id=h.tenant_id and op.corpus_id=h.corpus_id
    and op.document_id=h.document_id and op.generation=h.active_generation
  join public.document_publication_provider_seals m on m.tenant_id=h.tenant_id and m.corpus_id=h.corpus_id
    and m.document_id=h.document_id and m.generation=h.active_generation and m.provider='milvus'
  join public.document_publication_provider_seals e on e.tenant_id=h.tenant_id and e.corpus_id=h.corpus_id
    and e.document_id=h.document_id and e.generation=h.active_generation and e.provider='elasticsearch'
  left join lateral (select jsonb_agg(c.payload->>'descriptorJson' order by c.chunk_index) items from public.document_publication_asset_chunks c
    where c.tenant_id=h.tenant_id and c.corpus_id=h.corpus_id and c.document_id=h.document_id and c.generation=h.active_generation) chunks on true
  where h.tenant_id=p_tenant and h.corpus_id=p_corpus and not h.revoked and h.active_generation is not null
    and d.metadata ? 'source_kind' and d.metadata->>'persistence_status'='ready'
    and d.metadata->>'retrieval_enabled' is distinct from 'false' and coalesce(d.metadata->>'lifecycle','active')='active'
    and coalesce(nullif(d.metadata #>> '{document,trustLevel}',''),nullif(d.metadata #>> '{document,trust_level}',''),'external')=any(p_trust);
  return v_result;
end;
$$;
revoke all on function public.rag_read_publication_view(text,text,text[]) from public;

-- Source bytes are loaded only for one authorized document and exact view
-- identity. The caller revalidates the whole request view before and after IO.
create function public.rag_read_publication_source(
  p_tenant text, p_corpus text, p_document text, p_generation bigint, p_revision bigint,
  p_asset uuid, p_asset_revision text, p_trust text[], p_manifest_digest text
) returns table (source_bytes bytea, source_identity_bytes bytea)
language plpgsql stable security definer set search_path = pg_catalog as $$
declare
  stored public.document_publication_assets%rowtype;
  asset_manifest jsonb;
begin
  if p_trust is null or cardinality(p_trust) not between 1 and 4
    or not (p_trust <@ array['trusted','reviewed','external','quarantined']::text[])
    or p_manifest_digest is null or p_manifest_digest !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'invalid publication source request' using errcode='22023';
  end if;
  select asset.* into stored from public.document_publication_heads h
  join public.document_assets d on d.tenant_id=h.tenant_id and d.corpus_id=h.corpus_id and d.external_document_id=h.document_id
  join public.document_publication_attempts a on a.tenant_id=h.tenant_id and a.corpus_id=h.corpus_id
    and a.document_id=h.document_id and a.generation=h.active_generation
  join public.document_publication_assets asset on asset.tenant_id=h.tenant_id and asset.corpus_id=h.corpus_id
    and asset.document_id=h.document_id and asset.generation=h.active_generation
  join public.elasticsearch_publication_operations op on op.tenant_id=h.tenant_id and op.corpus_id=h.corpus_id
    and op.document_id=h.document_id and op.generation=h.active_generation
  join public.document_publication_provider_seals m on m.tenant_id=h.tenant_id and m.corpus_id=h.corpus_id
    and m.document_id=h.document_id and m.generation=h.active_generation and m.provider='milvus'
  join public.document_publication_provider_seals e on e.tenant_id=h.tenant_id and e.corpus_id=h.corpus_id
    and e.document_id=h.document_id and e.generation=h.active_generation and e.provider='elasticsearch'
  where h.tenant_id=p_tenant and h.corpus_id=p_corpus and h.document_id=p_document and not h.revoked
    and h.active_generation=p_generation and h.revision=p_revision and d.id=p_asset and d.xmin::text=p_asset_revision
    and d.metadata ? 'source_kind' and d.metadata->>'persistence_status'='ready'
    and d.metadata->>'retrieval_enabled' is distinct from 'false' and coalesce(d.metadata->>'lifecycle','active')='active'
    and coalesce(nullif(d.metadata #>> '{document,trustLevel}',''),nullif(d.metadata #>> '{document,trust_level}',''),'external')=any(p_trust)
    and a.status='published' and array['milvus','elasticsearch']::text[] <@ a.required_providers
    and asset.manifest_digest=a.manifest_digest and asset.manifest_digest=p_manifest_digest
    and asset.content_version=a.content_version and d.source_hash=a.content_version
    and op.state='bound' and op.revision=a.expected_revision and op.manifest_digest=a.manifest_digest
    and op.content_version=a.content_version and op.physical_collection=a.physical_collection
    and m.manifest_digest=a.manifest_digest and m.resource_name=a.physical_collection
    and e.manifest_digest=a.manifest_digest and e.resource_name=op.index_name and e.resource_id=op.index_uuid
    and not exists (select 1 from public.document_publication_asset_chunks c
      where c.tenant_id=h.tenant_id and c.corpus_id=h.corpus_id and c.document_id=h.document_id and c.generation=h.active_generation
        and not coalesce(((c.payload->>'descriptorJson')::jsonb->>'trustLevel')=any(p_trust),false));
  if not found then raise exception 'publication source unavailable or changed' using errcode='P0001'; end if;
  asset_manifest := stored.manifest_json::jsonb;
  if stored.manifest_digest is distinct from 'sha256:' || encode(sha256(convert_to(stored.manifest_json,'UTF8')),'hex')
    or asset_manifest->'source'->>'rawDigest' is distinct from 'sha256:' || encode(sha256(stored.source_bytes),'hex')
    or stored.content_version is distinct from 'sha256:' || encode(sha256(stored.source_identity_bytes),'hex') then
    raise exception 'publication source digest mismatch' using errcode='P0001';
  end if;
  return query select stored.source_bytes,stored.source_identity_bytes;
end;
$$;
revoke all on function public.rag_read_publication_source(text,text,text,bigint,bigint,uuid,text,text[],text) from public;
