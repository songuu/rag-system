-- Scope is authenticated by the trusted publisher service. UUID keyset pages
-- are bounded; new concurrent inserts may precede a cursor, so recovery must
-- repeat complete scans. No operation identity is removed or recycled.
create index publication_operation_intents_scope_id_idx
  on public.publication_operation_intents (tenant_id, corpus_id, document_id, operation_id);
create function public.rag_list_publication_intents(tenant text, corpus text, document text, after_id uuid, page_size integer)
returns table(operation_id uuid) language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if tenant is null or length(tenant) not between 1 and 128 or tenant <> btrim(tenant)
    or corpus is null or length(corpus) not between 1 and 128 or corpus <> btrim(corpus)
    or document is null or length(document) not between 1 and 256 or document <> btrim(document)
    or page_size is null or page_size < 1 or page_size > 100 then
    raise exception 'invalid publication intent discovery' using errcode = '22023';
  end if;
  return query select i.operation_id from public.publication_operation_intents i
    where i.tenant_id = tenant and i.corpus_id = corpus and i.document_id = document
      and (after_id is null or i.operation_id > after_id)
    order by i.operation_id limit page_size;
end;
$$;
revoke all on function public.rag_list_publication_intents(text,text,text,uuid,integer) from public;
