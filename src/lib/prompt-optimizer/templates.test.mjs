import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) return nextResolve(`${specifier}.ts`, context); throw error; } } });
const { buildOptimizationMessages, listPromptTemplates } = await import('./templates.ts');

test('templates expose general, structured, and image modes', () => {
  assert.deepEqual(listPromptTemplates().map(item => item.id), ['general-v1', 'structured-v1', 'image-v1']);
});

test('image template preserves variable tokens and requests structured JSON', () => {
  const messages = buildOptimizationMessages({ prompt: '画 {{subject}}', mode: 'image', variables: { subject: '猫' }, instruction: '保留中文', workspaceId: null, modelProfileId: null, templateId: 'image-v1', parentVersion: null, expectedCurrentVersion: null });
  assert.match(messages[0].content, /JSON/i);
  assert.match(messages[0].content, /主体.*构图.*光线/);
  assert.match(messages[1].content, /\{\{subject\}\}/);
});
