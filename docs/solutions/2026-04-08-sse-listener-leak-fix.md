---
title: "Next.js SSE 流中 listener 泄漏修复"
date: 2026-04-08
tags: [sse, memory-leak, nextjs, readablestream]
related_instincts: [sse-listener-cleanup]
---

# Next.js SSE 流中 listener 泄漏修复

## 问题
SSE 事件监听器在客户端断开后未被移除，导致内存泄漏。每个断开的连接留下一个"幽灵"listener，持续尝试向已关闭的 stream 写入。

## 根因
仅依赖 `_request.signal.addEventListener('abort', cleanup)` 清理 listener。在 Next.js Node HTTP adapter 中，request abort 事件不一定可靠触发。

## 解决方案
**双重清理机制**：同时使用 ReadableStream 的 `cancel()` hook 和 AbortSignal。

```typescript
let cleanupFn: (() => void) | null = null;

const stream = new ReadableStream({
  start(controller) {
    const listener = (event) => { /* ... */ };
    runner.addListener(id, listener);
    
    cleanupFn = () => runner.removeListener(id, listener);
    _request.signal.addEventListener('abort', cleanupFn);
  },
  cancel() {
    // ReadableStream cancel hook — 客户端断开时可靠触发
    cleanupFn?.();
  },
});
```

关键点：`cancel()` 是 ReadableStream 规范中的方法，当消费端关闭时由运行时调用，比 AbortSignal 更可靠。

## 预防
所有 SSE 实现都必须使用 `cancel()` hook 清理资源，不能仅依赖 AbortSignal。
