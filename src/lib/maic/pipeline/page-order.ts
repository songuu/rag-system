const MAIC_LLM_CONCURRENCY_MIN = 1;
const MAIC_LLM_CONCURRENCY_MAX = 16;
const MAIC_LLM_CONCURRENCY_DEFAULT = 4;

// MAIC_LLM_CONCURRENCY 控制 describe/script/focus 三阶段每阶段 LLM 并发上限。
// 阶段间已并行 (script ∥ focus ∥ questions), 全局峰值 ≈ 2*concurrency + 1。
// 默认 4 与历史行为一致; clamp 到 [1, 16] 防止 provider 限流。
export function resolveMaicLlmConcurrency(): number {
  const raw = process.env.MAIC_LLM_CONCURRENCY;
  if (!raw) return MAIC_LLM_CONCURRENCY_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return MAIC_LLM_CONCURRENCY_DEFAULT;
  return Math.max(
    MAIC_LLM_CONCURRENCY_MIN,
    Math.min(MAIC_LLM_CONCURRENCY_MAX, parsed)
  );
}

export async function mapPagesWithOrderedCallbacks<TPage extends { index: number }, TResult>(
  pages: TPage[],
  concurrency: number,
  worker: (page: TPage) => Promise<TResult>,
  onPage?: (index: number) => void
): Promise<TResult[]> {
  const total = pages.length;
  if (total === 0) return [];

  const safeConcurrency = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
  const results: TResult[] = new Array(total);
  const completed = new Set<number>();
  let emitCursor = 0;
  let nextSlot = 0;

  // 滑动窗口：维持 safeConcurrency 个 in-flight worker；
  // 任一完成立即取下一页，避免批次屏障让慢请求拖累整批。
  // onPage 仍按 pages 数组顺序单调触发。
  const emitReady = (): void => {
    while (emitCursor < total && completed.has(emitCursor)) {
      onPage?.(pages[emitCursor].index);
      emitCursor += 1;
    }
  };

  const runWorker = async (): Promise<void> => {
    while (true) {
      const slot = nextSlot;
      if (slot >= total) return;
      nextSlot = slot + 1;
      const result = await worker(pages[slot]);
      results[slot] = result;
      completed.add(slot);
      emitReady();
    }
  };

  const workers = Array.from({ length: safeConcurrency }, () => runWorker());
  await Promise.all(workers);
  return results;
}
