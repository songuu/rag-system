export interface SessionModelConfig {
  llm: { provider: string; model: string };
  embedding: { provider: string; model: string; dimension: number };
}

export interface SessionLlmSelection {
  provider: string;
  serverModel: string;
  model: string;
}

interface ValidatedSessionModelSelection {
  defaultLlmModel: string;
  config: {
    llm: SessionModelConfig['llm'];
    embedding: Omit<SessionModelConfig['embedding'], 'dimension'> & { dimension?: number };
  };
}

export async function requestSessionModelSelection(
  llmModel: string,
  embeddingModel: string,
  fetchSelection: typeof fetch = fetch,
  onProgress?: (message: string) => void,
): Promise<ValidatedSessionModelSelection> {
  // Next dev compiles a new route on its first request; budget for that work
  // without giving a deployed configuration-only request an unbounded wait.
  const timeoutMs = process.env.NODE_ENV === 'development' ? 60_000 : 15_000;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchSelection('/rag-api/model-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ llmModel, embeddingModel, reindex: true }),
    });
  } catch (error) {
    const timeout = modelSelectionTimeoutError(error, signal);
    if (timeout) throw timeout;
    throw new Error('无法连接模型切换服务，请检查服务并刷新模型和重建状态后重试。', { cause: error });
  }

  let data: Partial<ValidatedSessionModelSelection> & { success?: boolean; error?: string; job?: { id: string; status: string; stage: string; completed: number; error?: string } };
  try {
    data = await response.json();
  } catch (error) {
    const timeout = modelSelectionTimeoutError(error, signal);
    if (timeout) throw timeout;
    throw new Error(`模型切换服务返回了无效响应（HTTP ${response.status}），请刷新页面后重试。`, { cause: error });
  }
  if (!response.ok || !data?.success) throw new Error(data?.error || '模型切换验证失败，请重试。');
  if (response.status === 202) {
    if (!data.job?.id) throw new Error('索引重建服务未返回任务编号，当前模型未更改。');
    const jobId = data.job.id;
    const deadline = Date.now() + 31 * 60_000;
    while (data.job?.status === 'building') {
      onProgress?.(`正在重新构建向量索引：已处理 ${data.job.completed} 个文档块，旧索引保留中。`);
      if (Date.now() >= deadline) throw new Error('等待索引重建完成超时，请刷新当前模型状态后重试。');
      await new Promise(resolve => setTimeout(resolve, 1500));
      try {
        response = await fetchSelection(`/rag-api/model-selection?jobId=${encodeURIComponent(jobId)}`, {
          method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        });
        data = await response.json();
      } catch (error) {
        throw new Error('获取向量重建进度失败，后台任务可能仍在进行，请刷新模型状态后重试。', { cause: error });
      }
      if (!response.ok || !data.success) throw new Error(data.error || '无法获取索引重建状态，请刷新当前模型状态后重试。');
    }
    if (data.job?.status !== 'ready') throw new Error(data.job?.error || '向量索引重建失败，旧索引未更改。');
  }
  if (typeof data.defaultLlmModel !== 'string'
    || typeof data.config?.llm?.model !== 'string'
    || typeof data.config?.llm?.provider !== 'string'
    || typeof data.config?.embedding?.model !== 'string'
    || typeof data.config?.embedding?.provider !== 'string') {
    throw new Error('模型切换服务返回的数据不完整，当前页面选择未更新，请刷新模型状态后重试。');
  }
  return data as ValidatedSessionModelSelection;
}

function modelSelectionTimeoutError(error: unknown, signal: AbortSignal): Error | undefined {
  if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
    return new Error('模型切换验证超时，当前页面选择未更新。后台重建可能仍在进行，请刷新模型状态后重试。', { cause: error });
  }
}

export function isSameModel(first: string, second: string, provider: string): boolean {
  const normalize = (model: string) => provider === 'ollama'
    ? model.replace(/:latest$/, '')
    : model;
  return normalize(first) === normalize(second);
}

export function resolveSessionModelConfig(
  serverConfig: SessionModelConfig,
  selection: SessionLlmSelection | null
): SessionModelConfig {
  // Health describes the server default. Keep a validated session override
  // until an operator changes the provider or its configured default.
  if (!selection
    || selection.provider !== serverConfig.llm.provider
    || selection.serverModel !== serverConfig.llm.model) return serverConfig;
  return { ...serverConfig, llm: { ...serverConfig.llm, model: selection.model } };
}
