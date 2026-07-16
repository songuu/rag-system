import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { createStableErrorLog, redactErrorForLog } = await import('./error-redaction.ts');

test('redactErrorForLog removes bearer, assignment, URL userinfo, and query secrets', () => {
  const redacted = redactErrorForLog(
    new Error(
      'Authorization: Bearer abc.def token=topsecret password:hunter2 ' +
        'https://admin:pass@example.test/path?api_key=key123&safe=yes'
    )
  );
  const serialized = JSON.stringify(redacted);
  for (const secret of ['abc.def', 'topsecret', 'hunter2', 'admin:pass', 'key123']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /REDACTED/);
});

test('redactErrorForLog removes control characters and caps attacker-controlled text', () => {
  const redacted = redactErrorForLog(new Error(`line1\nline2\t${'x'.repeat(2_000)}`));
  assert.equal(/[\r\n\t]/.test(redacted.message), false);
  assert.equal(redacted.message.length, 1_000);
});

test('redactErrorForLog removes quoted JSON and header secrets', () => {
  const redacted = redactErrorForLog(
    new Error(
      '{"access_token":"abc123","nested":{"password":"hunter2"},' +
        '"authorization":"Bearer signed.jwt.value"}'
    )
  );
  const serialized = JSON.stringify(redacted);
  for (const secret of ['abc123', 'hunter2', 'signed.jwt.value']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('redactErrorForLog safely handles non-errors', () => {
  assert.deepEqual(redactErrorForLog('plain failure'), { name: 'Error', message: 'plain failure' });
});

test('createStableErrorLog drops arbitrary provider messages and unsafe codes', () => {
  const error = new Error('confidential-passage must never reach operational logs');
  error.name = 'ProviderError';
  error.code = 'PROVIDER_TIMEOUT';
  assert.deepEqual(createStableErrorLog(error), {
    name: 'ProviderError',
    code: 'PROVIDER_TIMEOUT',
  });
  assert.equal(JSON.stringify(createStableErrorLog(error)).includes('confidential-passage'), false);

  const unsafe = new Error('private model output');
  unsafe.name = 'bad\nname';
  unsafe.code = 'private-value';
  assert.deepEqual(createStableErrorLog(unsafe), { name: 'Error' });
  assert.deepEqual(createStableErrorLog({ secret: 'confidential-passage' }), { name: 'Error' });
});
