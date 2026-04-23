export async function mapPagesWithOrderedCallbacks<TPage extends { index: number }, TResult>(
  pages: TPage[],
  concurrency: number,
  worker: (page: TPage) => Promise<TResult>,
  onPage?: (index: number) => void
): Promise<TResult[]> {
  const safeConcurrency = Math.max(1, Math.floor(concurrency));
  const results: TResult[] = new Array(pages.length);

  for (let start = 0; start < pages.length; start += safeConcurrency) {
    const batch = pages.slice(start, start + safeConcurrency);
    const batchResults = await Promise.all(
      batch.map(async (page, batchIndex) => ({
        batchIndex,
        pageIndex: page.index,
        result: await worker(page),
      }))
    );

    // LLM calls finish nondeterministically; progress events must still be monotonic.
    batchResults.sort((left, right) => left.batchIndex - right.batchIndex);
    for (const item of batchResults) {
      results[start + item.batchIndex] = item.result;
      onPage?.(item.pageIndex);
    }
  }

  return results;
}
