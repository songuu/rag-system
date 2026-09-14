import { main } from './elasticsearch-index-worker';

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Elasticsearch index worker failed.');
  process.exitCode = 1;
});

