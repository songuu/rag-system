create table public.tenants (
  id text primary key,
  name text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenants_name_not_blank_check check (btrim(name) <> ''),
  constraint tenants_id_format_check check (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint tenants_updated_after_created_check check (updated_at >= created_at)
);

create table public.corpora (
  id text primary key,
  tenant_id text not null,
  name text not null,
  source_kind text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint corpora_name_not_blank_check check (btrim(name) <> ''),
  constraint corpora_id_format_check check (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint corpora_source_kind_not_blank_check check (btrim(source_kind) <> ''),
  constraint corpora_updated_after_created_check check (updated_at >= created_at),
  constraint corpora_tenant_id_key unique (tenant_id, id),
  constraint corpora_tenant_fk
    foreign key (tenant_id)
    references public.tenants (id)
    on delete cascade
);

create table public.document_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  corpus_id text not null,
  external_document_id text,
  original_name text not null,
  content_type text not null,
  byte_size bigint not null default 0,
  source_hash text not null,
  raw_blob_filename text,
  parsed_blob_filename text,
  parse_method text,
  metadata jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_assets_external_id_not_blank_check
    check (external_document_id is null or btrim(external_document_id) <> ''),
  constraint document_assets_original_name_not_blank_check check (btrim(original_name) <> ''),
  constraint document_assets_content_type_not_blank_check check (btrim(content_type) <> ''),
  constraint document_assets_byte_size_nonnegative_check check (byte_size >= 0),
  constraint document_assets_source_hash_not_blank_check check (btrim(source_hash) <> ''),
  constraint document_assets_raw_blob_not_blank_check
    check (raw_blob_filename is null or btrim(raw_blob_filename) <> ''),
  constraint document_assets_parsed_blob_not_blank_check
    check (parsed_blob_filename is null or btrim(parsed_blob_filename) <> ''),
  constraint document_assets_updated_after_created_check check (updated_at >= created_at),
  constraint document_assets_external_id_key
    unique (tenant_id, corpus_id, external_document_id),
  constraint document_assets_source_hash_key
    unique (tenant_id, corpus_id, source_hash),
  constraint document_assets_scope_id_key
    unique (tenant_id, corpus_id, id),
  constraint document_assets_corpus_scope_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade
);

create table public.object_blobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  corpus_id text not null,
  kind text not null,
  filename text not null,
  data bytea not null,
  content_type text not null default 'application/octet-stream',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint object_blobs_kind_check check (kind in ('raw', 'parsed', 'artifact')),
  constraint object_blobs_filename_not_blank_check check (btrim(filename) <> ''),
  constraint object_blobs_content_type_not_blank_check check (btrim(content_type) <> ''),
  constraint object_blobs_updated_after_created_check check (updated_at >= created_at),
  constraint object_blobs_scope_filename_key unique (tenant_id, corpus_id, filename),
  constraint object_blobs_corpus_scope_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade
);

create table public.index_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  corpus_id text,
  document_id uuid,
  job_type text not null,
  status text not null default 'queued',
  progress integer not null default 0,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint index_jobs_type_check
    check (job_type in ('parse', 'embed', 'milvus_sync', 'reindex', 'cleanup')),
  constraint index_jobs_status_check
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  constraint index_jobs_progress_check check (progress between 0 and 100),
  constraint index_jobs_document_requires_corpus_check
    check (document_id is null or corpus_id is not null),
  constraint index_jobs_completion_order_check
    check (completed_at is null or started_at is null or completed_at >= started_at),
  constraint index_jobs_updated_after_created_check check (updated_at >= created_at),
  constraint index_jobs_corpus_scope_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade,
  constraint index_jobs_document_scope_fk
    foreign key (tenant_id, corpus_id, document_id)
    references public.document_assets (tenant_id, corpus_id, id)
    on delete set null (document_id)
);

create table public.traces (
  id uuid primary key,
  tenant_id text not null,
  user_id text,
  session_id text,
  name text not null,
  input jsonb,
  output jsonb,
  metadata jsonb not null default '{}'::jsonb,
  tags text[] not null default array[]::text[],
  status text not null default 'PENDING',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint traces_name_not_blank_check check (btrim(name) <> ''),
  constraint traces_status_check check (status in ('PENDING', 'SUCCESS', 'ERROR')),
  constraint traces_end_order_check check (ended_at is null or ended_at >= started_at),
  constraint traces_updated_after_created_check check (updated_at >= created_at),
  constraint traces_tenant_id_key unique (tenant_id, id),
  constraint traces_tenant_fk
    foreign key (tenant_id)
    references public.tenants (id)
    on delete cascade
);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null,
  parent_observation_id uuid,
  type text not null,
  name text not null,
  input jsonb,
  output jsonb,
  model text,
  usage jsonb,
  metadata jsonb not null default '{}'::jsonb,
  level text not null default 'DEFAULT',
  status_message text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint observations_type_check check (type in ('GENERATION', 'SPAN', 'EVENT')),
  constraint observations_level_check check (level in ('DEFAULT', 'DEBUG', 'WARNING', 'ERROR')),
  constraint observations_name_not_blank_check check (btrim(name) <> ''),
  constraint observations_parent_not_self_check
    check (parent_observation_id is null or parent_observation_id <> id),
  constraint observations_end_order_check check (ended_at is null or ended_at >= started_at),
  constraint observations_updated_after_created_check check (updated_at >= created_at),
  constraint observations_trace_id_key unique (trace_id, id),
  constraint observations_trace_fk
    foreign key (trace_id)
    references public.traces (id)
    on delete cascade,
  constraint observations_parent_trace_fk
    foreign key (trace_id, parent_observation_id)
    references public.observations (trace_id, id)
    on delete set null (parent_observation_id)
);

create table public.trace_scores (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null,
  observation_id uuid,
  name text not null,
  value jsonb not null,
  source text not null,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trace_scores_name_not_blank_check check (btrim(name) <> ''),
  constraint trace_scores_source_check check (source in ('USER', 'AI', 'SYSTEM')),
  constraint trace_scores_updated_after_created_check check (updated_at >= created_at),
  constraint trace_scores_trace_fk
    foreign key (trace_id)
    references public.traces (id)
    on delete cascade,
  constraint trace_scores_observation_trace_fk
    foreign key (trace_id, observation_id)
    references public.observations (trace_id, id)
    on delete set null (observation_id)
);

create function public.rag_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function public.rag_reject_tenant_reassignment()
returns trigger
language plpgsql
as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant scope cannot be reassigned';
  end if;
  return new;
end;
$$;

create function public.rag_reject_trace_reassignment()
returns trigger
language plpgsql
as $$
begin
  if new.trace_id is distinct from old.trace_id then
    raise exception 'trace scope cannot be reassigned';
  end if;
  return new;
end;
$$;

create trigger tenants_set_updated_at
before update on public.tenants
for each row execute function public.rag_set_updated_at();

create trigger corpora_set_updated_at
before update on public.corpora
for each row execute function public.rag_set_updated_at();

create trigger document_assets_set_updated_at
before update on public.document_assets
for each row execute function public.rag_set_updated_at();

create trigger object_blobs_set_updated_at
before update on public.object_blobs
for each row execute function public.rag_set_updated_at();

create trigger index_jobs_set_updated_at
before update on public.index_jobs
for each row execute function public.rag_set_updated_at();

create trigger traces_reject_tenant_reassignment
before update of tenant_id on public.traces
for each row execute function public.rag_reject_tenant_reassignment();

create trigger traces_set_updated_at
before update on public.traces
for each row execute function public.rag_set_updated_at();

create trigger observations_reject_trace_reassignment
before update of trace_id on public.observations
for each row execute function public.rag_reject_trace_reassignment();

create trigger observations_set_updated_at
before update on public.observations
for each row execute function public.rag_set_updated_at();

create trigger trace_scores_reject_trace_reassignment
before update of trace_id on public.trace_scores
for each row execute function public.rag_reject_trace_reassignment();

create trigger trace_scores_set_updated_at
before update on public.trace_scores
for each row execute function public.rag_set_updated_at();

create index document_assets_tenant_corpus_created_idx
  on public.document_assets (tenant_id, corpus_id, created_at desc);

create index object_blobs_tenant_corpus_kind_idx
  on public.object_blobs (tenant_id, corpus_id, kind, updated_at desc);

create index index_jobs_tenant_status_created_idx
  on public.index_jobs (tenant_id, status, created_at desc);

create index index_jobs_corpus_status_created_idx
  on public.index_jobs (tenant_id, corpus_id, status, created_at desc)
  where corpus_id is not null;

create index traces_tenant_started_idx
  on public.traces (tenant_id, started_at desc);

create index traces_tenant_session_started_idx
  on public.traces (tenant_id, session_id, started_at desc)
  where session_id is not null;

create index observations_trace_started_idx
  on public.observations (trace_id, started_at, id);

create index trace_scores_trace_created_idx
  on public.trace_scores (trace_id, created_at, id);
