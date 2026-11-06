import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.resolve('src', specifier.slice(2)) + '.ts').href, context);
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
} });

const { prepareAskRequest } = await import('./prepared-request.ts');
const { citationPartition } = await import('../../../lib/rag/citations/locator-codec.ts');
const { NextRequest } = await import('next/server');

test('nonempty history requires the current authenticated conversation partition', async () => {
  const keys = ['RAG_ACCESS_MODE', 'RAG_SINGLE_TENANT_TOKEN', 'RAG_SINGLE_TENANT_ROLE', 'RAG_SINGLE_TENANT_ACTOR_ID', 'RAG_DEFAULT_TENANT_ID', 'RAG_DEFAULT_CORPUS_ID'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'history-test-token',
    RAG_SINGLE_TENANT_ROLE: 'owner', RAG_SINGLE_TENANT_ACTOR_ID: 'history-actor-a',
    RAG_DEFAULT_TENANT_ID: 'history-tenant', RAG_DEFAULT_CORPUS_ID: 'history-corpus',
  });
  const partition = citationPartition({ actorId: 'history-actor-a', tenantId: 'history-tenant', corpusId: 'history-corpus' });
  const build = (history, header, authorized = true) => new NextRequest('http://localhost/api/ask', {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(authorized ? { authorization: 'Bearer history-test-token' } : {}),
      ...(header === undefined ? {} : { 'x-rag-conversation-partition': header }),
    }, body: JSON.stringify({ question: '我是谁', conversationHistory: history }),
  });
  const history = [{ role: 'user', content: '我是你的爸爸' }];
  try {
    const prepared = await prepareAskRequest(build(history, partition), 'request-one');
    assert.deepEqual(prepared.input.conversationHistory, history);
    for (const header of [undefined, 'invalid', 'b'.repeat(64)]) {
      await assert.rejects(prepareAskRequest(build(history, header), 'request-two'), { code: 'CONVERSATION_PARTITION_MISMATCH', status: 409 });
    }
    assert.deepEqual((await prepareAskRequest(build([], undefined), 'request-empty')).input.conversationHistory, []);
    assert.deepEqual((await prepareAskRequest(build([], partition), 'request-empty-matched')).input.conversationHistory, []);
    await assert.rejects(prepareAskRequest(build([], 'b'.repeat(64)), 'request-empty-mismatched'), { code: 'CONVERSATION_PARTITION_MISMATCH', status: 409 });
    await assert.rejects(prepareAskRequest(build([], 'invalid'), 'request-empty-invalid'), { code: 'CONVERSATION_PARTITION_MISMATCH', status: 409 });
    await assert.rejects(prepareAskRequest(build(history, partition, false), 'request-unauthorized'), { code: 'RAG_AUTH_REQUIRED', status: 401 });
    process.env.RAG_SINGLE_TENANT_ACTOR_ID = 'history-actor-b';
    await assert.rejects(prepareAskRequest(build(history, partition), 'request-switched'), { code: 'CONVERSATION_PARTITION_MISMATCH', status: 409 });
    await assert.rejects(prepareAskRequest(build([], partition), 'request-empty-switched'), { code: 'CONVERSATION_PARTITION_MISMATCH', status: 409 });
  } finally {
    for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  }
});
