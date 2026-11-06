export interface PublicationReaderClientLease<T> {
  readonly value: T;
  release(): void;
  invalidate(): void;
}

interface Resource<T> { value: T; close(): Promise<unknown> }
type CloseOutcome = { ok: true } | { ok: false; error: unknown };
interface Entry<T> {
  key: string;
  resource: Resource<T>;
  users: number;
  retired: boolean;
  closing: boolean;
  closeFailed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: Promise<CloseOutcome>;
  resolveClosed(outcome: CloseOutcome): void;
}

/** Cache transports only. Permission and publication decisions belong to each request. */
export function createPublicationReaderClientCache<T>(options: {
  maxEntries: number;
  idleTimeoutMs: number;
  onCloseError?: (error: unknown) => void;
}) {
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1
    || !Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1) {
    throw new Error('Invalid publication reader cache configuration.');
  }
  const reusable = new Map<string, Entry<T>>();
  // Retired but still active/closing resources count against capacity too.
  const entries = new Set<Entry<T>>();

  function closeIfUnused(entry: Entry<T>): void {
    if (!entry.retired || entry.users || entry.closing || entry.closeFailed) return;
    entry.closing = true;
    void Promise.resolve().then(() => entry.resource.close()).then(() => {
      entries.delete(entry);
      entry.resolveClosed({ ok: true });
    }, error => {
      // A rejected close is not evidence that the underlying sockets are gone.
      // Keep the resource isolated and counted until explicit recovery succeeds.
      entry.closing = false;
      entry.closeFailed = true;
      try { options.onCloseError?.(error); } catch { /* Diagnostics cannot alter quarantine. */ }
      entry.resolveClosed({ ok: false, error });
    });
  }

  function retire(entry: Entry<T>): void {
    entry.retired = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (reusable.get(entry.key) === entry) reusable.delete(entry.key);
    closeIfUnused(entry);
  }

  function lease(entry: Entry<T>): PublicationReaderClientLease<T> {
    entry.users++;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    let released = false;
    return {
      get value() { return entry.resource.value; },
      invalidate: () => retire(entry),
      release() {
        if (released) return;
        released = true;
        entry.users--;
        if (entry.users) return;
        if (entry.retired) closeIfUnused(entry);
        else {
          entry.idleTimer = setTimeout(() => retire(entry), options.idleTimeoutMs);
          entry.idleTimer.unref?.();
        }
      },
    };
  }

  return {
    async acquire(key: string, create: () => Resource<T>, signal?: AbortSignal): Promise<PublicationReaderClientLease<T>> {
      signal?.throwIfAborted();
      for (;;) {
        const existing = reusable.get(key);
        if (existing) return lease(existing);
        if (entries.size < options.maxEntries) break;
        const idle = [...entries].find(entry => !entry.users && !entry.retired);
        if (!idle) throw new Error('Publication reader client capacity is unavailable.');
        retire(idle);
        const outcome = await waitForClose(idle.closed, signal);
        assertClosed([outcome]);
        // A request that stopped waiting must never construct a late client.
        signal?.throwIfAborted();
      }
      const resource = create();
      let resolveClosed!: (outcome: CloseOutcome) => void;
      const closed = new Promise<CloseOutcome>(resolve => { resolveClosed = resolve; });
      const entry: Entry<T> = { key, resource, users: 0, retired: false, closing: false, closeFailed: false, closed, resolveClosed };
      entries.add(entry); reusable.set(key, entry);
      return lease(entry);
    },
    /** Retire the current generation; active operations retain their leases until settled. */
    async close(): Promise<void> {
      const current = [...entries];
      current.forEach(retire);
      assertClosed(await Promise.all(current.map(entry => entry.closed)));
    },
    /** Recovery is explicit: ordinary requests and close() cannot hide a failed close. */
    async retryFailedClosures(): Promise<void> {
      const failed = [...entries].filter(entry => entry.closeFailed && !entry.users && !entry.closing);
      for (const entry of failed) {
        entry.closed = new Promise<CloseOutcome>(resolve => { entry.resolveClosed = resolve; });
        entry.closeFailed = false;
        closeIfUnused(entry);
      }
      assertClosed(await Promise.all(failed.map(entry => entry.closed)));
    },
  };
}

function assertClosed(outcomes: readonly CloseOutcome[]): void {
  const errors = outcomes.flatMap(outcome => outcome.ok ? [] : [outcome.error]);
  if (errors.length) throw new AggregateError(errors, 'Publication reader cleanup failed; resources remain quarantined.');
}

async function waitForClose(closed: Promise<CloseOutcome>, signal?: AbortSignal): Promise<CloseOutcome> {
  if (!signal) return closed;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([closed, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
