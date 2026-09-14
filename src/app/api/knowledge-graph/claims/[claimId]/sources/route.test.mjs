import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const target = path.resolve(projectRoot, 'src', specifier.slice(2)) + '.ts';
      return nextResolve(pathToFileURL(target).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

function findProjectRoot(start) {
  let current = start;
  while (!existsSync(path.join(current, 'package.json'))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Unable to locate project root.');
    current = parent;
  }
  return current;
}

const { GET } = await import('./route.ts');

test('rejects more than ten claim sources before security or graph queries run', async () => {
  const response = await GET(
    new Request('http://localhost/rag-api/knowledge-graph/claims/claim-a/sources?limit=11'),
    { params: Promise.resolve({ claimId: 'claim-a' }) }
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_LIMIT');
});

test('uses one-row look-ahead so the HTTP projection can report truncation', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => (
    readFile(new URL('./route.ts', import.meta.url), 'utf8')
  ));

  assert.match(source, /limit:\s*limit \+ 1/);
  assert.match(source, /projectClaimSourcesForHttp\(result\.data,\s*\{ limit \}\)/);
});
