-- PROTOTYPE ONLY. This file is deliberately outside the automatic migration
-- directory. Do not deploy it until writer/read-path fencing, permissions,
-- backup/restore handling, and real backend verification are complete.
-- The control plane is inert until the ingest and read paths opt in. A
-- generation is independent of the source hash: rebuilding the same source
-- with a different chunker, model, or index schema must get a new identity.
-- Intentionally no tenant/corpus foreign key: a deleted tenant cannot release
-- a name which an expired worker might still use for a delayed remote write.
create table public.document_publication_collection_reservations (
  physical_collection text primary key,
  bound boolean not null default false,
  reserved_at timestamptz not null default now(),
  check (physical_collection ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$')
);
-- Application roles must be granted only SELECT and INSERT for this table;
-- never grant UPDATE, DELETE, TRUNCATE, ownership, or ALTER privileges.
revoke update, delete, truncate on public.document_publication_collection_reservations from public;

create table public.document_publication_heads (
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  generation bigint not null default 0,
  revision bigint not null default 0,
  active_generation bigint,
  revoked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, corpus_id, document_id),
  foreign key (tenant_id, corpus_id) references public.corpora (tenant_id, id) on delete cascade,
  check (btrim(document_id) <> '' and length(document_id) <= 256),
  check (generation >= 0 and revision >= 0),
  check (active_generation is null or (active_generation > 0 and active_generation <= generation)),
  check (not revoked or active_generation is null)
);

create table public.document_publication_attempts (
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  generation bigint not null,
  idempotency_key text not null,
  content_version text not null,
  manifest_digest text not null,
  physical_collection text not null,
  required_providers text[] not null,
  status text not null,
  expected_revision bigint not null,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, corpus_id, document_id, generation),
  unique (tenant_id, corpus_id, document_id, idempotency_key),
  -- An abandoned worker may continue writing. Never reuse its collection for
  -- any later attempt, including a rebuild of the same source content.
  unique (physical_collection),
  foreign key (tenant_id, corpus_id, document_id)
    references public.document_publication_heads (tenant_id, corpus_id, document_id) on delete cascade,
  foreign key (physical_collection)
    references public.document_publication_collection_reservations (physical_collection) on delete restrict,
  check (generation > 0 and expected_revision > 0),
  check (btrim(idempotency_key) <> '' and length(idempotency_key) <= 256),
  check (btrim(content_version) <> '' and length(content_version) <= 256),
  check (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  check (physical_collection ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$'),
  check (cardinality(required_providers) between 1 and 3
    and required_providers <@ array['milvus','elasticsearch','neo4j']::text[]),
  check (status in ('queued', 'staging', 'published', 'failed', 'superseded', 'revoked')),
  check ((status = 'staging' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'staging' and lease_token is null and lease_expires_at is null))
);

-- Attempts may be deleted through a corpus cascade, but consumption of a
-- physical name must survive. The application role must not own this
-- function or either table, create objects in public, or UPDATE/DELETE the
-- reservations table. The SQL is prototype-only until those grants and
-- object-ownership constraints have been verified against the deployment.
create function public.rag_bind_publication_collection_once()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.document_publication_collection_reservations
     set bound = true
   where physical_collection = new.physical_collection and bound = false;
  if not found then
    raise exception 'publication collection is not reserved or already bound' using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function public.rag_bind_publication_collection_once() from public;
create trigger document_publication_bind_collection
before insert on public.document_publication_attempts
for each row execute function public.rag_bind_publication_collection_once();

-- Workers may update status and leases, but must never redirect an existing
-- attempt to a different identity or to a previously consumed collection.
create function public.rag_keep_publication_attempt_identity()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if (new.tenant_id, new.corpus_id, new.document_id, new.generation,
      new.idempotency_key, new.content_version, new.manifest_digest,
      new.physical_collection, new.required_providers, new.expected_revision, new.created_at)
     is distinct from
     (old.tenant_id, old.corpus_id, old.document_id, old.generation,
      old.idempotency_key, old.content_version, old.manifest_digest,
      old.physical_collection, old.required_providers, old.expected_revision, old.created_at) then
    raise exception 'publication attempt identity cannot be changed' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.rag_keep_publication_attempt_identity() from public;
create trigger document_publication_immutable_identity
before update on public.document_publication_attempts
for each row execute function public.rag_keep_publication_attempt_identity();

alter table public.document_publication_heads add constraint document_publication_active_attempt_fk
  foreign key (tenant_id, corpus_id, document_id, active_generation)
  references public.document_publication_attempts (tenant_id, corpus_id, document_id, generation)
  deferrable initially deferred;

-- Readbacks are observations only, not proof of stable sealed writes.
create table public.document_publication_observations (
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  generation bigint not null,
  provider text not null,
  manifest_digest text not null,
  evidence_digest text not null,
  observed_at timestamptz not null default now(),
  primary key (tenant_id, corpus_id, document_id, generation, provider),
  foreign key (tenant_id, corpus_id, document_id, generation)
    references public.document_publication_attempts (tenant_id, corpus_id, document_id, generation) on delete cascade,
  check (provider in ('milvus', 'elasticsearch', 'neo4j')),
  check (manifest_digest ~ '^sha256:[0-9a-f]{64}$' and evidence_digest ~ '^sha256:[0-9a-f]{64}$')
);

create index document_publication_attempts_expired_idx
  on public.document_publication_attempts (lease_expires_at)
  where status = 'staging';

-- The caller is the trusted application service. Tenant and actor
-- authorization remain in request-context; this function does not authenticate
-- an end user or provide independent tenant isolation. Do not grant table DML
-- to the service role; grant EXECUTE on this function only after provisioning
-- a dedicated owner and removing application CREATE rights on public.
create function public.rag_publication_control(
  operation text, tenant text, corpus text, document text, arguments jsonb
)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare
  h public.document_publication_heads%rowtype;
  a public.document_publication_attempts%rowtype;
  v_token uuid;
  v_generation bigint;
  v_revision bigint;
  v_lease_ms bigint;
  v_providers text[];
  v_evidence text;
begin
  if operation is null or operation not in ('begin', 'claim', 'renew', 'abandon', 'revoke', 'check', 'observe')
    or tenant is null or btrim(tenant) = '' or length(tenant) > 128
    or corpus is null or btrim(corpus) = '' or length(corpus) > 128
    or document is null or btrim(document) = '' or length(document) > 256
    or arguments is null or jsonb_typeof(arguments) <> 'object' then
    raise exception 'invalid publication arguments' using errcode='22023';
  end if;
  if operation in ('begin', 'revoke') then
    insert into public.document_publication_heads (tenant_id, corpus_id, document_id)
      values (tenant, corpus, document) on conflict do nothing;
  end if;
  select * into h from public.document_publication_heads
    where tenant_id=tenant and corpus_id=corpus and document_id=document for update;
  if not found then raise exception 'publication head unavailable' using errcode='P0001'; end if;

  if operation = 'begin' then
    if jsonb_typeof(arguments->'requiredProviders') is distinct from 'array'
      or coalesce(length(arguments->>'idempotencyKey') not between 1 and 256, true)
      or coalesce(length(arguments->>'contentVersion') not between 1 and 256, true)
      or coalesce((arguments->>'manifestDigest') !~ '^sha256:[0-9a-f]{64}$', true)
      or coalesce((arguments->>'physicalCollection') !~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$', true) then
      raise exception 'invalid publication begin' using errcode='22023';
    end if;
    select array_agg(value order by value) into v_providers from jsonb_array_elements_text(arguments->'requiredProviders');
    if coalesce(cardinality(v_providers) not between 1 and 3, true)
      or not v_providers <@ array['milvus','elasticsearch','neo4j']::text[]
      or cardinality(v_providers) <> (select count(distinct value) from unnest(v_providers) value) then
      raise exception 'invalid required providers' using errcode='22023';
    end if;
    select * into a from public.document_publication_attempts where tenant_id=tenant and corpus_id=corpus
      and document_id=document and idempotency_key=arguments->>'idempotencyKey';
    if found then
      if a.content_version <> arguments->>'contentVersion' or a.manifest_digest <> arguments->>'manifestDigest'
        or a.physical_collection <> arguments->>'physicalCollection' or a.required_providers <> v_providers
        or a.generation <> h.generation or a.expected_revision <> h.revision
        or not (a.status='queued' or (a.status='staging' and a.lease_expires_at > clock_timestamp())) then
        raise exception 'idempotency conflict' using errcode='P0001';
      end if;
    else
      update public.document_publication_attempts set status='superseded', lease_token=null, lease_expires_at=null,
        updated_at=clock_timestamp() where tenant_id=tenant and corpus_id=corpus and document_id=document
        and status in ('queued','staging');
      update public.document_publication_heads set generation=generation+1, revision=revision+1, updated_at=clock_timestamp()
        where tenant_id=tenant and corpus_id=corpus and document_id=document returning * into h;
      insert into public.document_publication_collection_reservations (physical_collection) values (arguments->>'physicalCollection');
      insert into public.document_publication_attempts (tenant_id,corpus_id,document_id,generation,idempotency_key,
        content_version,manifest_digest,physical_collection,required_providers,status,expected_revision)
        values (tenant,corpus,document,h.generation,arguments->>'idempotencyKey',arguments->>'contentVersion',
          arguments->>'manifestDigest',arguments->>'physicalCollection',v_providers,'queued',h.revision) returning * into a;
    end if;
    return jsonb_build_object('generation',a.generation::text,'revision',a.expected_revision::text,
      'manifestDigest',a.manifest_digest,'physicalCollection',a.physical_collection);
  end if;

  if operation = 'revoke' then
    if h.revision is distinct from (arguments->>'revision')::bigint then raise exception 'revision conflict' using errcode='P0001'; end if;
    update public.document_publication_attempts set status='revoked', lease_token=null, lease_expires_at=null, updated_at=clock_timestamp()
      where tenant_id=tenant and corpus_id=corpus and document_id=document and status in ('queued','staging');
    update public.document_publication_heads set active_generation=null,generation=generation+1,revision=revision+1,
      revoked=true,updated_at=clock_timestamp() where tenant_id=tenant and corpus_id=corpus and document_id=document;
    return '{}'::jsonb;
  end if;

  v_generation := (arguments->>'generation')::bigint;
  v_revision := (arguments->>'revision')::bigint;
  if v_generation is null or v_revision is null or h.generation <> v_generation or h.revision <> v_revision then
    raise exception 'publication superseded' using errcode='P0001';
  end if;
  select * into a from public.document_publication_attempts where tenant_id=tenant and corpus_id=corpus
    and document_id=document and generation=v_generation for update;
  if not found or a.expected_revision <> v_revision or a.manifest_digest is distinct from arguments->>'manifestDigest'
    or a.physical_collection is distinct from arguments->>'physicalCollection' then
    raise exception 'publication identity conflict' using errcode='P0001';
  end if;
  if operation = 'claim' then
    v_lease_ms := (arguments->>'leaseMs')::bigint;
    if coalesce(v_lease_ms not between 1000 and 3600000, true) then raise exception 'invalid lease' using errcode='22023'; end if;
    if a.status <> 'queued' then raise exception 'generation already claimed' using errcode='P0001'; end if;
    v_token := gen_random_uuid();
    update public.document_publication_attempts set status='staging',lease_token=v_token,
      lease_expires_at=clock_timestamp()+(v_lease_ms * interval '1 millisecond'),updated_at=clock_timestamp()
      where tenant_id=tenant and corpus_id=corpus and document_id=document and generation=v_generation;
    return jsonb_build_object('leaseToken',v_token::text);
  end if;
  v_token := (arguments->>'leaseToken')::uuid;
  if a.status <> 'staging' or v_token is null or a.lease_token <> v_token then
    raise exception 'invalid publication lease' using errcode='P0001';
  end if;
  if operation = 'abandon' then
    update public.document_publication_attempts set status='failed',lease_token=null,lease_expires_at=null,
      updated_at=clock_timestamp() where tenant_id=tenant and corpus_id=corpus and document_id=document and generation=v_generation;
    return '{}'::jsonb;
  end if;
  if a.lease_expires_at <= clock_timestamp() then raise exception 'publication lease expired' using errcode='P0001'; end if;
  if operation = 'renew' then
    v_lease_ms := (arguments->>'leaseMs')::bigint;
    if coalesce(v_lease_ms not between 1000 and 3600000, true) then raise exception 'invalid lease' using errcode='22023'; end if;
    update public.document_publication_attempts set lease_expires_at=clock_timestamp()+(v_lease_ms * interval '1 millisecond'),
      updated_at=clock_timestamp() where tenant_id=tenant and corpus_id=corpus and document_id=document and generation=v_generation
        and status='staging' and lease_token=v_token and lease_expires_at > clock_timestamp();
    if not found then raise exception 'publication lease expired' using errcode='P0001'; end if;
  elsif operation in ('check', 'observe') then
    if not coalesce(arguments->>'provider' = any(a.required_providers), false) then raise exception 'provider not required' using errcode='P0001'; end if;
    if operation = 'observe' then
      v_evidence := arguments->>'evidenceDigest';
      if v_evidence is null or v_evidence !~ '^sha256:[0-9a-f]{64}$' then raise exception 'invalid observation' using errcode='22023'; end if;
      insert into public.document_publication_observations (tenant_id,corpus_id,document_id,generation,provider,manifest_digest,evidence_digest)
        select tenant,corpus,document,v_generation,arguments->>'provider',a.manifest_digest,v_evidence
        where a.lease_expires_at > clock_timestamp()
        on conflict (tenant_id,corpus_id,document_id,generation,provider) do nothing;
      if a.lease_expires_at <= clock_timestamp() then raise exception 'publication lease expired' using errcode='P0001'; end if;
      if not exists (select 1 from public.document_publication_observations where tenant_id=tenant and corpus_id=corpus
        and document_id=document and generation=v_generation and provider=arguments->>'provider'
        and manifest_digest=a.manifest_digest and evidence_digest=v_evidence) then
        raise exception 'observation conflict' using errcode='P0001';
      end if;
    end if;
  end if;
  return '{}'::jsonb;
end;
$$;
revoke all on function public.rag_publication_control(text,text,text,text,jsonb) from public;
