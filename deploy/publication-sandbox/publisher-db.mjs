import pg from 'pg';
import { readSandboxConfig } from './sandbox.mjs';

const PUBLICATION_FUNCTIONS = [
  'rag_publication_control(text,text,text,text,jsonb)',
  'rag_stage_publication_asset(text,text,text,bigint,bigint,uuid,text,text,text,bytea,bytea,jsonb)',
  'rag_read_staged_publication_asset(text,text,text,bigint,bigint,uuid,text)',
  'rag_elasticsearch_publication_operation(text,text,text,text,jsonb)',
  'rag_record_publication_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text,text,text,text)',
  'rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text)',
  'rag_prepare_publication_intent(uuid,text,text,text,text,text,text)',
  'rag_read_publication_intent(uuid,text,text,text)',
  'rag_read_publication_grant_identity(uuid)',
  'rag_record_publication_grant_event(uuid,text)',
  'rag_list_publication_intents(text,text,text,uuid,integer)',
  'rag_list_all_publication_intents(uuid,integer)',
  'rag_list_publication_grant_events(uuid,bigint,integer)',
  'rag_claim_publication_request(uuid)',
  'rag_has_pending_publication()',
  'rag_inspect_publication_claim(uuid)',
  'rag_list_publication_claims(uuid,integer)',
  'rag_reserve_document_graph(text,text,text,bigint,bigint,uuid,text,text,text)',
  'rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text)',
  'rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text)',
];
const APP_QUEUE_FUNCTIONS = [
  'rag_read_publication_view(text,text,text[])',
  'rag_read_publication_source(text,text,text,bigint,bigint,uuid,text,text[],text)',
  'rag_enqueue_publication_request(uuid,text,text,text,text,bytea,bytea,jsonb)',
  'rag_read_publication_request_state(uuid,text,text,text)',
  'rag_read_publication_request_result(uuid,text,text,text)',
  'rag_read_document_graph_view(text,text,text[])',
  'rag_read_document_graph_snapshot(text,text,text,text[])',
];

/** Run only as the trusted sandbox migration principal, never in the app. */
export async function grantSandboxPublisher(id) {
  const config = readSandboxConfig(id);
  const client = new pg.Client({ host: '127.0.0.1', port: config.ports.postgres,
    database: config.database ?? 'publication_sandbox', user: 'pub_migration', password: config.credentials.dbMigration });
  await client.connect();
  try {
    const selected = await client.query("select current_database() as name, to_regclass('public.rag_schema_migrations') as ledger");
    if (selected.rows[0]?.name !== (config.database ?? 'publication_sandbox') || !selected.rows[0]?.ledger) throw new Error('Sandbox schema is unavailable.');
    const latest = await client.query("select name from public.rag_schema_migrations where version='0023'");
    if (latest.rowCount !== 1) throw new Error('Sandbox migration 0023 is required.');
    await client.query('begin');
    try {
      await client.query('grant usage on schema public to pub_publisher');
      for (const signature of PUBLICATION_FUNCTIONS) {
        // Application submission/read identities must not retain any older
        // direct-control grants when the deployment upgrades the protocol.
        await client.query(`revoke all privileges on function public.${signature} from pub_app`);
        // Signatures are a fixed internal allowlist, never user-supplied SQL.
        await client.query(`grant execute on function public.${signature} to pub_publisher`);
      }
      for (const signature of APP_QUEUE_FUNCTIONS) await client.query(`grant execute on function public.${signature} to pub_app`);
      const check = await client.query(`select
        has_function_privilege('pub_app', 'public.rag_record_publication_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text,text,text,text)', 'EXECUTE') as app_seal,
        has_function_privilege('pub_app', 'public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text)', 'EXECUTE') as app_publish,
        has_function_privilege('pub_publisher', 'public.rag_record_publication_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text,text,text,text)', 'EXECUTE') as publisher_seal,
        has_function_privilege('pub_publisher', 'public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text)', 'EXECUTE') as publisher_publish,
        has_table_privilege('pub_publisher','public.document_publication_provider_seals','UPDATE') as publisher_direct_write,
        has_function_privilege('pub_app','public.rag_claim_publication_request(uuid)','EXECUTE') as app_claim,
        has_function_privilege('pub_publisher','public.rag_claim_publication_request(uuid)','EXECUTE') as publisher_claim,
        has_function_privilege('pub_publisher','public.rag_inspect_publication_claim(uuid)','EXECUTE') as publisher_inspect,
        has_function_privilege('pub_publisher','public.rag_list_publication_claims(uuid,integer)','EXECUTE') as publisher_discover,
        has_function_privilege('pub_app','public.rag_enqueue_publication_request(uuid,text,text,text,text,bytea,bytea,jsonb)','EXECUTE') as app_enqueue,
        has_function_privilege('pub_app','public.rag_read_publication_request_state(uuid,text,text,text)','EXECUTE') as app_queue_read,
        has_function_privilege('pub_app','public.rag_read_publication_request_result(uuid,text,text,text)','EXECUTE') as app_result_read,
        has_function_privilege('pub_publisher','public.rag_enqueue_publication_request(uuid,text,text,text,text,bytea,bytea,jsonb)','EXECUTE') as publisher_enqueue,
        has_table_privilege('pub_app','public.publication_requests','INSERT,UPDATE,DELETE,TRUNCATE') as app_queue_write,
        has_table_privilege('pub_publisher','public.publication_requests','INSERT,UPDATE,DELETE,TRUNCATE') as publisher_queue_write,
        has_function_privilege('pub_app','public.rag_reserve_document_graph(text,text,text,bigint,bigint,uuid,text,text,text)','EXECUTE') as app_graph_reserve,
        has_function_privilege('pub_publisher','public.rag_reserve_document_graph(text,text,text,bigint,bigint,uuid,text,text,text)','EXECUTE') as publisher_graph_reserve,
        has_table_privilege('pub_publisher','public.document_graph_dispatches','INSERT,UPDATE,DELETE,TRUNCATE') as publisher_graph_write`);
      const row = check.rows[0];
      if (!row || row.app_seal || row.app_publish || !row.publisher_seal || !row.publisher_publish || row.publisher_direct_write
        || row.app_claim || !row.publisher_claim || !row.publisher_inspect || !row.publisher_discover || !row.app_enqueue
        || !row.app_queue_read || !row.app_result_read || row.publisher_enqueue || row.app_queue_write || row.publisher_queue_write
        || row.app_graph_reserve || !row.publisher_graph_reserve || row.publisher_graph_write) {
        throw new Error('Sandbox publisher grants are not isolated.');
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    return { publisherRole: 'pub_publisher', directTableWrites: false, productionAuthorized: false };
  } finally { await client.end(); }
}
