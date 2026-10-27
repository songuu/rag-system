import { parseCitationReferences } from '../citations/reference-parser';
import type { BaseMessage } from '@langchain/core/messages';

export interface ScopedAgentDiagnostics {
  version: 'scoped-agent-diagnostics-v1';
  /** Returned AI messages; provider retries that return no message are not counted. */
  modelResponseCount: number;
  usage: {
    measurement: 'provider' | 'partial' | 'unavailable';
    /** Responses with at least one valid input/output token measurement. */
    measuredModelResponses: number;
    /** Sums of available measurements only when measurement is partial. */
    inputTokenCount?: number;
    outputTokenCount?: number;
  };
  citations: {
    /** Checks numbered reference identity, never semantic support for a claim. */
    validation: 'reference-only';
    status: 'valid' | 'missing' | 'invalid';
    citationCount: number;
    invalidCitationCount: number;
    citedEvidenceIds: string[];
  };
}

export function buildScopedAgentDiagnostics(input: {
  messages: readonly BaseMessage[];
  answer: string;
  includedEvidenceIds: readonly string[];
}): ScopedAgentDiagnostics {
  const modelMessages = input.messages.filter(message => message.getType() === 'ai');
  let measuredModelResponses = 0;
  let completeResponses = 0;
  const inputMeasurement = { sum: 0, measured: false, overflow: false };
  const outputMeasurement = { sum: 0, measured: false, overflow: false };
  for (const message of modelMessages) {
    const metadata = 'usage_metadata' in message ? message.usage_metadata : undefined;
    const usage = metadata && typeof metadata === 'object' ? metadata : {};
    const inputTokenCount = 'input_tokens' in usage ? usage.input_tokens : undefined;
    const outputTokenCount = 'output_tokens' in usage ? usage.output_tokens : undefined;
    const hasInput = isTokenCount(inputTokenCount);
    const hasOutput = isTokenCount(outputTokenCount);
    if (hasInput || hasOutput) measuredModelResponses += 1;
    if (hasInput && hasOutput) completeResponses += 1;
    if (hasInput) addTokenMeasurement(inputMeasurement, inputTokenCount);
    if (hasOutput) addTokenMeasurement(outputMeasurement, outputTokenCount);
  }
  const complete = modelMessages.length > 0
    && completeResponses === modelMessages.length
    && !inputMeasurement.overflow
    && !outputMeasurement.overflow;
  return {
    version: 'scoped-agent-diagnostics-v1',
    modelResponseCount: modelMessages.length,
    usage: {
      measurement: complete ? 'provider' : measuredModelResponses > 0 ? 'partial' : 'unavailable',
      measuredModelResponses,
      ...(inputMeasurement.measured && !inputMeasurement.overflow
        ? { inputTokenCount: inputMeasurement.sum } : {}),
      ...(outputMeasurement.measured && !outputMeasurement.overflow
        ? { outputTokenCount: outputMeasurement.sum } : {}),
    },
    citations: inspectCitationReferences(input.answer, input.includedEvidenceIds),
  };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function addTokenMeasurement(
  measurement: { sum: number; measured: boolean; overflow: boolean },
  value: number
): void {
  measurement.measured = true;
  if (value > Number.MAX_SAFE_INTEGER - measurement.sum) measurement.overflow = true;
  if (!measurement.overflow) measurement.sum += value;
}

function inspectCitationReferences(
  answer: string,
  evidenceIds: readonly string[]
): ScopedAgentDiagnostics['citations'] {
  const parsed = parseCitationReferences(answer, evidenceIds.length);
  const citedEvidenceIds = new Set<string>();
  for (const range of parsed.ranges) {
    for (const number of range.numbers) {
      const id = evidenceIds[number - 1];
      if (id !== undefined) citedEvidenceIds.add(id);
    }
  }
  return {
    validation: 'reference-only',
    status: parsed.invalidCitationCount > 0 ? 'invalid' : parsed.citationCount > 0 ? 'valid' : 'missing',
    citationCount: parsed.citationCount,
    invalidCitationCount: parsed.invalidCitationCount,
    citedEvidenceIds: [...citedEvidenceIds],
  };
}
