-- Preserve snapshots and block corpus deletion until an explicit retention
-- policy exists. Unknown claims are never recycled or automatically deleted.
alter table public.publication_requests add column operation_id uuid;
create unique index publication_requests_operation_unique on public.publication_requests(operation_id) where operation_id is not null;
create index publication_requests_queued_order on public.publication_requests(created_at, request_id) where state = 'queued';
create index publication_requests_claimed_discovery on public.publication_requests(request_id) where state = 'claimed';

-- Remove the older entry point, including any grants, so every new claim is
-- bound to an identity known by its caller before the remote transaction.
drop function public.rag_claim_publication_request();
create function public.rag_claim_publication_request(p_operation uuid) returns table (
  request_id uuid, tenant_id text, corpus_id text, document_id text, manifest_json text,
  source_bytes bytea, source_identity_bytes bytea, chunks_json jsonb
) language plpgsql security definer set search_path=pg_catalog as $$
begin
  if p_operation is null then raise exception 'invalid operation identity' using errcode='22023'; end if;
  -- A repeated operation must not claim another request. A concurrent repeat
  -- is also stopped by the unique index even if both see no committed row.
  if exists(select 1 from public.publication_requests r where r.operation_id=p_operation) then
    raise exception 'operation already claimed; inspect outcome' using errcode='P0001';
  end if;
  return query with candidate as (
    select r.request_id from public.publication_requests r where r.state='queued'
    order by r.created_at,r.request_id for update skip locked limit 1
  ) update public.publication_requests r set state='claimed', claimed_at=clock_timestamp(), operation_id=p_operation
    from candidate c where r.request_id=c.request_id
    returning r.request_id,r.tenant_id,r.corpus_id,r.document_id,r.manifest_json,r.source_bytes,r.source_identity_bytes,r.chunks_json;
end;
$$;
revoke all on function public.rag_claim_publication_request(uuid) from public;

-- No source bytes, credentials or lease tokens are returned by inspection.
create function public.rag_inspect_publication_claim(p_operation uuid)
returns table(request_id uuid, operation_id uuid, tenant_id text, corpus_id text, document_id text, claimed_at timestamptz)
language sql stable security definer set search_path=pg_catalog as $$
  select r.request_id,r.operation_id,r.tenant_id,r.corpus_id,r.document_id,r.claimed_at
    from public.publication_requests r where r.operation_id=p_operation and r.state='claimed'
$$;
revoke all on function public.rag_inspect_publication_claim(uuid) from public;

-- Repeat full scans: a lower UUID may commit after a cursor has passed it.
-- Null operation_id identifies a legacy 0018 claim that needs manual review.
create function public.rag_list_publication_claims(p_after uuid,p_limit integer)
returns table(request_id uuid, operation_id uuid, tenant_id text, corpus_id text, document_id text, claimed_at timestamptz)
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'invalid page limit' using errcode='22023'; end if;
  return query select r.request_id,r.operation_id,r.tenant_id,r.corpus_id,r.document_id,r.claimed_at
    from public.publication_requests r where r.state='claimed' and (p_after is null or r.request_id>p_after)
    order by r.request_id limit p_limit;
end;
$$;
revoke all on function public.rag_list_publication_claims(uuid,integer) from public;
