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
  /** 0~1，新打分（reranker 给出的相关性分） */
  relevanceScore: number;
  /** 原数组中的索引，便于回填 metadata */
  originalIndex: number;
}

export interface RerankerProvider {
  /** 用于日志 / trace 字段 */
  readonly name: string;
  /** 用于日志 / cost 估算 */
  readonly model: string;

  rerank(query: string, docs: RerankerInput[], topK?: number): Promise<RerankerOutput[]>;
}

export type RerankerProviderId = 'siliconflow' | 'cohere' | 'voyage';

// ===== SiliconFlow（默认）=====

/**
 * SiliconFlow rerank API
 *
 * Endpoint: POST {base}/rerank
 * Docs: https://docs.siliconflow.cn/cn/api-reference/rerank/create-rerank
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

  async rerank(query: string, docs: RerankerInput[], topK?: number): Promise<RerankerOutput[]> {
    if (docs.length === 0) return [];

    const body: Record<string, unknown> = {
      model: this.model,
      query,
      documents: docs.map(d => d.content),
      return_documents: false,
    };
    if (typeof topK === 'number' && topK > 0) body.top_n = Math.min(topK, docs.length);

    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SiliconFlow rerank API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      results?: Array<{ index: number; relevance_score: number }>;
    };
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map(r => ({
      id: docs[r.index]?.id ?? `unknown-${r.index}`,
      content: docs[r.index]?.content ?? '',
      relevanceScore: r.relevance_score,
      originalIndex: r.index,
    }));
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

  async rerank(query: string, docs: RerankerInput[], topK?: number): Promise<RerankerOutput[]> {
    if (docs.length === 0) return [];

    const body: Record<string, unknown> = {
      model: this.model,
      query,
      documents: docs.map(d => d.content),
    };
    if (typeof topK === 'number' && topK > 0) body.top_n = Math.min(topK, docs.length);

    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cohere rerank API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      results?: Array<{ index: number; relevance_score: number }>;
    };
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map(r => ({
      id: docs[r.index]?.id ?? `unknown-${r.index}`,
      content: docs[r.index]?.content ?? '',
      relevanceScore: r.relevance_score,
      originalIndex: r.index,
    }));
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

  async rerank(query: string, docs: RerankerInput[], topK?: number): Promise<RerankerOutput[]> {
    if (docs.length === 0) return [];

    const body: Record<string, unknown> = {
      model: this.model,
      query,
      documents: docs.map(d => d.content),
      return_documents: false,
    };
    if (typeof topK === 'number' && topK > 0) body.top_k = Math.min(topK, docs.length);

    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Voyage rerank API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      data?: Array<{ index: number; relevance_score: number }>;
    };
    const results = Array.isArray(data.data) ? data.data : [];
    return results.map(r => ({
      id: docs[r.index]?.id ?? `unknown-${r.index}`,
      content: docs[r.index]?.content ?? '',
      relevanceScore: r.relevance_score,
      originalIndex: r.index,
    }));
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
