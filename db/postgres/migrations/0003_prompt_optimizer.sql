create table public.prompt_optimizer_model_profiles (
  tenant_id text not null,
  corpus_id text not null,
  profile_id text not null,
  name text not null,
  provider text not null,
  model text not null,
  base_url text,
  settings jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  archived_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prompt_optimizer_model_profiles_pk primary key (tenant_id, corpus_id, profile_id),
  constraint prompt_optimizer_model_profiles_id_format_check
    check (profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint prompt_optimizer_model_profiles_name_check check (btrim(name) <> ''),
  constraint prompt_optimizer_model_profiles_provider_check
    check (provider in ('openai', 'openrouter', 'compatible', 'ollama')),
  constraint prompt_optimizer_model_profiles_model_check check (btrim(model) <> ''),
  constraint prompt_optimizer_model_profiles_base_url_check
    check (base_url is null or btrim(base_url) <> ''),
  constraint prompt_optimizer_model_profiles_settings_check
    check (jsonb_typeof(settings) = 'object'),
  constraint prompt_optimizer_model_profiles_version_check check (version > 0),
  constraint prompt_optimizer_model_profiles_updated_check check (updated_at >= created_at),
  constraint prompt_optimizer_model_profiles_scope_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade
);

create table public.prompt_optimizer_workspaces (
  tenant_id text not null,
  corpus_id text not null,
  workspace_id text not null,
  title text not null,
  original_prompt text not null,
  mode text not null default 'general',
  variables jsonb not null default '{}'::jsonb,
  selected_model_profile_id text,
  current_version integer not null default 0,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prompt_optimizer_workspaces_pk primary key (tenant_id, corpus_id, workspace_id),
  constraint prompt_optimizer_workspaces_id_format_check
    check (workspace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint prompt_optimizer_workspaces_title_check
    check (btrim(title) <> '' and char_length(title) <= 160),
  constraint prompt_optimizer_workspaces_prompt_check
    check (btrim(original_prompt) <> '' and char_length(original_prompt) <= 20000),
  constraint prompt_optimizer_workspaces_mode_check
    check (mode in ('general', 'structured', 'image')),
  constraint prompt_optimizer_workspaces_variables_check
    check (jsonb_typeof(variables) = 'object'),
  constraint prompt_optimizer_workspaces_current_version_check check (current_version >= 0),
  constraint prompt_optimizer_workspaces_version_check check (version > 0),
  constraint prompt_optimizer_workspaces_updated_check check (updated_at >= created_at),
  constraint prompt_optimizer_workspaces_scope_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade,
  constraint prompt_optimizer_workspaces_profile_fk
    foreign key (tenant_id, corpus_id, selected_model_profile_id)
    references public.prompt_optimizer_model_profiles (tenant_id, corpus_id, profile_id)
);

create table public.prompt_optimizer_versions (
  tenant_id text not null,
  corpus_id text not null,
  workspace_id text not null,
  version_number integer not null,
  parent_version integer,
  kind text not null,
  prompt text not null,
  instruction text,
  analysis jsonb not null default '{}'::jsonb,
  variables_snapshot jsonb not null default '{}'::jsonb,
  model_profile_id text,
  template_id text not null,
  created_at timestamptz not null default now(),
  constraint prompt_optimizer_versions_pk
    primary key (tenant_id, corpus_id, workspace_id, version_number),
  constraint prompt_optimizer_versions_number_check check (version_number > 0),
  constraint prompt_optimizer_versions_parent_check
    check (parent_version is null or (parent_version > 0 and parent_version < version_number)),
  constraint prompt_optimizer_versions_kind_check
    check (kind in ('original', 'optimized', 'iterated', 'manual')),
  constraint prompt_optimizer_versions_prompt_check
    check (btrim(prompt) <> '' and char_length(prompt) <= 20000),
  constraint prompt_optimizer_versions_instruction_check
    check (instruction is null or char_length(instruction) <= 2000),
  constraint prompt_optimizer_versions_analysis_check check (jsonb_typeof(analysis) = 'object'),
  constraint prompt_optimizer_versions_variables_check
    check (jsonb_typeof(variables_snapshot) = 'object'),
  constraint prompt_optimizer_versions_template_check check (btrim(template_id) <> ''),
  constraint prompt_optimizer_versions_workspace_fk
    foreign key (tenant_id, corpus_id, workspace_id)
    references public.prompt_optimizer_workspaces (tenant_id, corpus_id, workspace_id)
    on delete cascade,
  constraint prompt_optimizer_versions_parent_fk
    foreign key (tenant_id, corpus_id, workspace_id, parent_version)
    references public.prompt_optimizer_versions (tenant_id, corpus_id, workspace_id, version_number),
  constraint prompt_optimizer_versions_profile_fk
    foreign key (tenant_id, corpus_id, model_profile_id)
    references public.prompt_optimizer_model_profiles (tenant_id, corpus_id, profile_id)
);

create function public.rag_reject_prompt_optimizer_identity_reassignment()
returns trigger language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.corpus_id is distinct from old.corpus_id then
    raise exception 'prompt optimizer scope cannot be reassigned';
  end if;
  return new;
end;
$$;

create function public.rag_reject_prompt_optimizer_version_update()
returns trigger language plpgsql as $$
begin
  raise exception 'prompt optimizer versions are immutable';
end;
$$;

create trigger prompt_optimizer_model_profiles_reject_scope_reassignment
before update of tenant_id, corpus_id on public.prompt_optimizer_model_profiles
for each row execute function public.rag_reject_prompt_optimizer_identity_reassignment();

create trigger prompt_optimizer_model_profiles_set_updated_at
before update on public.prompt_optimizer_model_profiles
for each row execute function public.rag_set_updated_at();

create trigger prompt_optimizer_workspaces_reject_scope_reassignment
before update of tenant_id, corpus_id on public.prompt_optimizer_workspaces
for each row execute function public.rag_reject_prompt_optimizer_identity_reassignment();

create trigger prompt_optimizer_workspaces_set_updated_at
before update on public.prompt_optimizer_workspaces
for each row execute function public.rag_set_updated_at();

create trigger prompt_optimizer_versions_reject_update
before update on public.prompt_optimizer_versions
for each row execute function public.rag_reject_prompt_optimizer_version_update();

create unique index prompt_optimizer_one_default_profile_idx
  on public.prompt_optimizer_model_profiles (tenant_id, corpus_id)
  where is_default and archived_at is null;

create unique index prompt_optimizer_profile_name_idx
  on public.prompt_optimizer_model_profiles (tenant_id, corpus_id, lower(name))
  where archived_at is null;

create index prompt_optimizer_workspaces_updated_idx
  on public.prompt_optimizer_workspaces (tenant_id, corpus_id, updated_at desc, workspace_id);

create index prompt_optimizer_versions_created_idx
  on public.prompt_optimizer_versions
  (tenant_id, corpus_id, workspace_id, created_at desc, version_number desc);
