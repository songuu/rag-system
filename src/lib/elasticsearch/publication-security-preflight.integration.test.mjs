import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@elastic/elasticsearch';
import { readSandboxConfig } from '../../../deploy/publication-sandbox/sandbox.mjs';
import { inspectPublicationElasticsearchSecurity } from './publication-security-preflight.ts';

test('isolated ES principal and authentication boundaries are verified against actual server', { skip: !process.env.PUBLICATION_SANDBOX_ID }, async () => {
  const c = readSandboxConfig(process.env.PUBLICATION_SANDBOX_ID);
  const config = {node: 'https://127.0.0.1:' + c.ports.elasticsearch, ca:c.ca,
    admin:{username:'elastic',password:c.credentials.elasticAdmin},writer:'pub_writer',sealer:'pub_sealer',
    reader:'pub_reader',indexName:'codex-generation-seal-0123456789abcdef0123456789abcdef'};
  assert.deepEqual(await inspectPublicationElasticsearchSecurity(config), {productionAuthorized:false});
  const es = new Client({node:config.node, auth:config.admin, tls:{ca:c.ca}, maxRetries:0});
  const name='sandbox_unauthorized_test_' + randomUUID().replaceAll('-', '');
  let createdRole = false, createdUser = false;
  try {
    await es.security.putRole({name,indices:[{names:[config.indexName],privileges:['write']}]});
    createdRole = true;
    await es.security.putUser({username:name,password:'Aa1' + 'a'.repeat(48),roles:[name]});
    createdUser = true;
    await assert.rejects(inspectPublicationElasticsearchSecurity(config), /unexpected Elasticsearch principal/);
  } finally {
    if (createdUser) await es.security.deleteUser({username:name});
    if (createdRole && createdUser) await es.security.deleteRole({name});
    await es.close();
  }
});

test('publisher roles reject elevated security and data privileges', { skip: !process.env.PUBLICATION_SANDBOX_ID }, async () => {
  const c = readSandboxConfig(process.env.PUBLICATION_SANDBOX_ID);
  const config = {node: 'https://127.0.0.1:' + c.ports.elasticsearch, ca:c.ca,
    admin:{username:'elastic',password:c.credentials.elasticAdmin},writer:'pub_writer',sealer:'pub_sealer',
    reader:'pub_reader',indexName:'codex-generation-seal-0123456789abcdef0123456789abcdef'};
  const es = new Client({node:config.node,auth:config.admin,tls:{ca:c.ca},maxRetries:0});
  try {
    for (const role of ['pub_writer_role','pub_sealer_role']) {
      const original = (await es.security.getRole({name:role}))[role];
      try {
        await es.security.putRole({name:role,...original,cluster:['manage_security']});
        await assert.rejects(inspectPublicationElasticsearchSecurity(config), /publisher role/);
      } finally {
        await es.security.putRole({name:role,...original});
      }
      assert.deepEqual((await es.security.getRole({name:role}))[role], original);
    }
    const role='pub_sealer_role';
    const original=(await es.security.getRole({name:role}))[role];
    try {
      const indices=original.indices.map(grant => ({...grant,privileges:[...grant.privileges,'write']}));
      await es.security.putRole({name:role,...original,indices});
      await assert.rejects(inspectPublicationElasticsearchSecurity(config), /publisher role/);
    } finally { await es.security.putRole({name:role,...original}); }
    assert.deepEqual((await es.security.getRole({name:role}))[role], original);
  } finally { await es.close(); }
});
