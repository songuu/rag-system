import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) return nextResolve(`${specifier}.ts`, context); throw error; } } });
const { encryptPromptOptimizerCredential, decryptPromptOptimizerCredential } = await import('./credentials.ts');
const env = { PROMPT_OPTIMIZER_CREDENTIAL_KEY: 'test-only-secret-with-more-than-24-chars' };
test('credential envelope encrypts with random nonces and round trips', () => {
  const first = encryptPromptOptimizerCredential('sk-private-value', 'tenant/profile', env);
  const second = encryptPromptOptimizerCredential('sk-private-value', 'tenant/profile', env);
  assert.notEqual(first, second); assert.equal(first.includes('sk-private-value'), false);
  assert.equal(decryptPromptOptimizerCredential(first, 'tenant/profile', env), 'sk-private-value');
  assert.throws(() => decryptPromptOptimizerCredential(first, 'other/profile', env), /could not be decrypted/i);
});
test('credential envelope fails closed when ciphertext is changed', () => {
  const envelope = encryptPromptOptimizerCredential('sk-private-value', 'tenant/profile', env);
  const parts = envelope.split('.');
  parts[2] = (parts[2].startsWith('A') ? 'B' : 'A') + parts[2].slice(1);
  const changed = parts.join('.');
  assert.throws(() => decryptPromptOptimizerCredential(changed, 'tenant/profile', env), /could not be decrypted/i);
});
test('credential encryption requires durable key material', () => {
  assert.throws(() => encryptPromptOptimizerCredential('sk-private-value', '', {}), /key is not configured/i);
  assert.throws(() => encryptPromptOptimizerCredential('sk-private-value', '', { PROMPT_OPTIMIZER_CREDENTIAL_KEY: 'short' }), /key is not configured/i);
});
