create table if not exists public.rag_schema_migrations (
  version text primary key,
  name text not null,
  checksum char(64) not null,
  applied_at timestamptz not null default clock_timestamp(),
  constraint rag_schema_migrations_version_format_check
    check (version ~ '^[0-9]{4}$'),
  constraint rag_schema_migrations_checksum_format_check
    check (checksum ~ '^[0-9a-f]{64}$')
);
