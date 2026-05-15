export type RagPersistenceBackend = 'local' | 'supabase' | 'dual-write';
export type RagVectorBackend = 'milvus' | 'zilliz' | 'supabase_pgvector' | 'hybrid';

export interface SupabaseRuntimeConfig {
  url: string;
  publishableKey: string;
  secretKey: string;
  serviceRoleKey: string;
  defaultTenantId: string;
  defaultCorpusId: string;
  rawBucket: string;
  parsedBucket: string;
  realtimeEnabled: boolean;
  persistenceBackend: RagPersistenceBackend;
  vectorBackend: RagVectorBackend;
}

function readEnv(name: string): string {
  return process.env[name]?.trim() || '';
}

function parseBoolean(value: string, fallback: boolean): boolean {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parsePersistenceBackend(value: string): RagPersistenceBackend {
  switch (value.toLowerCase()) {
    case 'supabase':
      return 'supabase';
    case 'dual-write':
    case 'dual_write':
    case 'dualwrite':
      return 'dual-write';
    case 'local':
    default:
      return 'local';
  }
}

function parseVectorBackend(value: string): RagVectorBackend {
  switch (value.toLowerCase()) {
    case 'zilliz':
      return 'zilliz';
    case 'supabase_pgvector':
    case 'supabase-pgvector':
    case 'pgvector':
      return 'supabase_pgvector';
    case 'hybrid':
      return 'hybrid';
    case 'milvus':
    default:
      return 'milvus';
  }
}

export function getSupabaseRuntimeConfig(): SupabaseRuntimeConfig {
  return {
    url: readEnv('NEXT_PUBLIC_SUPABASE_URL'),
    publishableKey: readEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY') || readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    secretKey: readEnv('SUPABASE_SECRET_KEY'),
    serviceRoleKey: readEnv('SUPABASE_SERVICE_ROLE_KEY'),
    defaultTenantId: readEnv('SUPABASE_DEFAULT_TENANT_ID'),
    defaultCorpusId: readEnv('SUPABASE_DEFAULT_CORPUS_ID'),
    rawBucket: readEnv('SUPABASE_STORAGE_RAW_BUCKET') || 'rag-raw-files',
    parsedBucket: readEnv('SUPABASE_STORAGE_PARSED_BUCKET') || 'rag-parsed-text',
    realtimeEnabled: parseBoolean(readEnv('SUPABASE_REALTIME_ENABLED'), true),
    persistenceBackend: parsePersistenceBackend(readEnv('RAG_PERSISTENCE_BACKEND')),
    vectorBackend: parseVectorBackend(readEnv('RAG_VECTOR_BACKEND')),
  };
}

export function isSupabaseConfigured(config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig()): boolean {
  return Boolean(config.url && (config.serviceRoleKey || config.secretKey || config.publishableKey));
}

export function isSupabaseAdminConfigured(config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig()): boolean {
  return Boolean(config.url && config.serviceRoleKey && config.defaultTenantId);
}

export function shouldUseSupabasePersistence(
  config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig()
): boolean {
  return config.persistenceBackend === 'supabase' || config.persistenceBackend === 'dual-write';
}

export function shouldDualWriteSupabase(
  config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig()
): boolean {
  return config.persistenceBackend === 'dual-write';
}

export function getSupabaseConfigSummary(config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig()) {
  return {
    configured: isSupabaseConfigured(config),
    adminConfigured: isSupabaseAdminConfigured(config),
    persistenceBackend: config.persistenceBackend,
    vectorBackend: config.vectorBackend,
    hasUrl: Boolean(config.url),
    hasPublishableKey: Boolean(config.publishableKey),
    hasSecretKey: Boolean(config.secretKey),
    hasServiceRoleKey: Boolean(config.serviceRoleKey),
    hasDefaultTenantId: Boolean(config.defaultTenantId),
    hasDefaultCorpusId: Boolean(config.defaultCorpusId),
    rawBucket: config.rawBucket,
    parsedBucket: config.parsedBucket,
    realtimeEnabled: config.realtimeEnabled,
  };
}
