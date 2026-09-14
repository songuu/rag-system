create table public.graph_active_snapshots (
  tenant_id text not null,
  corpus_id text not null,
  graph_version text,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, corpus_id),
  constraint graph_active_snapshots_corpus_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade,
  constraint graph_active_snapshots_graph_version_check
    check (graph_version is null or (btrim(graph_version) <> '' and length(graph_version) <= 512)),
  constraint graph_active_snapshots_revision_check check (revision >= 0)
);

create table public.graph_build_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  corpus_id text not null,
  graph_version text not null,
  status text not null default 'queued',
  progress double precision not null default 0,
  artifact_digest text,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint graph_build_jobs_corpus_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade,
  constraint graph_build_jobs_identity_key
    unique (tenant_id, corpus_id, graph_version),
  constraint graph_build_jobs_graph_version_check
    check (btrim(graph_version) <> '' and length(graph_version) <= 512),
  constraint graph_build_jobs_status_check
    check (status in ('queued', 'running', 'staged', 'validated', 'published', 'failed', 'cancelled')),
  constraint graph_build_jobs_progress_check check (progress between 0 and 1),
  constraint graph_build_jobs_attempts_check check (attempts >= 0),
  constraint graph_build_jobs_lease_check check (
    (status = 'running' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'running' and lease_token is null and lease_expires_at is null)
  ),
  constraint graph_build_jobs_digest_check
    check (artifact_digest is null or artifact_digest ~ '^sha256:[0-9a-f]{64}$')
);

create table public.graph_snapshot_lifecycle (
  tenant_id text not null,
  corpus_id text not null,
  graph_version text not null,
  state text not null default 'staged',
  operation_id uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, corpus_id, graph_version),
  constraint graph_snapshot_lifecycle_corpus_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade,
  constraint graph_snapshot_lifecycle_version_check
    check (btrim(graph_version) <> '' and length(graph_version) <= 512),
  constraint graph_snapshot_lifecycle_state_check
    check (state in ('staged', 'activating', 'deleting', 'deleted')),
  constraint graph_snapshot_lifecycle_lease_check check (
    (state in ('staged', 'deleted') and operation_id is null and lease_expires_at is null)
    or (state in ('activating', 'deleting') and operation_id is not null and lease_expires_at is not null)
  )
);

create table public.graph_publication_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  corpus_id text not null,
  event_type text not null,
  graph_version text,
  revision bigint not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  dead_lettered_at timestamptz,
  constraint graph_publication_outbox_corpus_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade,
  constraint graph_publication_outbox_revision_key
    unique (tenant_id, corpus_id, revision),
  constraint graph_publication_outbox_event_type_check
    check (event_type in ('graph.snapshot.activated', 'graph.snapshot.deactivated')),
  constraint graph_publication_outbox_revision_check check (revision > 0),
  constraint graph_publication_outbox_attempts_check check (attempts >= 0),
  constraint graph_publication_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint graph_publication_outbox_terminal_check check (
    not (published_at is not null and dead_lettered_at is not null)
  ),
  constraint graph_publication_outbox_graph_version_check
    check (graph_version is null or (btrim(graph_version) <> '' and length(graph_version) <= 512)),
  constraint graph_publication_outbox_published_after_created_check
    check (published_at is null or published_at >= created_at)
);

create trigger graph_build_jobs_set_updated_at
before update on public.graph_build_jobs
for each row execute function public.rag_set_updated_at();

create trigger graph_snapshot_lifecycle_set_updated_at
before update on public.graph_snapshot_lifecycle
for each row execute function public.rag_set_updated_at();

create index graph_build_jobs_scope_status_idx
  on public.graph_build_jobs (tenant_id, corpus_id, status, updated_at desc);

create index graph_publication_outbox_pending_idx
  on public.graph_publication_outbox (available_at, created_at)
  where published_at is null and dead_lettered_at is null;

create index graph_snapshot_lifecycle_recovery_idx
  on public.graph_snapshot_lifecycle (lease_expires_at)
  where state in ('activating', 'deleting');
