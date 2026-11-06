const STAGE_LABELS = {
  accepted: '已收到请求', auth: '正在验证会话', route: '正在识别问题', queue: '正在等待模型资源',
  warmup: '正在准备模型', retrieval: '正在检索资料', embedding: '正在计算检索向量',
  rerank: '正在筛选资料', generation: '正在生成回答', citation: '正在核验引用', validation: '正在核验资料版本',
} as const;
export interface AskProgress { stage: keyof typeof STAGE_LABELS; label: string }
export interface AskAnswerDelta { requestId: string; sequence: number; text: string }

/** Return a normal Response so existing status/identity handling stays intact. */
export async function readAskProgressResponse(response: Response, options: {
  signal?: AbortSignal; onProgress?: (event: AskProgress) => void;
  onAnswerDelta?: (event: AskAnswerDelta) => void;
} = {}): Promise<Response> {
  options.signal?.throwIfAborted();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('响应流无效。');
  const decoder = new TextDecoder();
  let buffer = '';
  let requestId = response.headers.get('x-request-id');
  let sequence = 0;
  let draftLength = 0;
  const activeStages: AskProgress['stage'][] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const next = await reader.read();
      options.signal?.throwIfAborted();
      buffer += decoder.decode(next.value, { stream: !next.done });
      if (buffer.length > 8 * 1024 * 1024) throw new Error('响应流超过允许大小。');
      // Preserve CRLF across arbitrary network chunk boundaries.
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/u);
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const text = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!text || !['status', 'answer_delta', 'result', 'error'].includes(event ?? '')) continue;
        let payload: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(text);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          payload = parsed as Record<string, unknown>;
        } catch { throw new Error('响应流格式无效。'); }
        if (event === 'status') {
          if (payload.stage === 'accepted' && payload.state === 'started' && typeof payload.requestId === 'string') {
            if (requestId && requestId !== payload.requestId) throw new Error('响应流请求身份无效。');
            requestId = payload.requestId;
          }
          if (typeof payload.stage === 'string' && Object.hasOwn(STAGE_LABELS, payload.stage)) {
            const stage = payload.stage as AskProgress['stage'];
            if (payload.state === 'started') {
              if (activeStages.length >= 256) throw new Error('响应处理阶段超过允许数量。');
              activeStages.push(stage);
              options.onProgress?.({ stage, label: STAGE_LABELS[stage] });
            } else if (payload.state === 'completed') {
              const index = activeStages.lastIndexOf(stage);
              if (index >= 0) activeStages.splice(index, 1);
              const resumed = activeStages.at(-1);
              if (resumed && resumed !== 'accepted') options.onProgress?.({ stage: resumed, label: STAGE_LABELS[resumed] });
            }
          }
          continue;
        }
        if (event === 'answer_delta') {
          if (!requestId || payload.requestId !== requestId || payload.sequence !== sequence + 1
            || typeof payload.text !== 'string' || !payload.text || payload.text.length > 16 * 1024
            || draftLength + payload.text.length > 256 * 1024) {
            throw new Error('响应增量无效。');
          }
          sequence++;
          draftLength += payload.text.length;
          options.onAnswerDelta?.({ requestId, sequence, text: payload.text });
          continue;
        }
        if (!Number.isInteger(payload.status) || Number(payload.status) < 200 || Number(payload.status) > 599
          || [204, 205, 304].includes(Number(payload.status)) || !payload.body || typeof payload.body !== 'object'
          || Array.isArray(payload.body) || (event === 'result') !== (Number(payload.status) < 400)) {
          throw new Error('响应流终态无效。');
        }
        return Response.json(payload.body, { status: Number(payload.status), headers: {
          'cache-control': 'no-store', ...(typeof payload.timing === 'string' ? { 'server-timing': payload.timing } : {}),
        } });
      }
      if (next.done) throw new Error('响应传输已中断，请重试。');
    }
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
