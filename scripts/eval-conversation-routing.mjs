#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('./') && !specifier.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
} });

const allowed = new Set(['rules', 'mock-candidate', 'ollama-candidate']);
const target = process.argv[2] ?? 'rules';
if (process.argv.length > 3 || !allowed.has(target)) {
  console.error('Usage: node scripts/eval-conversation-routing.mjs [rules|mock-candidate|ollama-candidate]');
  process.exitCode = 2;
} else {
  try {
    // The mock target must remain hermetic even if the invoking shell disables
    // semantic routing or selects a remote provider.
    if (target === 'mock-candidate') {
      process.env.RAG_SEMANTIC_ROUTER = 'on';
      process.env.MODEL_PROVIDER = 'ollama';
    }
    if (target === 'ollama-candidate') {
      const url = new URL(process.env.OLLAMA_BASE_URL || 'http://localhost:11434');
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error('ollama-candidate requires a local loopback Ollama endpoint');
      }
      if (process.env.RAG_SEMANTIC_ROUTER === 'off' || (process.env.MODEL_PROVIDER && process.env.MODEL_PROVIDER !== 'ollama')) {
        throw new Error('ollama-candidate requires the semantic router enabled and an Ollama provider');
      }
      const model = process.env.FAST_LLM_MODEL || 'qwen2.5:0.5b';
      let models;
      try {
        const response = await fetch(`${url.toString().replace(/\/+$/u, '')}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error('unavailable');
        models = (await response.json()).models;
      } catch {
        throw new Error('local Ollama model listing unavailable');
      }
      const normalized = name => name.includes(':') ? name : `${name}:latest`;
      if (!Array.isArray(models) || !models.some(entry => typeof entry?.name === 'string' && normalized(entry.name) === normalized(model))) {
        throw new Error('configured routing model is not installed locally');
      }
    }
    const fixture = await readFile(new URL('../src/lib/rag/eval/fixtures/conversation-routing-v1.json', import.meta.url), 'utf8');
    const dataset = JSON.parse(fixture);
    validate(dataset);
    const { routeConversation } = await import('../src/lib/rag/conversation-router.ts');
    const { classifyConversationCandidate } = await import('../src/lib/rag/semantic-conversation-router.ts');
    const { evaluateRoutingCases } = await import('../src/lib/rag/eval/conversation-routing-eval.ts');
    let noCandidate = 0;
    const report = await evaluateRoutingCases(dataset.cases, async (query, index) => {
      const rule = routeConversation(query);
      if (rule.route === 'direct' || target === 'rules') return rule;
      const options = target === 'mock-candidate' ? { fetch: async () => {
        const actions = dataset.cases[index].mockActions ?? [];
        return Response.json({ response: JSON.stringify({ complete: actions.length > 0, actions }) });
      } } : {};
      const candidate = await classifyConversationCandidate(query, options);
      if (!candidate) noCandidate++;
      // This hypothetical comparison deliberately measures the candidate's
      // risk; it never invokes an action or changes the live route.
      return candidate ? { route: 'direct', actions: candidate.actions } : rule;
    });
    console.log(JSON.stringify({
      dataset: `${dataset.datasetId}@${dataset.datasetVersion}`,
      datasetSha256: createHash('sha256').update(fixture).digest('hex'),
      target,
      model: target === 'ollama-candidate' ? process.env.FAST_LLM_MODEL || 'qwen2.5:0.5b' : null,
      note: target === 'rules' ? 'Deterministic rules only.' : target === 'mock-candidate'
        ? 'Mock responses test the harness; these are not model quality results.'
        : 'Hypothetical unverified candidates; this does not represent the production route.',
      timingNote: 'Sequential elapsed times; first does not prove a cold start. Report host/model residency separately.',
      noCandidate,
      noCandidateNote: 'Includes ineligible input, timeout, provider failure and invalid or unsupported output; these cannot be distinguished here.',
      report,
    }, null, 2));
  } catch (error) {
    console.error('[conversation-routing-eval] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  }
}

function validate(dataset) {
  if (!dataset || dataset.schemaVersion !== 'conversation-routing-eval/v1'
    || typeof dataset.datasetId !== 'string' || typeof dataset.datasetVersion !== 'string'
    || !Array.isArray(dataset.cases) || dataset.cases.length === 0) throw new Error('invalid dataset');
  const ids = new Set();
  for (const item of dataset.cases) {
    if (!item || !/^[a-z0-9-]{1,64}$/.test(item.id) || ids.has(item.id)
      || typeof item.query !== 'string' || !item.query.trim() || item.query.length > 512
      || !['direct', 'rag'].includes(item.expectedRoute) || !Array.isArray(item.expectedActions)
      || typeof item.requiresKnowledge !== 'boolean' || (item.requiresKnowledge && item.expectedRoute !== 'rag')
      || (item.expectedRoute === 'rag' && item.expectedActions.length !== 0)
      || (item.expectedRoute === 'direct' && item.expectedActions.length === 0)) throw new Error('invalid case');
    ids.add(item.id);
  }
}
