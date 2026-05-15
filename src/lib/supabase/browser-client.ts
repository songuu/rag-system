import { getSupabaseRuntimeConfig } from './env';

export function getSupabaseBrowserConfig() {
  const config = getSupabaseRuntimeConfig();
  return {
    url: config.url,
    publishableKey: config.publishableKey,
    configured: Boolean(config.url && config.publishableKey),
    realtimeEnabled: config.realtimeEnabled,
  };
}
