import { readSandboxConfig } from './sandbox.mjs';
import { verifySandbox as verifyConfig } from './bootstrap.mjs';

// The ID is resolved to a Compose project owned by this sandbox; callers
// cannot supply arbitrary endpoints or claim a Boolean authorization proof.
export async function verifySandbox(id) {
  return verifyConfig(readSandboxConfig(id));
}
