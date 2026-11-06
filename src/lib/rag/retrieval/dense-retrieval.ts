/** Overlap independent provider calls while keeping timed-out work tracked until it settles. */
export async function executeDenseRetrieval<Vector, Results, Statistics>(input: {
  connect(): Promise<void>;
  initialize(): Promise<void>;
  embed(): Promise<Vector>;
  search(vector: Vector): Promise<Results>;
  statistics?: () => Promise<Statistics>;
  assertNotAborted(): void;
}): Promise<{ results: Results; statistics: Statistics | undefined }> {
  input.assertNotAborted();
  const setup = async () => {
    await input.connect();
    input.assertNotAborted();
    await input.initialize();
    input.assertNotAborted();
  };
  // Await both even on failure: a provider may ignore cancellation and the lane's
  // admission fence must remain active until all of its work has settled.
  const [setupResult, embeddingResult] = await Promise.allSettled([
    setup(),
    Promise.resolve().then(() => {
      input.assertNotAborted();
      return input.embed();
    }),
  ]);
  input.assertNotAborted();
  if (setupResult.status === 'rejected') throw setupResult.reason;
  if (embeddingResult.status === 'rejected') throw embeddingResult.reason;

  const [searchResult, statisticsResult] = await Promise.allSettled([
    Promise.resolve().then(() => {
      input.assertNotAborted();
      return input.search(embeddingResult.value);
    }),
    Promise.resolve().then(() => {
      input.assertNotAborted();
      return input.statistics?.();
    }),
  ]);
  input.assertNotAborted();
  if (searchResult.status === 'rejected') throw searchResult.reason;
  if (statisticsResult.status === 'rejected') throw statisticsResult.reason;
  return { results: searchResult.value, statistics: statisticsResult.value };
}
