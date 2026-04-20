/**
 * SSE 流工具
 *
 * 要点 (踩过的坑):
 * 1. ReadableStream.cancel() 是主清理路径,比 signal.aborted 更可靠
 * 2. 结束事件后延迟 1s 再 close,避免客户端收不到最终事件
 */

export interface SseEmitter<E> {
  emit: (event: E) => void;
  close: () => void;
}

export interface SseSetupResult {
  cleanup: () => void;
}

const SSE_HEADERS: HeadersInit = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export function createSseResponse<E>(
  setup: (emitter: SseEmitter<E>) => Promise<SseSetupResult> | SseSetupResult
): Response {
  let cleanup: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      const emitter: SseEmitter<E> = {
        emit: (event: E) => {
          if (closed) return;
          try {
            const payload = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          } catch {
            // 流已关闭,忽略
          }
        },
        close: () => {
          if (closed) return;
          closed = true;
          setTimeout(() => {
            try {
              controller.close();
            } catch {
              // 已关闭
            }
          }, 1000);
        },
      };

      try {
        const result = await setup(emitter);
        cleanup = result.cleanup;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown setup error';
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', data: { message } })}\n\n`)
          );
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },

    cancel() {
      closed = true;
      cleanup?.();
      cleanup = null;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
