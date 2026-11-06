import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [pageSource, messageSource, panelSource, indexedDbSource] = await Promise.all([
  readFile(new URL('../app/page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./ChatMessage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./AnswerProcessingPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../lib/indexeddb.ts', import.meta.url), 'utf8'),
]);

test('home page replaces the opaque thinking bubble with explicit processing stages', () => {
  assert.match(pageSource, /正在等待服务端判断处理路径/);
  assert.match(pageSource, /resolveAnswerProcessing\(data\)/);
  assert.match(pageSource, /<AnswerProcessingPanel[\s\S]*?defaultExpanded[\s\S]*?isLive/);
  assert.doesNotMatch(pageSource, /AI 正在思考\.\.\./);
});

test('backend availability never overrides the server routing decision', () => {
  const submit = pageSource.slice(pageSource.indexOf('const handleSubmit ='), pageSource.indexOf("fetch('/rag-api/ask'"));
  assert.doesNotMatch(submit, /classifyDirectConversation|routeConversation|requiresKnowledge/);
  assert.doesNotMatch(submit, /if\s*\(\s*(?:vectorBackendDisabled|!milvusConnected)/);
  assert.match(pageSource, /disabled=\{isLoading \|\| !input\.trim\(\)\}/);
  assert.match(pageSource, /data\.conversationMode === 'direct'/);
});

test('completed processing details are rendered and persisted with assistant messages', () => {
  assert.match(messageSource, /<AnswerProcessingPanel details=\{message\.processingDetails\}/);
  assert.match(messageSource, /直接回复/);
  assert.match(indexedDbSource, /processingDetails\?: AnswerProcessingDetails/);
  assert.match(pageSource, /processingDetails,/);
});

test('processing panel explains its disclosure boundary and exposes live status accessibly', () => {
  assert.match(panelSource, /aria-live=\{isLive \? 'polite' : undefined\}/);
  assert.match(panelSource, /处理过程 · \{statusText\}/);
  assert.match(panelSource, /details\.disclosure/);
  assert.match(panelSource, /STATUS_LABELS/);
});
