import { NextResponse } from 'next/server';
import { isSameModel } from '@/lib/model-selection';
import {
  readJsonObjectWithLimit,
  RequestValidationError,
  validateLlmModelSelection,
  validateEmbeddingModelSelection,
  resolveRuntimeLlmModel,
  resolveRuntimeEmbeddingModel,
  resolveRuntimeEmbeddingProvider,
} from '@/lib/security/request-validation';
import { redactErrorForLog } from '@/lib/security/error-redaction';
import { assertCapability, RagSecurityError, resolveRagSecurityContext } from '@/lib/security/request-context';
import { getActiveEmbeddingIndex } from '@/lib/embedding-index-state';
import { embeddingReindexJobs } from '@/lib/embedding-reindex-jobs';

// LLM changes are request-scoped. Embedding changes explicitly rebuild the
// authenticated corpus and publish a durable pointer only after verification.
export async function POST(request: Request) {
  try {
    const securityContext = await resolveRagSecurityContext(request);
    const body = await readJsonObjectWithLimit(request, 4_096);
    // Request validation already resolves the provider defaults. Reading these
    // strings avoids compiling/loading the model SDKs for a configuration check.
    const llm = { provider: process.env.MODEL_PROVIDER || 'ollama', model: resolveRuntimeLlmModel() };
    const embedding = { provider: resolveRuntimeEmbeddingProvider(), model: resolveRuntimeEmbeddingModel() };
    let candidate = body.llmModel;
    if (llm.provider === 'ollama' && typeof candidate === 'string' && candidate.endsWith(':latest')) {
      const allowlist = process.env.RAG_ALLOWED_LLM_MODELS?.split(',').map(model => model.trim());
      const untagged = candidate.slice(0, -':latest'.length);
      // Preserve exact allowlist enforcement in /ask while accepting Ollama's
      // installed-model spelling when the operator approved its default tag.
      if (!allowlist?.includes(candidate) && allowlist?.includes(untagged)) candidate = untagged;
    }
    const model = validateLlmModelSelection(candidate);
    const embeddingCandidate = typeof body.embeddingModel === 'string'
      && isSameModel(body.embeddingModel, embedding.model, embedding.provider)
      ? embedding.model
      : body.embeddingModel;
    let approvedEmbedding = embeddingCandidate;
    if (embedding.provider === 'ollama' && typeof approvedEmbedding === 'string' && approvedEmbedding.endsWith(':latest')) {
      const allowlist = process.env.RAG_ALLOWED_EMBEDDING_MODELS?.split(',').map(model => model.trim());
      const untagged = approvedEmbedding.slice(0, -':latest'.length);
      if (!allowlist?.includes(approvedEmbedding) && allowlist?.includes(untagged)) approvedEmbedding = untagged;
    }
    const embeddingModel = validateEmbeddingModelSelection(approvedEmbedding);
    if (!isSameModel(embeddingModel, embedding.model, embedding.provider)) {
      if (body.reindex === true) {
        assertCapability(securityContext, 'reindex');
        const { beginEmbeddingReindex } = await import('@/lib/embedding-reindex-runtime');
        const job = beginEmbeddingReindex(embeddingModel, securityContext, {
          defaultLlmModel: llm.model,
          config: { llm: { provider: llm.provider, model }, embedding },
        });
        return NextResponse.json({ success: true, job: publicJob(job) }, { status: 202, headers: { 'cache-control': 'no-store' } });
      }
      throw new RequestValidationError(
        'EMBEDDING_MODEL_REQUIRES_REINDEX',
        '嵌入模型必须与当前知识库一致；更换嵌入模型需要重新构建索引。',
        409
      );
    }
    return NextResponse.json({
      success: true,
      defaultLlmModel: llm.model,
      config: {
        llm: { provider: llm.provider, model },
        embedding: { ...embedding, ...(getActiveEmbeddingIndex() ? { dimension: getActiveEmbeddingIndex()!.dimension } : {}) },
      },
    });
  } catch (error) {
    if (error instanceof RagSecurityError) return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
    if (error instanceof RequestValidationError) {
      return NextResponse.json({
        success: false,
        code: error.code,
        error: error.code === 'MODEL_NOT_ALLOWED'
          ? '所选模型未获服务器授权，请选择允许使用的模型。'
          : error.message,
      }, { status: error.status });
    }
    console.error('[Model Selection API]', redactErrorForLog(error));
    return NextResponse.json({ success: false, error: '验证模型选择失败，请稍后重试。' }, { status: 500 });
  }
}

function publicJob(job: import('@/lib/embedding-reindex-jobs').EmbeddingReindexJob) {
  return { id: job.id, model: job.model, status: job.status, stage: job.stage, completed: job.completed, error: job.error };
}

export async function GET(request: Request) {
  try {
    const context = await resolveRagSecurityContext(request);
    const id = new URL(request.url).searchParams.get('jobId');
    const job = id ? embeddingReindexJobs().get(id) : undefined;
    if (!job) return NextResponse.json({ success: false, error: '重建任务不存在或服务已重启，请刷新当前配置后重试。' }, { status: 404 });
    if (job.actorId !== context.actorId || job.tenantId !== context.tenantId || job.corpusId !== context.corpusId) {
      return NextResponse.json({ success: false, error: '无权访问此重建任务。' }, { status: 403 });
    }
    return NextResponse.json({ success: true, job: publicJob(job), ...(job.status === 'ready' ? job.selection : {}) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof RagSecurityError ? error.message : '获取重建状态失败。' }, { status: error instanceof RagSecurityError ? error.status : 500 });
  }
}
