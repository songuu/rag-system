/** Resource leases must cover every started RPC, including siblings of a failure. */
export async function settlePublicationReads<T extends readonly unknown[]>(
  operations: { [K in keyof T]: () => T[K] },
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  // Schedule callbacks together so a synchronous SDK throw cannot orphan an
  // earlier call before its rejection handler has been registered.
  const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as { [K in keyof T]: Awaited<T[K]> };
}
