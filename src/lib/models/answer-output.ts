import { RequestValidationError } from '../security/request-validation';

export const ANSWER_MAX_OUTPUT_TOKENS = 1024;
export const COVERAGE_MAX_OUTPUT_TOKENS = 128;

/** A token-limited fragment cannot be published as a completed grounded answer. */
export function assertCompleteAnswer(response: unknown): void {
  if (!response || typeof response !== 'object') return;
  const metadata = (response as { response_metadata?: Record<string, unknown> }).response_metadata;
  const reason = metadata?.finish_reason ?? metadata?.done_reason;
  if (reason === 'length' || reason === 'max_tokens') {
    throw new RequestValidationError('RAG_GENERATION_OUTPUT_LIMIT',
      '回答达到输出长度上限，未返回不完整答案。请缩小问题范围后重试。', 502);
  }
}
