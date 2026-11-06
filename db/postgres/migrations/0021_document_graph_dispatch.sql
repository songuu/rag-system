-- A graph name may not be reused even if the caller loses the reserve response
-- or a previously sent Neo4j request completes after lease expiry.
create table public.document_graph_dispatches (
  tenant_id text not null, corpus_id text not null, document_id text not null,
  generation bigint not null, graph_version text not null primary key,
  content_version text not null, manifest_digest text not null,
  reserved_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, corpus_id, document_id, generation),
  check (generation > 0),
  check (graph_version ~ '^doc-generation-[a-f0-9]{64}$'),
  check (content_version ~ '^sha256:[a-f0-9]{64}$'),
  check (manifest_digest ~ '^sha256:[a-f0-9]{64}$')
);
revoke all on public.document_graph_dispatches from public;

-- The publisher authenticates the tenant. Only its dedicated role may call
-- this function. No lease token or mutable lifecycle status is stored here.
create function public.rag_reserve_document_graph(
  tenant text, corpus text, document text, gen bigint, revision bigint,
  token uuid, graph text, content text, manifest text
) returns void language plpgsql security definer set search_path = pg_catalog as $$
declare h public.document_publication_heads%rowtype; a public.document_publication_attempts%rowtype;
begin
  select * into h from public.document_publication_heads
    where tenant_id=tenant and corpus_id=corpus and document_id=document for update;
  if not found or h.revoked or h.generation <> gen or h.revision <> revision then
    raise exception 'graph publication head unavailable' using errcode='P0001';
  end if;
  select * into a from public.document_publication_attempts
    where tenant_id=tenant and corpus_id=corpus and document_id=document and generation=gen for update;
  if not found or a.status <> 'staging' or a.expected_revision <> revision or token is null
    or a.lease_token <> token or a.lease_expires_at <= clock_timestamp()
    or a.content_version is distinct from content or a.manifest_digest is distinct from manifest then
    raise exception 'graph publication lease unavailable' using errcode='P0001';
  end if;
  -- Deliberately no ON CONFLICT: an uncertain prior result is never retried.
  insert into public.document_graph_dispatches
    (tenant_id,corpus_id,document_id,generation,graph_version,content_version,manifest_digest)
    values (tenant,corpus,document,gen,graph,content,manifest);
end;
$$;
revoke all on function public.rag_reserve_document_graph(text,text,text,bigint,bigint,uuid,text,text,text) from public;
