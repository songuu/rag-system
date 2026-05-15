import { randomUUID } from 'crypto';
import type { JsonValue, TableInsert, TableUpdate } from '../supabase/database.types';
import { getSupabaseAdminClient } from '../supabase/admin-client';
import {
  getSupabaseRuntimeConfig,
  isSupabaseAdminConfigured,
  type SupabaseRuntimeConfig,
} from '../supabase/env';
import type { IndexJobStore } from './ports';

export class SupabaseIndexJobStore implements IndexJobStore {
  private readonly config: SupabaseRuntimeConfig;

  constructor(config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig()) {
    this.config = config;
  }

  isReady(): boolean {
    return isSupabaseAdminConfigured(this.config);
  }

  async createJob(input: {
    corpusId?: string;
    documentId?: string;
    jobType: 'parse' | 'embed' | 'milvus_sync' | 'reindex' | 'cleanup';
    metadata?: Record<string, JsonValue>;
  }): Promise<string | null> {
    const client = getSupabaseAdminClient(this.config);
    if (!client || !this.isReady()) return null;

    const jobId = randomUUID();
    const row: TableInsert<'index_jobs'> = {
      id: jobId,
      tenant_id: this.config.defaultTenantId,
      corpus_id: (input.corpusId ?? this.config.defaultCorpusId) || null,
      document_id: input.documentId ?? null,
      job_type: input.jobType,
      status: 'queued',
      progress: 0,
      metadata: input.metadata ?? {},
    };

    await client.insertRows('index_jobs', row);
    return jobId;
  }

  async updateJob(input: {
    jobId: string;
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    progress?: number;
    error?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<void> {
    const client = getSupabaseAdminClient(this.config);
    if (!client || !this.isReady()) return;

    const row: TableUpdate<'index_jobs'> = {
      status: input.status,
      progress: input.progress,
      error: input.error,
      metadata: input.metadata,
      started_at: input.status === 'running' ? new Date().toISOString() : undefined,
      completed_at: input.status === 'succeeded' || input.status === 'failed' || input.status === 'cancelled'
        ? new Date().toISOString()
        : undefined,
    };

    await client.updateRows('index_jobs', { id: input.jobId }, row as Record<string, unknown>);
  }
}
