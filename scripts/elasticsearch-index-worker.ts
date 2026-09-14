import {
  closeElasticsearchClient,
  getElasticsearchClient,
  type ElasticsearchClientPort,
} from '../src/lib/elasticsearch/client';
import {
  assertElasticsearchConfigured,
  getElasticsearchRuntimeConfig,
} from '../src/lib/elasticsearch/config';
import {
  ensureElasticsearchLexicalIndex,
  replaceElasticsearchDocument,
  type ElasticsearchLexicalDocument,
} from '../src/lib/elasticsearch/lexical-index';
import {
  PostgresElasticsearchOutboxStore,
  type ClaimedElasticsearchOutboxEvent,
} from '../src/lib/elasticsearch/postgres-outbox-store';
import { closePostgresPool, getPostgresClient } from '../src/lib/postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
} from '../src/lib/postgres/env';

interface ElasticsearchOutboxStorePort {
  claim(options: { limit: number; leaseMs: number }): Promise<ClaimedElasticsearchOutboxEvent[]>;
  loadDocuments(event: ClaimedElasticsearchOutboxEvent): Promise<ElasticsearchLexicalDocument[]>;
  acknowledge(event: ClaimedElasticsearchOutboxEvent): Promise<boolean>;
  retry(event: ClaimedElasticsearchOutboxEvent, input: {
    error: unknown;
    maxAttempts: number;
    retryDelayMs: number;
  }): Promise<'retry' | 'dead-letter' | 'lost-lease'>;
}

export async function projectElasticsearchOutboxBatch(input: {
  store: ElasticsearchOutboxStorePort;
  client: ElasticsearchClientPort;
  indexName: string;
  limit: number;
  leaseMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  ensureIndex?: () => Promise<unknown>;
  replaceDocument?: (input: {
    client: ElasticsearchClientPort;
    indexName: string;
    event: ClaimedElasticsearchOutboxEvent;
    documents: ElasticsearchLexicalDocument[];
  }) => Promise<unknown>;
}) {
  await (input.ensureIndex ?? (() => ensureElasticsearchLexicalIndex({
    client: input.client,
    indexName: input.indexName,
  })))();
  const events = await input.store.claim({
    limit: boundedInteger(input.limit, 1, 1_000, 'batch size'),
    leaseMs: input.leaseMs ?? 30_000,
  });
  const summary = {
    claimed: events.length,
    projected: 0,
    retried: 0,
    deadLettered: 0,
    lostLease: 0,
  };
  for (const event of events) {
    try {
      const documents = await input.store.loadDocuments(event);
      if (event.eventType === 'upsert' && documents.length === 0) {
        throw new Error('Elasticsearch upsert event has no staged chunks.');
      }
      await (input.replaceDocument ?? defaultReplaceDocument)({
        client: input.client,
        indexName: input.indexName,
        event,
        documents,
      });
      if (await input.store.acknowledge(event)) summary.projected++;
      else summary.lostLease++;
    } catch (error) {
      const outcome = await input.store.retry(event, {
        error,
        maxAttempts: input.maxAttempts ?? 8,
        retryDelayMs: input.retryDelayMs ?? 5_000,
      });
      if (outcome === 'retry') summary.retried++;
      else if (outcome === 'dead-letter') summary.deadLettered++;
      else summary.lostLease++;
    }
  }
  return summary;
}

async function defaultReplaceDocument(input: {
  client: ElasticsearchClientPort;
  indexName: string;
  event: ClaimedElasticsearchOutboxEvent;
  documents: ElasticsearchLexicalDocument[];
}): Promise<void> {
  if (input.event.eventType === 'upsert') {
    for (const document of input.documents) {
      if (document.document_version !== input.event.documentVersion) {
        throw new Error('Staged Elasticsearch chunks do not match the claimed document version.');
      }
    }
  }
  await replaceElasticsearchDocument({
    client: input.client,
    indexName: input.indexName,
    identity: {
      tenantId: input.event.tenantId,
      corpusId: input.event.corpusId,
      documentId: input.event.documentId,
    },
    documents: input.event.eventType === 'delete' ? [] : input.documents,
  });
}

export async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const elasticsearchConfig = getElasticsearchRuntimeConfig();
  assertElasticsearchConfigured(elasticsearchConfig);
  if (elasticsearchConfig.mode === 'off') {
    throw new Error('Elasticsearch index worker requires RAG_ELASTICSEARCH_MODE=shadow or active.');
  }
  const postgresConfig = getPostgresRuntimeConfig();
  assertPostgresPersistenceConfigured(postgresConfig);
  const postgresClient = getPostgresClient(postgresConfig);
  if (!postgresClient) throw new Error('PostgreSQL is required for the Elasticsearch index worker.');
  const elasticsearchClient = await getElasticsearchClient(elasticsearchConfig);
  if (!elasticsearchClient) throw new Error('Elasticsearch client is disabled.');
  const store = new PostgresElasticsearchOutboxStore(postgresClient);
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    do {
      const summary = await projectElasticsearchOutboxBatch({
        store,
        client: elasticsearchClient,
        indexName: elasticsearchConfig.indexName,
        limit: options.batchSize,
        leaseMs: options.leaseMs,
        maxAttempts: options.maxAttempts,
        retryDelayMs: options.retryDelayMs,
      });
      console.log(JSON.stringify({ type: 'elasticsearch_index_iteration', ...summary }));
      if (!options.once && !stopping) await delay(options.intervalMs);
    } while (!options.once && !stopping);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.allSettled([closeElasticsearchClient(), closePostgresPool()]);
  }
}

function parseOptions(args: string[]) {
  const options = {
    once: false,
    intervalMs: 5_000,
    batchSize: 50,
    leaseMs: 30_000,
    maxAttempts: 8,
    retryDelayMs: 5_000,
  };
  for (const argument of args) {
    if (argument === '--') continue;
    if (argument === '--once') { options.once = true; continue; }
    const [name, rawValue] = argument.split('=', 2);
    if (!rawValue) throw new Error(`Unknown Elasticsearch index worker argument: ${argument}.`);
    if (name === '--interval-ms') options.intervalMs = boundedInteger(Number(rawValue), 100, 60_000, 'interval');
    else if (name === '--batch-size') options.batchSize = boundedInteger(Number(rawValue), 1, 1_000, 'batch size');
    else if (name === '--lease-ms') options.leaseMs = boundedInteger(Number(rawValue), 1_000, 600_000, 'lease');
    else if (name === '--max-attempts') options.maxAttempts = boundedInteger(Number(rawValue), 1, 100, 'max attempts');
    else if (name === '--retry-delay-ms') options.retryDelayMs = boundedInteger(Number(rawValue), 100, 3_600_000, 'retry delay');
    else throw new Error(`Unknown Elasticsearch index worker argument: ${argument}.`);
  }
  return options;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Elasticsearch index worker ${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

