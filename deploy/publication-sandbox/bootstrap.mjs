import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(label, fn) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try { return await fn(); } catch { await sleep(2000); }
  }
  throw new Error(`${label} did not become ready.`);
}

function assertStatus(value, label) {
  const s = value?.status ?? value;
  if (!s || s.error_code !== 'Success' || (s.code !== undefined && Number(s.code) !== 0)) {
    throw new Error(`${label} failed.`);
  }
}

const dbOptions = (config, user, password) => ({ host: '127.0.0.1', port: config.ports.postgres,
  database: 'publication_sandbox', user, password, connectionTimeoutMillis: 3000 });
const esClient = (config, user, password) => new ElasticsearchClient({ node: `https://127.0.0.1:${config.ports.elasticsearch}`,
  auth: { username: user, password }, tls: { ca: config.ca }, requestTimeout: 5000, maxRetries: 0 });
const milvusClient = (config, user, password) => new MilvusClient({ address: `127.0.0.1:${config.ports.milvus}`,
  ...(user ? { username: user, password } : {}), timeout: 5000, maxRetries: 0, isGlobal: false,
  // Avoid an eager, unobserved connectPromise when deliberately probing an
  // invalid credential. Each actual RPC is awaited and its error handled.
  __SKIP_CONNECT__: true, channelOptions: { 'grpc.enable_retries': 0 } });

export async function bootstrapSandbox(config) {
  const c = config.credentials;
  const pgAdmin = await retry('PostgreSQL', async () => {
    const client = new pg.Client(dbOptions(config, 'sandbox_admin', c.postgresAdmin));
    try { await client.connect(); return client; } catch (error) { await client.end().catch(() => {}); throw error; }
  });
  try {
    const result = await pgAdmin.query('select current_database() as db');
    if (result.rows[0]?.db !== 'publication_sandbox') throw new Error('Unexpected test database.');
    for (const [user, password] of [['pub_migration', c.dbMigration], ['pub_app', c.dbApp], ['pub_publisher', c.dbPublisher]]) {
      if (!/^Aa1[a-f0-9]{48}$/.test(password)) throw new Error('Invalid generated password.');
      const found = await pgAdmin.query('select 1 from pg_roles where rolname = $1', [user]);
      if (!found.rowCount) await pgAdmin.query(`create role ${user} login password '${password}'`);
      else await pgAdmin.query(`alter role ${user} login password '${password}'`);
    }
    await pgAdmin.query('alter database publication_sandbox owner to pub_migration');
    await pgAdmin.query('alter schema public owner to pub_migration');
    await pgAdmin.query('revoke create on schema public from public');
  } finally { await pgAdmin.end(); }

  const es = esClient(config, 'elastic', c.elasticAdmin);
  try {
    await retry('Elasticsearch', () => es.info());
    const indexNames = ['codex-generation-seal-*', 'rag-publication-*'];
    for (const [name, privileges] of [
      ['pub_writer_role', ['create_index', 'write', 'read', 'view_index_metadata']],
      ['pub_sealer_role', ['manage', 'read', 'view_index_metadata']],
      ['pub_reader_role', ['read', 'view_index_metadata']],
    ]) await es.security.putRole({ name, indices: [{ names: indexNames, privileges }] });
    for (const [username, password, role] of [
      ['pub_writer', c.esWriter, 'pub_writer_role'], ['pub_sealer', c.esSealer, 'pub_sealer_role'],
      ['pub_reader', c.esReader, 'pub_reader_role'],
    ]) await es.security.putUser({ username, password, roles: [role] });
    // These reserved identities can manage index templates but are not used by
    // the standalone sandbox. Disable them before accepting publication work.
    for (const username of ['kibana', 'kibana_system', 'remote_monitoring_user']) {
      await es.security.disableUser({ username });
    }
  } finally { await es.close(); }

  const milvus = await retry('Milvus', async () => {
    const updated = milvusClient(config, 'root', c.milvusAdmin);
    try { assertStatus(await updated.listUsers(), 'Milvus administrator authentication'); return updated; }
    catch {
      await updated.closeConnection().catch(() => {});
      const fresh = milvusClient(config, 'root', 'Milvus');
      try {
        assertStatus(await fresh.listUsers(), 'Milvus bootstrap authentication');
        assertStatus(await fresh.updateUser({ username: 'root', oldPassword: 'Milvus', newPassword: c.milvusAdmin }), 'Milvus root password rotation');
      } finally { await fresh.closeConnection().catch(() => {}); }
      const rotated = milvusClient(config, 'root', c.milvusAdmin);
      assertStatus(await rotated.listUsers(), 'Milvus rotated administrator authentication');
      return rotated;
    }
  });
  try {
    const users = await milvus.listUsers(); assertStatus(users, 'Milvus user list');
    const roles = await milvus.listRoles(); assertStatus(roles, 'Milvus role list');
    for (const [username, password, role] of [['pub_writer', c.milvusWriter, 'pub_writer_role'], ['pub_reader', c.milvusReader, 'pub_reader_role']]) {
      if (!users.usernames?.includes(username)) assertStatus(await milvus.createUser({ username, password }), 'Milvus user creation');
      if (!roles.results?.some(item => item.role?.name === role)) assertStatus(await milvus.createRole({ roleName: role }), 'Milvus role creation');
      assertStatus(await milvus.addUserToRole({ username, roleName: role }), 'Milvus role assignment');
    }
    // The writer may create a new collection but does not receive wildcard
    // data-write privileges. A future trusted publisher must grant and revoke
    // exact-collection access for each generation; it is not yet implemented.
    const existing = await milvus.listGrants({ roleName: 'pub_writer_role', db_name: 'default' });
    assertStatus(existing, 'Milvus writer grants');
    for (const item of existing.entities ?? []) {
      const privilege = item.grantor?.privilege?.name;
      if (item.object_name === '*' && privilege && privilege !== 'CreateCollection') {
        assertStatus(await milvus.revokePrivilegeV2({ role: 'pub_writer_role', privilege,
          db_name: 'default', collection_name: '*' }), 'Milvus wildcard privilege removal');
      }
    }
    for (const [role, privilege] of [['pub_reader_role', 'CollectionReadOnly'], ['pub_writer_role', 'CreateCollection']]) {
      assertStatus(await milvus.grantPrivilegeV2({ role, privilege, db_name: 'default', collection_name: '*' }), 'Milvus privilege grant');
    }
  } finally { await milvus.closeConnection(); }
}

/** A diagnostic, not proof of exclusive publishers or of drained remote RPCs. */
export async function verifySandbox(config) {
  const c = config.credentials;
  const pgAdmin = new pg.Client(dbOptions(config, 'sandbox_admin', c.postgresAdmin));
  await pgAdmin.connect();
  try {
    const r = await pgAdmin.query(`select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname = any($1::text[]) order by rolname`, [['pub_migration', 'pub_app', 'pub_publisher']]);
    if (r.rows.length !== 3 || r.rows.some(row => row.rolsuper || row.rolbypassrls || row.rolcreaterole || row.rolcreatedb)) {
      throw new Error('PostgreSQL roles are not restricted.');
    }
    const membership = await pgAdmin.query(`select pg_has_role('pub_app','pub_publisher','member') as app_publisher,
      pg_has_role('pub_app','pub_migration','member') as app_migration`);
    if (membership.rows[0]?.app_publisher || membership.rows[0]?.app_migration) throw new Error('PostgreSQL roles are not separated.');
  } finally { await pgAdmin.end(); }

  const esAdmin = esClient(config, 'elastic', c.elasticAdmin);
  const esReader = esClient(config, 'pub_reader', c.esReader);
  const esWriter = esClient(config, 'pub_writer', c.esWriter);
  const esSealer = esClient(config, 'pub_sealer', c.esSealer);
  const anonymous = new ElasticsearchClient({ node: `https://127.0.0.1:${config.ports.elasticsearch}`,
    tls: { ca: config.ca }, requestTimeout: 5000, maxRetries: 0 });
  try {
    let rejected = false;
    try { await anonymous.info(); } catch (error) { rejected = error?.statusCode === 401 || error?.meta?.statusCode === 401; }
    if (!rejected) throw new Error('Elasticsearch anonymous access was not rejected.');
    const auth = await Promise.all([esReader.security.authenticate(), esWriter.security.authenticate(), esSealer.security.authenticate()]);
    if (auth.map(item => item.username).join(',') !== 'pub_reader,pub_writer,pub_sealer') throw new Error('Elasticsearch identities mismatch.');
    const name = 'codex-generation-seal-check';
    const permissions = async client => client.security.hasPrivileges({ index: [{ names: [name], privileges: ['read', 'write', 'manage', 'create_index'] }] });
    const [read, write, seal] = await Promise.all([permissions(esReader), permissions(esWriter), permissions(esSealer)]);
    if (!read.index?.[name]?.read || read.index[name].write || read.index[name].manage || read.index[name].create_index
      || !write.index?.[name]?.write || write.index[name].manage || !seal.index?.[name]?.manage) {
      throw new Error('Elasticsearch role permissions do not meet the sandbox contract.');
    }
    await esAdmin.info();
  } finally { await Promise.all([esAdmin.close(), esReader.close(), esWriter.close(), esSealer.close(), anonymous.close()]); }

  const admin = milvusClient(config, 'root', c.milvusAdmin);
  const reader = milvusClient(config, 'pub_reader', c.milvusReader);
  const writer = milvusClient(config, 'pub_writer', c.milvusWriter);
  const anonymousMilvus = milvusClient(config);
  try {
    let rejected = false;
    try { const result = await anonymousMilvus.listUsers(); rejected = (result?.status ?? result)?.error_code !== 'Success'; }
    catch { rejected = true; }
    if (!rejected) throw new Error('Milvus anonymous access was not rejected.');
    const users = await admin.listUsers(); assertStatus(users, 'Milvus user inventory');
    if ([...(users.usernames ?? [])].sort().join(',') !== 'pub_reader,pub_writer,root') {
      throw new Error('Milvus user inventory is not isolated.');
    }
    for (const [username, expectedRole] of [['pub_reader', 'pub_reader_role'], ['pub_writer', 'pub_writer_role']]) {
      const user = await admin.selectUser({ username, includeRoleInfo: true });
      assertStatus(user, 'Milvus role lookup');
      if (!user.results?.some(item => item.user?.name === username && item.roles?.some(role => role.name === expectedRole)
        && !item.roles?.some(role => role.name === 'admin'))) throw new Error('Milvus role does not match.');
    }
    const writerGrants = await admin.listGrants({ roleName: 'pub_writer_role', db_name: 'default' });
    assertStatus(writerGrants, 'Milvus writer grants');
    if ((writerGrants.entities ?? []).some(item => item.object_name === '*'
      && item.grantor?.privilege?.name !== 'CreateCollection')) throw new Error('Milvus writer has wildcard collection privileges.');
    const authenticated = await writer.hasCollection({ collection_name: 'sandbox_probe_nonexistent' });
    assertStatus(authenticated, 'Milvus writer authentication');
    // The random collection belongs only to this isolated sandbox. If an
    // incorrectly privileged reader creates it, the sandbox administrator
    // removes exactly that new collection before reporting failure.
    const probe = `sandbox_probe_${randomUUID().replaceAll('-', '')}`;
    let created = false;
    let permissionDenied = false;
    try {
      const result = await reader.createCollection({ collection_name: probe, fields: [
        { name: 'id', data_type: DataType.Int64, is_primary_key: true },
        { name: 'embedding', data_type: DataType.FloatVector, type_params: { dim: '2' } },
      ] });
      const status = result?.status ?? result;
      created = status?.error_code === 'Success';
      permissionDenied = status?.error_code === 'PermissionDenied' || status?.code === 7;
    } catch (error) { permissionDenied = error?.code === 7; }
    if (created) {
      assertStatus(await admin.dropCollection({ collection_name: probe }), 'Milvus probe cleanup');
      throw new Error('Milvus reader can create a collection.');
    }
    if (!permissionDenied) throw new Error('Milvus reader denial was not an authorization error.');
  } finally { await Promise.all([admin.closeConnection(), reader.closeConnection(), writer.closeConnection(), anonymousMilvus.closeConnection()]); }
  const details = { id: config.id, ports: config.ports,
    certificateDigest: createHash('sha256').update(config.ca).digest('hex'),
    postgres: 'roles-separated', elasticsearch: 'tls-auth-and-role-checks-passed',
    milvus: 'auth-and-reader-write-check-passed' };
  return { ...details, configurationDigest: `sha256:${createHash('sha256').update(JSON.stringify(details)).digest('hex')}`,
    productionAuthorized: false };
}
