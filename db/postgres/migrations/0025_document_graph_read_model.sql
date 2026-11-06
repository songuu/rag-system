-- The app reads the verifier's digest-bound graph projection from PostgreSQL;
-- it never receives the Neo4j management credential.
alter table public.document_graph_publication_seals add column snapshot_json text;
alter table public.document_graph_publication_seals add constraint graph_snapshot_capacity
  check(snapshot_json is null or octet_length(snapshot_json) between 2 and 4194304);

create function public.rag_record_document_graph_seal(
  tenant text, corpus text, document text, gen bigint, revision bigint, token uuid,
  graph text, configuration text, evidence text, manifest text, snapshot text
) returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare payload jsonb; header jsonb; snapshot_hash text;
begin
  if snapshot is null or octet_length(snapshot) not between 2 and 4194304 then
    raise exception 'invalid graph snapshot' using errcode='22023';
  end if;
  payload := snapshot::jsonb;
  if jsonb_typeof(payload) is distinct from 'array' or jsonb_array_length(payload) <> 6 then
    raise exception 'invalid graph snapshot structure' using errcode='22023';
  end if;
  header := payload->0;
  snapshot_hash := 'sha256:' || encode(sha256(convert_to(snapshot,'UTF8')),'hex');
  if header->>'tenantId' is distinct from tenant or header->>'corpusId' is distinct from corpus
    or header->>'graphVersion' is distinct from graph or header->>'graphId' is distinct from graph
    or manifest is null or manifest::jsonb->>'snapshotDigest' is distinct from snapshot_hash then
    raise exception 'graph snapshot binding mismatch' using errcode='P0001';
  end if;
  perform public.rag_record_document_graph_seal(tenant,corpus,document,gen,revision,token,graph,configuration,evidence,manifest);
  update public.document_graph_publication_seals g set snapshot_json=snapshot
    where g.tenant_id=tenant and g.corpus_id=corpus and g.document_id=document and g.generation=gen
      and (g.snapshot_json is null or g.snapshot_json=snapshot);
  if not found then raise exception 'graph snapshot changed' using errcode='P0001'; end if;
  return true;
end;
$$;
revoke all on function public.rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text) from public;

create function public.rag_require_published_graph_snapshot()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.status='published' and old.status is distinct from 'published' and 'neo4j'=any(new.required_providers)
    and not exists(select 1 from public.document_graph_publication_seals g
      where g.tenant_id=new.tenant_id and g.corpus_id=new.corpus_id and g.document_id=new.document_id and g.generation=new.generation
        and g.snapshot_json is not null and g.graph_manifest_json::jsonb->>'snapshotDigest'
          = 'sha256:' || encode(sha256(convert_to(g.snapshot_json,'UTF8')),'hex')) then
    raise exception 'verified graph snapshot unavailable' using errcode='P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.rag_require_published_graph_snapshot() from public;
create trigger require_published_graph_snapshot before update of status on public.document_publication_attempts
for each row execute function public.rag_require_published_graph_snapshot();

create function public.rag_read_document_graph_snapshot(tenant text, corpus text, document text, trust text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare allowed jsonb; result jsonb;
begin
  allowed := public.rag_read_document_graph_view(tenant,corpus,trust);
  select d || jsonb_build_object('snapshotJson',g.snapshot_json) into result
    from jsonb_array_elements(allowed) d
    join public.document_graph_publication_seals g on g.tenant_id=tenant and g.corpus_id=corpus
      and g.document_id=document and g.generation=(d->>'generation')::bigint
    where d->>'documentId'=document and g.snapshot_json is not null;
  return result;
end;
$$;
revoke all on function public.rag_read_document_graph_snapshot(text,text,text,text[]) from public;
