-- Milvus limits names to 32 characters, so the chosen role uses only the last
-- 24 hex characters. Reserve that derived identity permanently across intents.
-- Existing collisions stop migration for explicit operator reconciliation.
create unique index publication_operation_intents_grant_suffix_unique
  on public.publication_operation_intents ((right(physical_collection, 24)));

-- Trusted recovery administrator only. Complete scans must repeat because new
-- UUIDs may sort before a previous cursor; absence is not a terminal state.
create function public.rag_list_all_publication_intents(after_id uuid, page_size integer)
returns table(operation_id uuid, tenant_id text, corpus_id text, document_id text)
language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if page_size is null or page_size < 1 or page_size > 100 then
    raise exception 'invalid recovery page' using errcode = '22023';
  end if;
  return query select i.operation_id, i.tenant_id, i.corpus_id, i.document_id
    from public.publication_operation_intents i
    where after_id is null or i.operation_id > after_id
    order by i.operation_id limit page_size;
end;
$$;
revoke all on function public.rag_list_all_publication_intents(uuid,integer) from public;

create function public.rag_list_publication_grant_events(operation uuid, after_event bigint, page_size integer)
returns table(event_id bigint, phase text, created_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if operation is null or after_event is null or after_event < 0 or page_size is null or page_size < 1 or page_size > 100 then
    raise exception 'invalid grant event page' using errcode = '22023';
  end if;
  if not exists (select 1 from public.publication_operation_intents where operation_id = operation) then
    raise exception 'publication operation unavailable' using errcode = 'P0001';
  end if;
  return query select e.id, e.phase, e.created_at from public.publication_grant_events e
    where e.operation_id = operation and e.id > after_event order by e.id limit page_size;
end;
$$;
revoke all on function public.rag_list_publication_grant_events(uuid,bigint,integer) from public;
