import { RagRequestAbortedError, throwIfRagRequestAborted } from '../core/cancellation';

/**
 * Reranker provider 抽象
 *
 * 三 provider 同接口；env-based 选型；未配置任何 key 时 throw 而非静默 fallback
 * （沿用 model-config 的"显式失败"模式）。
 *
 * Provider 选择优先级：
 *   1. options.provider 显式指定
 *   2. RERANK_PROVIDER env
 *   3. 默认走 SiliconFlow（与项目主 embedding provider 一致）
 *
 * 失败语义：本模块的 rerank() 方法在 provider API 失败时**直接抛 error**，
 * 由上游 rerank.ts 的 wrapper 层负责"降级到原排序"。这里不做静默降级，
 * 因为 provider 层无法判断"重排失败 = 严重还是无所谓"。
 */

export interface RerankerInput {
  id: string;
  content: string;
}

export interface RerankerOutput {
  id: string;
  content: string;
  /** Provider relevance score; finite, model-specific, not calibrated confidence. */
  relevanceScore: number;
  /** 原数组中的索引，便于回填 metadata */
  originalIndex: number;
}

export interface RerankerProvider {
  /** 用于日志 / trace 字段 */
  readonly name: string;
  /** 用于日志 / cost 估算 */
  readonly model: string;

  rerank(query: string, docs: RerankerInput[], topK?: number, options?: RerankerRequestOptions): Promise<RerankerOutput[]>;
}

export interface RerankerRequestOptions {
  signal?: AbortSignal;
}

export type RerankerProviderId = 'siliconflow' | 'cohere' | 'voyage';

// ===== SiliconFlow（默认）=====

/**
 * SiliconFlow rerank API
 *
 * Endpoint: POST {base}/rerank
 * Docs: https://docs.siliconflow.com/en/api-reference/rerank/create-rerank
 * Default model: BAAI/bge-reranker-v2-m3（多语言；4 项目主流的 embedding family）
 */
export class SiliconFlowReranker implements RerankerProvider {
  readonly name = 'siliconflow';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    if (!config.apiKey) {
      throw new Error('SiliconFlow reranker requires apiKey');
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'BAAI/bge-reranker-v2-m3';
    this.baseUrl = config.baseUrl ?? 'https://api.siliconflow.cn/v1';
  }

  async rerank(query: string, docs: RerankerInput[], topK?: number, options: RerankerRequestOptions = {}): Promise<RerankerOutput[]> {
    throwIfRagRequestAborted(options.signal);
    if (docs.length === 0) return [];

    const body: Record<string, unknown> = {
      model: this.model,
      query,
      documents: docs.map(d => d.content),
      return_documents: false,
    };
    if (typeof topK === 'number' && topK > 0) body.top_n = Math.min(topK, docs.length);

    return requestRerank({
      provider: this.name,
      url: `${this.baseUrl}/rerank`,
      apiKey: this.apiKey,
      body,
      docs,
      responseKey: 'results',
      signal: options.signal,
    });
  }
}

// ===== Cohere =====

/**
 * Cohere rerank API
 *
 * Endpoint: POST https://api.cohere.com/v2/rerank
 * Docs: https://docs.cohere.com/reference/rerank
 * Default model: rerank-v3.5
 */
export class CohereReranker implements RerankerProvider {
  readonly name = 'cohere';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    if (!config.apiKey) {
      throw new Error('Cohere reranker requires apiKey');
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'rerank-v3.5';
    this.baseUrl = config.baseUrl ?? 'https://api.cohere.com/v2';
  }

  async rerank(query: string, docs: RerankerInput[], topK?: number, options: RerankerRequestOptions = {}): Promise<RerankerOutput[]> {
    throwIfRagRequestAborted(options.signal);
    if (docs.length === 0) return [];

    const body: Record<string, unknown> = {
      model: this.model,
      query,
      documents: docs.map(d => d.content),
    };
    if (typeof topK === 'number' && topK > 0) body.top_n = Math.min(topK, docs.length);

    return requestRerank({
      provider: this.name,
      url: `${this.baseUrl}/rerank`,
      apiKey: this.apiKey,
      body,
      docs,
      responseKey: 'results',
      signal: options.signal,
    });
  }
}

// ===== Voyage =====

/**
 * Voyage rerank API
 *
 * Endpoint: POST https://api.voyageai.com/v1/rerank
 * Docs: https://docs.voyageai.com/reference/reranker-api
 * Default model: rerank-2
 *
 * 注意 Voyage 用 top_k 而 SiliconFlow/Cohere 用 top_n；响应内 `data` 数组。
 */
export class VoyageReranker implements RerankerProvider {
  readonly name = 'voyage';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    if (!config.apiKey) {
      throw new Error('Voyage reranker requires apiKey');
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'rerank-2';
    this.baseUrl = config.baseUrl ?? 'https://api.voyageai.com/v1';
  }

  async rerank(query: string, docs: RerankerInput[], topK?: number, options: RerankerRequestOptions = {}): Promise<RerankerOutput[]> {
    throwIfRagRequestAborted(options.signal);
    if (docs.length === 0) return [];

    const body: Record<string, unknown> = {
      model: this.model,
      query,
      documents: docs.map(d => d.content),
      return_documents: false,
    };
    if (typeof topK === 'number' && topK > 0) body.top_k = Math.min(topK, docs.length);

    return requestRerank({
      provider: this.name,
      url: `${this.baseUrl}/rerank`,
      apiKey: this.apiKey,
      body,
      docs,
      responseKey: 'data',
      signal: options.signal,
    });
  }
}

// ===== Provider 选型 =====

/**
 * 按 env / 显式 ID 构建 reranker provider
 *
 * @param providerId 显式指定；不传时按 RERANK_PROVIDER env；env 未设时默认 'siliconflow'
 * @throws Error 当所选 provider 的 API key 未配置时
 */
export function buildReranker(providerId?: RerankerProviderId): RerankerProvider {
  const resolved = providerId ?? (process.env.RERANK_PROVIDER as RerankerProviderId | undefined) ?? 'siliconflow';

  switch (resolved) {
    case 'siliconflow': {
      const apiKey = process.env.SILICONFLOW_API_KEY ?? '';
      if (!apiKey) {
        throw new Error(
          'Reranker provider=siliconflow requires SILICONFLOW_API_KEY env (与现有 embedding provider 共用)'
        );
      }
      return new SiliconFlowReranker({
        apiKey,
        model: process.env.RERANK_MODEL,
        baseUrl: process.env.SILICONFLOW_BASE_URL,
      });
    }
    case 'cohere': {
      const apiKey = process.env.COHERE_API_KEY ?? '';
      if (!apiKey) throw new Error('Reranker provider=cohere requires COHERE_API_KEY env');
      return new CohereReranker({
        apiKey,
        model: process.env.RERANK_MODEL,
        baseUrl: process.env.COHERE_BASE_URL,
      });
    }
    case 'voyage': {
      const apiKey = process.env.VOYAGE_API_KEY ?? '';
      if (!apiKey) throw new Error('Reranker provider=voyage requires VOYAGE_API_KEY env');
      return new VoyageReranker({
        apiKey,
        model: process.env.RERANK_MODEL,
        baseUrl: process.env.VOYAGE_BASE_URL,
      });
    }
    default:
      throw new Error(`Unknown reranker provider: ${resolved}`);
  }
}

/**
 * 判断当前环境是否已配置至少一个 reranker provider
 * 用于调用方在 enable rerank 前提前检查，避免 throw
 */
export function isRerankerConfigured(providerId?: RerankerProviderId): boolean {
  const resolved = providerId ?? (process.env.RERANK_PROVIDER as RerankerProviderId | undefined) ?? 'siliconflow';
  switch (resolved) {
    case 'siliconflow':
      return Boolean(process.env.SILICONFLOW_API_KEY);
    case 'cohere':
      return Boolean(process.env.COHERE_API_KEY);
    case 'voyage':
      return Boolean(process.env.VOYAGE_API_KEY);
    default:
      return false;
  }
}

/** Keep provider-owned response and transport text out of durable diagnostics. */
async function requestRerank(input: {
  provider: RerankerProviderId;
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  docs: RerankerInput[];
  responseKey: 'results' | 'data';
  signal?: AbortSignal;
}): Promise<RerankerOutput[]> {
  const documents = input.docs.map(({ id, content }) => ({ id, content }));
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify(input.body),
      signal: input.signal,
    });
  } catch (error) {
    throwIfRagRequestAborted(input.signal);
    if (error instanceof Error && error.name === 'AbortError') throw new RagRequestAbortedError();
    throw new Error(`Reranker provider=${input.provider} request failed.`);
  }
  throwIfRagRequestAborted(input.signal);
  if (!response.ok) {
    const providerError = new Error(`Reranker provider=${input.provider} HTTP status=${response.status}.`);
    try {
      // Keep socket cleanup inside the lane promise so its deadline/orphan fence still owns it.
      await response.body?.cancel();
    } catch {
      // Cleanup errors can contain provider data; preserve only the safe HTTP failure or cancellation.
      throwIfRagRequestAborted(input.signal);
      throw providerError;
    }
    throwIfRagRequestAborted(input.signal);
    throw providerError;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throwIfRagRequestAborted(input.signal);
    throw new Error(`Reranker provider=${input.provider} invalid response.`);
  }
  throwIfRagRequestAborted(input.signal);
  const rows = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)[input.responseKey]
    : undefined;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > documents.length) {
    throw new Error(`Reranker provider=${input.provider} invalid response.`);
  }
  const seen = new Set<number>();
  return rows.map(row => {
    if (!row || typeof row !== 'object') {
      throw new Error(`Reranker provider=${input.provider} invalid response.`);
    }
    const { index, relevance_score: score } = row as Record<string, unknown>;
    if (typeof index !== 'number' || !Number.isInteger(index)
      || index < 0 || index >= documents.length || seen.has(index)
      || typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error(`Reranker provider=${input.provider} invalid response.`);
    }
    seen.add(index);
    return { ...documents[index], relevanceScore: score, originalIndex: index };
  });
}