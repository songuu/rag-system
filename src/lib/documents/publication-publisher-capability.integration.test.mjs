import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { readSandboxConfig } from '../../../deploy/publication-sandbox/sandbox.mjs';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(`${s}.ts`, c); throw error;
} } });
const id = process.env.PUBLICATION_INTENT_SANDBOX_ID;
test('publisher capability rejects owner and effective table grants on real database', { skip: !id }, async () => {
  const { assertPublisherPostgresCapability } = await import('./publication-publisher-capability.ts');
  const { PublicationOwnerSession } = await import('./publication-owner-session.ts');
  const cfg = readSandboxConfig(id);
  const connect = (user, password) => new pg.Client({ host: '127.0.0.1', port: cfg.ports.postgres, database: 'publication_sandbox', user, password });
  const migration = connect('pub_migration', cfg.credentials.dbMigration);
  const publisher = connect('pub_publisher', cfg.credentials.dbPublisher);
  const administrator = connect('sandbox_admin', cfg.credentials.postgresAdmin);
  const owner = new PublicationOwnerSession({ host: '127.0.0.1', port: cfg.ports.postgres,
    database: 'publication_sandbox', user: 'pub_publisher', password: cfg.credentials.dbPublisher });
  let granted = false;
  let graphGrant = false;
  let columnGrant = false;
  let requestColumnGrant = false;
  let publicColumnGrant = false;
  let assetColumnGrant = false;
  let corpusGrant = false;
  let ownerTransaction = false;
  try {
    await migration.connect(); await publisher.connect(); await administrator.connect(); await owner.start();
    await assertPublisherPostgresCapability(publisher);
    await owner.execute(() => assertPublisherPostgresCapability(owner));
    await assert.rejects(assertPublisherPostgresCapability(migration), /insufficiently isolated/);
    await migration.query('grant select on public.publication_requests to pub_publisher'); granted = true;
    await assert.rejects(assertPublisherPostgresCapability(publisher), /insufficiently isolated/);
    await assert.rejects(owner.execute(() => assertPublisherPostgresCapability(owner)), /insufficiently isolated/);
    await migration.query('revoke select on public.publication_requests from pub_publisher'); granted = false;
    await assertPublisherPostgresCapability(publisher);
    await migration.query('grant update (graph_version) on public.document_graph_dispatches to pub_publisher'); columnGrant = true;
    await assert.rejects(assertPublisherPostgresCapability(publisher), /insufficiently isolated/);
    await migration.query('revoke update (graph_version) on public.document_graph_dispatches from pub_publisher'); columnGrant = false;
    await migration.query('grant select (tenant_id) on public.publication_requests to pub_publisher'); requestColumnGrant = true;
    await assert.rejects(assertPublisherPostgresCapability(publisher), /insufficiently isolated/);
    await migration.query('revoke select (tenant_id) on public.publication_requests from pub_publisher'); requestColumnGrant = false;
    await migration.query('grant update (graph_version) on public.document_graph_dispatches to public'); publicColumnGrant = true;
    await assert.rejects(assertPublisherPostgresCapability(publisher), /insufficiently isolated/);
    await migration.query('revoke update (graph_version) on public.document_graph_dispatches from public'); publicColumnGrant = false;
    await migration.query('grant update (metadata) on public.document_assets to pub_publisher'); assetColumnGrant = true;
    await assert.rejects(assertPublisherPostgresCapability(publisher), /insufficiently isolated/);
    await migration.query('revoke update (metadata) on public.document_assets from pub_publisher'); assetColumnGrant = false;
    await migration.query('grant delete on public.corpora to pub_publisher'); corpusGrant = true;
    await assert.rejects(assertPublisherPostgresCapability(publisher), /insufficiently isolated/);
    await migration.query('revoke delete on public.corpora from pub_publisher'); corpusGrant = false;
    await migration.query('grant select on public.document_graph_dispatches to pub_publisher'); graphGrant = true;
    await assert.rejects(assertPublisherPostgresCapability(publisher), /insufficiently isolated/);
    await migration.query('revoke select on public.document_graph_dispatches from pub_publisher'); graphGrant = false;
    for (const table of ['document_graph_dispatches', 'document_assets', 'corpora']) {
      const ownerQuery = 'select pg_get_userbyid(relowner) as name from pg_class where oid=to_regclass($1)';
      const originalOwner = await migration.query(ownerQuery, [`public.${table}`]);
      assert.equal(originalOwner.rows[0].name, 'pub_migration');
      await administrator.query('begin'); ownerTransaction = true;
      // Fixed internal allowlist, with the owner change rolled back before continuing.
      await administrator.query(`alter table public.${table} owner to pub_publisher`);
      await administrator.query('set local role pub_publisher');
      await assert.rejects(assertPublisherPostgresCapability(administrator), /insufficiently isolated/);
      await administrator.query('rollback'); ownerTransaction = false;
      const restoredOwner = await migration.query(ownerQuery, [`public.${table}`]);
      assert.equal(restoredOwner.rows[0].name, originalOwner.rows[0].name);
    }
  } finally {
    if (ownerTransaction) await administrator.query('rollback');
    if (granted) await migration.query('revoke select on public.publication_requests from pub_publisher');
    if (columnGrant) await migration.query('revoke update (graph_version) on public.document_graph_dispatches from pub_publisher');
    if (requestColumnGrant) await migration.query('revoke select (tenant_id) on public.publication_requests from pub_publisher');
    if (publicColumnGrant) await migration.query('revoke update (graph_version) on public.document_graph_dispatches from public');
    if (assetColumnGrant) await migration.query('revoke update (metadata) on public.document_assets from pub_publisher');
    if (corpusGrant) await migration.query('revoke delete on public.corpora from pub_publisher');
    if (graphGrant) await migration.query('revoke select on public.document_graph_dispatches from pub_publisher');
    await Promise.all([owner.close().catch(() => {}), administrator.end(), publisher.end(), migration.end()]);
  }
});

test('publisher rejects a non-inherited role that it can SET ROLE into', { skip: !id }, async () => {
  const { assertPublisherPostgresCapability } = await import('./publication-publisher-capability.ts');
  const cfg = readSandboxConfig(id);
  const config = { host: '127.0.0.1', port: cfg.ports.postgres, database: 'publication_sandbox' };
  const administrator = new pg.Client({ ...config, user: 'sandbox_admin', password: cfg.credentials.postgresAdmin });
  const publisher = new pg.Client({ ...config, user: 'pub_publisher', password: cfg.credentials.dbPublisher });
  const roleName = `pub_set_test_${randomUUID().replaceAll('-', '')}`;
  let roleCreated = false; let membershipGranted = false;
  try {
    await administrator.connect(); await publisher.connect();
    await assertPublisherPostgresCapability(publisher);
    // The generated name is restricted to a PostgreSQL identifier.
    await administrator.query(`create role ${roleName} nologin`); roleCreated = true;
    await administrator.query(`grant ${roleName} to pub_publisher with inherit false, set true`); membershipGranted = true;
    const membership = await administrator.query(`select m.inherit_option, m.set_option from pg_auth_members m
      join pg_roles member on member.oid=m.member join pg_roles granted on granted.oid=m.roleid
      where member.rolname='pub_publisher' and granted.rolname=$1`, [roleName]);
    assert.deepEqual(membership.rows, [{ inherit_option: false, set_option: true }]);
    await assert.rejects(assertPublisherPostgresCapability(publisher), /insufficiently isolated/);
  } finally {
    if (membershipGranted) await administrator.query(`revoke ${roleName} from pub_publisher`);
    if (roleCreated) await administrator.query(`drop role ${roleName}`);
    await Promise.all([publisher.end(), administrator.end()]);
  }
});
