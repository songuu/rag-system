import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const { createGenerationAccess, reconcileGenerationGrants, consumeGenerationRetirementProof } = await import('./publication-generation-access.ts');
const collection = `rag_publication_${'a'.repeat(32)}`;
const ok = { error_code: 'Success', reason: '' };

function fixture(overrides = {}) {
  const calls = [];
  const grants = new Set();
  const admin = {
    async createRole(x) { calls.push(['role', x]); return ok; },
    async createUser(x) { calls.push(['user', { username: x.username }]); return ok; },
    async addUserToRole(x) { calls.push(['membership', x]); return ok; },
    async createCollection(x) { calls.push(['collection', x]); return ok; },
    async flushSync(x) { calls.push(['flush', x]); return { status: ok }; },
    async grantPrivilegeV2(x) { calls.push(['grant', x]); grants.add(x.privilege); return ok; },
    async revokePrivilegeV2(x) { calls.push(['revoke', x]); grants.delete(x.privilege); return ok; },
    async listGrants() { return { status: ok, entities: [...grants].map(privilege => ({ object_name: collection, grantor: { privilege: { name: privilege } } })) }; },
    ...overrides.admin,
  };
  let clientOptions;
  const writer = { async insert(x) { calls.push(['insert', x]); return { status: ok }; },
    async createIndex(x) { calls.push(['index', x]); return { status: ok }; },
    async flushSync(x) { calls.push(['flush', x]); return { status: ok }; },
    async loadCollectionSync(x) { calls.push(['load', x]); return { status: ok }; },
    async closeConnection() { calls.push(['close']); } };
  return { calls, admin, writer, getOptions: () => clientOptions, input: {
    collection, dimension: 2, admin, address: '127.0.0.1:1234', checkLease: async () => true,
    persistIntent: async identity => { calls.push(['persist', identity]); },
    createClient: config => { clientOptions = config; return writer; },
    ...overrides.input,
  } };
}

test('persists before provisioning, fixes no-retry settings and scopes all grants', async () => {
  const f = fixture();
  const session = await createGenerationAccess(f.input);
  assert.equal(f.calls[0][0], 'persist');
  assert.equal(f.getOptions().maxRetries, 0);
  assert.equal(f.getOptions().isGlobal, false);
  assert.equal(f.getOptions().channelOptions['grpc.enable_retries'], 0);
  assert.ok(f.calls.filter(c => c[0] === 'grant').every(c => c[1].collection_name === collection));
  await session.createIndex();
  await session.insert([{ id: 'x' }]);
  await session.flush();
  await session.load();
  assert.equal(f.calls.find(c => c[0] === 'insert')[1].collection_name, collection);
  const evidence = await session.revoke();
  assert.equal(evidence.productionAuthorized, false);
  assert.ok(f.calls.some(c => c[0] === 'close'));
  await assert.rejects(session.insert([{ id: 'x' }]), /closed|abandoned/i);
});

test('a lease failure prevents any backend I/O', async () => {
  const f = fixture({ input: { checkLease: async () => false } });
  await assert.rejects(createGenerationAccess(f.input), /lease/i);
  assert.equal(f.calls.length, 0);
});

test('a colliding role never creates a successful actor or authorizes retirement', async () => {
  const f = fixture({ admin: { async createRole() { return { error_code: 'CreateRoleFailure', code: 1100 }; } } });
  await assert.rejects(createGenerationAccess(f.input), /provisioning failed/);
  assert.equal(f.calls.some(call => ['user', 'membership', 'grant', 'collection'].includes(call[0])), false);
  assert.throws(() => consumeGenerationRetirementProof({}, { collection, username: `pgu_${collection.slice(-24)}`, role: `pgr_${collection.slice(-24)}` }, f.admin), /not eligible/);
});

test('injected test clients never become retirement authority even after success', async () => {
  const f = fixture(); const actor = await createGenerationAccess(f.input);
  await actor.createIndex(); await actor.insert([{ id: 'x' }]); await actor.flush(); await actor.load(); await actor.revoke();
  assert.throws(() => consumeGenerationRetirementProof(actor, actor.identity, f.admin), /not eligible/);
});

test('an uncertain writer operation prevents revocation from being treated as a seal', async () => {
  const f = fixture();
  f.writer.insert = async () => { throw new Error('unknown completion'); };
  const session = await createGenerationAccess(f.input);
  await assert.rejects(session.insert([{ id: 'x' }]), /abandoned/i);
  await assert.rejects(session.revoke(), /abandoned/i);
});

test('timed-out write remains abandoned even when the backend later returns success', async () => {
  const f = fixture({ input: { timeoutMs: 20 } }); let release;
  f.writer.insert = async () => { f.calls.push(['late-insert']); return new Promise(resolve => { release = resolve; }); };
  const session = await createGenerationAccess(f.input); await session.createIndex();
  await assert.rejects(session.insert([{ id: 'x' }]), /abandoned/);
  release({ status: ok }); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(session.revoke(), /abandoned/);
  assert.throws(() => consumeGenerationRetirementProof(session, session.identity, f.admin), /not eligible/);
  assert.equal(f.calls.some(call => call[0] === 'revoke'), false);
});

test('timed-out revoke cannot authorize retirement when the delayed RPC succeeds', async () => {
  const f = fixture({ input: { timeoutMs: 20 } }); let release;
  const session = await createGenerationAccess(f.input);
  await session.createIndex(); await session.insert([{ id: 'x' }]); await session.flush(); await session.load();
  f.admin.revokePrivilegeV2 = async () => { f.calls.push(['late-revoke']); return new Promise(resolve => { release = resolve; }); };
  await assert.rejects(session.revoke(), /abandoned/);
  release(ok); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(session.revoke(), /abandoned/);
  assert.throws(() => consumeGenerationRetirementProof(session, session.identity, f.admin), /not eligible/);
  assert.equal(f.calls.filter(call => call[0] === 'late-revoke').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'close'), false);
});

test('retirement remains unavailable even after successful revocation', async () => {
  const f = fixture({ admin: {
    async removeUserFromRole(x) { f.calls.push(['remove-membership', x]); return ok; },
    async deleteUser(x) { f.calls.push(['delete-user', x]); return ok; },
    async dropRole(x) { f.calls.push(['drop-role', x]); return ok; },
  } });
  const session = await createGenerationAccess(f.input);
  assert.equal('retire' in session, false);
  await session.revoke();
  assert.equal('retire' in session, false);
  assert.equal(f.calls.some(call => ['remove-membership', 'delete-user', 'drop-role'].includes(call[0])), false);
});

test('retirement remains unavailable after an unknown writer result', async () => {
  const f = fixture();
  f.writer.insert = async () => { throw new Error('unknown completion'); };
  const session = await createGenerationAccess(f.input);
  await assert.rejects(session.insert([{ id: 'x' }]), /abandoned/i);
  assert.equal('retire' in session, false);
});

test('rejects any residual role grant after revoke', async () => {
  const f = fixture({ admin: { async listGrants() { return { status: ok, entities: [{ object_name: '*', grantor: { privilege: { name: 'CollectionReadWrite' } } }] }; } } });
  const session = await createGenerationAccess(f.input);
  await assert.rejects(session.revoke(), /abandoned/i);
});

test('independent reconciliation revokes precise persisted identity after actor abandonment', async () => {
  const f = fixture();
  f.writer.insert = async () => { throw new Error('unknown completion'); };
  const session = await createGenerationAccess(f.input);
  await assert.rejects(session.insert([{ id: 'x' }]), /abandoned/i);
  const events = [];
  const result = await reconcileGenerationGrants({ operationId: 'op-1', admin: f.admin,
    readIntent: async () => session.identity,
    recordEvent: async event => events.push(event), timeoutMs: 1000 });
  assert.deepEqual(result, { status: 'unknown', observedNoGrants: true, productionAuthorized: false, inFlightDrained: false });
  assert.equal(f.calls.filter(c => c[0] === 'revoke').length, 3);
  assert.ok(f.calls.filter(c => c[0] === 'revoke').every(c => c[1].role === session.identity.role && c[1].collection_name === collection));
  assert.equal(events[0].phase, 'started');
  assert.equal(events.at(-1).phase, 'unknown');
});

test('reconciliation rejects mismatched identities before any mutation', async () => {
  const f = fixture();
  await assert.rejects(reconcileGenerationGrants({ operationId: 'op-1', admin: f.admin,
    readIntent: async () => ({ collection, username: 'pgu_wrong', role: 'pgr_wrong' }),
    recordEvent: async () => {} }), /identity/i);
  assert.equal(f.calls.length, 0);
});

test('reconciliation rejects unexpected grants without revoking them', async () => {
  const f = fixture({ admin: { async listGrants() { return { status: ok,
    entities: [{ object_name: '*', grantor: { privilege: { name: 'CollectionReadWrite' } } }] }; } } });
  const identity = { collection, username: `pgu_${collection.slice(-24)}`, role: `pgr_${collection.slice(-24)}` };
  await assert.rejects(reconcileGenerationGrants({ operationId: 'op-1', admin: f.admin,
    readIntent: async () => identity, recordEvent: async () => {} }), /unexpected/i);
  assert.equal(f.calls.filter(c => c[0] === 'revoke').length, 0);
});
