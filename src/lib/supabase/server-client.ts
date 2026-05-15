import { getSupabaseRuntimeConfig, isSupabaseConfigured } from './env';
import { SupabaseRestClient } from './rest-client';

export function getSupabaseServerClient(accessToken?: string): SupabaseRestClient | null {
  const config = getSupabaseRuntimeConfig();
  if (!isSupabaseConfigured(config)) return null;

  const key = accessToken || config.secretKey || config.serviceRoleKey || config.publishableKey;
  if (!key) return null;

  return new SupabaseRestClient({
    url: config.url,
    key,
  });
}
