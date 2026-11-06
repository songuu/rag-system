import { randomBytes } from 'node:crypto';
import { MilvusClient, type ClientConfig } from '@zilliz/milvus2-sdk-node';
import { buildPublicationCollectionSchema } from './milvus-publication-generation';

type Admin = Pick<MilvusClient, 'createRole' | 'createUser' | 'addUserToRole' | 'grantPrivilegeV2'
  | 'revokePrivilegeV2' | 'listGrants' | 'createCollection' | 'flushSync'>;
type Writer = Pick<MilvusClient, 'createIndex' | 'insert' | 'loadCollectionSync' | 'closeConnection'>;
type Input = {
  collection: string;
  dimension: number;
  address: string;
  admin: Admin;
  checkLease: () => Promise<boolean>;
  /** Persist this identity before any remote mutation so unknown outcomes remain discoverable. */
  persistIntent: (identity: { collection: string; username: string; role: string }) => Promise<void>;
  timeoutMs?: number;
  /** Test seam. An injected client is never evidence of production isolation. */
  createClient?: (config: ClientConfig) => Writer;
};

const PRIVILEGES = ['CollectionReadWrite', 'CreateIndex', 'Load'] as const;
type State = 'open' | 'abandoned' | 'closed';
type GenerationIdentity = { collection: string; username: string; role: string };
const privatelyProvisionedActors = new WeakSet<PublicationGenerationAccess>();
const retirementProofs = new WeakMap<PublicationGenerationAccess, { identity: GenerationIdentity; admin: Admin }>();

/** Single-use proof belongs to an actor created by the real private SDK factory. */
export function consumeGenerationRetirementProof(actor: PublicationGenerationAccess, identity: GenerationIdentity, admin: unknown): void {
  const value = retirementProofs.get(actor);
  retirementProofs.delete(actor);
  if (!value || value.admin !== admin || value.identity.collection !== identity.collection || value.identity.username !== identity.username || value.identity.role !== identity.role) {
    throw new Error('Generation actor is not eligible for retirement.');
  }
}

/** Independent administrative recovery. This observes grants, not RPC drainage. */
export async function reconcileGenerationGrants(input: {
  operationId: string;
  admin: Pick<Admin, 'listGrants' | 'revokePrivilegeV2'>;
  /** Load only from the trusted durable operation journal, never from HTTP input. */
  readIntent: (operationId: string) => Promise<GenerationIdentity | null>;
  /** Persist each event durably; failure stops any further mutations. */
  recordEvent: (event: { operationId: string; identity: GenerationIdentity; phase: string }) => Promise<void>;
  timeoutMs?: number;
}): Promise<{ status: 'unknown'; observedNoGrants: true; productionAuthorized: false; inFlightDrained: false }> {
  const timeout = input.timeoutMs ?? 10000;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId) || !Number.isSafeInteger(timeout)
    || timeout < 1 || timeout > 30000 || typeof input.readIntent !== 'function' || typeof input.recordEvent !== 'function') {
    throw new Error('Invalid generation reconciliation configuration.');
  }
  const identity = await bounded(() => input.readIntent(input.operationId), timeout);
  if (!identity || !/^rag_publication_[a-f0-9]{32}$/.test(identity.collection)
    || identity.username !== `pgu_${identity.collection.slice(-24)}`
    || identity.role !== `pgr_${identity.collection.slice(-24)}`) throw new Error('Invalid generation reconciliation identity.');
  const event = (phase: string) => bounded(() => input.recordEvent({ operationId: input.operationId, identity, phase }), timeout);
  const list = async () => {
    const response = await bounded(() => input.admin.listGrants({ roleName: identity.role, db_name: 'default' }), timeout);
    assertStatus(response);
    if (!Array.isArray(response.entities)) throw new Error('Invalid generation grants response.');
    return response.entities;
  };
  await event('started');
  try {
    const grants = await list();
    const names = new Set<string>();
    for (const grant of grants) {
      const name = grant.grantor?.privilege?.name;
      if (grant.object_name !== identity.collection || typeof name !== 'string'
        || ![...PRIVILEGES, 'GetLoadState', 'GetLoadingProgress'].includes(name as typeof PRIVILEGES[number])
        || names.has(name)) throw new Error('Unexpected generation role grant.');
      names.add(name);
    }
    for (const privilege of PRIVILEGES) {
      if (!names.has(privilege)) continue;
      await event(`revoke:${privilege}`);
      assertStatus(await bounded(() => input.admin.revokePrivilegeV2({ role: identity.role, privilege,
        db_name: 'default', collection_name: identity.collection }), timeout));
      await event(`revoked:${privilege}`);
    }
    if ((await list()).length !== 0) throw new Error('Generation role has residual grants.');
    await event('observed-no-grants');
    // A late grant or writer RPC may still complete, even after a clean read.
    // Keep the operation in the recovery queue for subsequent full scans.
    await event('unknown');
    return { status: 'unknown', observedNoGrants: true, productionAuthorized: false, inFlightDrained: false };
  } catch (error) {
    try { await event('unknown'); } catch { /* The previous durable event remains actionable. */ }
    throw error;
  }
}

/**
 * Experimental per-generation access. Administrative ownership and a single
 * writer process are trusted deployment assumptions. Role revocation does not
 * establish that earlier remote RPCs have drained; no result is a seal proof.
 */
export class PublicationGenerationAccess {
  readonly productionAuthorized = false as const;
  readonly identity: Readonly<{ collection: string; username: string; role: string }>;
  #admin: Admin;
  #writer: Writer;
  #checkLease: () => Promise<boolean>;
  #timeoutMs: number;
  #state: State = 'open';
  #busy = false;
  #retirementStage = 0;

  constructor(input: { admin: Admin; writer: Writer; checkLease: () => Promise<boolean>; timeoutMs: number;
    identity: { collection: string; username: string; role: string } }) {
    this.#admin = input.admin;
    this.#writer = input.writer;
    this.#checkLease = input.checkLease;
    this.#timeoutMs = input.timeoutMs;
    this.identity = Object.freeze({ ...input.identity });
  }

  async insert(data: Parameters<MilvusClient['insert']>[0]['data']): Promise<unknown> {
    if (!Array.isArray(data) || data.length < 1 || data.length > 1000) throw new Error('Invalid generation insert.');
    return this.#exclusive(async () => {
      const result = await this.#step(() => this.#writer.insert({ collection_name: this.identity.collection, data }));
      assertStatus(result);
      this.#retirementStage = this.#retirementStage === 1 ? 2 : -1;
      return result;
    });
  }

  async createIndex(): Promise<void> {
    await this.#exclusive(async () => {
      assertStatus(await this.#step(() => this.#writer.createIndex({ collection_name: this.identity.collection,
        field_name: 'embedding', index_name: 'publication_vector_index', index_type: 'FLAT', metric_type: 'COSINE' })));
      this.#retirementStage = this.#retirementStage === 0 ? 1 : -1;
    });
  }

  async flush(): Promise<void> {
    await this.#exclusive(async () => {
      // In Milvus 2.5 Flush may require global privilege; use the trusted
      // administrator on the exact collection instead of widening writer access.
      assertStatus(await this.#step(() => this.#admin.flushSync({ collection_names: [this.identity.collection] })));
      this.#retirementStage = this.#retirementStage === 2 ? 3 : -1;
    });
  }

  async load(): Promise<void> {
    await this.#exclusive(async () => {
      assertStatus(await this.#step(() => this.#writer.loadCollectionSync({ collection_name: this.identity.collection })));
      this.#retirementStage = this.#retirementStage === 3 ? 4 : -1;
    });
  }

  async revoke(): Promise<{ productionAuthorized: false }> {
    return this.#exclusive(async () => {
      for (const privilege of PRIVILEGES) {
        const result = await this.#step(() => this.#admin.revokePrivilegeV2({ role: this.identity.role,
          privilege, db_name: 'default', collection_name: this.identity.collection }));
        assertStatus(result);
      }
      const response = await this.#step(() => this.#admin.listGrants({ roleName: this.identity.role, db_name: 'default' }));
      assertStatus(response);
      if (!Array.isArray(response.entities) || response.entities.length !== 0) throw new Error('Generation role has residual grants.');
      await this.#step(() => this.#writer.closeConnection());
      this.#state = 'closed';
      if (this.#retirementStage === 4 && privatelyProvisionedActors.has(this)) retirementProofs.set(this, { identity: { ...this.identity }, admin: this.#admin });
      return { productionAuthorized: false };
    });
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#state !== 'open') throw new Error('Generation access is closed or abandoned.');
    if (this.#busy) throw new Error('Concurrent generation access is not allowed.');
    this.#busy = true;
    try { return await work(); }
    catch (error) {
      this.#state = 'abandoned';
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
        && Number.isSafeInteger(error.code) ? ` (code ${error.code})` : '';
      throw new Error(`Generation access abandoned after an uncertain or failed operation${code}.`);
    }
    finally { this.#busy = false; }
  }

  async #step<T>(work: () => Promise<T>): Promise<T> {
    if (await bounded(this.#checkLease, this.#timeoutMs) !== true) throw new Error('Publication lease lost.');
    const value = await bounded(work, this.#timeoutMs);
    if (await bounded(this.#checkLease, this.#timeoutMs) !== true) throw new Error('Publication lease lost.');
    return value;
  }
}

export async function createGenerationAccess(input: Input): Promise<PublicationGenerationAccess> {
  if (!/^rag_publication_[a-f0-9]{32}$/.test(input.collection) || !Number.isSafeInteger(input.dimension)
    || input.dimension < 1 || input.dimension > 65536 || typeof input.address !== 'string' || !input.address.trim()
    || typeof input.checkLease !== 'function' || typeof input.persistIntent !== 'function') {
    throw new Error('Invalid generation access configuration.');
  }
  const timeoutMs = input.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid generation access timeout.');
  // Milvus 2.5 restricts user names to 32 characters; collisions fail closed
  // when the backend refuses to create an already-existing role or user.
  const suffix = input.collection.slice(-24);
  const identity = { collection: input.collection, username: `pgu_${suffix}`, role: `pgr_${suffix}` };
  const password = `Aa1${randomBytes(24).toString('hex')}`;
  if (await bounded(input.checkLease, timeoutMs) !== true) throw new Error('Publication lease lost.');
  // Never put a password in the durable intent: a crash abandons this generation.
  await bounded(() => input.persistIntent(identity), timeoutMs);
  const step = async <T>(work: () => Promise<T>) => {
    if (await bounded(input.checkLease, timeoutMs) !== true) throw new Error('Publication lease lost.');
    const result = await bounded(work, timeoutMs);
    if (await bounded(input.checkLease, timeoutMs) !== true) throw new Error('Publication lease lost.');
    return result;
  };
  let phase = 'role';
  try {
    assertStatus(await step(() => input.admin.createRole({ roleName: identity.role })));
    phase = 'user';
    assertStatus(await step(() => input.admin.createUser({ username: identity.username, password })));
    phase = 'membership';
    assertStatus(await step(() => input.admin.addUserToRole({ username: identity.username, roleName: identity.role })));
    phase = 'grant';
    for (const privilege of PRIVILEGES) assertStatus(await step(() => input.admin.grantPrivilegeV2({
      role: identity.role, privilege, db_name: 'default', collection_name: identity.collection,
    })));
    phase = 'collection';
    assertStatus(await step(() => input.admin.createCollection(buildPublicationCollectionSchema(identity.collection, input.dimension))));
    const config: ClientConfig = { address: input.address, username: identity.username, password,
      maxRetries: 0, isGlobal: false, channelOptions: { 'grpc.enable_retries': 0 } };
    const writer = (input.createClient ?? (options => new MilvusClient(options)))(config);
    const actor = new PublicationGenerationAccess({ admin: input.admin, writer, checkLease: input.checkLease, timeoutMs, identity });
    if (!input.createClient) privatelyProvisionedActors.add(actor);
    return actor;
  } catch {
    // Never remove a possibly in-flight collection or recycle this identity.
    throw new Error(`Generation provisioning failed or has an unknown outcome at ${phase}; abandon this generation.`);
  }
}

async function bounded<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Generation operation timed out.')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function assertStatus(value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('Invalid generation operation status.');
  const object = value as Record<string, unknown>;
  const status = object.status && typeof object.status === 'object' ? object.status as Record<string, unknown> : object;
  if (status.error_code !== 'Success' || (status.code !== undefined && status.code !== 0)) {
    throw new Error('Generation operation failed.');
  }
}
