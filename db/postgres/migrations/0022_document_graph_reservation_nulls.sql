-- SQL three-valued logic must not allow a missing revision to bypass the
-- lease-bound head check. Replace without modifying the applied 0021 ledger.
create or replace function public.rag_reserve_document_graph(
  tenant text, corpus text, document text, gen bigint, revision bigint,
  token uuid, graph text, content text, manifest text
) returns void language plpgsql security definer set search_path = pg_catalog as $$
declare h public.document_publication_heads%rowtype; a public.document_publication_attempts%rowtype;
begin
  if tenant is null or corpus is null or document is null or gen is null or revision is null
    or token is null or graph is null or content is null or manifest is null then
    raise exception 'invalid graph reservation' using errcode='22023';
  end if;
  select * into h from public.document_publication_heads
    where tenant_id=tenant and corpus_id=corpus and document_id=document for update;
  if not found or h.revoked or h.generation <> gen or h.revision <> revision then
    raise exception 'graph publication head unavailable' using errcode='P0001';
  end if;
  select * into a from public.document_publication_attempts
    where tenant_id=tenant and corpus_id=corpus and document_id=document and generation=gen for update;
  if not found or a.status <> 'staging' or a.expected_revision <> revision
    or a.lease_token is distinct from token or a.lease_expires_at <= clock_timestamp()
    or a.content_version is distinct from content or a.manifest_digest is distinct from manifest then
    raise exception 'graph publication lease unavailable' using errcode='P0001';
  end if;
  insert into public.document_graph_dispatches
    (tenant_id,corpus_id,document_id,generation,graph_version,content_version,manifest_digest)
    values (tenant,corpus,document,gen,graph,content,manifest);
end;
$$;
revoke all on function public.rag_reserve_document_graph(text,text,text,bigint,bigint,uuid,text,text,text) from public;
