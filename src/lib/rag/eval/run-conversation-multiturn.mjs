#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const target = process.argv[2] ?? 'rules';
if (!['rules', 'shadow', 'active'].includes(target) || process.argv.length > 3) {
  console.error('Usage: node src/lib/rag/eval/run-conversation-multiturn.mjs [rules|shadow|active]');
  process.exitCode = 2;
} else {
  try {
    if (target !== 'rules') {
      const url = new URL(process.env.OLLAMA_BASE_URL || 'http://localhost:11434');
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('model target requires a local loopback Ollama endpoint');
    }
    const json = await readFile(new URL('./fixtures/conversation-multiturn-v1.json', import.meta.url), 'utf8');
    const dataset = JSON.parse(json);
    if (dataset.schemaVersion !== 'conversation-multiturn-eval/v1' || !Array.isArray(dataset.cases)) throw new Error('invalid fixture');
    const { routeConversation } = await import('../conversation-router.ts');
    const { classifyConversationIntent, replyToConversation } = await import('../conversation-chat.ts');
    const { evaluateConversationCases } = await import('./conversation-routing-eval.ts');
    const report = await evaluateConversationCases(dataset.cases, async (query, history, index) => {
      if (target === 'rules') {
        const route = routeConversation(query);
        return { route: route.route === 'direct' ? 'conversation' : 'rag', userTurns: [] };
      }
      if (target === 'shadow') {
        const candidate = await classifyConversationIntent(query, history);
        if (!candidate) return null;
        const route = candidate.kind === 'session' && candidate.userTurnIndex >= 0 ? 'conversation'
          : candidate.kind === 'chat' ? 'conversation' : candidate.kind === 'session' || candidate.kind === 'unknown' ? 'clarify' : 'rag';
        const source = history[candidate.userTurnIndex];
        const userTurns = candidate.kind === 'session' && source && candidate.quote && source.content.includes(candidate.quote) ? [candidate.userTurnIndex] : [];
        return { route, userTurns, omittedRequest: dataset.cases[index].requiresKnowledge && route !== 'rag' };
      }
      const reply = await replyToConversation(query, history);
      if (!reply) return { route: 'rag', userTurns: [] };
      const userTurns = history.flatMap((turn, i) => turn.role === 'user' && reply.answer.includes(turn.content) ? [i] : []);
      const clarification = /无法确定|不知道|无法确认|暂不可用|请.*(?:告诉|提供|确认)/u.test(reply.answer) && userTurns.length === 0;
      return { route: clarification ? 'clarify' : 'conversation', userTurns,
        omittedRequest: dataset.cases[index].requiresKnowledge,
        claimsVerifiedIdentity: /(?:已核实|身份认证|确认你的真实身份)/u.test(reply.answer) };
    });
    console.log(JSON.stringify({ dataset: `${dataset.datasetId}@${dataset.datasetVersion}`,
      datasetSha256: createHash('sha256').update(json).digest('hex'), target,
      note: 'Synthetic fixtures only; shadow is unverified candidate output. Active evaluates the chat helper, not full HTTP/RAG execution.',
      timingNote: 'Sequential timings; first request is not necessarily cold. Record hardware and model residency separately.', report }, null, 2));
  } catch (error) {
    console.error('[conversation-multiturn-eval] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  }
}
