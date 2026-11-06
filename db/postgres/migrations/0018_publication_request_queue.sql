-- Requests are immutable snapshots; their presence never implies publication.
-- Scope is authorized by the application before calling these functions.
create table public.publication_requests (
  request_id uuid primary key,
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  manifest_json text not null,
  source_bytes bytea not null,
  source_identity_bytes bytea not null,
  chunks_json jsonb not null,
  state text not null default 'queued' check (state in ('queued','claimed')),
  created_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  check (length(tenant_id) between 1 and 128 and tenant_id = btrim(tenant_id)),
  check (length(corpus_id) between 1 and 128 and corpus_id = btrim(corpus_id)),
  check (length(document_id) between 1 and 256 and document_id = btrim(document_id)),
  check (octet_length(manifest_json) between 1 and 262144),
  check (octet_length(source_bytes) between 1 and 33554432),
  check (octet_length(source_identity_bytes) between 1 and 33554432),
  check (jsonb_typeof(chunks_json) = 'array' and octet_length(chunks_json::text) <= 12582912),
  foreign key (tenant_id, corpus_id) references public.corpora (tenant_id, id)
);
revoke all on public.publication_requests from public;

create function public.rag_enqueue_publication_request(
  p_request uuid, p_tenant text, p_corpus text, p_document text,
  p_manifest text, p_source bytea, p_identity bytea, p_chunks jsonb
) returns void language plpgsql security definer set search_path = pg_catalog as $$
declare v_manifest jsonb;
begin
  if p_request is null or p_tenant is null or p_corpus is null or p_document is null
    or p_manifest is null or p_source is null or p_identity is null or p_chunks is null then
    raise exception 'invalid publication request' using errcode = '22023';
  end if;
  v_manifest := p_manifest::jsonb;
  if v_manifest->>'profile' is distinct from 'rag-publication-asset/v1'
    or v_manifest->>'tenantId' is distinct from p_tenant
    or v_manifest->>'corpusId' is distinct from p_corpus
    or v_manifest->>'documentId' is distinct from p_document
    or v_manifest #>> '{source,rawDigest}' is distinct from 'sha256:' || encode(sha256(p_source), 'hex')
    or v_manifest #>> '{source,identityDigest}' is distinct from 'sha256:' || encode(sha256(p_identity), 'hex')
    or v_manifest->>'contentVersion' is distinct from 'sha256:' || encode(sha256(p_identity), 'hex')
    or jsonb_typeof(p_chunks) is distinct from 'array'
    or jsonb_array_length(p_chunks) not between 1 and 1000 then
    raise exception 'publication request identity mismatch' using errcode = '22023';
  end if;
  insert into public.publication_requests (request_id,tenant_id,corpus_id,document_id,manifest_json,source_bytes,source_identity_bytes,chunks_json)
    values (p_request,p_tenant,p_corpus,p_document,p_manifest,p_source,p_identity,p_chunks)
    on conflict (request_id) do nothing;
  if not exists (select 1 from public.publication_requests r where r.request_id=p_request
    and r.tenant_id=p_tenant and r.corpus_id=p_corpus and r.document_id=p_document
    and r.manifest_json=p_manifest and r.source_bytes=p_source and r.source_identity_bytes=p_identity and r.chunks_json=p_chunks) then
    raise exception 'publication request conflict' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.rag_enqueue_publication_request(uuid,text,text,text,text,bytea,bytea,jsonb) from public;

-- Claim is deliberately one-shot. A lost response is unknown; the same
-- request is never automatically redelivered to a second publisher.
create function public.rag_claim_publication_request() returns table (
  request_id uuid, tenant_id text, corpus_id text, document_id text, manifest_json text,
  source_bytes bytea, source_identity_bytes bytea, chunks_json jsonb
) language plpgsql security definer set search_path = pg_catalog as $$
begin
  return query with candidate as (
    select r.request_id from public.publication_requests r where r.state='queued'
    order by r.created_at,r.request_id for update skip locked limit 1
  ) update public.publication_requests r set state='claimed',claimed_at=clock_timestamp()
    from candidate c where r.request_id=c.request_id
    returning r.request_id,r.tenant_id,r.corpus_id,r.document_id,r.manifest_json,r.source_bytes,r.source_identity_bytes,r.chunks_json;
end;
$$;
revoke all on function public.rag_claim_publication_request() from public;

create function public.rag_read_publication_request_state(p_request uuid,p_tenant text,p_corpus text,p_document text)
returns text language sql stable security definer set search_path=pg_catalog as $$
  select r.state from public.publication_requests r where r.request_id=p_request
    and r.tenant_id=p_tenant and r.corpus_id=p_corpus and r.document_id=p_document
$$;
revoke all on function public.rag_read_publication_request_state(uuid,text,text,text) from public;
