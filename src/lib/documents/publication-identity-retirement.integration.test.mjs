import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, appendFile, unlink } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { readSandboxConfig } from '../../../deploy/publication-sandbox/sandbox.mjs';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const sandbox = process.env.PUBLICATION_SANDBOX_ID;
const enabled = process.env.PUBLICATION_SANDBOX_ALLOW_MUTATIONS === '1' && /^[a-f0-9]{24}$/.test(sandbox ?? '');

test('isolated successful writer identity can be retired while collection remains readable', { skip: !enabled, timeout: 180000 }, async () => {
  const cfg = readSandboxConfig(sandbox);
  const base = { address: `127.0.0.1:${cfg.ports.milvus}`, maxRetries: 0, isGlobal: false,
    channelOptions: { 'grpc.enable_retries': 0 } };
  const admin = new MilvusClient({ ...base, username: 'root', password: cfg.credentials.milvusAdmin });
  const reader = new MilvusClient({ ...base, username: 'pub_reader', password: cfg.credentials.milvusReader });
  const suffix = randomUUID().replaceAll('-', '');
  const collection = `rag_publication_${suffix}`;
  const identity = { collection, username: `pgu_${suffix.slice(-24)}`, role: `pgr_${suffix.slice(-24)}` };
  const intentPath = join(cfg.path, `retirement-test-${suffix}.json`);
  let finished = false;
  const check = result => assert.equal((result.status ?? result).error_code, 'Success');
  try {
    const { createGenerationAccess } = await import('./publication-generation-access.ts');
    const { retireGenerationIdentity } = await import('./publication-milvus-retirement.ts');
    const { createPublicationChunk } = await import('./milvus-publication-generation.ts');
    const access = await createGenerationAccess({ collection, dimension: 2, address: base.address, admin,
      checkLease: async () => true, persistIntent: async value => {
        assert.deepEqual(value, identity);
        await writeFile(intentPath, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      } });
    const row = createPublicationChunk({ tenantId: 'retirement-test', corpusId: 'retirement-test',
      allowedTrustLevels: ['external'], enforceIsolation: true }, { documentId: 'doc', generation: 1,
      documentVersion: 'v1', trustLevel: 'external', chunkIndex: 0, content: 'test', embedding: [0.1, 0.2] }, 2);
    await access.createIndex(); await access.insert([row]); await access.flush(); await access.load();
    await access.revoke();
    const grants = await admin.listGrants({ roleName: identity.role, db_name: 'default' });
    check(grants); assert.deepEqual(grants.entities, []);
    // This experiment only retires identities whose create, use, revoke and
    // close calls all returned successfully in this process. Any failure is
    // retained for investigation and is never retried automatically.
    // Direct administration is confined to this isolated test and the exact
    // identity created above. This is not a production retirement mechanism.
    await retireGenerationIdentity({ actor: access, operationId: suffix, identity, admin, check: async () => {}, journal: {
      readIntent: async () => identity, recordEvent: async event => { await appendFile(intentPath, `\n${event.phase}`); },
    } });
    const users = await admin.listUsers(); check(users); assert.ok(!users.usernames.includes(identity.username));
    const roles = await admin.listRoles(); check(roles); assert.ok(!roles.results.some(item => item.role?.name === identity.role));
    const result = await reader.query({ collection_name: collection, consistency_level: 'Strong',
      output_fields: ['count(*)'], filter: '' });
    check(result); assert.equal(Number(result.data[0]['count(*)']), 1);
    finished = true;
  } finally {
    // Only the uniquely named collection created by this successful test is removed.
    if (finished) { check(await admin.dropCollection({ collection_name: collection })); await unlink(intentPath); }
    await Promise.all([admin.closeConnection(), reader.closeConnection()]);
  }
});

test('successful actor rejects a different administrator instance before any identity mutation', { skip: !enabled, timeout: 180000 }, async () => {
  const cfg = readSandboxConfig(sandbox);
  const base = { address: `127.0.0.1:${cfg.ports.milvus}`, maxRetries: 0, isGlobal: false,
    channelOptions: { 'grpc.enable_retries': 0 } };
  const admin = new MilvusClient({ ...base, username: 'root', password: cfg.credentials.milvusAdmin });
  const differentAdmin = new MilvusClient({ ...base, username: 'root', password: cfg.credentials.milvusAdmin });
  const suffix = randomUUID().replaceAll('-', ''); const collection = `rag_publication_${suffix}`;
  const identity = { collection, username: `pgu_${suffix.slice(-24)}`, role: `pgr_${suffix.slice(-24)}` };
  const intentPath = join(cfg.path, `retirement-cross-admin-${suffix}.json`);
  let complete = false;
  const check = result => assert.equal((result.status ?? result).error_code, 'Success');
  try {
    const { createGenerationAccess } = await import('./publication-generation-access.ts');
    const { createPublicationChunk } = await import('./milvus-publication-generation.ts');
    const { retireGenerationIdentity } = await import('./publication-milvus-retirement.ts');
    const actor = await createGenerationAccess({ collection, dimension: 2, address: base.address, admin,
      checkLease: async () => true, persistIntent: async value => { assert.deepEqual(value, identity);
        await writeFile(intentPath, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); } });
    const row = createPublicationChunk({ tenantId: 'retirement-test', corpusId: 'retirement-test', allowedTrustLevels: ['external'], enforceIsolation: true },
      { documentId: 'doc', generation: 1, documentVersion: 'v1', trustLevel: 'external', chunkIndex: 0, content: 'test', embedding: [0.1, 0.2] }, 2);
    await actor.createIndex(); await actor.insert([row]); await actor.flush(); await actor.load(); await actor.revoke();
    await assert.rejects(retireGenerationIdentity({ actor, operationId: suffix, identity, admin: differentAdmin,
      check: async () => {}, journal: { readIntent: async () => identity, recordEvent: async () => { throw new Error('unexpected'); } } }), /not eligible/);
    const users = await admin.listUsers(); check(users); assert.ok(users.usernames.includes(identity.username));
    const roles = await admin.listRoles(); check(roles); assert.ok(roles.results.some(item => item.role?.name === identity.role));
    // The test owns this exact role and all its RPCs completed successfully.
    check(await admin.removeUserFromRole({ username: identity.username, roleName: identity.role }));
    check(await admin.deleteUser({ username: identity.username })); check(await admin.dropRole({ roleName: identity.role }));
    complete = true;
  } finally {
    if (complete) { check(await admin.dropCollection({ collection_name: collection })); await unlink(intentPath); }
    await Promise.all([admin.closeConnection(), differentAdmin.closeConnection()]);
  }
});
