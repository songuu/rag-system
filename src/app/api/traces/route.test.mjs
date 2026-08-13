import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const persistenceStubUrl = 'data:text/javascript,' + encodeURIComponent(`
export async function listTracesFromPersistence() {
  throw new Error('persistence must not be reached');
}
export async function clearTracePersistence() {
  throw new Error('persistence must not be reached');
}
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/persistence/trace-store') {
      return { url: persistenceStubUrl, shortCircuit: true };
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const modulePath = path.resolve(process.cwd(), 'src', specifier.slice(2));
      const target = existsSync(modulePath + '.ts')
        ? modulePath + '.ts'
        : path.join(modulePath, 'index.ts');
      return nextResolve(pathToFileURL(target).href, context);
    }
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

const environmentKeys = [
  'NODE_ENV',
  'RAG_ACCESS_MODE',
  'RAG_SINGLE_TENANT_TOKEN',
  'RAG_SINGLE_TENANT_ROLE',
  'RAG_DEFAULT_TENANT_ID',
  'RAG_DEFAULT_CORPUS_ID',
];
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]])
);

Object.assign(process.env, {
  NODE_ENV: 'production',
  RAG_ACCESS_MODE: 'single-tenant-token',
  RAG_SINGLE_TENANT_TOKEN: 'trace-route-secret',
  RAG_SINGLE_TENANT_ROLE: 'viewer',
  RAG_DEFAULT_TENANT_ID: 'tenant-a',
  RAG_DEFAULT_CORPUS_ID: 'corpus-a',
});

const { NextRequest } = await import('next/server');
const { GET, DELETE } = await import('./route.ts');

test.after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('trace list requires authentication before persistence access', async () => {
  const response = await GET(new NextRequest('http://localhost/api/traces'));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'RAG_AUTH_REQUIRED');
});

test('trace clear requires manage-runtime capability', async () => {
  const response = await DELETE(new NextRequest('http://localhost/api/traces', {
    method: 'DELETE',
    headers: { authorization: 'Bearer trace-route-secret' },
  }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'RAG_CAPABILITY_FORBIDDEN');
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
