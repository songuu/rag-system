/** A read timeout cannot cancel PostgreSQL work already sent. It prevents
 * late completion from starting later reads or returning data to the caller. */
export async function publicationReadWithin<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Publication read timed out.')), 30_000);
      if (signal) {
        aborted = () => reject(signal.reason ?? new Error('Publication read cancelled.'));
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      }
    });
    const value = await Promise.race([Promise.resolve().then(() => { signal?.throwIfAborted(); return work(); }), cancellation]);
    signal?.throwIfAborted();
    return value;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && aborted) signal.removeEventListener('abort', aborted);
  }
}
