import { types } from 'node:util';

export async function waitForProviderEntry(entered, pending) {
  // Attach terminal handlers before awaiting entry: an earlier whole-operation
  // failure must neither become unhandled nor leave the test waiting forever.
  await Promise.race([entered, pending.then(
    () => { throw new Error('Provider execution completed before expected entry'); },
    cause => { throw new Error('Provider execution failed before expected entry' + closedContext(cause), { cause }); },
  )]);
}

function closedContext(cause) {
  // Test diagnostics are descriptive, never provider authentication. A rejected
  // Proxy or accessor must not execute just to format a failure message.
  const safe = cause !== null && typeof cause === 'object' && !types.isProxy(cause);
  const own = key => safe ? Object.getOwnPropertyDescriptor(cause, key)?.value : undefined;
  const codes = ['invalid-config', 'invalid-request', 'busy', 'already-sealed', 'halted', 'publication-mismatch',
    'invalid-clock', 'invalid-key', 'invalid-readback', 'operation-failed', 'operation-timeout', 'provider-contract-invalid'];
  const phases = ['configuration', 'preflight', 'publication-read', 'clock', 'encrypt', 'seal', 'readback', 'decrypt', 'final-validation'];
  const code = own('code'), phase = own('phase');
  const flag = key => { const value = own(key); return value === true ? 'true' : value === false ? 'false' : 'unknown'; };
  return ' [code=' + (codes.includes(code) ? code : 'unknown') + ', phase=' + (phases.includes(phase) ? phase : 'unknown')
    + ', pending=' + flag('pendingCompletionUnknown') + ', mutation=' + flag('mutationMayHaveOccurred') + ']';
}
