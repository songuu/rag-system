import {
  getSupabaseRuntimeConfig,
  isSupabaseAdminConfigured,
  type SupabaseRuntimeConfig,
} from './env';
import { SupabaseRestClient } from './rest-client';

let cachedAdminClient: SupabaseRestClient | null = null;
let cachedSignature = '';

function signature(config: SupabaseRuntimeConfig): string {
  return [
    config.url,
    config.serviceRoleKey ? 'service' : '',
    config.defaultTenantId,
    config.defaultCorpusId,
  ].join('|');
}

export function getSupabaseAdminClient(
  config: SupabaseRuntimeConfig = getSupabaseRuntimeConfig()
): SupabaseRestClient | null {
  if (!isSupabaseAdminConfigured(config)) return null;

  const nextSignature = signature(config);
  if (!cachedAdminClient || cachedSignature !== nextSignature) {
    cachedAdminClient = new SupabaseRestClient({
      url: config.url,
      key: config.serviceRoleKey,
    });
    cachedSignature = nextSignature;
  }

  return cachedAdminClient;
}
