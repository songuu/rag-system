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
  let citationCount = 0;
  let invalidCitationCount = 0;
  const citedEvidenceIds = new Set<string>();
  const { blocks, referenceLabels } = collectMarkdownProse(answer);

  // Preindex delimiters once per prose block so unmatched brackets/backticks
  // cannot trigger repeated scans of the remaining answer. Only validated IDs,
  // bounded by the evidence snapshot, leave this local reference inspection.
  for (const block of blocks) {
    const { squareClosers, parenthesisClosers, lastTicks } = indexMarkdownDelimiters(block);
    let inlineTicks = 0;
    let index = 0;
    while (index < block.length) {
      if (block[index] === '\\' && !inlineTicks) {
        index += 2;
        continue;
      }
      if (block.charCodeAt(index) === 96) {
        let end = index + 1;
        while (block.charCodeAt(end) === 96) end += 1;
        const length = end - index;
        if (inlineTicks === length) inlineTicks = 0;
        else if (!inlineTicks && (lastTicks.get(length) ?? -1) > index) inlineTicks = length;
        index = end;
        continue;
      }
      if (inlineTicks || block[index] !== '[') {
        index += 1;
        continue;
      }
      const linkEnd = markdownLinkEnd({
        text: block, start: index, squareClosers, parenthesisClosers, referenceLabels,
      });
      if (linkEnd !== undefined) {
        index = linkEnd;
        continue;
      }
      const group = readCitationGroup(block, index, evidenceIds);
      index = Math.max(index + 1, group.end);
      if (!group.closed) continue;
      citationCount += group.count;
      invalidCitationCount += group.invalidCount;
      for (const id of group.ids) citedEvidenceIds.add(id);
    }
  }
  return {
    validation: 'reference-only',
    status: invalidCitationCount > 0 ? 'invalid' : citationCount > 0 ? 'valid' : 'missing',
    citationCount,
    invalidCitationCount,
    citedEvidenceIds: [...citedEvidenceIds],
  };
}

/** Exclude common block forms without attempting a complete Markdown parser. */
function collectMarkdownProse(answer: string) {
  const blocks: string[] = [];
  const referenceLabels = new Set<string>();
  let paragraph: string[] = [];
  let inList = false;
  let fence: { marker: string; length: number } | undefined;
  const flush = () => {
    if (paragraph.length) blocks.push(paragraph.join('\n'));
    paragraph = [];
  };
  for (const line of answer.split('\n')) {
    const fenceMatch = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker
        && fenceMatch[1].length >= fence.length && /^\s*$/.test(fenceMatch[2])) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    const indented = /^( {4}|\t)/.test(line);
    const listItem = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(line);
    const isIndentedCode = indented && !(inList && listItem);
    if (!indented && line.trim()) inList = listItem;
    if (isIndentedCode || /^\s*$/.test(line)) {
      flush();
      continue;
    }
    // Reference labels are bounded to Markdown's 999-character label limit.
    const definition = /^ {0,3}\[([^\]\r\n]{1,999})\]:[ \t]*\S/.exec(line);
    if (definition) {
      flush();
      referenceLabels.add(normalizeReferenceLabel(definition[1]));
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return { blocks, referenceLabels };
}

function indexMarkdownDelimiters(text: string) {
  const squareClosers = new Map<number, number>();
  const parenthesisClosers = new Map<number, number>();
  const squareOpenings: number[] = [];
  const parenthesisOpenings: number[] = [];
  const lastTicks = new Map<number, number>();
  // Backslashes inside inline code are literal, so escaped ticks must still be
  // eligible as closers; the main scanner decides whether a run can open code.
  for (const match of text.matchAll(/\x60+/g)) lastTicks.set(match[0].length, match.index);
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') squareOpenings.push(index);
    if (character === '(') parenthesisOpenings.push(index);
    if (character === ']') {
      const opening = squareOpenings.pop();
      if (opening !== undefined) squareClosers.set(opening, index);
    }
    if (character === ')') {
      const opening = parenthesisOpenings.pop();
      if (opening !== undefined) parenthesisClosers.set(opening, index);
    }
  }
  return { squareClosers, parenthesisClosers, lastTicks };
}

function markdownLinkEnd(input: {
  text: string;
  start: number;
  squareClosers: ReadonlyMap<number, number>;
  parenthesisClosers: ReadonlyMap<number, number>;
  referenceLabels: ReadonlySet<string>;
}): number | undefined {
  const { text, start, squareClosers, parenthesisClosers, referenceLabels } = input;
  const labelEnd = squareClosers.get(start);
  if (labelEnd === undefined) return undefined;
  const suffix = labelEnd + 1;
  if (text[suffix] === '(') {
    const destinationEnd = parenthesisClosers.get(suffix);
    if (destinationEnd !== undefined) return destinationEnd + 1;
  }
  if (labelEnd - start > 1000) return undefined;
  const label = normalizeReferenceLabel(text.slice(start + 1, labelEnd));
  if (text[suffix] === '[') {
    const referenceEnd = squareClosers.get(suffix);
    if (referenceEnd !== undefined && referenceEnd - suffix <= 1000) {
      const reference = normalizeReferenceLabel(text.slice(suffix + 1, referenceEnd)) || label;
      if (referenceLabels.has(reference)) return referenceEnd + 1;
    }
  }
  // Adjacent numeric citations are references only when a real definition
  // resolves the second label; undefined [1][2] remains two evidence citations.
  return referenceLabels.has(label) ? labelEnd + 1 : undefined;
}

function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function readCitationGroup(line: string, start: number, evidenceIds: readonly string[]) {
  let cursor = start + 1;
  let count = 0;
  let invalidCount = 0;
  const ids = new Set<string>();
  while (cursor < line.length) {
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
    const digitStart = cursor;
    let number = 0;
    while (line.charCodeAt(cursor) >= 48 && line.charCodeAt(cursor) <= 57) {
      // Saturating at the snapshot size also makes arbitrarily long integers safe.
      number = Math.min(evidenceIds.length + 1, number * 10 + line.charCodeAt(cursor) - 48);
      cursor += 1;
    }
    if (cursor === digitStart) break;
    count += 1;
    const id = evidenceIds[number - 1];
    if (id === undefined) invalidCount += 1;
    else ids.add(id);
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
    if (line[cursor] === ']') {
      return { closed: true, end: cursor + 1, count, invalidCount, ids };
    }
    if (line[cursor] !== ',' && line[cursor] !== '，') break;
    cursor += 1;
  }
  return { closed: false, end: cursor, count: 0, invalidCount: 0, ids };
}

