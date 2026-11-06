import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { observeProviderInvocation } from '../rag/core/provider-usage-observer';
import {
  TextModelError,
  rethrowTextModelCancellation,
  type TextModelClient,
  type TextModelResult,
  type TextModelUsage,
} from './text-model';

/** ModelFactory remains responsible for provider selection, transport timeouts and retries. */
export function createLangChainTextModelClient(model: Pick<BaseChatModel, 'invoke'>): TextModelClient {
  return {
    async complete(request) {
      request.signal?.throwIfAborted();
      try {
        const response = await observeProviderInvocation('generation', () => model.invoke(
          request.messages.map(message => ({ role: message.role, content: message.content })),
          { signal: request.signal },
        ));
        // A non-cooperative provider must not turn cancellation into a successful answer.
        request.signal?.throwIfAborted();
        const record = asRecord(response);
        const additional = asRecord(record.additional_kwargs);
        if (hasCalls(record.tool_calls) || hasCalls(record.invalid_tool_calls)
          || hasCalls(additional.tool_calls) || additional.function_call) {
          throw new TextModelError('MODEL_RESPONSE_INVALID', request.operation);
        }
        const text = textContent(record.content);
        const metadata = asRecord(record.response_metadata);
        const reason = metadata.finish_reason ?? metadata.done_reason;
        if (text === undefined || reason === 'tool_calls' || reason === 'function_call') {
          throw new TextModelError('MODEL_RESPONSE_INVALID', request.operation);
        }
        return {
          text,
          stopReason: stopReason(reason),
          usage: readUsage(record.usage_metadata),
        };
      } catch (error) {
        rethrowTextModelCancellation(error, request.signal);
        if (error instanceof TextModelError) throw error;
        throw new TextModelError('MODEL_INVOCATION_FAILED', request.operation, { cause: error });
      }
    },
  };
}

function textContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.flatMap(block => {
    const record = asRecord(block);
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
  return blocks.length ? blocks.join('\n') : undefined;
}

function readUsage(value: unknown): TextModelUsage {
  const usage = asRecord(value);
  const hasInput = isTokenCount(usage.input_tokens);
  const hasOutput = isTokenCount(usage.output_tokens);
  return {
    measurement: hasInput && hasOutput ? 'provider' : hasInput || hasOutput ? 'partial' : 'unavailable',
    ...(hasInput ? { inputTokenCount: usage.input_tokens as number } : {}),
    ...(hasOutput ? { outputTokenCount: usage.output_tokens as number } : {}),
  };
}

function stopReason(value: unknown): TextModelResult['stopReason'] {
  return value === 'stop' || value === 'length' || value === 'content_filter' ? value : 'unknown';
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasCalls(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
