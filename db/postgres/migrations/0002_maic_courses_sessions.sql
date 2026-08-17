create table public.maic_courses (
  tenant_id text not null,
  corpus_id text not null,
  course_id text not null,
  payload jsonb not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint maic_courses_pk primary key (tenant_id, corpus_id, course_id),
  constraint maic_courses_id_not_blank_check check (btrim(course_id) <> ''),
  constraint maic_courses_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint maic_courses_payload_id_check check (payload->>'course_id' = course_id),
  constraint maic_courses_payload_status_check
    check (payload->>'status' in ('uploaded', 'preparing', 'ready', 'failed')),
  constraint maic_courses_version_positive_check check (version > 0),
  constraint maic_courses_updated_after_created_check check (updated_at >= created_at),
  constraint maic_courses_corpus_scope_fk
    foreign key (tenant_id, corpus_id)
    references public.corpora (tenant_id, id)
    on delete cascade
);

create table public.maic_classroom_sessions (
  tenant_id text not null,
  corpus_id text not null,
  course_id text not null,
  session_id text not null,
  payload jsonb not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint maic_classroom_sessions_pk primary key (tenant_id, corpus_id, session_id),
  constraint maic_classroom_sessions_id_not_blank_check check (btrim(session_id) <> ''),
  constraint maic_classroom_sessions_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint maic_classroom_sessions_state_object_check
    check (jsonb_typeof(payload->'state') = 'object'),
  constraint maic_classroom_sessions_payload_id_check check (payload->>'session_id' = session_id),
  constraint maic_classroom_sessions_payload_course_check check (payload->>'course_id' = course_id),
  constraint maic_classroom_sessions_payload_status_check
    check (payload #>> '{state,status}' in ('idle', 'running', 'paused', 'ended', 'error')),
  constraint maic_classroom_sessions_version_positive_check check (version > 0),
  constraint maic_classroom_sessions_updated_after_created_check check (updated_at >= created_at),
  constraint maic_classroom_sessions_course_scope_fk
    foreign key (tenant_id, corpus_id, course_id)
    references public.maic_courses (tenant_id, corpus_id, course_id)
    on delete cascade
);

create function public.rag_reject_maic_course_identity_reassignment()
returns trigger
language plpgsql
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.corpus_id is distinct from old.corpus_id
    or new.course_id is distinct from old.course_id then
    raise exception 'MAIC course scope and identity cannot be reassigned';
  end if;
  return new;
end;
$$;

create function public.rag_reject_maic_session_identity_reassignment()
returns trigger
language plpgsql
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.corpus_id is distinct from old.corpus_id
    or new.course_id is distinct from old.course_id
    or new.session_id is distinct from old.session_id then
    raise exception 'MAIC session scope and identity cannot be reassigned';
  end if;
  return new;
end;
$$;

create trigger maic_courses_reject_identity_reassignment
before update of tenant_id, corpus_id, course_id on public.maic_courses
for each row execute function public.rag_reject_maic_course_identity_reassignment();

create trigger maic_courses_set_updated_at
before update on public.maic_courses
for each row execute function public.rag_set_updated_at();

create trigger maic_classroom_sessions_reject_identity_reassignment
before update of tenant_id, corpus_id, course_id, session_id on public.maic_classroom_sessions
for each row execute function public.rag_reject_maic_session_identity_reassignment();

create trigger maic_classroom_sessions_set_updated_at
before update on public.maic_classroom_sessions
for each row execute function public.rag_set_updated_at();

create index maic_courses_scope_created_idx
  on public.maic_courses (tenant_id, corpus_id, created_at desc, course_id);

create unique index maic_classroom_sessions_one_active_course_idx
  on public.maic_classroom_sessions (tenant_id, corpus_id, course_id)
  where ((payload #>> '{state,status}') <> 'ended');

create index maic_classroom_sessions_scope_updated_idx
  on public.maic_classroom_sessions (tenant_id, corpus_id, updated_at desc, session_id);
