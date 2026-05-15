create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  default_tenant_id uuid references public.tenants(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tenant_members (
  tenant_id uuid references public.tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create or replace function public.is_tenant_member(target_tenant_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = target_tenant_id
      and tm.user_id = auth.uid()
  );
$$;

create or replace function public.is_tenant_editor(target_tenant_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = target_tenant_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'admin', 'member')
  );
$$;

grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.is_tenant_editor(uuid) to authenticated;

create table if not exists public.corpora (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  source_kind text not null,
  metadata jsonb not null default '{}',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  corpus_id uuid not null references public.corpora(id) on delete cascade,
  original_name text not null,
  content_type text not null,
  byte_size bigint not null default 0,
  source_hash text not null,
  storage_bucket text not null,
  storage_path text not null,
  parsed_bucket text,
  parsed_path text,
  parse_method text,
  metadata jsonb not null default '{}',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (corpus_id, source_hash)
);

create table if not exists public.chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  corpus_id uuid not null references public.corpora(id) on delete cascade,
  document_id uuid not null references public.document_assets(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  token_count integer,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create table if not exists public.index_manifests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  corpus_id uuid not null references public.corpora(id) on delete cascade,
  backend text not null check (backend in ('milvus', 'zilliz', 'supabase_pgvector')),
  collection_name text,
  embedding_model text not null,
  embedding_dimension integer not null,
  index_type text,
  metric_type text,
  version_hash text not null,
  status text not null check (status in ('pending', 'ready', 'stale', 'failed')),
  updated_at timestamptz not null default now(),
  unique (corpus_id, backend, embedding_model)
);

create table if not exists public.index_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  corpus_id uuid references public.corpora(id) on delete set null,
  document_id uuid references public.document_assets(id) on delete set null,
  job_type text not null check (job_type in ('parse', 'embed', 'milvus_sync', 'reindex', 'cleanup')),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  error text,
  metadata jsonb not null default '{}',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.traces (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references auth.users(id),
  session_id text,
  name text not null,
  input jsonb,
  output jsonb,
  metadata jsonb not null default '{}',
  tags text[] not null default '{}',
  status text not null check (status in ('PENDING', 'SUCCESS', 'ERROR')),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.observations (
  id uuid primary key,
  trace_id uuid not null references public.traces(id) on delete cascade,
  parent_observation_id uuid references public.observations(id) on delete set null,
  type text not null check (type in ('GENERATION', 'SPAN', 'EVENT')),
  name text not null,
  input jsonb,
  output jsonb,
  model text,
  usage jsonb,
  metadata jsonb not null default '{}',
  level text not null default 'DEFAULT',
  status_message text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.trace_scores (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null references public.traces(id) on delete cascade,
  observation_id uuid references public.observations(id) on delete set null,
  name text not null,
  value jsonb not null,
  source text not null check (source in ('USER', 'AI', 'SYSTEM')),
  comment text,
  created_at timestamptz not null default now()
);

create table if not exists public.chunk_embeddings_1536 (
  chunk_id uuid primary key references public.chunks(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  corpus_id uuid not null references public.corpora(id) on delete cascade,
  embedding_model text not null,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists document_assets_tenant_corpus_idx
  on public.document_assets (tenant_id, corpus_id, created_at desc);

create index if not exists chunks_tenant_corpus_idx
  on public.chunks (tenant_id, corpus_id, document_id, chunk_index);

create index if not exists index_jobs_tenant_status_idx
  on public.index_jobs (tenant_id, status, created_at desc);

create index if not exists traces_tenant_started_idx
  on public.traces (tenant_id, started_at desc);

create index if not exists observations_trace_idx
  on public.observations (trace_id, started_at);

create index if not exists trace_scores_trace_idx
  on public.trace_scores (trace_id, created_at desc);

create index if not exists chunk_embeddings_1536_hnsw_idx
  on public.chunk_embeddings_1536
  using hnsw (embedding vector_cosine_ops);

alter table public.tenants enable row level security;
alter table public.profiles enable row level security;
alter table public.tenant_members enable row level security;
alter table public.corpora enable row level security;
alter table public.document_assets enable row level security;
alter table public.chunks enable row level security;
alter table public.index_manifests enable row level security;
alter table public.index_jobs enable row level security;
alter table public.traces enable row level security;
alter table public.observations enable row level security;
alter table public.trace_scores enable row level security;
alter table public.chunk_embeddings_1536 enable row level security;

create policy "members can read their tenants"
on public.tenants
for select
to authenticated
using (public.is_tenant_member(id));

create policy "users can read own profile"
on public.profiles
for select
to authenticated
using (user_id = auth.uid());

create policy "users can update own profile"
on public.profiles
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "members can read memberships"
on public.tenant_members
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_tenant_member(tenant_id)
);

create policy "tenant members can read corpora"
on public.corpora
for select
to authenticated
using (public.is_tenant_member(tenant_id));

create policy "tenant editors can write corpora"
on public.corpora
for all
to authenticated
using (public.is_tenant_editor(tenant_id))
with check (public.is_tenant_editor(tenant_id));

create policy "tenant members can read document assets"
on public.document_assets
for select
to authenticated
using (public.is_tenant_member(tenant_id));

create policy "tenant editors can write document assets"
on public.document_assets
for all
to authenticated
using (public.is_tenant_editor(tenant_id))
with check (public.is_tenant_editor(tenant_id));

create policy "tenant members can read chunks"
on public.chunks
for select
to authenticated
using (public.is_tenant_member(tenant_id));

create policy "tenant editors can write chunks"
on public.chunks
for all
to authenticated
using (public.is_tenant_editor(tenant_id))
with check (public.is_tenant_editor(tenant_id));

create policy "tenant members can read index manifests"
on public.index_manifests
for select
to authenticated
using (public.is_tenant_member(tenant_id));

create policy "tenant editors can write index manifests"
on public.index_manifests
for all
to authenticated
using (public.is_tenant_editor(tenant_id))
with check (public.is_tenant_editor(tenant_id));

create policy "tenant members can read index jobs"
on public.index_jobs
for select
to authenticated
using (public.is_tenant_member(tenant_id));

create policy "tenant editors can write index jobs"
on public.index_jobs
for all
to authenticated
using (public.is_tenant_editor(tenant_id))
with check (public.is_tenant_editor(tenant_id));

create policy "tenant members can read traces"
on public.traces
for select
to authenticated
using (public.is_tenant_member(tenant_id));

create policy "tenant editors can write traces"
on public.traces
for all
to authenticated
using (public.is_tenant_editor(tenant_id))
with check (public.is_tenant_editor(tenant_id));

create policy "tenant members can read observations"
on public.observations
for select
to authenticated
using (
  exists (
    select 1
    from public.traces t
    where t.id = observations.trace_id
      and public.is_tenant_member(t.tenant_id)
  )
);

create policy "tenant editors can write observations"
on public.observations
for all
to authenticated
using (
  exists (
    select 1
    from public.traces t
    where t.id = observations.trace_id
      and public.is_tenant_editor(t.tenant_id)
  )
)
with check (
  exists (
    select 1
    from public.traces t
    where t.id = observations.trace_id
      and public.is_tenant_editor(t.tenant_id)
  )
);

create policy "tenant members can read trace scores"
on public.trace_scores
for select
to authenticated
using (
  exists (
    select 1
    from public.traces t
    where t.id = trace_scores.trace_id
      and public.is_tenant_member(t.tenant_id)
  )
);

create policy "tenant members can insert trace scores"
on public.trace_scores
for insert
to authenticated
with check (
  exists (
    select 1
    from public.traces t
    where t.id = trace_scores.trace_id
      and public.is_tenant_member(t.tenant_id)
  )
);

create policy "tenant members can read chunk embeddings"
on public.chunk_embeddings_1536
for select
to authenticated
using (public.is_tenant_member(tenant_id));
