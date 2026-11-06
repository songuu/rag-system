import type { MilvusClient } from '@zilliz/milvus2-sdk-node';

/** Strict baseline for a dedicated local backend before a generation exists.
 * This is an instantaneous check; the trusted administrator must prevent all
 * other processes from modifying users, roles and grants during publication. */
export async function assertMilvusPublicationBaseline(admin: Pick<MilvusClient, 'listUsers' | 'listRoles' | 'listGrants' | 'listDatabases' | 'listPrivilegeGroups'>,
  anonymous: Pick<MilvusClient, 'hasCollection'>, defaultRoot: Pick<MilvusClient, 'hasCollection'>): Promise<void> {
  const denied = async (client: Pick<MilvusClient, 'hasCollection'>) => {
    try {
      const response = await client.hasCollection({ collection_name: 'publication_auth_probe' });
      const status = response.status;
      if (status?.code === 7 || status?.error_code === 'PermissionDenied' || status?.error_code === 'Unauthenticated') return;
    } catch (error) { if (error && typeof error === 'object' && 'code' in error && (error.code === 7 || error.code === 16)) return; }
    throw new Error('Milvus anonymous or default credentials were not explicitly rejected.');
  };
  await denied(anonymous);
  await denied(defaultRoot);
  const databases = await admin.listDatabases(); assertSuccess(databases);
  if (JSON.stringify(databases.db_names) !== JSON.stringify(['default'])) throw new Error('Milvus database inventory is not isolated.');
  const groups = await admin.listPrivilegeGroups(); assertSuccess(groups);
  const readOnly = groups.privilege_groups?.filter(group => group.group_name === 'CollectionReadOnly');
  const readNames = ['Query', 'Search', 'IndexDetail', 'GetFlushState', 'GetLoadState', 'GetLoadingProgress', 'HasPartition', 'ShowPartitions', 'DescribeCollection', 'DescribeAlias', 'GetStatistics', 'ListAliases'].sort();
  if (readOnly?.length !== 1 || JSON.stringify((readOnly[0].privileges ?? []).map(item => item.name).sort()) !== JSON.stringify(readNames)) {
    throw new Error('Milvus read-only privilege group is not trustworthy.');
  }
  const readWrite = groups.privilege_groups?.filter(group => group.group_name === 'CollectionReadWrite');
  const writeNames = [...readNames, 'Load', 'Release', 'Insert', 'Delete', 'Upsert', 'Import', 'Flush', 'Compaction',
    'LoadBalance', 'CreateIndex', 'DropIndex', 'CreatePartition', 'DropPartition'].sort();
  if (readWrite?.length !== 1 || JSON.stringify((readWrite[0].privileges ?? []).map(item => item.name).sort()) !== JSON.stringify(writeNames)) {
    throw new Error('Milvus read-write privilege group is not trustworthy.');
  }
  const users = await admin.listUsers();
  assertSuccess(users);
  if ([...(users.usernames ?? [])].sort().join(',') !== 'pub_reader,pub_writer,root') throw new Error('Milvus user inventory is not isolated.');
  const roles = await admin.listRoles({ includeUserInfo: true });
  assertSuccess(roles);
  const expected = new Map([['admin', []], ['public', []], ['pub_reader_role', ['pub_reader']], ['pub_writer_role', ['pub_writer']]]);
  if (!Array.isArray(roles.results) || roles.results.length !== expected.size) throw new Error('Milvus role inventory is not isolated.');
  for (const role of roles.results) {
    const name = role.role?.name;
    if (!name || !expected.has(name)) throw new Error('Unexpected Milvus role.');
    const members = (role.users ?? []).map(item => item.name).sort();
    if (JSON.stringify(members) !== JSON.stringify(expected.get(name))) throw new Error('Unexpected Milvus role membership.');
    expected.delete(name);
    if (name === 'admin') continue; // root/admin is the explicit trusted boundary.
    const grants = await admin.listGrants({ roleName: name, db_name: 'default' });
    assertSuccess(grants);
    if (!Array.isArray(grants.entities)) throw new Error('Invalid Milvus grant inventory.');
    const actual = grants.entities.map(grant => `${grant.object?.name}:${grant.object_name}:${grant.db_name}:${grant.grantor?.privilege?.name}`).sort();
    const allowed = name === 'public' ? ['Collection:*:*:IndexDetail', 'Global:*:*:DescribeCollection', 'Global:*:*:ListAliases']
      : name === 'pub_reader_role' ? ['Global:*:default:CollectionReadOnly'] : ['Global:*:default:CreateCollection'];
    if (JSON.stringify(actual) !== JSON.stringify(allowed.sort())) throw new Error('Unexpected Milvus grant.');
  }
}

function assertSuccess(value: unknown): void {
  const item = value as { status?: { error_code?: string; code?: number }; error_code?: string; code?: number };
  const status = item?.status ?? item;
  if (status?.error_code !== 'Success' || status.code !== undefined && status.code !== 0) throw new Error('Milvus capability check failed.');
}
