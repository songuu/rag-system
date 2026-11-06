import { queryPostgres, type PostgresQueryClient } from '../postgres/client';

/** Reader admission requires only the authoritative view/source functions.
 * Publishing and ingestion privileges are deliberately not reader prerequisites. */
export async function assertPublicationReaderPostgresCapability(client: PostgresQueryClient): Promise<void> {
  return assertApplicationProfile(client, ['public.rag_read_publication_view(text,text,text[])',
    'public.rag_read_publication_source(text,text,text,bigint,bigint,uuid,text,text[],text)']);
}

/** Queue submission never requires direct publication-control or sealing rights. */
export async function assertPublicationQueuePostgresCapability(client: PostgresQueryClient): Promise<void> {
  return assertApplicationProfile(client, ['public.rag_enqueue_publication_request(uuid,text,text,text,text,bytea,bytea,jsonb)',
    'public.rag_read_publication_request_state(uuid,text,text,text)', 'public.rag_read_publication_request_result(uuid,text,text,text)']);
}

export async function assertPublicationGraphPostgresCapability(client: PostgresQueryClient): Promise<void> {
  return assertApplicationProfile(client, ['public.rag_read_document_graph_view(text,text,text[])',
    'public.rag_read_document_graph_snapshot(text,text,text,text[])']);
}

async function assertApplicationProfile(client: PostgresQueryClient, required: string[]): Promise<void> {
  const result = await queryPostgres<{ ready: boolean }>(client, `
    with protected_tables(name) as (values
      ('public.document_publication_collection_reservations'), ('public.document_publication_heads'),
      ('public.document_publication_attempts'), ('public.document_publication_observations'),
      ('public.document_publication_assets'), ('public.document_publication_asset_chunks'),
      ('public.elasticsearch_publication_operations'), ('public.document_publication_provider_seals'),
      ('public.document_publication_prior_assets'), ('public.document_publication_receipts'),
      ('public.publication_requests'), ('public.publication_operation_intents'), ('public.publication_grant_events'),
      ('public.document_graph_dispatches'), ('public.document_graph_publication_seals')
    ), required(signature) as (select unnest($1::text[])), forbidden(signature) as (values
      ('public.rag_record_publication_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text,text,text,text)'),
      ('public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text)'),
      ('public.rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text)'),
      ('public.rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text)'),
      ('public.rag_claim_publication_request(uuid)'),
      ('public.rag_publication_control(text,text,text,text,jsonb)'),
      ('public.rag_stage_publication_asset(text,text,text,bigint,bigint,uuid,text,text,text,bytea,bytea,jsonb)'),
      ('public.rag_elasticsearch_publication_operation(text,text,text,text,jsonb)')
    )
    select current_user = session_user
      and exists (select 1 from pg_catalog.pg_roles r where r.rolname=current_user
        and not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole and not r.rolcreatedb and not r.rolreplication)
      and not exists (select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member where r.rolname=current_user)
      and not pg_catalog.has_schema_privilege(current_user,'public','CREATE')
      and not exists (select 1 from protected_tables t left join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass(t.name)
        where c.oid is null or pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER')
          or pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
      and not exists (select 1 from required t left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(t.signature)
        where p.oid is null or pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER')
          or not pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE'))
      and not exists (select 1 from forbidden t left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(t.signature)
        where p.oid is null or pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER')
          or pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) as ready`, [required], 'check publication application capability');
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new Error('Publication reader database capability is unavailable.');
}
