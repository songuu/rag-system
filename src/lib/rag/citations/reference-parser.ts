export interface CitationReferenceRange {
  /** UTF-16 offsets into the unmodified answer; end is exclusive. */
  start: number;
  end: number;
  numbers: number[];
}

/** Shared by server validation and browser rendering; code and Markdown links are not citations. */
export function parseCitationReferences(answer: string, maxNumber = 1000): {
  ranges: CitationReferenceRange[];
  citationCount: number;
  invalidCitationCount: number;
} {
  if (!Number.isSafeInteger(maxNumber) || maxNumber < 0 || maxNumber > 1000) {
    throw new Error('Citation snapshot size must be between zero and 1000.');
  }
  const ranges: CitationReferenceRange[] = [];
  let citationCount = 0;
  let invalidCitationCount = 0;
  const { blocks, referenceLabels } = collectMarkdownProse(answer);
  for (const { text: block, start } of blocks) {
    const { squareClosers, parenthesisClosers, lastTicks } = indexMarkdownDelimiters(block);
    let inlineTicks = 0;
    let index = 0;
    while (index < block.length) {
      if (block[index] === '\\' && !inlineTicks) { index += 2; continue; }
      if (block.charCodeAt(index) === 96) {
        let end = index + 1;
        while (block.charCodeAt(end) === 96) end += 1;
        const length = end - index;
        if (inlineTicks === length) inlineTicks = 0;
        else if (!inlineTicks && (lastTicks.get(length) ?? -1) > index) inlineTicks = length;
        index = end;
        continue;
      }
      if (inlineTicks || block[index] !== '[') { index += 1; continue; }
      const linkEnd = markdownLinkEnd({ text: block, start: index, squareClosers, parenthesisClosers, referenceLabels });
      if (linkEnd !== undefined) { index = linkEnd; continue; }
      const group = readCitationGroup(block, index, maxNumber);
      const rangeStart = index;
      index = Math.max(index + 1, group.end);
      if (!group.closed) continue;
      citationCount += group.numbers.length;
      invalidCitationCount += group.numbers.filter(number => number < 1 || number > maxNumber).length;
      ranges.push({ start: start + rangeStart, end: start + group.end, numbers: group.numbers });
    }
  }
  return { ranges, citationCount, invalidCitationCount };
}

function collectMarkdownProse(answer: string) {
  const blocks: Array<{ text: string; start: number }> = [];
  const referenceLabels = new Set<string>();
  let paragraph: string[] = [];
  let paragraphStart = 0;
  let offset = 0;
  let inList = false;
  let fence: { marker: string; length: number } | undefined;
  const flush = () => {
    if (paragraph.length) blocks.push({ text: paragraph.join('\n'), start: paragraphStart });
    paragraph = [];
  };
  for (const line of answer.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    const fenceMatch = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length && /^\s*$/.test(fenceMatch[2])) fence = undefined;
      continue;
    }
    if (fenceMatch) { flush(); fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length }; continue; }
    const indented = /^( {4}|\t)/.test(line);
    const listItem = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(line);
    const isIndentedCode = indented && !(inList && listItem);
    if (!indented && line.trim()) inList = listItem;
    if (isIndentedCode || /^\s*$/.test(line)) { flush(); continue; }
    const definition = /^ {0,3}\[([^\]\r\n]{1,999})\]:[ \t]*\S/.exec(line);
    if (definition) { flush(); referenceLabels.add(normalizeReferenceLabel(definition[1])); continue; }
    if (!paragraph.length) paragraphStart = start;
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
  for (const match of text.matchAll(/\x60+/g)) lastTicks.set(match[0].length, match.index);
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') { index += 1; continue; }
    if (character === '[') squareOpenings.push(index);
    if (character === '(') parenthesisOpenings.push(index);
    if (character === ']') { const opening = squareOpenings.pop(); if (opening !== undefined) squareClosers.set(opening, index); }
    if (character === ')') { const opening = parenthesisOpenings.pop(); if (opening !== undefined) parenthesisClosers.set(opening, index); }
  }
  return { squareClosers, parenthesisClosers, lastTicks };
}

function markdownLinkEnd(input: { text: string; start: number; squareClosers: ReadonlyMap<number, number>; parenthesisClosers: ReadonlyMap<number, number>; referenceLabels: ReadonlySet<string> }): number | undefined {
  const { text, start, squareClosers, parenthesisClosers, referenceLabels } = input;
  const labelEnd = squareClosers.get(start);
  if (labelEnd === undefined) return undefined;
  const suffix = labelEnd + 1;
  if (text[suffix] === '(') { const destinationEnd = parenthesisClosers.get(suffix); if (destinationEnd !== undefined) return destinationEnd + 1; }
  if (labelEnd - start > 1000) return undefined;
  const label = normalizeReferenceLabel(text.slice(start + 1, labelEnd));
  if (text[suffix] === '[') {
    const referenceEnd = squareClosers.get(suffix);
    if (referenceEnd !== undefined && referenceEnd - suffix <= 1000) {
      const reference = normalizeReferenceLabel(text.slice(suffix + 1, referenceEnd)) || label;
      if (referenceLabels.has(reference)) return referenceEnd + 1;
    }
  }
  return referenceLabels.has(label) ? labelEnd + 1 : undefined;
}

function normalizeReferenceLabel(label: string): string { return label.trim().replace(/\s+/g, ' ').toLowerCase(); }

function readCitationGroup(line: string, start: number, maxNumber: number) {
  let cursor = start + 1;
  const numbers: number[] = [];
  while (cursor < line.length) {
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
    const digitStart = cursor;
    let number = 0;
    while (line.charCodeAt(cursor) >= 48 && line.charCodeAt(cursor) <= 57) {
      number = Math.min(maxNumber + 1, number * 10 + line.charCodeAt(cursor) - 48);
      cursor += 1;
    }
    if (cursor === digitStart) break;
    numbers.push(number);
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
    if (line[cursor] === ']') return { closed: true, end: cursor + 1, numbers };
    if (line[cursor] !== ',' && line[cursor] !== '，') break;
    cursor += 1;
  }
  return { closed: false, end: cursor, numbers: [] };
}
