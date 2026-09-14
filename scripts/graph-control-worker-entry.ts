import { main } from './graph-control-worker';

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Graph control worker failed.');
  process.exitCode = 1;
});
