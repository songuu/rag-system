import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
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

test('isolated Milvus grants and removes only a newly created generation role', { skip: !enabled }, async () => {
  const config = readSandboxConfig(sandbox);
  const client = new MilvusClient({ address: `127.0.0.1:${config.ports.milvus}`,
    username: 'root', password: config.credentials.milvusAdmin, maxRetries: 0,
    isGlobal: false, channelOptions: { 'grpc.enable_retries': 0 } });
  const suffix = randomUUID().replaceAll('-', '');
  const collection = `rag_publication_${suffix}`;
  const identity = { collection, username: `pgu_${suffix.slice(-24)}`, role: `pgr_${suffix.slice(-24)}` };
  const intentPath = join(config.path, `generation-acl-test-${suffix}.json`);
  let safeToCleanup = false;
  try {
    const { createGenerationAccess } = await import('./publication-generation-access.ts');
    let recorded;
    const access = await createGenerationAccess({ collection, dimension: 2,
      address: `127.0.0.1:${config.ports.milvus}`, admin: client,
      checkLease: async () => true, persistIntent: async value => {
        await writeFile(intentPath, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        recorded = value;
      } });
    assert.deepEqual(recorded, identity);
    const before = await client.listGrants({ roleName: identity.role, db_name: 'default' });
    assert.equal(before.status.error_code, 'Success');
    assert.ok(before.entities.length > 0 && before.entities.every(item => item.object_name === collection));
    const { createPublicationChunk } = await import('./milvus-publication-generation.ts');
    const row = createPublicationChunk({ tenantId: 'acl-test', corpusId: 'acl-test',
      allowedTrustLevels: ['external'], enforceIsolation: true }, {
      documentId: 'doc', generation: 1, documentVersion: 'v1', trustLevel: 'external',
      chunkIndex: 0, content: 'test', embedding: [0.1, 0.2],
    }, 2);
    await access.createIndex();
    await access.insert([row]);
    await access.flush();
    await access.load();
    assert.deepEqual(await access.revoke(), { productionAuthorized: false });
    const after = await client.listGrants({ roleName: identity.role, db_name: 'default' });
    assert.equal(after.status.error_code, 'Success');
    assert.equal(after.entities.length, 0);
    safeToCleanup = true;
  } catch (error) {
    // The non-secret identity permits an operator to inspect an uncertain
    // outcome; no automatic deletion occurs on this path.
    console.error(`Isolated generation requiring inspection: ${collection}`);
    throw error;
  } finally {
    // Only clean known settled operations and the exact randomly-created names.
    // On unknown completion leave everything for explicit reconciliation.
    if (safeToCleanup) {
      for (const result of [
        await client.dropCollection({ collection_name: identity.collection }),
        await client.removeUserFromRole({ username: identity.username, roleName: identity.role }),
        await client.deleteUser({ username: identity.username }),
        await client.dropRole({ roleName: identity.role }),
      ]) {
        assert.equal((result.status ?? result).error_code, 'Success');
      }
      await unlink(intentPath);
    }
    await client.closeConnection();
  }
});
