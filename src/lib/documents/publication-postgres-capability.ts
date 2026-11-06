import { queryPostgres, type PostgresQueryClient } from '../postgres/client';

export class PublicationDatabaseCapabilityError extends Error {
  readonly code = 'PUBLICATION_DATABASE_CAPABILITY_UNAVAILABLE';
  constructor() {
    super('Publication database capability is unavailable or insufficiently isolated.');
    this.name = 'PublicationDatabaseCapabilityError';
  }
}

/** Run on the actual application connection before enabling publication.
 * Authorization of the requesting actor remains the responsibility of the application.
 */
export async function assertPublicationPostgresCapability(client: PostgresQueryClient): Promise<void> {
  try {
    const result = await queryPostgres<{ ready: boolean }>(client, `
      with protected_tables(name) as (values
        ('public.document_publication_collection_reservations'),
        ('public.document_publication_heads'), ('public.document_publication_attempts'),
        ('public.document_publication_observations'), ('public.document_publication_assets'),
        ('public.document_publication_asset_chunks'), ('public.elasticsearch_publication_operations'),
        ('public.document_publication_provider_seals'), ('public.document_publication_prior_assets'),
        ('public.document_publication_receipts'), ('public.publication_requests'),
        ('public.publication_operation_intents'), ('public.publication_grant_events')
      ), allowed_functions(signature) as (values
        ('public.rag_publication_control(text,text,text,text,jsonb)'),
        ('public.rag_stage_publication_asset(text,text,text,bigint,bigint,uuid,text,text,text,bytea,bytea,jsonb)'),
        ('public.rag_read_staged_publication_asset(text,text,text,bigint,bigint,uuid,text)'),
        ('public.rag_elasticsearch_publication_operation(text,text,text,text,jsonb)'),
        ('public.rag_read_publication_view(text,text,text[])'),
        ('public.rag_read_publication_source(text,text,text,bigint,bigint,uuid,text,text[],text)'),
        ('public.rag_enqueue_publication_request(uuid,text,text,text,text,bytea,bytea,jsonb)'),
        ('public.rag_read_publication_request_state(uuid,text,text,text)'),
        ('public.rag_read_publication_request_result(uuid,text,text,text)')
      ), publisher_functions(signature) as (values
        ('public.rag_record_publication_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text,text,text,text)'),
        ('public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text)'),
        ('public.rag_claim_publication_request(uuid)'), ('public.rag_inspect_publication_claim(uuid)'),
        ('public.rag_list_publication_claims(uuid,integer)')
      )
      select exists (select 1 from pg_catalog.pg_roles role
        where role.rolname = current_user and not role.rolsuper and not role.rolbypassrls)
        and not pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
        and not exists (select 1 from protected_tables target
          left join pg_catalog.pg_class object on object.oid = pg_catalog.to_regclass(target.name)
          where object.oid is null
            or pg_catalog.pg_has_role(current_user, object.relowner, 'MEMBER')
            or pg_catalog.has_table_privilege(current_user, object.oid,
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
        and not exists (select 1 from allowed_functions target
          left join pg_catalog.pg_proc object on object.oid = pg_catalog.to_regprocedure(target.signature)
          where object.oid is null
            or pg_catalog.pg_has_role(current_user, object.proowner, 'MEMBER')
            or not pg_catalog.has_function_privilege(current_user, object.oid, 'EXECUTE'))
        and not exists (select 1 from publisher_functions target
          left join pg_catalog.pg_proc object on object.oid = pg_catalog.to_regprocedure(target.signature)
          where object.oid is null
            or pg_catalog.pg_has_role(current_user, object.proowner, 'MEMBER')
            or pg_catalog.has_function_privilege(current_user, object.oid, 'EXECUTE')) as ready`,
    [], 'check publication database capability');
    if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new PublicationDatabaseCapabilityError();
  } catch {
    throw new PublicationDatabaseCapabilityError();
  }
}
