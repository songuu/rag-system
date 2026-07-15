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

const { SupabaseRestClient } = await import('./rest-client.ts');
const { getSupabaseServerClient } = await import('./server-client.ts');
const { getSupabaseAdminClient } = await import('./admin-client.ts');

test('request-scoped client keeps publishable apikey separate from user bearer token', async () => {
  const calls = [];
  const client = new SupabaseRestClient({
    url: 'https://example.supabase.co/',
    apiKey: 'publishable-key',
    accessToken: 'user-jwt',
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({ id: 'user-1' });
    },
  });

  assert.deepEqual(await client.getAuthUser(), { id: 'user-1' });
  assert.equal(String(calls[0].input), 'https://example.supabase.co/auth/v1/user');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('apikey'), 'publishable-key');
  assert.equal(headers.get('authorization'), 'Bearer user-jwt');
});

test('legacy key keeps admin client header behavior compatible', async () => {
  const calls = [];
  const client = new SupabaseRestClient({
    url: 'https://example.supabase.co',
    key: 'service-role',
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse([]);
    },
  });

  await client.selectRows('traces');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('apikey'), 'service-role');
  assert.equal(headers.get('authorization'), 'Bearer service-role');
});

test('server request client returns null without a user token and never falls back admin', () => {
  const client = getSupabaseServerClient(undefined, {
    config: {
      url: 'https://example.supabase.co',
      publishableKey: 'publishable-key',
    },
  });
  assert.equal(client, null);
});

test('server request client requires the publishable project key', () => {
  const client = getSupabaseServerClient('user-jwt', {
    config: {
      url: 'https://example.supabase.co',
      publishableKey: '',
    },
  });
  assert.equal(client, null);
});

test('existing admin client remains configured with its legacy service-role credential', () => {
  const client = getSupabaseAdminClient({
    url: 'https://example.supabase.co',
    publishableKey: '',
    secretKey: '',
    serviceRoleKey: 'service-role',
    defaultTenantId: 'tenant-1',
    defaultCorpusId: 'corpus-1',
    rawBucket: 'raw',
    parsedBucket: 'parsed',
    realtimeEnabled: false,
    persistenceBackend: 'local',
    vectorBackend: 'milvus',
  });
  assert.ok(client);
  assert.equal(client.isConfigured(), true);
});

test('selectRows encodes filters, ordering, and limits through injected transport', async () => {
  const calls = [];
  const client = new SupabaseRestClient({
    url: 'https://example.supabase.co',
    apiKey: 'publishable-key',
    accessToken: 'user-jwt',
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse([{ id: 'corpus-1' }]);
    },
  });

  const rows = await client.selectRows('corpora', {
    select: 'id,tenant_id',
    filters: { id: 'corpus-1', tenant_id: 'tenant-1' },
    order: { column: 'created_at', ascending: false },
    limit: 1,
  });

  assert.deepEqual(rows, [{ id: 'corpus-1' }]);
  const url = new URL(String(calls[0].input));
  assert.equal(url.searchParams.get('select'), 'id,tenant_id');
  assert.equal(url.searchParams.get('id'), 'eq.corpus-1');
  assert.equal(url.searchParams.get('tenant_id'), 'eq.tenant-1');
  assert.equal(url.searchParams.get('order'), 'created_at.desc');
  assert.equal(url.searchParams.get('limit'), '1');
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
