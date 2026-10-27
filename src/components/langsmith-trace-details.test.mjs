import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
    throw error;
  }
} });
const require = createRequire(import.meta.url);
const steps = [
  { step: 'retrieve_original', type: 'retriever', duration: 265, metrics: { evidenceCount: 3, laneCount: 2 } },
  { step: 'agent_model_request_tool', type: 'llm', duration: 237, metrics: { modelCallIndex: 1, toolCallCount: 1 } },
  { step: 'read_scoped_rag_context', type: 'tool', duration: 0, metrics: { evidenceCount: 3 } },
  { step: 'agent_model_answer', type: 'llm', duration: 1545, metrics: { modelCallIndex: 2, toolCallCount: 0, answerCharacterCount: 120 } },
].map(step => ({ ...step, status: 'completed', metadata: { prompt: 'PRIVATE_PROMPT', context: 'PRIVATE_CONTEXT' } }));

async function renderViewer(workflowSteps, run) {
  const metrics = await import('../lib/rag/workflow-step-metrics.ts');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL('./LangSmithTraceViewer.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, process: { env: {} }, require(name) {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name.includes('workflow-step-metrics')) return metrics;
    if (name === './LangSmithReactFlowGraph') return { __esModule: true, default: props => React.createElement('div', { 'data-graph': true }, JSON.stringify(props.steps)) };
    throw Error('Unexpected import: ' + name);
  } });
  const { createRoot } = await import('react-dom/client'); const container = dom.window.document.getElementById('root'); const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(module.exports.default, { workflowSteps })));
    await run({ container, async click(element) { assert.ok(element, 'Missing actionable step'); await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); } });
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}

test('every canonical step expands to actual execution metrics without private prompts', async () => {
  await renderViewer(steps, async ({ container, click }) => {
    for (const step of steps) {
      await click(container.querySelector(`[aria-label="查看步骤 ${step.step}"]`));
      const detail = container.querySelector(`[aria-label="${step.step} 执行详情"]`);
      assert.ok(detail, 'Missing visible detail region'); assert.match(detail.textContent, /执行概览/);
      assert.match(detail.textContent, new RegExp(step.duration + 'ms')); assert.doesNotMatch(detail.textContent, /PRIVATE_PROMPT|PRIVATE_CONTEXT/);
      for (const value of Object.values(step.metrics)) assert.ok(detail.textContent.includes(String(value)));
    }
    assert.match(container.textContent, /回答长度/); assert.match(container.textContent, /120 字符/);
    await click([...container.querySelectorAll('button')].find(button => button.textContent.includes('ReactFlow')));
    assert.match(container.querySelector('[data-graph]').textContent, /证据数量/);
  });
});

test('historical status-only steps explain missing details and legacy input/output still render', async () => {
  await renderViewer([{ step: 'old', status: 'completed', duration: 0 }, { step: 'legacy', input: { question: 'known input' }, output: { summary: 'known output' } }], async ({ container, click }) => {
    await click(container.querySelector('[aria-label="查看步骤 old"]'));
    assert.match(container.textContent, /该记录没有保存详细输入输出/); assert.match(container.textContent, /0ms/);
    await click(container.querySelector('[aria-label="查看步骤 legacy"]'));
    assert.match(container.textContent, /known input/); assert.match(container.textContent, /known output/);
  });
});

test('metric projection keeps finite counters and known stop reasons only', async () => {
  const { parseWorkflowStepMetrics } = await import('../lib/rag/workflow-step-metrics.ts');
  assert.deepEqual(parseWorkflowStepMetrics({ evidenceCount: 0, toolCallCount: 1, stopReason: 'budget', prompt: 'PRIVATE', raw: { content: 'PRIVATE' } }), { evidenceCount: 0, toolCallCount: 1, stopReason: 'budget' });
  for (const value of [null, [], { evidenceCount: -1, toolCallCount: NaN, answerCharacterCount: Infinity, stopReason: 'PRIVATE' }]) assert.equal(parseWorkflowStepMetrics(value), undefined);
});
