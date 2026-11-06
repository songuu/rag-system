import { AIMessageChunk } from '@langchain/core/messages';

const MAX_STREAM_CHARACTERS = 256 * 1024;
const REASONING_TAGS = ['<think>', '</think>', '<analysis>', '</analysis>'] as const;

/** Consume real model chunks while keeping the SDK's usage and stop metadata.
 * Only the final answer model may call this helper; routing and tools stay private. */
export async function streamAnswerMessage(input: {
  stream(signal: AbortSignal): Promise<AsyncIterable<AIMessageChunk>>;
  signal: AbortSignal;
  onDelta(text: string): void;
}): Promise<AIMessageChunk> {
  input.signal.throwIfAborted();
  const stream = await input.stream(input.signal);
  const iterator = stream[Symbol.asyncIterator]();
  const filter = createAnswerTextFilter();
  let completed = false;
  let combined: AIMessageChunk | undefined;
  let answer = '';
  let receivedCharacters = 0;
  const publish = (text: string) => {
    if (!text) return;
    input.signal.throwIfAborted();
    answer += text;
    input.onDelta(text);
  };
  try {
    for (;;) {
      input.signal.throwIfAborted();
      const next = await iterator.next();
      input.signal.throwIfAborted();
      if (next.done) { completed = true; break; }
      const chunk = next.value;
      if (hasToolCall(chunk)) throw new Error('Answer stream unexpectedly returned a tool call.');
      // Bound reasoning too: hidden text still occupies the aggregated message.
      receivedCharacters += JSON.stringify(chunk.content).length + JSON.stringify(chunk.additional_kwargs).length;
      if (receivedCharacters > MAX_STREAM_CHARACTERS) throw new Error('Answer stream exceeded its output limit.');
      combined = combined ? combined.concat(chunk) : chunk;
      publish(filter.push(answerText(chunk.content)));
    }
    publish(filter.finish());
    input.signal.throwIfAborted();
    if (!combined) throw new Error('Answer stream returned an empty answer.');
    const responseMetadata = normalizeTerminalMetadata(combined.response_metadata);
    const stopReason = responseMetadata.finish_reason ?? responseMetadata.done_reason;
    // A reasoning model can exhaust the output budget before emitting text;
    // keep that reason so the caller returns the explicit output-limit error.
    if (!answer.trim() && stopReason !== 'length' && stopReason !== 'max_tokens') {
      throw new Error('Answer stream returned an empty answer.');
    }
    return new AIMessageChunk({
      id: combined.id, name: combined.name, content: answer,
      additional_kwargs: combined.additional_kwargs,
      response_metadata: responseMetadata,
      usage_metadata: combined.usage_metadata,
    });
  } finally {
    // Do not detach iterator cleanup: the generation deadline must keep a
    // cancelled, non-cooperative provider counted as occupying model capacity.
    if (!completed) await iterator.return?.();
  }
}

function normalizeTerminalMetadata(metadata: AIMessageChunk['response_metadata']): AIMessageChunk['response_metadata'] {
  // OpenAI Responses uses status/details instead of Chat Completions' finish_reason.
  // Preserve its original fields while routing output limits through the existing 502 check.
  if (metadata.status !== undefined && metadata.status !== 'completed') {
    const details: unknown = metadata.incomplete_details;
    if (metadata.status === 'incomplete' && details && typeof details === 'object'
      && 'reason' in details && details.reason === 'max_output_tokens') {
      return { ...metadata, finish_reason: 'length' };
    }
    throw new Error('Answer stream returned an unsuccessful terminal provider status.');
  }
  const stopReason: unknown = metadata.finish_reason ?? metadata.done_reason;
  if (stopReason === undefined && metadata.status === 'completed') return metadata;
  // Installed Ollama and OpenAI chat adapters both use stop for normal completion.
  // Filtering, tool handoff and unknown reasons cannot certify a complete answer.
  if (stopReason === 'stop' || stopReason === 'length' || stopReason === 'max_tokens') return metadata;
  throw new Error('Answer stream ended without a successful terminal provider reason.');
}

function answerText(content: AIMessageChunk['content']): string {
  if (typeof content === 'string') return content;
  return content.flatMap(block => (block.type === 'text' || block.type === 'output_text')
    && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('');
}

function hasToolCall(chunk: AIMessageChunk): boolean {
  return Boolean(chunk.tool_calls?.length || chunk.invalid_tool_calls?.length || chunk.tool_call_chunks?.length
    || chunk.additional_kwargs.function_call || chunk.additional_kwargs.tool_calls?.length
    || (Array.isArray(chunk.content) && chunk.content.some(block =>
      ['tool_use', 'server_tool_use', 'tool_call', 'function_call', 'input_json_delta'].includes(block.type))));
}

/** Some compatible providers put reasoning tags inside text instead of metadata.
 * Buffer possible tag prefixes so a marker split across packets never leaks. */
function createAnswerTextFilter() {
  let pending = '';
  const reasoning: string[] = [];
  return {
    push(text: string): string {
      pending += text;
      let visible = '';
      let match: RegExpExecArray | null;
      while ((match = /<\/?(think|analysis)>/iu.exec(pending))) {
        if (reasoning.length === 0) visible += pending.slice(0, match.index);
        const tag = match[1].toLowerCase();
        if (match[0][1] !== '/') reasoning.push(tag);
        else if (reasoning.at(-1) === tag) reasoning.pop();
        pending = pending.slice(match.index + match[0].length);
      }
      const lowercase = pending.toLowerCase();
      let held = 0;
      for (const tag of REASONING_TAGS) {
        for (let length = 1; length < tag.length && length <= pending.length; length++) {
          if (lowercase.endsWith(tag.slice(0, length))) held = Math.max(held, length);
        }
      }
      const ready = pending.slice(0, pending.length - held);
      pending = pending.slice(pending.length - held);
      return visible + (reasoning.length === 0 ? ready : '');
    },
    finish(): string {
      // At EOF an unclosed prefix can be an ordinary '<' comparison operator.
      // Only text inside a known reasoning section remains private.
      const visible = reasoning.length === 0 ? pending : '';
      pending = '';
      return visible;
    },
  };
}
