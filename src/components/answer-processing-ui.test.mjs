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
  assert.match(pageSource, /createPendingAnswerProcessing\(submittedQuestion\)/);
  assert.match(pageSource, /resolveAnswerProcessing\(data\)/);
  assert.match(pageSource, /<AnswerProcessingPanel[\s\S]*?defaultExpanded[\s\S]*?isLive/);
  assert.doesNotMatch(pageSource, /AI 正在思考\.\.\./);
});

test('direct conversation remains available without Milvus while knowledge queries stay gated', () => {
  assert.match(pageSource, /vectorBackendDisabled && !isDirectConversation/);
  assert.match(pageSource, /!milvusConnected && !isDirectConversation/);
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
