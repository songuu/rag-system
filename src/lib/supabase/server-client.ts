import { getSupabaseRuntimeConfig, type SupabaseRuntimeConfig } from './env';
import { SupabaseRestClient } from './rest-client';

export interface SupabaseServerClientOptions {
  config?: Pick<SupabaseRuntimeConfig, 'url' | 'publishableKey'>;
  fetchImpl?: typeof fetch;
}

export function getSupabaseServerClient(
  accessToken?: string,
  options: SupabaseServerClientOptions = {}
): SupabaseRestClient | null {
  const config = options.config ?? getSupabaseRuntimeConfig();
  const normalizedAccessToken = accessToken?.trim();

  // User request clients must never silently become an admin client.
  // Service-role work remains isolated in admin-client.ts.
  if (!config.url || !config.publishableKey || !normalizedAccessToken) return null;

  return new SupabaseRestClient({
    url: config.url,
    apiKey: config.publishableKey,
    accessToken: normalizedAccessToken,
    fetchImpl: options.fetchImpl,
  });
}
