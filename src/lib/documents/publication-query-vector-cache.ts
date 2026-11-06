interface CacheOptions { maxEntries?: number; maxBytes?: number; ttlMs?: number; now?: () => number }

/** Only completed vectors are retained. Requests never share an in-flight signal or collector. */
export function createPublicationQueryVectorCache(options: CacheOptions = {}) {
  const maxEntries = options.maxEntries ?? 128;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  if (![maxEntries, maxBytes, ttlMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid publication query cache policy.');
  }
  const entries = new Map<string, { vector: Float64Array; expiresAt: number }>();
  let bytes = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.vector.byteLength; entries.delete(key); }
  };
  return Object.freeze({
    get(key: string): number[] | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { remove(key); return undefined; }
      entries.delete(key); entries.set(key, entry);
      return Array.from(entry.vector);
    },
    set(key: string, vector: readonly number[]): void {
      remove(key);
      if (!vector.length || vector.length * Float64Array.BYTES_PER_ELEMENT > maxBytes
        || vector.some(value => !Number.isFinite(value))) return;
      const timestamp = now();
      for (const [existingKey, entry] of entries) if (entry.expiresAt <= timestamp) remove(existingKey);
      const stored = new Float64Array(vector);
      while (entries.size >= maxEntries || bytes + stored.byteLength > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
      entries.set(key, { vector: stored, expiresAt: timestamp + ttlMs }); bytes += stored.byteLength;
    },
    delete: remove,
  });
}
