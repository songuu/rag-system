import { captureAskProviderUsage, type AskStageEvent } from './provider-usage-observer';
import { RAG_SYNC_REQUEST_BUDGET_MS } from './request-budgets';

interface ExecutionOptions {
  requestId: string;
  execute(signal: AbortSignal): Promise<Response>;
  budgetMs?: number;
}

/** JSON remains the default. Eligible legacy answers may send transient drafts;
 * only the terminal response is authoritative for history and citations. */
export async function executeAskRequest(request: Request, options: ExecutionOptions): Promise<Response> {
  const budgetMs = options.budgetMs ?? RAG_SYNC_REQUEST_BUDGET_MS;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Ask request deadline must be positive.');
  const disconnected = new AbortController();
  const deadline = new AbortController();
  const signal = AbortSignal.any([request.signal, disconnected.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), budgetMs);
  const failure = (status: number, code: string, error: string) => Response.json({
    success: false, code, error, requestId: options.requestId,
  }, { status, headers: { 'cache-control': 'no-store', 'x-request-id': options.requestId } });
  const perform = async (onStage?: (event: AskStageEvent) => void, onAnswerDelta?: (text: string) => void) => {
    let abort: (() => void) | undefined;
    let cancellationGrace: ReturnType<typeof setTimeout> | undefined;
    try {
      return await captureAskProviderUsage(async () => {
        try {
          signal.throwIfAborted();
          const cancelled = new Promise<never>((_, reject) => {
            abort = () => {
              const interrupted = () => reject(new Error('Ask execution interrupted.'));
              // Cooperative executors return useful partial diagnostics on
              // cancellation. Keep those, but bound non-cooperative work.
              if (deadline.signal.aborted) interrupted();
              else cancellationGrace = setTimeout(interrupted, 100);
            };
            signal.addEventListener('abort', abort, { once: true });
          });
          // Observe late failures without allowing them to produce a second response.
          const response = await Promise.race([options.execute(signal), cancelled]);
          if (deadline.signal.aborted || (signal.aborted && response.status !== 499)) {
            throw new Error('Ask execution interrupted.');
          }
          return response;
        } catch {
          return deadline.signal.aborted
            ? failure(504, 'RAG_REQUEST_TIMEOUT', '请求处理超时，请稍后重试。')
            : signal.aborted ? failure(499, 'RAG_REQUEST_ABORTED', '请求已取消。')
              : failure(500, 'ASK_INTERNAL_ERROR', '处理请求时发生错误。');
        }
      }, { signal, onStage, onAnswerDelta });
    } finally {
      clearTimeout(timer);
      clearTimeout(cancellationGrace);
      if (abort) signal.removeEventListener('abort', abort);
    }
  };
  if (!request.headers.get('accept')?.split(',').some(type => type.trim().split(';')[0] === 'text/event-stream')) {
    return perform();
  }
  const encoder = new TextEncoder();
  let open = true;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let sequence = 0;
      let draftLength = 0;
      const send = (event: string, data: unknown) => {
        if (open) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('status', { stage: 'accepted', state: 'started', requestId: options.requestId });
      heartbeat = setInterval(() => { if (open) controller.enqueue(encoder.encode(': heartbeat\n\n')); }, 15_000);
      void (async () => {
        try {
          const response = await perform(event => send('status', event), text => {
            if (!open || signal.aborted) return;
            // Bound draft memory independently of the final response. Reaching
            // the preview cap never truncates the authoritative answer.
            const remaining = 256 * 1024 - draftLength;
            const preview = text.slice(0, Math.max(0, remaining));
            draftLength += preview.length;
            for (let offset = 0; offset < preview.length; offset += 16 * 1024) {
              send('answer_delta', { requestId: options.requestId, sequence: ++sequence,
                text: preview.slice(offset, offset + 16 * 1024) });
            }
          });
          const payload: unknown = await response.json();
          send(response.ok ? 'result' : 'error', { status: response.status, body: payload,
            timing: response.headers.get('server-timing') });
        } catch {
          send('error', { status: 500, body: { success: false, code: 'ASK_RESPONSE_INVALID',
            error: '响应传输失败，请重试。', requestId: options.requestId } });
        } finally {
          clearInterval(heartbeat);
          if (open) { open = false; controller.close(); }
        }
      })();
    },
    cancel() { open = false; clearInterval(heartbeat); disconnected.abort(); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-request-id': options.requestId } });
}
