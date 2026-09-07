export type VectorIngestStage =
  | 'preparing'
  | 'loading'
  | 'splitting'
  | 'contextualizing'
  | 'embedding'
  | 'storing'
  | 'reindexing';

export interface VectorIngestSnapshot {
  version: 'vector-ingest-state/v1';
  status: 'ready' | 'building';
  activeOperations: number;
  stages: Partial<Record<VectorIngestStage, number>>;
  topology: 'process-local';
  retryAfterSeconds: number;
  lastFailure?: {
    code: string;
    at: string;
  };
}

export interface VectorIngestLease {
  updateStage(stage: VectorIngestStage): void;
  fail(error: unknown): void;
  release(): void;
}

interface ActiveVectorIngest {
  collectionName: string;
  stage: VectorIngestStage;
  startedAt: number;
}

interface VectorIngestStore {
  active: Map<string, ActiveVectorIngest>;
  lastFailure?: VectorIngestSnapshot['lastFailure'];
}

const GLOBAL_STORE_KEY = '__ragVectorIngestStateV1' as const;
const DEFAULT_MAX_CONCURRENT_INGEST = 1;
const MAX_CONCURRENT_INGEST = 8;
const RETRY_AFTER_SECONDS = 2;

type VectorIngestGlobal = typeof globalThis & {
  [GLOBAL_STORE_KEY]?: VectorIngestStore;
};

export class VectorIngestBusyError extends Error {
  readonly code = 'VECTOR_INGEST_BUSY';
  readonly status = 429;
  readonly retryAfterSeconds = RETRY_AFTER_SECONDS;

  constructor(limit: number) {
    super(`Vector ingestion concurrency limit reached (${limit}).`);
    this.name = 'VectorIngestBusyError';
  }
}

export class VectorIndexBuildingError extends Error {
  readonly code = 'RAG_INDEX_BUILDING';
  readonly status = 503;
  readonly retryAfterSeconds = RETRY_AFTER_SECONDS;

  constructor() {
    super('Knowledge-base vectorization is in progress. Retry after it is ready.');
    this.name = 'VectorIndexBuildingError';
  }
}

export function beginVectorIngest(input: {
  operationId: string;
  collectionName: string;
  stage?: VectorIngestStage;
}): VectorIngestLease {
  const operationId = input.operationId.trim();
  const collectionName = input.collectionName.trim();
  if (!operationId) throw new Error('Vector ingest operationId is required.');
  if (!collectionName) throw new Error('Vector ingest collectionName is required.');

  const store = getStore();
  const limit = resolveVectorIngestConcurrencyLimit();
  if (store.active.has(operationId) || store.active.size >= limit) {
    throw new VectorIngestBusyError(limit);
  }

  store.active.set(operationId, {
    collectionName,
    stage: input.stage ?? 'preparing',
    startedAt: Date.now(),
  });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    store.active.delete(operationId);
  };

  return {
    updateStage(stage) {
      if (released) return;
      const operation = store.active.get(operationId);
      if (operation) operation.stage = stage;
    },
    fail(error) {
      if (released) return;
      store.lastFailure = {
        code: safeErrorCode(error, 'VECTORIZATION_FAILED'),
        at: new Date().toISOString(),
      };
      release();
    },
    release,
  };
}

export function getVectorIngestSnapshot(): VectorIngestSnapshot {
  const store = getStore();
  const stages: VectorIngestSnapshot['stages'] = {};
  for (const operation of store.active.values()) {
    stages[operation.stage] = (stages[operation.stage] ?? 0) + 1;
  }

  return {
    version: 'vector-ingest-state/v1',
    status: store.active.size > 0 ? 'building' : 'ready',
    activeOperations: store.active.size,
    stages,
    topology: 'process-local',
    retryAfterSeconds: RETRY_AFTER_SECONDS,
    ...(store.lastFailure === undefined
      ? {}
      : { lastFailure: { ...store.lastFailure } }),
  };
}

export function assertVectorSearchReady(): void {
  if (getStore().active.size > 0) throw new VectorIndexBuildingError();
}

export function resetVectorIngestStateForTests(): void {
  const root = globalThis as VectorIngestGlobal;
  root[GLOBAL_STORE_KEY] = { active: new Map() };
}

function getStore(): VectorIngestStore {
  const root = globalThis as VectorIngestGlobal;
  const existing = root[GLOBAL_STORE_KEY];
  if (existing) return existing;
  const created: VectorIngestStore = { active: new Map() };
  root[GLOBAL_STORE_KEY] = created;
  return created;
}

function resolveVectorIngestConcurrencyLimit(
  value: string | undefined = process.env.RAG_MAX_CONCURRENT_VECTOR_INGEST
): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_MAX_CONCURRENT_INGEST;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENT_INGEST) {
    throw new Error(
      `RAG_MAX_CONCURRENT_VECTOR_INGEST must be an integer between 1 and ${MAX_CONCURRENT_INGEST}.`
    );
  }
  return parsed;
}

function safeErrorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
    ? code
    : fallback;
}
