import { NextResponse } from 'next/server';
import { generateRagEvalDataset, generateRagEvalDatasetFromCorpus, validateDatasetGenerationSettings, withDatasetCancellation } from '@/lib/rag/eval/dataset-generation';
import { createStableErrorLog } from '@/lib/security/error-redaction';
import { RagSecurityError, resolveRagSecurityContext } from '@/lib/security/request-context';
import { publicErrorPayload, readJsonObjectWithLimit, RequestValidationError } from '@/lib/security/request-validation';
import { createRetrievalScope } from '@/lib/security/retrieval-scope';
import type { RagEvalDataset } from '@/lib/rag/eval/types';
import type { KnowledgeDatasetSourceCoverage } from '@/lib/rag/eval/knowledge-dataset-sources';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  let accepted: RagEvalDataset | undefined;
  let sourceCoverage: KnowledgeDatasetSourceCoverage[] | undefined;
  let requestedCount = 0;
  let attempts = 0;
  const onProgress = (dataset: RagEvalDataset, progress: { attempts: number }) => {
    if (controller.signal.aborted) return;
    accepted = dataset;
    attempts = progress.attempts;
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', cancel, { once: true });
  if (request.signal.aborted) cancel();
  try {
    const context = await resolveRagSecurityContext(request, { capability: 'query', requestIdFactory: () => requestId });
    const raw = await readJsonObjectWithLimit(request, 128 * 1024);
    const settings = validateDatasetGenerationSettings(raw);
    requestedCount = settings.count;
    // Leave response time below the gateway's 300-second timeout, including top-ups.
    timeout = setTimeout(() => controller.abort(new RequestValidationError(
      'DATASET_GENERATION_TIMEOUT', '生成测试集超时，请减少题数或资料长度后重试。', 504
    )), 270_000);
    const result = await withDatasetCancellation(async () => {
      if (Object.hasOwn(raw, 'documentAssetIds')) {
        if (Object.keys(raw).some(key => !['datasetId', 'datasetVersion', 'count', 'documentAssetIds'].includes(key))) {
          throw new RequestValidationError('INVALID_DATASET_GENERATION_REQUEST', '请选择知识库文档或手动资料中的一种生成方式。');
        }
        const { loadKnowledgeDatasetSources } = await import('@/lib/rag/eval/knowledge-dataset-sources');
        const sources = await loadKnowledgeDatasetSources({
          documentAssetIds: raw.documentAssetIds as string[],
          scope: createRetrievalScope({ tenantId: context.tenantId, corpusId: context.corpusId, enforceIsolation: true }),
          signal: controller.signal,
        });
        sourceCoverage = sources.sourceCoverage;
        const dataset = await generateRagEvalDatasetFromCorpus(settings, sources.corpus, { signal: controller.signal, onProgress });
        return { dataset, sourceCoverage: sources.sourceCoverage };
      }
      return { dataset: await generateRagEvalDataset(raw, { signal: controller.signal, onProgress }) };
    }, controller.signal);
    return NextResponse.json({ success: true, ...result,
      generation: { requestedCount, generatedCount: result.dataset.cases.length, attempts, complete: true },
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[RAG Dataset Generation]', { requestId, ...createStableErrorLog(error) });
    if (error instanceof RagSecurityError) {
      return NextResponse.json({ success: false, ...error.toResponseBody() }, { status: error.status, headers: { 'cache-control': 'no-store' } });
    }
    const failure = controller.signal.aborted
      ? controller.signal.reason instanceof RequestValidationError
        ? controller.signal.reason
        : new RequestValidationError('DATASET_GENERATION_CANCELLED', '测试集生成已取消。', 499)
      : error;
    if (accepted?.cases.length && !request.signal.aborted) {
      const reason = failure instanceof RequestValidationError && failure.code === 'DATASET_GENERATION_TIMEOUT'
        ? 'timeout' : failure instanceof RequestValidationError && failure.code === 'DATASET_GENERATION_INCOMPLETE'
          ? 'attempt_limit' : 'provider_error';
      const generatedCount = accepted.cases.length;
      const stop = reason === 'timeout' ? '生成等待超时' : reason === 'attempt_limit' ? '已达自动补齐上限' : '后续生成未完成';
      const message = `${stop}。要求 ${requestedCount} 题，已保留 ${generatedCount} 题，还差 ${requestedCount - generatedCount} 题，可先下载部分草稿。`;
      return NextResponse.json({ success: true, dataset: accepted,
        ...(sourceCoverage ? { sourceCoverage } : {}),
        generation: { requestedCount, generatedCount, attempts, complete: false, reason, message },
      }, { headers: { 'cache-control': 'no-store' } });
    }
    const response = publicErrorPayload(failure, 'DATASET_GENERATION_FAILED', '无法生成测试集，请检查模型服务后重试。', requestId);
    return NextResponse.json({ success: false, ...response.body }, { status: response.status, headers: { 'cache-control': 'no-store' } });
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', cancel);
  }
}
