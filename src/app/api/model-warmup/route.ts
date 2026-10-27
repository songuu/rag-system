import { NextResponse } from 'next/server';
import { readJsonObjectWithLimit, validateLlmModelSelection, validateEmbeddingModelSelection,
  resolveRuntimeEmbeddingProvider, publicErrorPayload } from '@/lib/security/request-validation';
import { resolveRagSecurityContext, RagSecurityError } from '@/lib/security/request-context';
import { beginOllamaModelWarmup, getOllamaModelReadiness, warmOllamaModel, warmOllamaEmbeddingModel } from '@/lib/ollama-readiness';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await resolveRagSecurityContext(request, { capability: 'query' });
    const body = await readJsonObjectWithLimit(request, 4096);
    const model = validateLlmModelSelection(body.llmModel);
    const embeddingModel = validateEmbeddingModelSelection(body.embeddingModel);
    const embeddingProvider = resolveRuntimeEmbeddingProvider();
    const readiness = (process.env.MODEL_PROVIDER || 'ollama') === 'ollama'
      ? beginOllamaModelWarmup(model, { preparationKey: `embedding:${embeddingProvider}:${embeddingModel}`, prepare: async () => {
          // Warm the small classifier first. A large model's disk loading can
          // otherwise occupy Ollama's queue past the classifier's deadline.
          if (process.env.RAG_SEMANTIC_ROUTER !== 'off') try {
            await warmOllamaModel(process.env.FAST_LLM_MODEL || 'qwen2.5:0.5b', {
              settings: { numCtx: 2048, keepAlive: '15m' }, timeoutMs: 10_000,
            });
          } catch { /* An unavailable classifier must not block the selected model. */ }
          if (embeddingProvider === 'ollama') await warmOllamaEmbeddingModel(embeddingModel);
        } }) : { model, phase: 'ready', detail: '远程提供商无需本机预加载。' };
    return NextResponse.json({ success: true, readiness }, { status: readiness.phase === 'loading' ? 202 : 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const mapped = error instanceof RagSecurityError
      ? { status: error.status, body: { error: { code: error.code, message: error.message } } }
      : error instanceof Error && error.message.startsWith('MODEL_PRELOAD_')
        ? { status: 503, body: { error: { code: error.message, message: '模型预加载失败，请检查模型是否安装以及 Ollama 服务状态。' } } }
        : error instanceof Error && error.name === 'TimeoutError'
          ? { status: 504, body: { error: { code: 'MODEL_PRELOAD_TIMEOUT', message: '模型加载超过 240 秒，请检查可用内存或选择更小的已安装模型。' } } }
          : publicErrorPayload(error, 'MODEL_PRELOAD_FAILED', '模型预加载未完成，请检查本地服务后重试。', requestId);
    return NextResponse.json({ success: false, code: mapped.body.error.code, error: mapped.body.error.message }, { status: mapped.status });
  }
}

export async function GET(request: Request) {
  try {
    await resolveRagSecurityContext(request, { capability: 'query' });
    const model = validateLlmModelSelection(new URL(request.url).searchParams.get('model'));
    const embeddingModel = validateEmbeddingModelSelection(new URL(request.url).searchParams.get('embeddingModel'));
    const readiness = getOllamaModelReadiness(model, {
      preparationKey: `embedding:${resolveRuntimeEmbeddingProvider()}:${embeddingModel}`,
    });
    return NextResponse.json({ success: true, readiness }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const mapped = error instanceof RagSecurityError
      ? { status: error.status, body: { error: { code: error.code, message: error.message } } }
      : publicErrorPayload(error, 'MODEL_PRELOAD_STATUS_FAILED', '无法读取模型加载状态。', crypto.randomUUID());
    return NextResponse.json({ success: false, error: mapped.body.error.message }, { status: mapped.status });
  }
}
