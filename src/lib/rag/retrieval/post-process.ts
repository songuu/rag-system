/**
 * 检索后处理：MMR + source 去重
 *
 * 设计原则：
 * - 默认 off，调用方显式开
 * - 输入是 Milvus search 结果（含 score / metadata / source）
 * - 不依赖 Milvus client，所有逻辑纯 TypeScript，便于单测
 */

export interface PostProcessResult {
  id: string;
  content: string;
  score: number;
  /** 经典 dense vector 距离，可选 */
  distance?: number;
  /** 用于 MMR 的 embedding（如可拿到原 chunk vector） */
  embedding?: number[];
  /** 用于 dedupe 的 source 字段（如文件名） */
  source?: string;
  /** 透传 metadata */
  metadata?: Record<string, unknown>;
}

export interface MmrOptions {
  /** 0~1，相关度 vs 多样性权重。1 = pure relevance, 0 = pure diversity */
  lambda?: number;
  /** 最终返回数量；默认 = results.length */
  topK?: number;
}

/**
 * Maximal Marginal Relevance（经典版本）
 *
 * 要求每个 result 有 embedding；缺 embedding 的项保留原顺序，附在尾部。
 * 算法：每轮挑选 argmax(λ·rel - (1-λ)·max_sim_to_selected)
 *
 * @param queryEmbedding 查询向量
 * @param results 候选（已按 score 倒序）
 * @param options { lambda, topK }
 */
export function mmrRerank<T extends PostProcessResult>(
  queryEmbedding: number[],
  results: T[],
  options: MmrOptions = {}
): T[] {
  const lambda = clamp(options.lambda ?? 0.7, 0, 1);
  const topK = options.topK ?? results.length;

  const withEmbedding: Array<T & { _norm: number[] }> = [];
  const withoutEmbedding: T[] = [];
  for (const r of results) {
    if (r.embedding && r.embedding.length === queryEmbedding.length) {
      withEmbedding.push({ ...r, _norm: l2Normalize(r.embedding) });
    } else {
      withoutEmbedding.push(r);
    }
  }

  if (withEmbedding.length === 0) return results.slice(0, topK);

  const qNorm = l2Normalize(queryEmbedding);
  const selected: Array<T & { _norm: number[] }> = [];
  const remaining = withEmbedding.slice();

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const rel = dot(qNorm, remaining[i]._norm);
      let maxSimToSelected = 0;
      for (const s of selected) {
        const sim = dot(s._norm, remaining[i]._norm);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const mmrScore = lambda * rel - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  // 去掉内部 _norm 字段
  const cleaned = selected.map(s => {
    const { _norm, ...rest } = s;
    void _norm;
    return rest as unknown as T;
  });

  // 没有 embedding 的项按原 score 顺序补在尾部
  return [...cleaned, ...withoutEmbedding].slice(0, topK);
}

/**
 * 按 source 字段去重：同一 source 最多保留 perSource 条
 *
 * 保留顺序：按输入顺序（通常已按 score 倒序），先到先得
 */
export function dedupeBySource<T extends PostProcessResult>(
  results: T[],
  perSource: number = 2
): T[] {
  if (perSource <= 0) return [];
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const r of results) {
    const src = r.source || '__unknown__';
    const c = counts.get(src) ?? 0;
    if (c < perSource) {
      out.push(r);
      counts.set(src, c + 1);
    }
  }
  return out;
}

/** 流水线：先 dedupe 再 MMR，或反过来；调用方控制 */
export interface PostProcessPipelineOptions {
  dedupeBySource?: number;
  mmr?: MmrOptions & { queryEmbedding?: number[] };
}

export function applyPostProcess<T extends PostProcessResult>(
  results: T[],
  options: PostProcessPipelineOptions = {}
): T[] {
  let out = results;
  if (typeof options.dedupeBySource === 'number') {
    out = dedupeBySource(out, options.dedupeBySource);
  }
  if (options.mmr && options.mmr.queryEmbedding) {
    out = mmrRerank(options.mmr.queryEmbedding, out, options.mmr);
  }
  return out;
}

// ===== 内部工具 =====

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function l2Normalize(v: number[]): number[] {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n === 0) return v.slice();
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
