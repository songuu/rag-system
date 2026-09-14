create table public.mirofish_projects (
  tenant_id text not null,
  corpus_id text not null,
  project_id text not null,
  project_data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, corpus_id, project_id),
  constraint mirofish_projects_corpus_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade,
  constraint mirofish_projects_id_check
    check (project_id ~ '^proj_[A-Za-z0-9_-]{1,128}$'),
  constraint mirofish_projects_data_check
    check (jsonb_typeof(project_data) = 'object')
);

create trigger mirofish_projects_set_updated_at
before update on public.mirofish_projects
for each row execute function public.rag_set_updated_at();

create index mirofish_projects_scope_updated_idx
  on public.mirofish_projects (tenant_id, corpus_id, updated_at desc);
