import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { readSandboxConfig } from './sandbox.mjs';

/** Provision an independent read-only identity only inside the selected sandbox. */
export async function provisionSandboxObserver(id) {
  const config = readSandboxConfig(id);
  const path = join(config.path, 'observer-credential.json');
  if (!existsSync(path)) {
    const credentials = { user: `pub_obs_${randomBytes(8).toString('hex')}`, password: `Aa1${randomBytes(24).toString('hex')}` };
    writeFileSync(path, JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
  }
  const credentials = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^pub_obs_[a-f0-9]{16}$/.test(credentials.user) || !/^Aa1[a-f0-9]{48}$/.test(credentials.password)) {
    throw new Error('Invalid sandbox observer credential.');
  }
  const base = { host: '127.0.0.1', port: config.ports.postgres, database: 'publication_sandbox' };
  const admin = new pg.Client({ ...base, user: 'sandbox_admin', password: config.credentials.postgresAdmin });
  const owner = new pg.Client({ ...base, user: 'pub_migration', password: config.credentials.dbMigration });
  try {
    await admin.connect();
    const existing = await admin.query('select 1 from pg_roles where rolname=$1', [credentials.user]);
    if (!existing.rowCount) await admin.query(`create role "${credentials.user}" login noinherit nosuperuser nocreatedb nocreaterole password '${credentials.password}'`);
    const role = await admin.query(`select r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit, r.rolreplication, r.rolbypassrls,
      exists(select 1 from pg_auth_members m where m.member=r.oid) as member from pg_roles r where r.rolname=$1`, [credentials.user]);
    if (!role.rows[0] || Object.values(role.rows[0]).some(Boolean)) throw new Error('Sandbox observer role is not isolated.');
    await owner.connect();
    await owner.query(`grant usage on schema public to "${credentials.user}"`);
    await owner.query(`grant execute on function public.rag_list_all_publication_intents(uuid,integer) to "${credentials.user}"`);
    await owner.query(`grant execute on function public.rag_list_publication_grant_events(uuid,bigint,integer) to "${credentials.user}"`);
    const extra = await owner.query(`select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
      and n.nspname not like 'pg_temp_%' and p.prorettype <> 'pg_catalog.trigger'::regtype
      and has_function_privilege($1,p.oid,'EXECUTE')
      and p.oid not in ('public.rag_list_all_publication_intents(uuid,integer)'::regprocedure,
        'public.rag_list_publication_grant_events(uuid,bigint,integer)'::regprocedure) limit 1`, [credentials.user]);
    if (extra.rowCount) throw new Error('Sandbox observer inherits unexpected function privileges.');
    // has_*_privilege resolves explicit, inherited, PUBLIC and ownership
    // privileges. Check every non-system schema, not only publication tables.
    const capabilities = await owner.query(`select
      exists(select 1 from pg_database d where d.datname=current_database() and d.datdba=(select oid from pg_roles where rolname=$1)) as database_owner,
      exists(select 1 from pg_namespace n where n.nspname not in ('pg_catalog','information_schema')
        and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%'
        and (n.nspowner=(select oid from pg_roles where rolname=$1) or has_schema_privilege($1,n.oid,'CREATE'))) as schema_authority,
      exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp_%' and (c.relowner=(select oid from pg_roles where rolname=$1)
          or c.relkind in ('r','p','v','m','f') and (has_table_privilege($1,c.oid,'SELECT') or has_table_privilege($1,c.oid,'INSERT')
            or has_table_privilege($1,c.oid,'UPDATE') or has_table_privilege($1,c.oid,'DELETE')
            or has_table_privilege($1,c.oid,'TRUNCATE') or has_table_privilege($1,c.oid,'REFERENCES')
            or has_table_privilege($1,c.oid,'TRIGGER') or has_any_column_privilege($1,c.oid,'SELECT')
            or has_any_column_privilege($1,c.oid,'INSERT') or has_any_column_privilege($1,c.oid,'UPDATE')
            or has_any_column_privilege($1,c.oid,'REFERENCES'))
          or c.relkind='S' and (has_sequence_privilege($1,c.oid,'SELECT') or has_sequence_privilege($1,c.oid,'USAGE') or has_sequence_privilege($1,c.oid,'UPDATE')))) as relation_authority,
      exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp_%' and p.proowner=(select oid from pg_roles where rolname=$1)) as function_owner,
      exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
        where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp_%' and t.typowner=(select oid from pg_roles where rolname=$1)) as type_owner`, [credentials.user]);
    if (!capabilities.rows[0] || Object.values(capabilities.rows[0]).some(Boolean)) {
      throw new Error('Sandbox observer has unexpected ownership or access privileges.');
    }
    return { ...base, ...credentials };
  } finally { await owner.end().catch(() => {}); await admin.end().catch(() => {}); }
}
