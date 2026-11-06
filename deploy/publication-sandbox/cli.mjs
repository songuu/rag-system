import { bootstrapSandbox } from './bootstrap.mjs';
import { createSandbox, destroySandbox, readSandboxConfig, startSandbox, stopSandbox, writeConnectionFiles } from './sandbox.mjs';
import { verifySandbox } from './verify.mjs';
import { grantSandboxPublisher } from './publisher-db.mjs';

const [action, suppliedId, confirmation] = process.argv.slice(2);
let activeId;
try {
  if (action === 'create' && !suppliedId) {
    activeId = createSandbox();
    startSandbox(activeId);
    const config = readSandboxConfig(activeId);
    await bootstrapSandbox(config);
    const diagnostics = await verifySandbox(activeId);
    writeConnectionFiles(config);
    process.stdout.write(JSON.stringify({ id: activeId, ports: config.ports, diagnostics }) + '\n');
  } else if (action === 'verify' && suppliedId && !confirmation) {
    process.stdout.write(JSON.stringify({ id: suppliedId, diagnostics: await verifySandbox(suppliedId) }) + '\n');
  } else if (action === 'grant-publisher' && suppliedId && !confirmation) {
    process.stdout.write(JSON.stringify({ id: suppliedId, diagnostics: await grantSandboxPublisher(suppliedId) }) + '\n');
  } else if (action === 'stop' && suppliedId && !confirmation) {
    stopSandbox(suppliedId);
    process.stdout.write('Sandbox stopped; its data and credentials were retained.\n');
  } else if (action === 'destroy' && suppliedId && confirmation === '--confirm') {
    destroySandbox(suppliedId, `destroy:${suppliedId}`);
    process.stdout.write('Sandbox and its data were removed.\n');
  } else {
    throw new Error('Usage: create | verify ID | grant-publisher ID | stop ID | destroy ID --confirm');
  }
} catch (error) {
  if (action === 'create' && activeId) {
    // In particular, never leave a fresh Milvus root password on a listening
    // port if bootstrap failed. Retain data for explicit inspection/cleanup.
    try { stopSandbox(activeId); } catch { /* report original generic failure */ }
  }
  // Driver errors can embed DSNs or credential-bearing request details.
  // Never print arbitrary SDK/child-process messages to the terminal.
  void error;
  process.stderr.write(`Sandbox operation failed; credentials were not printed.${activeId ? ` Sandbox ID: ${activeId}.` : ''}\n`);
  process.exitCode = 1;
}
