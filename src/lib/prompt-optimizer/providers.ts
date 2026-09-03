import type { ModelProvider } from './contracts';
import type { ModelMessage } from './templates';

export interface ModelProfileRuntimeInput {
  profileId: string; name: string; provider: ModelProvider; model: string; baseUrl: string | null;
  settings: Record<string, unknown>;
}

type Environment = Record<string, string | undefined>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let activeOptimizationRequests = 0;
const MAX_CONCURRENT_OPTIMIZATIONS = 4;

export class PromptOptimizerBusyError extends Error {
  readonly status = 429;
  constructor() { super('Prompt optimizer is busy. Retry shortly.'); this.name = 'PromptOptimizerBusyError'; }
}

export function resolveProviderRuntime(profile: ModelProfileRuntimeInput, env: Environment = process.env) {
  const production = env.NODE_ENV === 'production';
  let baseUrl: string;
  let apiKey = '';
  if (profile.provider === 'openai') {
    baseUrl = 'https://api.openai.com/v1';
    apiKey = env.PROMPT_OPTIMIZER_OPENAI_API_KEY || env.OPENAI_API_KEY || '';
  } else if (profile.provider === 'openrouter') {
    baseUrl = 'https://openrouter.ai/api/v1';
    apiKey = env.PROMPT_OPTIMIZER_OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || '';
  } else if (profile.provider === 'ollama') {
    if (production) throw new Error('Ollama prompt optimization is development only.');
    baseUrl = profile.baseUrl || 'http://127.0.0.1:11434/v1';
    const url = checkedUrl(baseUrl);
    if (!['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'].includes(url.hostname)) throw new Error('Ollama endpoint must use a loopback address or host.docker.internal.');
  } else {
    if (!profile.baseUrl) throw new Error('Compatible provider requires a base URL.');
    baseUrl = profile.baseUrl;
    apiKey = env.PROMPT_OPTIMIZER_COMPATIBLE_API_KEY || env.CUSTOM_API_KEY || '';
    const url = checkedUrl(baseUrl);
    if (production) {
      if (url.protocol !== 'https:') throw new Error('Production compatible model endpoints must use HTTPS.');
      const allowed = new Set((env.PROMPT_OPTIMIZER_ALLOWED_MODEL_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
      if (!allowed.has(url.origin)) throw new Error('Compatible model endpoint is not in the production allowlist.');
    } else {
      const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
      const allowed = new Set((env.PROMPT_OPTIMIZER_ALLOWED_MODEL_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
      if (!loopback && !allowed.has(url.origin)) throw new Error('Compatible model endpoint is not in the development allowlist.');
    }
  }
  if (profile.provider !== 'ollama' && !apiKey) throw new Error(`Missing prompt optimizer credential for ${profile.provider}.`);
  return { endpoint: `${baseUrl.replace(/\/$/, '')}/chat/completions`, apiKey };
}

export async function requestOptimization(
  profile: ModelProfileRuntimeInput,
  messages: ModelMessage[],
  env: Environment = process.env,
  fetcher: Fetcher = fetch
): Promise<string> {
  const runtime = resolveProviderRuntime(profile, env);
  if (activeOptimizationRequests >= MAX_CONCURRENT_OPTIMIZATIONS) throw new PromptOptimizerBusyError();
  activeOptimizationRequests += 1;
  const controller = new AbortController();
  const temperature = boundedNumber(profile.settings.temperature, 0, 2, 0.3);
  const maxTokens = Math.round(boundedNumber(profile.settings.maxTokens, 256, 16384, 1800));
  const topP = boundedNumber(profile.settings.topP, 0, 1, 1);
  const timeoutMs = Math.round(boundedNumber(profile.settings.timeoutMs, 5000, 120000, 60000));
  const configuredTimeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(runtime.endpoint, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(runtime.apiKey ? { Authorization: `Bearer ${runtime.apiKey}` } : {}) },
      body: JSON.stringify({ model: profile.model, messages, temperature, top_p: topP, max_tokens: maxTokens,
        ...(profile.provider === 'openai' ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!response.ok) throw new Error(`Prompt optimizer model request failed with status ${response.status}.`);
    const responseText = await response.text();
    if (new TextEncoder().encode(responseText).byteLength > 2 * 1024 * 1024) throw new Error('Prompt optimizer model response is too large.');
    let payload: { choices?: Array<{ message?: { content?: unknown } }> };
    try { payload = JSON.parse(responseText); } catch { throw new Error('Prompt optimizer model returned invalid JSON.'); }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Prompt optimizer model returned no content.');
    return content;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Prompt optimizer model request timed out.');
    throw error;
  } finally { clearTimeout(configuredTimeout); activeOptimizationRequests -= 1; }
}

function checkedUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch { throw new Error('Model base URL is invalid.'); }
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
