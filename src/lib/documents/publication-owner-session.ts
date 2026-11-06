import { Client, type ClientConfig } from 'pg';
import type { PostgresQueryResult } from '../postgres/client';
import { PUBLISHER_CAPABILITY_SQL } from './publication-publisher-capability';

// This is a cooperation lock for trusted publisher processes, not a fence
// against administrators or code that does not participate in the protocol.
const OWNER_LOCK_CLASS = 1380013904;
const OWNER_LOCK_OBJECT = 1347764812;

/** One private, non-pooled PostgreSQL session owns the lock for its lifetime. */
export class PublicationOwnerSession {
  #client: Client;
  #abort = new AbortController();
  #state: 'new' | 'active' | 'closed' = 'new';
  #busy = false;
  #timeoutMs: number;
  #ending?: Promise<void>;
  #work?: Promise<unknown>;

  constructor(config: ClientConfig, timeoutMs = 30000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 300000) throw new Error('Invalid publication owner timeout.');
    this.#timeoutMs = timeoutMs;
    this.#client = new Client({ ...config, connectionTimeoutMillis: timeoutMs, application_name: 'rag-publication-owner' });
    this.#client.on('error', () => this.#abort.abort());
    this.#client.on('end', () => this.#abort.abort());
  }

  get signal(): AbortSignal { return this.#abort.signal; }

  /** Claim is executed on the same session holding the owner lock. A lost
   * session may have committed a claim, so the caller must retain unknown. */
  async query<T>(text: string, values?: unknown[]): Promise<PostgresQueryResult<T>> {
    const capability = text === PUBLISHER_CAPABILITY_SQL && Array.isArray(values) && values.length === 0;
    const claim = text === 'select * from public.rag_claim_publication_request($1::uuid)' && Array.isArray(values) && values.length === 1;
    if (!this.#busy || (!capability && !claim)) {
      throw new Error('Publication owner permits only its fenced claim query.');
    }
    await this.assertOwner();
    const result = await bounded(this.#client.query(text, values), this.#timeoutMs, this.signal);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  async start(): Promise<void> {
    if (this.#state !== 'new') throw new Error('Publication owner cannot be restarted.');
    this.#state = 'closed';
    try {
      await bounded(this.#client.connect(), this.#timeoutMs, this.signal);
      const result = await bounded(this.#client.query<{ acquired: boolean }>(
        'select pg_catalog.pg_try_advisory_lock($1::int, $2::int) as acquired', [OWNER_LOCK_CLASS, OWNER_LOCK_OBJECT]), this.#timeoutMs, this.signal);
      if (result.rows.length !== 1 || result.rows[0].acquired !== true || this.signal.aborted) {
        throw new Error('Publication owner is already active or unavailable.');
      }
      this.#state = 'active';
    } catch (error) {
      this.#abort.abort();
      await this.#end();
      throw error;
    }
  }

  /** Recheck the same session immediately before every external operation. */
  async assertOwner(): Promise<void> {
    if (this.#state !== 'active' || this.signal.aborted) throw new Error('Publication ownership was lost.');
    try {
      const result = await bounded(this.#client.query<{ held: boolean }>(
        `select exists (select 1 from pg_catalog.pg_locks
          where locktype = 'advisory' and pid = pg_catalog.pg_backend_pid() and granted
          and classid = $1::oid and objid = $2::oid and objsubid = 2) as held`,
        [OWNER_LOCK_CLASS, OWNER_LOCK_OBJECT]), this.#timeoutMs, this.signal);
      if (result.rows.length !== 1 || result.rows[0].held !== true || this.signal.aborted) throw new Error('Publication ownership was lost.');
    } catch (error) {
      this.#abort.abort();
      this.#state = 'closed';
      if (!this.#work) await this.#end();
      throw error;
    }
  }

  /** Serialise cooperative operations; failed or ambiguous work cannot restart. */
  async execute<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error('Concurrent publisher operations are forbidden.');
    this.#busy = true;
    let settled = false;
    try {
      await this.assertOwner();
      // Callbacks must observe the signal between external RPCs. An already
      // issued RPC cannot be cancelled or fenced by this advisory lock.
      this.#work = Promise.resolve().then(() => work(this.signal)).finally(() => { settled = true; });
      const value = await bounded(this.#work as Promise<T>, this.#timeoutMs, this.signal);
      this.#work = undefined;
      await this.assertOwner();
      return value;
    } catch (error) {
      this.#abort.abort();
      this.#state = 'closed';
      if (this.#work && !settled) {
        // Keep the cooperative lock until the old work settles. If the PG
        // connection is lost first, no lock can fence its in-flight RPC.
        const pending = this.#work;
        void pending.then(() => this.#end(), () => this.#end());
      } else { this.#work = undefined; await this.#end(); }
      throw error;
    } finally { this.#busy = false; }
  }

  async close(): Promise<void> {
    this.#state = 'closed';
    this.#abort.abort();
    if (this.#work) { await bounded(this.#work.catch(() => undefined), this.#timeoutMs); this.#work = undefined; }
    await this.#end();
  }

  async #end(): Promise<void> {
    this.#ending ??= this.#client.end().catch(() => undefined);
    await bounded(this.#ending, this.#timeoutMs).catch(() => undefined);
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Publication owner operation timed out.')), timeoutMs);
      if (signal) {
        onAbort = () => reject(new Error('Publication ownership was lost.'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
    return await Promise.race([promise, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
