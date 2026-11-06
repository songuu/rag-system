-- Only the publication control plane can produce an active result. A queue
-- claim or an absent intent is never sufficient evidence of publication.
create function public.rag_read_publication_request_result(p_request uuid,p_tenant text,p_corpus text,p_document text)
returns jsonb language sql stable security definer set search_path=pg_catalog as $$
  select jsonb_build_object('requestId',r.request_id::text,'queueState',r.state,
    'operationId',r.operation_id::text,'attemptState',a.status,
    'currentlyActive',coalesce(a.status='published' and not h.revoked and h.active_generation=a.generation,false),
    'generation',a.generation::text,'headRevision',h.revision::text)
  from public.publication_requests r
  left join public.publication_operation_intents i on i.operation_id=r.operation_id
    and i.tenant_id=r.tenant_id and i.corpus_id=r.corpus_id and i.document_id=r.document_id
    and i.manifest_digest='sha256:' || encode(sha256(convert_to(r.manifest_json,'UTF8')),'hex')
    and i.content_version=(r.manifest_json::jsonb)->>'contentVersion'
  left join public.document_publication_attempts a on a.tenant_id=i.tenant_id and a.corpus_id=i.corpus_id
    and a.document_id=i.document_id and a.idempotency_key=i.operation_id::text
    and a.manifest_digest=i.manifest_digest and a.content_version=i.content_version
    and a.physical_collection=i.physical_collection
  left join public.document_publication_heads h on h.tenant_id=a.tenant_id and h.corpus_id=a.corpus_id and h.document_id=a.document_id
  where r.request_id=p_request and r.tenant_id=p_tenant and r.corpus_id=p_corpus and r.document_id=p_document
$$;
revoke all on function public.rag_read_publication_request_result(uuid,text,text,text) from public;
