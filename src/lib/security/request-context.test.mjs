import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  RagSecurityError,
  assertCapability,
  canRagRole,
  resolveRagSecurityContext,
} = await import('./request-context.ts');

const SINGLE_ENV = {
  NODE_ENV: 'production',
  RAG_ACCESS_MODE: 'single-tenant-token',
  RAG_SINGLE_TENANT_TOKEN: 'operator-secret',
  RAG_DEFAULT_TENANT_ID: 'tenant-1',
  RAG_DEFAULT_CORPUS_ID: 'corpus-1',
};

test('role capability matrix keeps viewer read-only and reserves runtime management for admins', () => {
  assert.equal(canRagRole('viewer', 'query'), true);
  assert.equal(canRagRole('viewer', 'ingest'), false);
  assert.equal(canRagRole('member', 'delete-document'), true);
  assert.equal(canRagRole('member', 'reindex'), false);
  assert.equal(canRagRole('admin', 'manage-runtime'), true);
  assert.equal(canRagRole('owner', 'manage-runtime'), true);
});

test('local-dev is the non-production default and preserves legacy local scope', async () => {
  const context = await resolveRagSecurityContext(request(), {
    env: { NODE_ENV: 'development' },
    requestIdFactory: () => 'generated-local',
  });
  assert.deepEqual(context, {
    actorId: 'local-dev',
    tenantId: 'local-dev-tenant',
    corpusId: 'local-dev-corpus',
    role: 'owner',
    accessMode: 'local-dev',
    requestId: 'generated-local',
    enforceIsolation: false,
  });
});

test('local-dev uses configured fixed scope without trusting a body identity', async () => {
  const context = await resolveRagSecurityContext(request(), {
    env: {
      NODE_ENV: 'test',
      RAG_ACCESS_MODE: 'local-dev',
      RAG_DEFAULT_TENANT_ID: 'local-tenant',
      RAG_DEFAULT_CORPUS_ID: 'local-corpus',
    },
    requestedCorpusId: 'local-corpus',
    requestIdFactory: () => 'local-scope',
  });
  assert.equal(context.tenantId, 'local-tenant');
  assert.equal(context.corpusId, 'local-corpus');
});

test('production rejects local-dev even when it is explicitly configured', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request(), {
      env: { NODE_ENV: 'production', RAG_ACCESS_MODE: 'local-dev' },
      requestIdFactory: () => 'prod-local',
    }),
    'RAG_LOCAL_DEV_FORBIDDEN',
    503,
    'prod-local'
  );
});

test('invalid access mode returns a stable configuration error', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request(), {
      env: { NODE_ENV: 'production', RAG_ACCESS_MODE: 'disabled' },
      requestIdFactory: () => 'bad-mode',
    }),
    'RAG_AUTH_MODE_INVALID',
    503,
    'bad-mode'
  );
});

test('RAG_AUTH_MODE remains a compatible alias for access mode', async () => {
  const context = await resolveRagSecurityContext(request(), {
    env: { NODE_ENV: 'test', RAG_AUTH_MODE: 'local-dev' },
    requestIdFactory: () => 'alias',
  });
  assert.equal(context.accessMode, 'local-dev');
});

test('invalid corpus identifiers fail before any auth backend call', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request(), {
      env: { NODE_ENV: 'test' },
      requestedCorpusId: '../tenant-b',
      requestIdFactory: () => 'bad-corpus',
    }),
    'RAG_CORPUS_INVALID',
    400,
    'bad-corpus'
  );
});

test('local-dev cannot select a corpus outside its fixed scope', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request(), {
      env: {
        NODE_ENV: 'test',
        RAG_DEFAULT_CORPUS_ID: 'corpus-a',
      },
      requestedCorpusId: 'corpus-b',
      requestIdFactory: () => 'local-cross-corpus',
    }),
    'RAG_CORPUS_FORBIDDEN',
    403,
    'local-cross-corpus'
  );
});

test('safe client request id is preserved', async () => {
  const context = await resolveRagSecurityContext(request(undefined, 'req_123:abc'), {
    env: { NODE_ENV: 'test' },
    requestIdFactory: () => 'unused',
  });
  assert.equal(context.requestId, 'req_123:abc');
});

test('unsafe client request id is replaced by the server factory', async () => {
  const context = await resolveRagSecurityContext(request(undefined, '../bad'), {
    env: { NODE_ENV: 'test' },
    requestIdFactory: () => 'safe-generated',
  });
  assert.equal(context.requestId, 'safe-generated');
});

test('single-tenant mode requires token and fixed scope configuration', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request('operator-secret'), {
      env: {
        NODE_ENV: 'production',
        RAG_ACCESS_MODE: 'single-tenant-token',
        RAG_SINGLE_TENANT_TOKEN: 'operator-secret',
      },
      requestIdFactory: () => 'missing-scope',
    }),
    'RAG_SCOPE_CONFIG_MISSING',
    503,
    'missing-scope'
  );
});

test('single-tenant mode rejects a missing bearer token', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request(), {
      env: SINGLE_ENV,
      requestIdFactory: () => 'missing-token',
    }),
    'RAG_AUTH_REQUIRED',
    401,
    'missing-token'
  );
});

test('single-tenant mode rejects a malformed bearer header', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(requestWithAuthorization('Basic abc'), {
      env: SINGLE_ENV,
      requestIdFactory: () => 'malformed-token',
    }),
    'RAG_AUTH_REQUIRED',
    401,
    'malformed-token'
  );
});

test('single-tenant mode rejects an incorrect token', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request('wrong'), {
      env: SINGLE_ENV,
      requestIdFactory: () => 'wrong-token',
    }),
    'RAG_AUTH_INVALID',
    401,
    'wrong-token'
  );
});

test('single-tenant mode resolves its fixed production scope', async () => {
  const context = await resolveRagSecurityContext(request('operator-secret'), {
    env: {
      ...SINGLE_ENV,
      RAG_SINGLE_TENANT_ACTOR_ID: 'gateway-operator',
    },
    requestedCorpusId: 'corpus-1',
    requestIdFactory: () => 'single-ok',
  });
  assert.deepEqual(context, {
    actorId: 'gateway-operator',
    tenantId: 'tenant-1',
    corpusId: 'corpus-1',
    role: 'owner',
    accessMode: 'single-tenant-token',
    requestId: 'single-ok',
    enforceIsolation: true,
  });
});

test('single-tenant mode rejects cross-corpus selection', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request('operator-secret'), {
      env: SINGLE_ENV,
      requestedCorpusId: 'corpus-2',
      requestIdFactory: () => 'single-cross-corpus',
    }),
    'RAG_CORPUS_FORBIDDEN',
    403,
    'single-cross-corpus'
  );
});

test('single-tenant viewer cannot perform ingest capability', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request('operator-secret'), {
      env: { ...SINGLE_ENV, RAG_SINGLE_TENANT_ROLE: 'viewer' },
      capability: 'ingest',
      requestIdFactory: () => 'viewer-ingest',
    }),
    'RAG_CAPABILITY_FORBIDDEN',
    403,
    'viewer-ingest'
  );
});

test('invalid single-tenant role is a stable configuration error', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request('operator-secret'), {
      env: { ...SINGLE_ENV, RAG_SINGLE_TENANT_ROLE: 'superuser' },
      requestIdFactory: () => 'bad-role',
    }),
    'RAG_AUTH_MODE_INVALID',
    503,
    'bad-role'
  );
});

test('unknown access modes fail closed', async () => {
  await expectSecurityError(
    () => resolveRagSecurityContext(request('obsolete-token'), {
      env: { NODE_ENV: 'production', RAG_ACCESS_MODE: 'managed-cloud' },
      requestIdFactory: () => 'invalid-access-mode',
    }),
    'RAG_AUTH_MODE_INVALID',
    503,
    'invalid-access-mode'
  );
});

test('assertCapability error exposes stable safe response fields', () => {
  const context = {
    actorId: 'viewer-1',
    tenantId: 'tenant-1',
    corpusId: 'corpus-1',
    role: 'viewer',
    accessMode: 'single-tenant-token',
    requestId: 'stable-error',
    enforceIsolation: true,
  };
  assert.throws(
    () => assertCapability(context, 'manage-runtime'),
    (error) => {
      assert.ok(error instanceof RagSecurityError);
      assert.deepEqual(error.toResponseBody(), {
        error: {
          code: 'RAG_CAPABILITY_FORBIDDEN',
          message: 'The authenticated actor is not allowed to perform this operation.',
          requestId: 'stable-error',
        },
      });
      return true;
    }
  );
});

function request(token, requestId) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (requestId) headers.set('x-request-id', requestId);
  return { headers };
}

function requestWithAuthorization(authorization) {
  return { headers: new Headers({ authorization }) };
}

async function expectSecurityError(action, code, status, requestId) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof RagSecurityError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.requestId, requestId);
    return true;
  });
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
