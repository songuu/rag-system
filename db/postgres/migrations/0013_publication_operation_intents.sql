-- Durable before begin: an unknown result is never evidence that begin failed.
-- Intents outlive tenant deletion so physical identities are never recycled.
create table public.publication_operation_intents (
  operation_id uuid primary key,
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  content_version text not null,
  manifest_digest text not null,
  physical_collection text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  check (length(tenant_id) between 1 and 128 and tenant_id = btrim(tenant_id)),
  check (length(corpus_id) between 1 and 128 and corpus_id = btrim(corpus_id)),
  check (length(document_id) between 1 and 256 and document_id = btrim(document_id)),
  check (content_version ~ '^sha256:[0-9a-f]{64}$'),
  check (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  check (physical_collection ~ '^rag_publication_[0-9a-f]{32}$')
);
revoke all on public.publication_operation_intents from public;

-- Only a trusted publisher gets EXECUTE. Scope must be authenticated by the
-- service; an HTTP caller must not directly provide these function arguments.
create function public.rag_prepare_publication_intent(
  operation uuid, tenant text, corpus text, document text, content text, manifest text, collection text
) returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  if operation is null or tenant is null or corpus is null or document is null
    or content is null or manifest is null or collection is null then
    raise exception 'invalid operation intent' using errcode = '22023';
  end if;
  insert into public.publication_operation_intents
    (operation_id, tenant_id, corpus_id, document_id, content_version, manifest_digest, physical_collection)
    values (operation, tenant, corpus, document, content, manifest, collection)
    on conflict (operation_id) do nothing;
  if not exists (select 1 from public.publication_operation_intents i where i.operation_id = operation
    and i.tenant_id = tenant and i.corpus_id = corpus and i.document_id = document
    and i.content_version = content and i.manifest_digest = manifest and i.physical_collection = collection) then
    raise exception 'operation intent identity conflict' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.rag_prepare_publication_intent(uuid,text,text,text,text,text,text) from public;

-- not_observed is deliberately not a terminal state: an earlier begin may
-- still commit after this snapshot. Never infer failure or reuse its identity.
create function public.rag_read_publication_intent(operation uuid, tenant text, corpus text, document text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare i public.publication_operation_intents%rowtype; a public.document_publication_attempts%rowtype;
  h public.document_publication_heads%rowtype;
begin
  select * into i from public.publication_operation_intents x where x.operation_id = operation
    and x.tenant_id = tenant and x.corpus_id = corpus and x.document_id = document;
  if not found then raise exception 'operation intent unavailable' using errcode = 'P0001'; end if;
  select * into a from public.document_publication_attempts x where x.tenant_id = i.tenant_id
    and x.corpus_id = i.corpus_id and x.document_id = i.document_id and x.idempotency_key = i.operation_id::text;
  if found and (a.content_version <> i.content_version or a.manifest_digest <> i.manifest_digest
    or a.physical_collection <> i.physical_collection) then
    raise exception 'operation attempt identity conflict' using errcode = 'P0001';
  end if;
  select * into h from public.document_publication_heads x where x.tenant_id = i.tenant_id
    and x.corpus_id = i.corpus_id and x.document_id = i.document_id;
  return jsonb_build_object('operationId', i.operation_id::text, 'tenantId', i.tenant_id,
    'corpusId', i.corpus_id, 'documentId', i.document_id, 'contentVersion', i.content_version,
    'manifestDigest', i.manifest_digest, 'physicalCollection', i.physical_collection,
    'state', coalesce(a.status, 'not_observed'), 'generation', a.generation::text,
    'attemptRevision', a.expected_revision::text, 'headRevision', h.revision::text,
    'headRevoked', h.revoked, 'currentlyActive', coalesce(a.status = 'published' and not h.revoked and h.active_generation = a.generation, false));
end;
$$;
revoke all on function public.rag_read_publication_intent(uuid,text,text,text) from public;
