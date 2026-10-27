export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { hydrateEmbeddingIndex } = await import('./lib/embedding-index-persistence');
    await hydrateEmbeddingIndex();
  }
}
