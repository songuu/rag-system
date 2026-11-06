import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Exercise the real route and request executor while keeping providers offline.
const modules = {
  './prepared-request': `export const resolveAskRequestId = () => 'draft-entry';
    export async function prepareAskRequest() { return globalThis.__answerStreamEntry.prepared; }`,
  '@/lib/rag/answer-processing': `export function createDirectConversationReply() { return null; }`,
  '@/lib/rag/conversation-chat': `export async function replyToConversation() { return null; }`,
  '@/lib/rag/mixed-conversation-answer': `
    export function splitMixedIdentityQuestion() { return globalThis.__answerStreamEntry.mixed ? 'knowledge' : null; }
    export async function composeMixedConversationAnswer(response) { return { combined: true, response }; }`,
  '@/lib/rag/core/cancellation': `export class RagRequestAbortedError extends Error {}
    export function throwIfRagRequestAborted(signal) { signal?.throwIfAborted(); }`,
  '@/lib/security/request-context': `export class RagSecurityError extends Error {}`,
  '@/lib/security/request-validation': `export class RequestValidationError extends Error {}
    export const resolveRuntimeEmbeddingProvider = () => 'custom';
    export const resolveRuntimeEmbeddingModel = () => 'test';
    export const publicErrorPayload = () => ({ status: 500, body: { error: { code: 'ERROR', message: 'error' } } });`,
  '@/lib/security/unified-publication-write-guard': `export const getUnifiedPublicationWriteBlock = () => null;`,
  '@/lib/ollama-readiness': `export async function warmOllamaEmbeddingModel() { throw Error('unexpected warmup'); }`,
  './runtime': `export async function executePreparedAsk() { return globalThis.__answerStreamEntry.answer(); }`,
  './publication-runtime': `export async function executePublishedAsk() { return globalThis.__answerStreamEntry.answer(); }`,
};
registerHooks({ resolve(s, c, next) {
  if (modules[s]) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(modules[s]) };
  if (s === 'next/server') return next('next/server.js', c);
  try { return next(s, c); } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(s + '.ts', c);
    throw e;
  }
} });
const { POST } = await import('./route.ts');
const observer = await import('../../../lib/rag/core/provider-usage-observer.ts');

test('answer drafts require the authenticated ordinary legacy route', async t => {
  const previous = process.env.RAG_UNIFIED_PUBLICATION_MODE;
  t.after(() => {
    if (previous === undefined) delete process.env.RAG_UNIFIED_PUBLICATION_MODE;
    else process.env.RAG_UNIFIED_PUBLICATION_MODE = previous;
    delete globalThis.__answerStreamEntry;
  });
  for (const scenario of [
    { name: 'ordinary', expected: true },
    { name: 'json', json: true },
    { name: 'published', published: true },
    { name: 'mixed', mixed: true },
    { name: 'agent', input: { useAgenticRAG: true } },
    { name: 'adaptive', input: { useAdaptiveEntityRAG: true } },
    { name: 'durable', input: { executionMode: 'durable' } },
    { name: 'memory', input: { storageBackend: 'memory' } },
  ]) {
    process.env.RAG_UNIFIED_PUBLICATION_MODE = scenario.published ? 'active' : '';
    let enabled;
    globalThis.__answerStreamEntry = {
      mixed: scenario.mixed,
      prepared: { input: { question: 'knowledge', executionMode: 'sync', storageBackend: 'milvus',
        llmModel: 'test', embeddingModel: 'test', conversationHistory: [], ...scenario.input }, body: {}, securityContext: {} },
      answer: async () => {
        enabled = observer.isAskAnswerStreamingEnabled();
        observer.emitAskAnswerDelta('draft-only');
        return Response.json({ success: true, answer: 'final-only' });
      },
    };
    const response = await POST(new Request('http://local/api/ask', {
      method: 'POST', headers: scenario.json ? {} : { accept: 'text/event-stream' },
    }));
    const body = await response.text();
    assert.equal(enabled, Boolean(scenario.expected), scenario.name);
    assert.equal(body.includes('event: answer_delta'), Boolean(scenario.expected), scenario.name);
    assert.match(body, /final-only/);
    if (!scenario.expected) assert.doesNotMatch(body, /draft-only/);
  }
});
