import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileMiroFishGraphArtifactStore } from '../src/lib/mirofish/graph-artifact-store';
import { getMiroFishGraphArtifactRuntime } from '../src/lib/mirofish/graph-artifact-runtime';
import { importMiroFishGraphArtifacts } from '../src/lib/knowledge-graph/artifact-importer';
import { Neo4jKnowledgeGraphCommandStore } from '../src/lib/knowledge-graph/neo4j-command-store';
import { getNeo4jRuntimeConfig } from '../src/lib/neo4j/config';
import { getNeo4jClient } from '../src/lib/neo4j/driver';
import { initializeNeo4jSchema } from '../src/lib/neo4j/schema';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  shouldUsePostgresPersistence,
} from '../src/lib/postgres/env';
import { createRetrievalScope } from '../src/lib/security/retrieval-scope';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log([
      'Usage: pnpm graph:import [-- --apply]',
      '',
      'Default: dry-run only; reads and validates artifacts without writing Neo4j.',
      '--apply: write staged snapshots through the configured PostgreSQL control plane.',
    ].join('\n'));
    return;
  }
  const apply = resolveApplyMode(process.argv.slice(2));
  assertApplyControlPlaneConfigured(apply);
  const tenantId = requiredEnv('RAG_DEFAULT_TENANT_ID');
  const corpusId = requiredEnv('RAG_DEFAULT_CORPUS_ID');
  const root = path.resolve(
    process.env.RAG_MIROFISH_GRAPH_STORE_ROOT?.trim()
      || path.join(process.cwd(), 'uploads', 'mirofish-graph-artifacts-v2')
  );
  const client = getNeo4jClient(getNeo4jRuntimeConfig());
  if (!client) {
    throw new Error('Neo4j credentials are required for historical graph import.');
  }
  if (shouldInitializeSchema(apply)) {
    await initializeNeo4jSchema(client);
  }
  const summary = await importMiroFishGraphArtifacts({
    source: new FileMiroFishGraphArtifactStore(root),
    target: new Neo4jKnowledgeGraphCommandStore(client),
    ...(apply
      ? {
          coordinatedTarget: getMiroFishGraphArtifactRuntime({
            ...process.env,
            RAG_GRAPH_BACKEND: 'neo4j',
          }).store,
        }
      : {}),
    scope: createRetrievalScope({
      tenantId,
      corpusId,
      allowedTrustLevels: ['trusted', 'reviewed', 'external'],
      enforceIsolation: true,
    }),
    dryRun: !apply,
  });
  console.log(JSON.stringify(summary));
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to write staged snapshots.');
  }
}

export function resolveApplyMode(args: readonly string[]): boolean {
  const unknown = args.filter(arg => arg !== '--apply');
  if (unknown.length > 0) {
    throw new Error(`Unknown graph import argument: ${unknown[0]}.`);
  }
  return args.includes('--apply');
}

export function shouldInitializeSchema(apply: boolean): boolean {
  return apply;
}

export function assertApplyControlPlaneConfigured(
  apply: boolean,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!apply) return;
  const config = getPostgresRuntimeConfig(env);
  if (!shouldUsePostgresPersistence(config)) {
    throw new Error(
      '--apply requires the PostgreSQL graph publication control plane; '
      + 'set RAG_PERSISTENCE_BACKEND=postgres or dual-write.'
    );
  }
  assertPostgresPersistenceConfigured(config);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + ' is required.');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Historical graph import failed.');
    process.exitCode = 1;
  });
}
