import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) return nextResolve(`${specifier}.ts`, context); throw error; } } });
const { PromptOptimizerService } = await import('./service.ts');

test('optimize creates a workspace and appends its first immutable version', async () => {
  const events = [];
  const profile = { profileId: 'profile-1', name: 'OpenAI', provider: 'openai', model: 'gpt-4.1-mini', baseUrl: null, settings: {}, isDefault: true, archivedAt: null };
  const store = {
    async getDefaultModelProfile() { return profile; },
    async getModelProfile() { return profile; },
    async createWorkspace(input) { events.push(['workspace', input]); return { workspace_id: 'workspace-1' }; },
    async appendVersion(input) { events.push(['version', input]); return { versionNumber: 1, prompt: input.prompt }; },
  };
  const service = new PromptOptimizerService(store, async (_profile, messages) => {
    assert.match(messages[0].content, /只返回 JSON/);
    return '{"prompt":"优化结果","analysis":{"summary":"更具体","improvements":["增加约束"]}}';
  });
  const result = await service.optimize({ prompt: '写 {{topic}}', mode: 'general', variables: { topic: '产品' } });
  assert.equal(result.workspaceId, 'workspace-1');
  assert.equal(events[1][1].expectedCurrentVersion, 0);
  assert.equal(events[1][1].kind, 'optimized');
  assert.equal(events[1][1].prompt, '优化结果');
});

test('optimize requires an independent profile before calling a model', async () => {
  const service = new PromptOptimizerService({ async getDefaultModelProfile() { return null; } }, async () => { throw new Error('must not run'); });
  await assert.rejects(() => service.optimize({ prompt: '写一首诗' }), /create and select/i);
});

test('model profile settings reject unknown secret-shaped fields', async () => {
  const service = new PromptOptimizerService({ async saveModelProfile() { throw new Error('must not persist'); } }, async () => '');
  await assert.rejects(() => service.saveProfile({ name: 'unsafe', provider: 'openai', model: 'gpt', settings: { apiKey: 'secret' } }), /unknown model setting/i);
});
