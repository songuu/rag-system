import { queryPostgres, type PostgresQueryClient } from '../postgres/client';

/** Validated on the exact connected publisher role, not on a settings digest. */
export const PUBLISHER_CAPABILITY_SQL = `
with targets(name) as (values
 ('public.document_publication_collection_reservations'),('public.document_publication_heads'),
 ('public.document_publication_attempts'),('public.document_publication_observations'),
 ('public.document_publication_assets'),('public.document_publication_asset_chunks'),
 ('public.elasticsearch_publication_operations'),('public.document_publication_provider_seals'),
 ('public.document_publication_prior_assets'),('public.document_publication_receipts'),
 ('public.publication_requests'),('public.publication_operation_intents'),('public.publication_grant_events'),
 ('public.document_graph_dispatches'), ('public.document_graph_publication_seals'), ('public.document_assets'), ('public.corpora')
), required(signature) as (values
 ('public.rag_publication_control(text,text,text,text,jsonb)'),
 ('public.rag_stage_publication_asset(text,text,text,bigint,bigint,uuid,text,text,text,bytea,bytea,jsonb)'),
 ('public.rag_read_staged_publication_asset(text,text,text,bigint,bigint,uuid,text)'),
 ('public.rag_elasticsearch_publication_operation(text,text,text,text,jsonb)'),
 ('public.rag_record_publication_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text,text,text,text)'),
 ('public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text)'),
 ('public.rag_prepare_publication_intent(uuid,text,text,text,text,text,text)'),
 ('public.rag_read_publication_intent(uuid,text,text,text)'),
 ('public.rag_read_publication_grant_identity(uuid)'), ('public.rag_record_publication_grant_event(uuid,text)'),
 ('public.rag_list_publication_intents(text,text,text,uuid,integer)'),
 ('public.rag_list_all_publication_intents(uuid,integer)'), ('public.rag_list_publication_grant_events(uuid,bigint,integer)'),
 ('public.rag_claim_publication_request(uuid)'), ('public.rag_inspect_publication_claim(uuid)'),
 ('public.rag_has_pending_publication()'),
 ('public.rag_list_publication_claims(uuid,integer)'),
 ('public.rag_reserve_document_graph(text,text,text,bigint,bigint,uuid,text,text,text)'),
 ('public.rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text)'),
 ('public.rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text)')
), forbidden(signature) as (values
 ('public.rag_enqueue_publication_request(uuid,text,text,text,text,bytea,bytea,jsonb)')
)
select exists (select 1 from pg_catalog.pg_roles r where r.rolname=current_user
 and not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole and not r.rolcreatedb and not r.rolreplication)
 and current_user = session_user
 and not exists (select 1 from pg_catalog.pg_auth_members membership
   join pg_catalog.pg_roles member on member.oid=membership.member
   where member.rolname=current_user)
 and not pg_catalog.has_schema_privilege(current_user,'public','CREATE')
 and not exists (select 1 from targets t left join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass(t.name)
   where c.oid is null or pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER')
   or pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
 and not exists (select 1 from required t left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(t.signature)
   where p.oid is null or pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER')
   or not pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE'))
 and not exists (select 1 from forbidden t left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(t.signature)
   where p.oid is null or pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER')
   or pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE'))
 and not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prosecdef and p.prorettype <> 'pg_catalog.trigger'::regtype
     and pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
     and not exists (select 1 from required r where pg_catalog.to_regprocedure(r.signature)=p.oid)) as ready`;

export async function assertPublisherPostgresCapability(client: PostgresQueryClient): Promise<void> {
  const result = await queryPostgres<{ ready: boolean }>(client, PUBLISHER_CAPABILITY_SQL, [], 'check publisher database capability');
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new Error('Publisher database capability is unavailable or insufficiently isolated.');
}
