-- Each source and manifest belongs to a unique immutable publication attempt.
-- A staged asset is not an active publication; only a separately verified,
-- atomic publication transition may expose it through a trusted read view.
create table public.document_publication_assets (
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  generation bigint not null,
  content_version text not null,
  manifest_digest text not null,
  manifest_json text not null,
  source_bytes bytea not null,
  source_identity_bytes bytea not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, corpus_id, document_id, generation),
  foreign key (tenant_id, corpus_id, document_id, generation)
    references public.document_publication_attempts (tenant_id, corpus_id, document_id, generation)
    on delete cascade,
  check (content_version ~ '^sha256:[0-9a-f]{64}$'),
  check (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  check (octet_length(manifest_json) between 1 and 262144),
  check (octet_length(source_bytes) between 1 and 33554432),
  check (octet_length(source_identity_bytes) between 1 and 33554432)
);

-- The root manifest stores hashes; this table retains the exact content and
-- float32 bytes needed to reconstruct and verify each provider's generation.
create table public.document_publication_asset_chunks (
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  generation bigint not null,
  chunk_index integer not null,
  payload jsonb not null,
  primary key (tenant_id, corpus_id, document_id, generation, chunk_index),
  foreign key (tenant_id, corpus_id, document_id, generation)
    references public.document_publication_assets (tenant_id, corpus_id, document_id, generation)
    on delete cascade,
  check (chunk_index >= 0 and chunk_index < 1000),
  check (jsonb_typeof(payload) = 'object')
);

-- Assets can be removed by authorized lifecycle cleanup, but never rewritten
-- under an existing generation. The application role must not own this table.
create function public.rag_keep_publication_asset_immutable()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'publication asset cannot be modified' using errcode = '23514';
end;
$$;
revoke all on function public.rag_keep_publication_asset_immutable() from public;
create trigger document_publication_asset_immutable
before update on public.document_publication_assets
for each row execute function public.rag_keep_publication_asset_immutable();
create trigger document_publication_chunk_immutable
before update on public.document_publication_asset_chunks
for each row execute function public.rag_keep_publication_asset_immutable();

-- Scope is authorized by the trusted application request-context. The caller
-- must not receive table DML; its dedicated role gets only EXECUTE on this
-- function. The function owner must not be the application role, and the app
-- must not have CREATE privilege on public or the ability to alter the function.
create function public.rag_stage_publication_asset(
  p_tenant text, p_corpus text, p_document text, p_generation bigint, p_revision bigint,
  p_lease uuid, p_collection text, p_content_version text, p_manifest text,
  p_source bytea, p_source_identity bytea, p_chunks jsonb
) returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare
  h public.document_publication_heads%rowtype;
  a public.document_publication_attempts%rowtype;
  payload jsonb;
  computed_manifest text;
  computed_content text;
  computed_raw text;
  expected_chunk jsonb;
  actual_chunk jsonb;
  descriptor jsonb;
  v_chunk_index integer;
  vector_bytes bytea;
  dimension integer;
begin
  if p_tenant is null or p_corpus is null or p_document is null or p_generation is null or p_generation < 1
    or p_revision is null or p_revision < 1 or p_lease is null or p_collection is null
    or p_content_version is null or p_content_version !~ '^sha256:[0-9a-f]{64}$'
    or p_manifest is null or octet_length(p_manifest) not between 1 and 262144
    or p_source is null or octet_length(p_source) not between 1 and 33554432
    or p_source_identity is null or octet_length(p_source_identity) not between 1 and 33554432
    or p_chunks is null or jsonb_typeof(p_chunks) <> 'array' or octet_length(p_chunks::text) > 12582912 then
    raise exception 'invalid publication asset' using errcode = '22023';
  end if;
  computed_manifest := 'sha256:' || encode(sha256(convert_to(p_manifest, 'UTF8')), 'hex');
  computed_content := 'sha256:' || encode(sha256(p_source_identity), 'hex');
  computed_raw := 'sha256:' || encode(sha256(p_source), 'hex');
  payload := p_manifest::jsonb;
  if jsonb_typeof(payload) <> 'object' or payload->>'profile' is distinct from 'rag-publication-asset/v1'
    or payload->>'tenantId' is distinct from p_tenant or payload->>'corpusId' is distinct from p_corpus
    or payload->>'documentId' is distinct from p_document or payload->>'contentVersion' is distinct from p_content_version
    or payload #>> '{source,identityDigest}' is distinct from computed_content
    or payload #>> '{source,rawDigest}' is distinct from computed_raw or computed_content <> p_content_version then
    raise exception 'publication asset digest mismatch' using errcode = '22023';
  end if;
  if jsonb_typeof(payload->'chunks') is distinct from 'array'
    or jsonb_array_length(payload->'chunks') not between 1 and 1000
    or jsonb_array_length(payload->'chunks') <> jsonb_array_length(p_chunks)
    or coalesce(payload #>> '{embedding,dimension}', '') !~ '^[1-9][0-9]{0,4}$' then
    raise exception 'invalid publication chunk manifest' using errcode = '22023';
  end if;
  dimension := (payload #>> '{embedding,dimension}')::integer;
  if dimension > 65536 or dimension::bigint * 4 * jsonb_array_length(p_chunks) > 8388608 then
    raise exception 'publication vector capacity exceeded' using errcode = '22023';
  end if;

  -- Match the lock order of rag_publication_control to serialize a staging
  -- write with revoke, superseding begin, and lease transitions.
  select * into h from public.document_publication_heads
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document for update;
  -- A new generation may be staged after a revoke while visibility remains
  -- revoked. Its revision changes only on a future verified publication.
  if not found or h.generation <> p_generation or h.revision <> p_revision then
    raise exception 'publication asset head conflict' using errcode = 'P0001';
  end if;
  select * into a from public.document_publication_attempts
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation for update;
  if not found or a.expected_revision <> p_revision or a.status <> 'staging'
    or a.lease_token is distinct from p_lease or a.lease_expires_at <= clock_timestamp()
    or a.physical_collection is distinct from p_collection or a.content_version is distinct from p_content_version
    or a.manifest_digest is distinct from computed_manifest then
    raise exception 'publication asset attempt conflict' using errcode = 'P0001';
  end if;

  insert into public.document_publication_assets (tenant_id, corpus_id, document_id, generation,
    content_version, manifest_digest, manifest_json, source_bytes, source_identity_bytes)
  values (p_tenant, p_corpus, p_document, p_generation, p_content_version, computed_manifest,
    p_manifest, p_source, p_source_identity)
  on conflict (tenant_id, corpus_id, document_id, generation) do nothing;
  if not exists (select 1 from public.document_publication_assets
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation
      and content_version=p_content_version and manifest_digest=computed_manifest and manifest_json=p_manifest
      and source_bytes=p_source and source_identity_bytes=p_source_identity) then
    raise exception 'publication asset conflict' using errcode = 'P0001';
  end if;
  for v_chunk_index in 0..jsonb_array_length(p_chunks)-1 loop
    expected_chunk := payload->'chunks'->v_chunk_index;
    actual_chunk := p_chunks->v_chunk_index;
    if jsonb_typeof(expected_chunk) is distinct from 'object' or jsonb_typeof(actual_chunk) is distinct from 'object'
      or actual_chunk - array['chunkIndex','content','embeddingBase64','metadataJson','descriptorJson']::text[] <> '{}'::jsonb
      or expected_chunk->>'chunkIndex' is distinct from v_chunk_index::text
      or actual_chunk->>'chunkIndex' is distinct from v_chunk_index::text
      or jsonb_typeof(actual_chunk->'content') is distinct from 'string'
      or octet_length(actual_chunk->>'content') not between 1 and 65000
      or jsonb_typeof(actual_chunk->'embeddingBase64') is distinct from 'string'
      or jsonb_typeof(actual_chunk->'metadataJson') is distinct from 'string'
      or jsonb_typeof(actual_chunk->'descriptorJson') is distinct from 'string'
      or jsonb_typeof((actual_chunk->>'metadataJson')::jsonb) is distinct from 'object' then
      raise exception 'invalid publication chunk' using errcode = '22023';
    end if;
    descriptor := (actual_chunk->>'descriptorJson')::jsonb;
    vector_bytes := decode(actual_chunk->>'embeddingBase64', 'base64');
    if jsonb_typeof(descriptor) is distinct from 'object'
      or descriptor->>'chunkIndex' is distinct from v_chunk_index::text
      or expected_chunk->>'descriptorDigest' is distinct from 'sha256:' || encode(sha256(convert_to(actual_chunk->>'descriptorJson', 'UTF8')), 'hex')
      or octet_length(vector_bytes) <> dimension * 4
      or descriptor->>'contentDigest' is distinct from 'sha256:' || encode(sha256(convert_to(actual_chunk->>'content', 'UTF8')), 'hex')
      or descriptor->>'embeddingDigest' is distinct from 'sha256:' || encode(sha256(vector_bytes), 'hex')
      or descriptor->>'metadataDigest' is distinct from 'sha256:' || encode(sha256(convert_to(actual_chunk->>'metadataJson', 'UTF8')), 'hex') then
      raise exception 'publication chunk digest mismatch' using errcode = '22023';
    end if;
    insert into public.document_publication_asset_chunks (tenant_id, corpus_id, document_id, generation, chunk_index, payload)
      values (p_tenant, p_corpus, p_document, p_generation, v_chunk_index, actual_chunk)
      on conflict (tenant_id, corpus_id, document_id, generation, chunk_index) do nothing;
    if not exists (select 1 from public.document_publication_asset_chunks stored
      where stored.tenant_id=p_tenant and stored.corpus_id=p_corpus and stored.document_id=p_document
        and stored.generation=p_generation and stored.chunk_index=v_chunk_index and stored.payload=actual_chunk) then
      raise exception 'publication chunk conflict' using errcode = 'P0001';
    end if;
  end loop;
  if a.lease_expires_at <= clock_timestamp() then
    raise exception 'publication asset lease expired' using errcode = 'P0001';
  end if;
  return true;
end;
$$;

-- Source retrieval for a staging worker is deliberately limited to its exact
-- active lease. Published reads require a separate authorized publication view.
create function public.rag_read_staged_publication_asset(
  p_tenant text, p_corpus text, p_document text, p_generation bigint, p_revision bigint,
  p_lease uuid, p_collection text
) returns table (content_version text, manifest_digest text, manifest_json text,
                 source_bytes bytea, source_identity_bytes bytea, chunks_json jsonb)
language plpgsql security definer set search_path = pg_catalog as $$
declare
  h public.document_publication_heads%rowtype;
  a public.document_publication_attempts%rowtype;
  stored public.document_publication_assets%rowtype;
  result_chunks jsonb;
begin
  select * into h from public.document_publication_heads
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document for update;
  if not found or h.generation is distinct from p_generation or h.revision is distinct from p_revision then
    raise exception 'publication asset head conflict' using errcode = 'P0001';
  end if;
  select * into a from public.document_publication_attempts
    where tenant_id=p_tenant and corpus_id=p_corpus and document_id=p_document and generation=p_generation for update;
  if not found or a.expected_revision is distinct from p_revision or a.status <> 'staging'
    or a.lease_token is distinct from p_lease or a.lease_expires_at <= clock_timestamp()
    or a.physical_collection is distinct from p_collection then
    raise exception 'publication asset attempt conflict' using errcode = 'P0001';
  end if;
  select * into stored from public.document_publication_assets asset
    where asset.tenant_id=p_tenant and asset.corpus_id=p_corpus and asset.document_id=p_document
      and asset.generation=p_generation and asset.manifest_digest=a.manifest_digest and asset.content_version=a.content_version;
  if not found then raise exception 'publication asset unavailable' using errcode = 'P0001'; end if;
  select jsonb_agg(chunk.payload order by chunk.chunk_index) into result_chunks
    from public.document_publication_asset_chunks chunk
    where chunk.tenant_id=p_tenant and chunk.corpus_id=p_corpus and chunk.document_id=p_document and chunk.generation=p_generation;
  if result_chunks is null or jsonb_array_length(result_chunks) <> jsonb_array_length((stored.manifest_json::jsonb)->'chunks')
    or a.lease_expires_at <= clock_timestamp() then
    raise exception 'publication asset incomplete or lease expired' using errcode = 'P0001';
  end if;
  return query select stored.content_version, stored.manifest_digest, stored.manifest_json,
    stored.source_bytes, stored.source_identity_bytes, result_chunks;
end;
$$;
revoke all on table public.document_publication_assets from public;
revoke all on table public.document_publication_asset_chunks from public;
revoke all on function public.rag_stage_publication_asset(text,text,text,bigint,bigint,uuid,text,text,text,bytea,bytea,jsonb) from public;
revoke all on function public.rag_read_staged_publication_asset(text,text,text,bigint,bigint,uuid,text) from public;
