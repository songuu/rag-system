import { Client } from '@elastic/elasticsearch';

/** Result is an observation, not a proof that outstanding writes have drained. */
export async function inspectPublicationElasticsearchSecurity(config: {
  node: string; ca: string | Buffer; admin: { username: string; password: string };
  writer: string; sealer: string; reader: string; indexName: string;
}): Promise<{ productionAuthorized: false }> {
  if (!config.node.startsWith('https://') || !config.ca || !config.admin.password
    || !/^codex-generation-seal-[a-f0-9]{32}$/.test(config.indexName)
    || new Set([config.admin.username, config.writer, config.sealer, config.reader]).size !== 4) {
    throw new Error('Invalid Elasticsearch security inspection configuration.');
  }
  const client = new Client({ node: config.node, auth: config.admin, tls: { ca: config.ca }, maxRetries: 0, requestTimeout: 5000 });
  try {
    const [nodes, users, mappings, keys, accounts, template, identity] = await Promise.all([
      client.nodes.info({ metric: 'settings' }), client.security.getUser(), client.security.getRoleMapping(),
      client.security.queryApiKeys({ size: 1 }), client.security.getServiceAccounts(),
      client.indices.simulateIndexTemplate({ name: config.indexName }), client.security.authenticate(),
    ]);
    if (identity.username !== config.admin.username || !sameSet(identity.roles, ['superuser'])
      || !users[config.admin.username]?.enabled || !sameSet(users[config.admin.username].roles, ['superuser'])) {
      throw new Error('Elasticsearch trusted administrator identity is invalid.');
    }
    const members = Object.values(nodes.nodes);
    if (members.length !== 1 || !nodes._nodes || nodes._nodes.failed !== 0) throw new Error('Elasticsearch node inventory is not isolated.');
    const settings = asRecord(members[0].settings);
    const security = asRecord(asRecord(settings.xpack).security);
    if (security.enabled !== 'true' || asRecord(asRecord(security.http).ssl).enabled !== 'true') {
      throw new Error('Elasticsearch authentication or TLS is unavailable.');
    }
    const authc = asRecord(security.authc);
    if (authc.anonymous !== undefined) throw new Error('Elasticsearch anonymous authentication is not supported.');
    const realms = asRecord(authc.realms);
    const file = asRecord(realms.file);
    const fileRealms = Object.values(file);
    if (!fileRealms.length || fileRealms.some(value => asRecord(value).enabled !== 'false')
      || Object.keys(realms).some(key => !['file', 'native'].includes(key))) {
      throw new Error('Elasticsearch realm configuration is not verifiably isolated.');
    }
    if (Object.keys(mappings).length || keys.total !== 0 || Object.keys(template).length) {
      throw new Error('Elasticsearch external authorization or index templates are present.');
    }
    for (const name of Object.keys(accounts)) {
      const parts = name.split('/');
      if (parts.length !== 2) throw new Error('Invalid Elasticsearch service account identity.');
      const result = await client.security.getServiceCredentials({ namespace: parts[0], service: parts[1] });
      if (result.count !== 0 || Object.keys(result.tokens).length || result.nodes_credentials._nodes.failed !== 0
        || Object.keys(result.nodes_credentials.file_tokens).length) {
        throw new Error('Elasticsearch service credentials are present.');
      }
    }
    // Publisher identities are privileged, but may only receive the exact
    // sandbox roles. Effective checks for one index alone would miss cluster
    // escalation or permissions on another physical index.
    const roleSpecifications = [
      [config.writer, 'pub_writer_role', ['create_index', 'write', 'read', 'view_index_metadata']],
      [config.sealer, 'pub_sealer_role', ['manage', 'read', 'view_index_metadata']],
      [config.reader, 'pub_reader_role', ['read', 'view_index_metadata']],
    ] as const;
    for (const [user, roleName, allowed] of roleSpecifications) {
      if (!users[user]?.enabled || !sameSet(users[user].roles, [roleName])) throw new Error('Elasticsearch publisher role membership is invalid.');
      const response = await client.security.getRole({ name: roleName });
      const role = asRecord(response[roleName]);
      if (!sameSet(role.cluster, []) || !sameSet(role.run_as, []) || !sameSet(role.applications, [])
        || Object.keys(role).some(key => !['cluster', 'indices', 'applications', 'run_as', 'metadata', 'transient_metadata'].includes(key))
        || !Array.isArray(role.indices) || role.indices.length !== 1) throw new Error('Elasticsearch publisher role exceeds its allowed capabilities.');
      const grant = asRecord(role.indices[0]);
      if (!sameSet(grant.names, ['codex-generation-seal-*', 'rag-publication-*']) || !sameSet(grant.privileges, allowed)
        || grant.allow_restricted_indices !== false
        || Object.keys(grant).some(key => !['names', 'privileges', 'allow_restricted_indices'].includes(key))) {
        throw new Error('Elasticsearch publisher role exceeds its allowed capabilities.');
      }
    }
    const privileges = ['write', 'manage', 'create_index', 'delete_index', 'create_doc', 'index', 'delete', 'all'] as const;
    for (const [user, record] of Object.entries(users)) {
      if (!record.enabled) continue;
      const response = await client.security.hasPrivileges({ index: [{ names: [config.indexName], privileges: [...privileges] }],
        cluster: ['manage', 'manage_security', 'manage_api_key', 'manage_index_templates', 'all'] },
      { headers: { 'es-security-runas-user': user } });
      const index = response.index?.[config.indexName];
      if (!index || privileges.some(privilege => typeof index[privilege] !== 'boolean')) throw new Error('Elasticsearch privileges are incomplete.');
      if (user !== config.admin.username
        && Object.values(response.cluster).some(Boolean)) {
        throw new Error('Elasticsearch publisher role has cluster management privileges.');
      }
      if (![config.admin.username, config.writer, config.sealer].includes(user)
        && (privileges.some(privilege => index[privilege]) || Object.values(response.cluster).some(Boolean))) {
        throw new Error('An unexpected Elasticsearch principal has write or management privileges.');
      }
    }
    for (const name of [config.admin.username, config.writer, config.sealer, config.reader]) {
      if (!users[name]?.enabled) throw new Error('An expected Elasticsearch principal is unavailable.');
    }
    return { productionAuthorized: false };
  } finally { await client.close(); }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && new Set(value).size === expected.length
    && value.every(item => typeof item === 'string' && expected.includes(item));
}
