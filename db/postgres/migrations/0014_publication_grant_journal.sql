-- Access identities are deterministic from the immutable operation intent.
-- Events are append-only and never contain credentials or lease tokens.
create table public.publication_grant_events (
  id bigint generated always as identity primary key,
  operation_id uuid not null references public.publication_operation_intents(operation_id),
  phase text not null check (phase ~ '^(started|unknown|observed-no-grants|revoke:(CollectionReadWrite|CreateIndex|Load)|revoked:(CollectionReadWrite|CreateIndex|Load))$'),
  created_at timestamptz not null default clock_timestamp()
);
revoke all on public.publication_grant_events from public;

create function public.rag_read_publication_grant_identity(operation uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare collection text;
begin
  select physical_collection into collection from public.publication_operation_intents where operation_id = operation;
  if not found then raise exception 'publication grant identity unavailable' using errcode = 'P0001'; end if;
  return jsonb_build_object('collection', collection, 'username', 'pgu_' || right(collection, 24), 'role', 'pgr_' || right(collection, 24));
end;
$$;
revoke all on function public.rag_read_publication_grant_identity(uuid) from public;

create function public.rag_record_publication_grant_event(operation uuid, event_phase text)
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  insert into public.publication_grant_events(operation_id, phase) values (operation, event_phase);
end;
$$;
revoke all on function public.rag_record_publication_grant_event(uuid,text) from public;
