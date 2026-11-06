-- Add compact authoritative source metadata without loading retained bytes.
-- Creation is the immutable source staging time; update is the last provider
-- verification time for this exact generation. All view filters stay unchanged.
create or replace function public.rag_read_publication_view(p_tenant text, p_corpus text, p_trust text[])
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
      'byteSize',octet_length(asset.source_bytes),'createdAt',asset.created_at,
      'updatedAt',greatest(asset.created_at,m.verified_at,e.verified_at),
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
