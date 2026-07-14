import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const { buildIntentRouterGraph, routeIntent } = await import('./intent-router.ts');
const { buildReasoningRAGGraph } = await import('./reasoning-rag.ts');
const { buildSCRAGGraph } = await import('./self-corrective-rag.ts');

const MIGRATED_WORKFLOW_FILES = [
  'src/lib/agentic-rag.ts',
  'src/lib/self-corrective-rag.ts',
  'src/lib/reasoning-rag.ts',
  'src/lib/intent-router.ts',
];

test('RAG workflows use LangChain runnable orchestration instead of LangGraph runtime', () => {
  for (const file of MIGRATED_WORKFLOW_FILES) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /@langchain\/langgraph|StateGraph|Annotation\.Root/);
    assert.match(source, /createRunnableStateNode/);
  }
});

test('adaptive entity RAG no longer claims to be graph-backed', () => {
  const source = readFileSync('src/lib/adaptive-entity-rag.ts', 'utf8');
  assert.doesNotMatch(source, /基于 LangGraph/);
  assert.match(source, /LangChain Runnable-inspired/);
});

test('intent router runnable preserves quick chat route without model IO', async () => {
  const classification = await routeIntent('你好', { routerModel: 'no-model-needed' });

  assert.equal(classification.intent, 'chat');
  assert.equal(classification.suggestedLane, 1);
  assert.equal(classification.requiresRetrieval, false);
});

test('intent router runnable preserves reasoning keyword route without model IO', async () => {
  const classification = await routeIntent('请对比 A 和 B 的优劣', {
    routerModel: 'no-model-needed',
  });

  assert.equal(classification.intent, 'reasoning');
  assert.equal(classification.suggestedLane, 3);
  assert.equal(classification.requiresReasoning, true);
});

test('buildIntentRouterGraph keeps invoke-compatible workflow contract', async () => {
  const workflow = buildIntentRouterGraph();
  const result = await workflow.invoke({
    query: '谢谢',
    routerModel: 'no-model-needed',
    startTime: 1781136000000,
  });

  assert.equal(result.query, '谢谢');
  assert.equal(result.routerModel, 'no-model-needed');
  assert.equal(result.startTime, 1781136000000);
  assert.equal(result.classification?.intent, 'chat');
});

test('migrated workflow builders keep LangChain Runnable surface beyond invoke', () => {
  for (const workflow of [
    buildIntentRouterGraph(),
    buildSCRAGGraph(),
    buildReasoningRAGGraph(),
  ]) {
    assert.equal(typeof workflow.invoke, 'function');
    assert.equal(typeof workflow.stream, 'function');
    assert.equal(typeof workflow.batch, 'function');
  }
});

test('agentic workflow consumes recursionLimit as a rewrite-loop safety net', () => {
  const source = readFileSync('src/lib/agentic-rag.ts', 'utf8');
  assert.match(source, /resolveAgenticRecursionLimit/);
  assert.match(source, /rewriteIterations > recursionLimit/);
  assert.match(source, /recursion_limit_exceeded/);
});

test('reasoning RAG short-circuits tool stages after gateway or parse rejection', () => {
  const source = readFileSync('src/lib/reasoning-rag.ts', 'utf8');
  assert.match(source, /hybrid_retrieval:invalid_args/);
  assert.match(source, /toolGateway\.invoke[\s\S]*if \(!state\.shouldContinue\)[\s\S]*generator\.invoke/);
  assert.match(source, /hybridRetrieval\.invoke[\s\S]*if \(!state\.shouldContinue\)[\s\S]*generator\.invoke/);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
