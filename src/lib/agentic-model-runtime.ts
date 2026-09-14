import { categorizeModelName } from './model-catalog';
import { findEquivalentOllamaModel } from './ollama-model-name';
import { redactErrorForLog } from './security/error-redaction';

export interface InstalledOllamaModel {
  name: string;
  size?: number;
}

export interface ResolvedAgenticModels {
  llmModel: string;
  fastLlmModel: string;
  rerankerModel: string;
  fallbacks: string[];
}

type AgenticFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function discoverInstalledOllamaModels(
  ollamaBaseUrl: string,
  options: {
    signal?: AbortSignal;
    fetchImplementation?: AgenticFetch;
  } = {}
): Promise<InstalledOllamaModel[]> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const baseUrl = ollamaBaseUrl.replace(/\/+$/, '');
  const response = await fetchImplementation(`${baseUrl}/api/tags`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Ollama 模型列表请求失败: HTTP ${response.status}`);
  }

  const payload = await response.json() as { models?: unknown };
  if (!Array.isArray(payload.models)) return [];

  return payload.models.flatMap(model => {
    if (!model || typeof model !== 'object') return [];
    const record = model as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name.trim()) return [];
    return [{
      name: record.name,
      size: typeof record.size === 'number' ? record.size : undefined,
    }];
  });
}

export class AgenticModelUnavailableError extends Error {
  readonly code = 'AGENTIC_LLM_MODEL_UNAVAILABLE';
  readonly modelName: string;

  constructor(modelName: string) {
    super(`所选模型 ${sanitizeModelName(modelName)} 未安装或当前不可用。`);
    this.name = 'AgenticModelUnavailableError';
    this.modelName = modelName;
  }
}

export function reconcileAgenticOllamaModels(input: {
  requestedLlmModel: string;
  configuredFastLlmModel: string;
  configuredRerankerModel: string;
  installedModels: readonly InstalledOllamaModel[];
}): ResolvedAgenticModels {
  const runnableModels = input.installedModels.filter(model => {
    const category = categorizeModelName(model.name);
    return category === 'llm' || category === 'reasoning';
  });
  const llmModel = findEquivalentOllamaModel(input.requestedLlmModel, runnableModels);

  if (!llmModel) {
    throw new AgenticModelUnavailableError(input.requestedLlmModel);
  }

  const localRunnableModels = runnableModels.filter(
    model => !model.name.trim().toLowerCase().endsWith(':cloud')
  );

  // Auxiliary nodes are latency-sensitive. Prefer the smallest installed chat
  // model when their configured model is absent. Ollama cloud entries are tiny
  // manifests rather than local weights, so never choose one implicitly.
  const auxiliaryFallback = [...localRunnableModels]
    .sort((left, right) => sortableSize(left.size) - sortableSize(right.size))[0]
    ?.name ?? llmModel;
  const configuredFastModel = findEquivalentOllamaModel(
    input.configuredFastLlmModel,
    localRunnableModels
  );
  const fastLlmModel = configuredFastModel ?? auxiliaryFallback;
  const configuredRerankerModel = findEquivalentOllamaModel(
    input.configuredRerankerModel,
    localRunnableModels
  );
  const rerankerModel = configuredRerankerModel ?? fastLlmModel;
  const fallbacks: string[] = [];

  if (!configuredFastModel) {
    fallbacks.push(
      `快速模型 ${sanitizeModelName(input.configuredFastLlmModel)} 不可用，已回退到 ${fastLlmModel}。`
    );
  }
  if (!configuredRerankerModel) {
    fallbacks.push(
      `Reranker 模型 ${sanitizeModelName(input.configuredRerankerModel)} 不可用，已回退到 ${rerankerModel}。`
    );
  }

  return { llmModel, fastLlmModel, rerankerModel, fallbacks };
}

export function resolveAgenticGenerationTimeoutMs(
  modelRequestTimeoutMs: number,
  reasoningRequestTimeoutMs: number
): number {
  const validTimeouts = [modelRequestTimeoutMs, reasoningRequestTimeoutMs]
    .filter(timeout => Number.isFinite(timeout) && timeout > 0);
  // A 19 GB local model took 177 seconds on a 16 GB GPU during the live
  // verification run. Keep one minute of cold-start variance instead of
  // sitting directly on that observed boundary.
  return Math.max(240_000, ...validTimeouts);
}

export function describeAgenticModelFailure(
  error: unknown,
  context: { modelName: string; timeoutMs: number }
): string {
  const safeModelName = sanitizeModelName(context.modelName);
  const safeError = redactErrorForLog(error);
  const diagnostic = `${safeError.name} ${safeError.message}`.toLowerCase();

  if (/timeout|timed out|aborted due to timeout/.test(diagnostic)) {
    const timeoutSeconds = Math.max(1, Math.ceil(context.timeoutMs / 1_000));
    return `模型 ${safeModelName} 请求超过 ${timeoutSeconds} 秒，请改用更小模型或提高模型超时。`;
  }
  if (/model.*not found|not found.*model|404/.test(diagnostic)) {
    return `模型 ${safeModelName} 未安装或名称不正确。`;
  }

  return `模型 ${safeModelName} 调用失败（${safeError.name}）。`;
}

function sortableSize(size: number | undefined): number {
  return typeof size === 'number' && Number.isFinite(size) && size > 0
    ? size
    : Number.MAX_SAFE_INTEGER;
}

function sanitizeModelName(modelName: string): string {
  return modelName.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 120) || 'unknown';
}
