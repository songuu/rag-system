import type { MilvusClient } from '@zilliz/milvus2-sdk-node';
import type { PublicationGrantJournal } from './publication-grant-journal';
import { consumeGenerationRetirementProof, type PublicationGenerationAccess } from './publication-generation-access';

/** Call only after a single actor returned success for every write and revoke.
 * The journal retains unknown: even successful deletion never proves RPC drainage. */
export async function retireGenerationIdentity(input: {
  operationId: string; identity: { collection: string; username: string; role: string };
  actor: PublicationGenerationAccess;
  journal: Pick<PublicationGrantJournal, 'readIntent' | 'recordEvent'>;
  admin: Pick<MilvusClient, 'removeUserFromRole' | 'deleteUser' | 'dropRole'>;
  check: () => Promise<void>;
}): Promise<void> {
  await input.check();
  consumeGenerationRetirementProof(input.actor, input.identity, input.admin);
  const persisted = await input.journal.readIntent(input.operationId);
  if (persisted.collection !== input.identity.collection || persisted.username !== input.identity.username
    || persisted.role !== input.identity.role) throw new Error('Retirement identity is not owned by this operation.');
  await input.journal.recordEvent({ operationId: input.operationId, identity: persisted, phase: 'unknown' });
  await input.check(); status(await input.admin.removeUserFromRole({ username: persisted.username, roleName: persisted.role }));
  await input.check(); status(await input.admin.deleteUser({ username: persisted.username }));
  await input.check(); status(await input.admin.dropRole({ roleName: persisted.role }));
  await input.check();
}

function status(value: unknown): void {
  const result = value as { status?: { error_code?: string; code?: number }; error_code?: string; code?: number };
  const response = result?.status ?? result;
  if (response?.error_code !== 'Success' || response.code !== undefined && response.code !== 0) throw new Error('Milvus identity retirement failed or is unknown.');
}
