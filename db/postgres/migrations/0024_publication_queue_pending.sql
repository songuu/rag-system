-- Read-only admission for the dedicated publisher loop. Empty polls never
-- consume an operation identity or attempt an irreversible queue claim.
create function public.rag_has_pending_publication()
returns boolean language sql stable security definer set search_path=pg_catalog as $$
  select exists(select 1 from public.publication_requests where state='queued');
$$;
revoke all on function public.rag_has_pending_publication() from public;
