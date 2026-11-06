import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context); throw error;
} } });
const { assertMilvusPublicationBaseline } = await import('./publication-milvus-capability.ts');
const ok = { error_code: 'Success', code: 0 };
const grant = (object, db, privilege) => ({ object: { name: object }, object_name: '*', db_name: db, grantor: { privilege: { name: privilege } } });
function fixture() {
  const state = { users: ['root', 'pub_reader', 'pub_writer'], roles: [
    { role: { name: 'admin' }, users: [] }, { role: { name: 'public' }, users: [] },
    { role: { name: 'pub_reader_role' }, users: [{ name: 'pub_reader' }] },
    { role: { name: 'pub_writer_role' }, users: [{ name: 'pub_writer' }] }],
    grants: { public: [grant('Collection', '*', 'IndexDetail'), grant('Global', '*', 'DescribeCollection'), grant('Global', '*', 'ListAliases')],
      pub_reader_role: [grant('Global', 'default', 'CollectionReadOnly')], pub_writer_role: [grant('Global', 'default', 'CreateCollection')] } };
  const readonly = ['Query', 'Search', 'IndexDetail', 'GetFlushState', 'GetLoadState', 'GetLoadingProgress', 'HasPartition', 'ShowPartitions', 'DescribeCollection', 'DescribeAlias', 'GetStatistics', 'ListAliases'];
  state.databases = ['default']; state.privileges = readonly; state.extraWritePrivileges = [];
  const denied = { hasCollection: async () => ({ status: { code: 7, error_code: 'PermissionDenied' } }) };
  return { state, denied, admin: { listUsers: async () => ({ status: ok, usernames: state.users }), listRoles: async () => ({ status: ok, results: state.roles }),
    listDatabases: async () => ({ status: ok, db_names: state.databases }), listPrivilegeGroups: async () => ({ status: ok,
      privilege_groups: [{ group_name: 'CollectionReadOnly', privileges: state.privileges.map(name => ({ name })) },
        { group_name: 'CollectionReadWrite', privileges: [...readonly, 'Load', 'Release', 'Insert', 'Delete', 'Upsert', 'Import', 'Flush', 'Compaction',
          'LoadBalance', 'CreateIndex', 'DropIndex', 'CreatePartition', 'DropPartition', ...state.extraWritePrivileges].map(name => ({ name })) }] }),
    listGrants: async ({ roleName }) => ({ status: ok, entities: state.grants[roleName] }) } };
}
test('accepts only the expected Milvus role baseline', async () => {
  const f = fixture(); await assertMilvusPublicationBaseline(f.admin, f.denied, f.denied);
});
test('rejects extra users, role membership and wildcard writers', async () => {
  for (const mutate of [f => f.state.users.push('attacker'), f => f.state.roles[2].users.push({ name: 'attacker' }),
    f => f.state.grants.pub_writer_role.push(grant('Global', 'default', 'CollectionReadWrite')),
    f => f.state.databases.push('other'), f => f.state.privileges.push('Insert'), f => f.state.extraWritePrivileges.push('ManageOwnership')]) {
    const f = fixture(); mutate(f); await assert.rejects(assertMilvusPublicationBaseline(f.admin, f.denied, f.denied));
  }
});
test('rejects successful anonymous and default root authentication', async () => {
  const f = fixture(); const permitted = { hasCollection: async () => ({ status: ok }) };
  await assert.rejects(assertMilvusPublicationBaseline(f.admin, permitted, f.denied), /explicitly rejected/);
  await assert.rejects(assertMilvusPublicationBaseline(f.admin, f.denied, permitted), /explicitly rejected/);
});

test('isolated Milvus passes the strict identity and authentication baseline',
  { skip: process.env.PUBLICATION_SANDBOX_ALLOW_MUTATIONS !== '1' || !/^[a-f0-9]{24}$/.test(process.env.PUBLICATION_SANDBOX_ID ?? ''), timeout: 120000 }, async () => {
  const { readSandboxConfig } = await import('../../../deploy/publication-sandbox/sandbox.mjs');
  const { MilvusClient } = await import('@zilliz/milvus2-sdk-node');
  const cfg = readSandboxConfig(process.env.PUBLICATION_SANDBOX_ID);
  const config = { address: `127.0.0.1:${cfg.ports.milvus}`, maxRetries: 0, isGlobal: false, channelOptions: { 'grpc.enable_retries': 0 } };
  const admin = new MilvusClient({ ...config, username: 'root', password: cfg.credentials.milvusAdmin });
  const anonymous = new MilvusClient(config);
  const defaultRoot = new MilvusClient({ ...config, username: 'root', password: 'Milvus' });
  // SDK connects eagerly; explicitly observe its rejected initial connection as
  // well as the authorization result checked by the preflight.
  void anonymous.connectPromise.catch(() => {});
  void defaultRoot.connectPromise.catch(() => {});
  let createdDatabase = false;
  const dbName = `pub_test_${Date.now()}`;
  try {
    await assertMilvusPublicationBaseline(admin, anonymous, defaultRoot);
    const created = await admin.createDatabase({ db_name: dbName });
    assert.equal((created.status ?? created).error_code, 'Success'); createdDatabase = true;
    await assert.rejects(assertMilvusPublicationBaseline(admin, anonymous, defaultRoot), /database inventory/);
  }
  finally {
    if (createdDatabase) { const removed = await admin.dropDatabase({ db_name: dbName }); assert.equal((removed.status ?? removed).error_code, 'Success'); }
    await Promise.all([admin.closeConnection(), anonymous.closeConnection(), defaultRoot.closeConnection()]);
  }
});
