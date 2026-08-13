export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TraceStatus = 'PENDING' | 'SUCCESS' | 'ERROR';
export type ObservationType = 'GENERATION' | 'SPAN' | 'EVENT';
export type ObservationLevel = 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR';
export type TraceScoreSource = 'USER' | 'AI' | 'SYSTEM';
export type IndexJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type IndexJobType = 'parse' | 'embed' | 'milvus_sync' | 'reindex' | 'cleanup';
export type VectorBackend = 'milvus' | 'zilliz' | 'postgres_pgvector';
