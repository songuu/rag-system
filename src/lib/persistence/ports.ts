import type { JsonValue, TraceScoreSource } from '../supabase/database.types';

export type BlobKind = 'raw' | 'parsed' | 'artifact';

export interface FileManifestItem {
  id: string;
  originalName: string;
  originalExtension: string;
  storedFilename: string;
  parsedFilename: string;
  size: number;
  contentLength: number;
  uploadedAt: string;
  parseMethod: string;
  pages?: number;
}

export interface BlobWriteOptions {
  kind: BlobKind;
  contentType?: string;
  metadata?: Record<string, JsonValue>;
}

export interface BlobStat {
  size: number;
  modified: string;
}

export interface BlobStore {
  ensureRoot(): Promise<void>;
  exists(filename: string): Promise<boolean>;
  write(filename: string, data: string | Uint8Array, options: BlobWriteOptions): Promise<void>;
  readText(filename: string): Promise<string>;
  list(): Promise<string[]>;
  stat(filename: string): Promise<BlobStat>;
  delete(filename: string): Promise<boolean>;
}

export interface UploadManifestStore {
  loadManifest(): Promise<Record<string, FileManifestItem>>;
  saveManifest(manifest: Record<string, FileManifestItem>): Promise<void>;
  recordUpload(item: FileManifestItem): Promise<void>;
  removeUpload(match: string): Promise<FileManifestItem | null>;
}

export interface TraceListPayload {
  traces: JsonValue[];
  stats: JsonValue;
}

export interface TraceStore {
  listTraces(): Promise<TraceListPayload>;
  getTrace(traceId: string): Promise<JsonValue | null>;
  upsertTrace(trace: JsonValue): Promise<void>;
  addScore(input: {
    traceId: string;
    observationId?: string;
    name: string;
    value: JsonValue;
    source: TraceScoreSource;
    comment?: string;
  }): Promise<string>;
  clear(): Promise<void>;
}

export interface IndexJobStore {
  createJob(input: {
    corpusId?: string;
    documentId?: string;
    jobType: 'parse' | 'embed' | 'milvus_sync' | 'reindex' | 'cleanup';
    metadata?: Record<string, JsonValue>;
  }): Promise<string | null>;
  updateJob(input: {
    jobId: string;
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    progress?: number;
    error?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<void>;
}
