/**
 * Client-safe runtime defaults.
 *
 * These values are only first-render fallbacks. Server runtime choices still
 * come from model-config.ts and embedding-config.ts, then flow to clients via
 * /api/model-config.
 */
export const DEFAULT_RUNTIME_MODELS = {
  llm: 'llama3.1',
  embedding: 'nomic-embed-text',
  reasoning: 'deepseek-r1',
} as const;

