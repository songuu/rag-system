import type { PublicationGrantJournal } from './publication-grant-journal';

type Journal = Pick<PublicationGrantJournal, 'listAll' | 'listEvents'>;
type Event = { id: string; phase: string };

/**
 * Read-only recovery observer. No callback can authorize an automatic revoke:
 * lease checks cannot fence a remote grant or another process. Each operation
 * eventually restarts its event scan from zero because sequence allocation and
 * transaction commit have different orders. Timed-out calls can still finish;
 * callbacks must be read-only and idempotent. A timeout stops the worker so
 * an unresolved call is never overlapped by another cycle.
 */
export class PublicationGrantRecoveryWorker {
  private running = false;
  private finished = false;
  private inventoryCursor: string | null = null;
  private readonly eventCursors = new Map<string, string>();
  private readonly options: {
    journal: Journal;
    onEvent: (operationId: string, event: Event) => Promise<void>;
    onError: (operationId: string | null, error: unknown) => Promise<void>;
    onUnknown: (operationId: string) => Promise<void>;
    signal: AbortSignal;
    operationDelayMs: number; cycleDelayMs: number; maxPages: number; operationTimeoutMs?: number;
  };
  constructor(options: PublicationGrantRecoveryWorker['options']) {
    if (!Number.isSafeInteger(options.operationDelayMs) || options.operationDelayMs < 100 || options.operationDelayMs > 60000
      || !Number.isSafeInteger(options.cycleDelayMs) || options.cycleDelayMs < 1000 || options.cycleDelayMs > 3600000
      || !Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 10000
      || !Number.isSafeInteger(options.operationTimeoutMs ?? 10000) || (options.operationTimeoutMs ?? 10000) < 10
      || (options.operationTimeoutMs ?? 10000) > 30000) throw new Error('Invalid recovery worker limits.');
    if (typeof options.onUnknown !== 'function') throw new Error('A recovery unknown handler is required.');
    this.options = options;
  }
  async run(): Promise<void> {
    if (this.running || this.finished) throw new Error('Recovery worker is already running or permanently stopped.');
    this.running = true;
    try {
      while (!this.options.signal.aborted) {
        try { await this.scan(); }
        catch (error) {
          if (this.options.signal.aborted) return;
          if (error instanceof RecoveryTimeout) throw error;
          await this.invoke(() => this.options.onError(null, error));
        }
        if (this.options.signal.aborted) return;
        await delay(this.options.cycleDelayMs, this.options.signal);
      }
    } finally { this.running = false; this.finished = true; }
  }
  private async scan(): Promise<void> {
    let after = this.inventoryCursor;
    for (let page = 0; page < this.options.maxPages; page++) {
      if (this.options.signal.aborted) return;
      const rows = await this.invoke(() => this.options.journal.listAll(after, 100));
      if (this.options.signal.aborted) return;
      for (const row of rows) {
        if (this.options.signal.aborted) return;
        try {
          await this.scanEvents(row.operationId);
          if (this.options.signal.aborted) return;
          await this.invoke(() => this.options.onUnknown(row.operationId));
        } catch (error) {
          if (this.options.signal.aborted) return;
          if (error instanceof RecoveryTimeout) throw error;
          await this.invoke(() => this.options.onError(row.operationId, error));
        }
        if (this.options.signal.aborted) return;
        await delay(this.options.operationDelayMs, this.options.signal);
      }
      if (rows.length < 100) { this.inventoryCursor = null; return; }
      after = rows[rows.length - 1].operationId;
      this.inventoryCursor = after;
    }
    throw new Error('Recovery inventory scan paused at its page limit; the next cycle resumes and outcome remains unknown.');
  }
  private async scanEvents(operationId: string): Promise<void> {
    let after = this.eventCursors.get(operationId) ?? '0';
    for (let page = 0; page < this.options.maxPages; page++) {
      if (this.options.signal.aborted) return;
      const events = await this.invoke(() => this.options.journal.listEvents(operationId, after, 100));
      if (this.options.signal.aborted) return;
      for (const event of events) {
        if (this.options.signal.aborted) return;
        await this.invoke(() => this.options.onEvent(operationId, event));
      }
      if (this.options.signal.aborted) return;
      if (events.length < 100) { this.eventCursors.delete(operationId); return; }
      after = events[events.length - 1].id;
      this.eventCursors.set(operationId, after);
    }
    // Resume this operation on the next pass, then restart from zero after
    // reaching the end so delayed commits eventually appear.
  }
  private async invoke<T>(work: () => Promise<T>): Promise<T> {
    const signal = this.options.signal;
    if (signal.aborted) throw new Error('Recovery observer cancelled.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (signal.aborted) throw new Error('Recovery observer cancelled.');
        return work();
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RecoveryTimeout()), this.options.operationTimeoutMs ?? 10000);
        onAbort = () => reject(new Error('Recovery observer cancelled.'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}

class RecoveryTimeout extends Error {
  constructor() { super('Recovery observer operation timed out; worker stopped and outcome remains unknown.'); }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
