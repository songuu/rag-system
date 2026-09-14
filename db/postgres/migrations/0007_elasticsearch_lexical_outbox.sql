create table public.elasticsearch_lexical_chunks (
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  document_version text not null,
  chunk_id text not null,
  trust_level text not null,
  content text not null,
  source text,
  page integer,
  start_offset integer,
  end_offset integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, corpus_id, document_id, document_version, chunk_id),
  constraint elasticsearch_lexical_chunks_corpus_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade,
  constraint elasticsearch_lexical_chunks_trust_check
    check (trust_level in ('trusted', 'reviewed', 'external', 'quarantined')),
  constraint elasticsearch_lexical_chunks_content_check
    check (btrim(content) <> '' and length(content) <= 65000),
  constraint elasticsearch_lexical_chunks_identity_check
    check (
      btrim(document_id) <> '' and length(document_id) <= 256
      and btrim(document_version) <> '' and length(document_version) <= 256
      and btrim(chunk_id) <> '' and length(chunk_id) <= 256
    ),
  constraint elasticsearch_lexical_chunks_offsets_check
    check (
      (start_offset is null and end_offset is null)
      or (start_offset >= 0 and end_offset > start_offset)
    )
);

create table public.elasticsearch_lexical_outbox (
  id uuid primary key default gen_random_uuid(),
  sequence bigserial not null unique,
  tenant_id text not null,
  corpus_id text not null,
  document_id text not null,
  document_version text not null,
  event_type text not null,
  projection_digest text not null,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  dead_lettered_at timestamptz,
  constraint elasticsearch_lexical_outbox_corpus_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade,
  constraint elasticsearch_lexical_outbox_identity_key
    unique (tenant_id, corpus_id, document_id, document_version, event_type),
  constraint elasticsearch_lexical_outbox_event_check
    check (event_type in ('upsert', 'delete')),
  constraint elasticsearch_lexical_outbox_document_check
    check (btrim(document_id) <> '' and length(document_id) <= 256),
  constraint elasticsearch_lexical_outbox_version_check
    check (
      (event_type = 'delete' and document_version = '*')
      or (event_type = 'upsert' and btrim(document_version) <> '' and length(document_version) <= 256)
    ),
  constraint elasticsearch_lexical_outbox_attempts_check check (attempts >= 0),
  constraint elasticsearch_lexical_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint elasticsearch_lexical_outbox_terminal_check check (
    not (published_at is not null and dead_lettered_at is not null)
  )
);

create trigger elasticsearch_lexical_chunks_set_updated_at
before update on public.elasticsearch_lexical_chunks
for each row execute function public.rag_set_updated_at();

create index elasticsearch_lexical_outbox_pending_idx
  on public.elasticsearch_lexical_outbox (available_at, sequence)
  where published_at is null and dead_lettered_at is null;

create index elasticsearch_lexical_chunks_document_idx
  on public.elasticsearch_lexical_chunks (
    tenant_id, corpus_id, document_id, document_version, start_offset
  );

