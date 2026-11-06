-- A create operation is durable before any ES request is sent. Records remain
-- after corpus deletion so that an uncertain or late create cannot have its
-- physical index name silently reused. The application must authorize scope
-- through request-context before calling this service-role function.
create table public.elasticsearch_publication_operations (
  operation_id uuid primary key,
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  generation bigint not null,
  revision bigint not null,
  manifest_digest text not null,
  physical_collection text not null,
  content_version text not null,
  index_name text not null unique,
  owner_marker text not null,
  state text not null default 'prepared',
  index_uuid text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, corpus_id, document_id, generation),
  check (generation > 0 and revision > 0),
  check (length(tenant_id) between 1 and 128 and length(corpus_id) between 1 and 128
    and length(document_id) between 1 and 256 and length(content_version) between 1 and 256),
  check (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  check (physical_collection ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$'),
  check (index_name ~ '^codex-generation-seal-[0-9a-f]{32}$'),
  check (owner_marker ~ '^[0-9a-f]{64}$'),
  check ((state in ('prepared', 'creating') and index_uuid is null)
    or (state = 'bound' and index_uuid is not null and index_uuid ~ '^[A-Za-z0-9_-]{1,128}$'))
);

-- No table DML is granted to application or PUBLIC. This service function
-- enforces state transitions, but does not authenticate an end user/tenant:
-- its caller must be a trusted, non-owner application role and must enforce
-- request-context authorization. Scope from an HTTP payload is not trusted.
revoke all on table public.elasticsearch_publication_operations from public;
create function public.rag_elasticsearch_publication_operation(
  action text, tenant text, corpus text, document text, arguments jsonb
)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare
  h public.document_publication_heads%rowtype;
  a public.document_publication_attempts%rowtype;
  o public.elasticsearch_publication_operations%rowtype;
  v_generation bigint;
  v_revision bigint;
  v_operation_id uuid;
  v_token uuid;
begin
  if action is null or action not in ('prepare', 'start', 'bind', 'read')
    or tenant is null or btrim(tenant) = '' or length(tenant) > 128
    or corpus is null or btrim(corpus) = '' or length(corpus) > 128
    or document is null or btrim(document) = '' or length(document) > 256
    or arguments is null or jsonb_typeof(arguments) <> 'object' then
    raise exception 'invalid Elasticsearch operation arguments' using errcode = '22023';
  end if;
  v_operation_id := (arguments->>'operationId')::uuid;
  if v_operation_id is null then raise exception 'operation ID required' using errcode = '22023'; end if;

  if action = 'read' then
    select * into o from public.elasticsearch_publication_operations
      where operation_id = v_operation_id and tenant_id = tenant and corpus_id = corpus and document_id = document;
    if not found then raise exception 'operation unavailable' using errcode = 'P0001'; end if;
  else
    v_generation := (arguments->>'generation')::bigint;
    v_revision := (arguments->>'revision')::bigint;
    v_token := (arguments->>'leaseToken')::uuid;
    if v_generation is null or v_revision is null or v_token is null then
      raise exception 'operation lease required' using errcode = '22023';
    end if;
    select * into h from public.document_publication_heads
      where tenant_id = tenant and corpus_id = corpus and document_id = document for update;
    if not found or h.generation <> v_generation or h.revision <> v_revision or h.revoked then
      raise exception 'operation superseded' using errcode = 'P0001';
    end if;
    select * into a from public.document_publication_attempts
      where tenant_id = tenant and corpus_id = corpus and document_id = document and generation = v_generation for update;
    if not found or a.expected_revision <> v_revision or a.status <> 'staging' or a.lease_token <> v_token
      or a.lease_expires_at <= clock_timestamp() or a.manifest_digest is distinct from arguments->>'manifestDigest'
      or a.physical_collection is distinct from arguments->>'physicalCollection'
      or not ('elasticsearch' = any(a.required_providers)) then
      raise exception 'invalid operation lease or identity' using errcode = 'P0001';
    end if;

    if action = 'prepare' then
      if a.content_version is distinct from arguments->>'contentVersion'
        or coalesce((arguments->>'indexName') !~ '^codex-generation-seal-[0-9a-f]{32}$', true)
        or coalesce((arguments->>'marker') !~ '^[0-9a-f]{64}$', true) then
        raise exception 'invalid prepared operation' using errcode = '22023';
      end if;
      select * into o from public.elasticsearch_publication_operations
        where tenant_id = tenant and corpus_id = corpus and document_id = document and generation = v_generation;
      if found then
        if o.revision <> v_revision or o.content_version <> a.content_version or o.manifest_digest <> a.manifest_digest
          or o.physical_collection <> a.physical_collection then
          raise exception 'operation identity conflict' using errcode = 'P0001';
        end if;
      else
        insert into public.elasticsearch_publication_operations (
          operation_id, tenant_id, corpus_id, document_id, generation, revision, manifest_digest,
          physical_collection, content_version, index_name, owner_marker
        ) values (v_operation_id, tenant, corpus, document, v_generation, v_revision, a.manifest_digest,
          a.physical_collection, a.content_version, arguments->>'indexName', arguments->>'marker') returning * into o;
      end if;
    else
      select * into o from public.elasticsearch_publication_operations
        where operation_id = v_operation_id and tenant_id = tenant and corpus_id = corpus
          and document_id = document and generation = v_generation for update;
      if not found or o.revision <> v_revision or o.manifest_digest <> a.manifest_digest
        or o.physical_collection <> a.physical_collection or o.content_version <> a.content_version then
        raise exception 'operation identity conflict' using errcode = 'P0001';
      end if;
      if action = 'start' then
        update public.elasticsearch_publication_operations set state = 'creating', updated_at = clock_timestamp()
          where operation_id = v_operation_id and state = 'prepared' returning * into o;
        if not found then raise exception 'operation already started' using errcode = 'P0001'; end if;
      elsif action = 'bind' then
        if o.index_name is distinct from arguments->>'indexName' or o.owner_marker is distinct from arguments->>'marker'
          or o.content_version is distinct from arguments->>'contentVersion' then
          raise exception 'operation binding identity conflict' using errcode = 'P0001';
        end if;
        if coalesce((arguments->>'indexUuid') !~ '^[A-Za-z0-9_-]{1,128}$', true) then
          raise exception 'invalid index UUID' using errcode = '22023';
        end if;
        if o.state = 'bound' and o.index_uuid = arguments->>'indexUuid' then
          null; -- An already confirmed binding is idempotent.
        elsif o.state = 'creating' then
          update public.elasticsearch_publication_operations set state = 'bound', index_uuid = arguments->>'indexUuid',
            updated_at = clock_timestamp() where operation_id = v_operation_id returning * into o;
        else
          raise exception 'operation UUID conflict' using errcode = 'P0001';
        end if;
      end if;
    end if;
    -- A lease expiring during a state transition must roll back the mutation.
    if a.lease_expires_at <= clock_timestamp() then raise exception 'operation lease expired' using errcode = 'P0001'; end if;
  end if;

  return jsonb_build_object('version', 1, 'operationId', o.operation_id::text,
    'indexName', o.index_name, 'marker', o.owner_marker, 'status', o.state, 'indexUuid', o.index_uuid,
    'identity', jsonb_build_object('tenantId', o.tenant_id, 'corpusId', o.corpus_id, 'documentId', o.document_id,
      'generation', o.generation::text, 'documentVersion', o.content_version));
end;
$$;
revoke all on function public.rag_elasticsearch_publication_operation(text,text,text,text,jsonb) from public;
