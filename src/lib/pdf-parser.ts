export type PdfParserProvider = 'pdf-parse' | 'liteparse';

export interface PdfParseOptions {
  provider?: PdfParserProvider;
  includeMetadata?: boolean;
  ocrEnabled?: boolean;
  maxPages?: number;
  targetPages?: string;
  password?: string;
}

export interface PdfParseOutput {
  text: string;
  pages: number;
  parseMethod: 'pdf-parse-v2' | 'liteparse-v2';
  title?: string;
  author?: string;
  createdAt?: string;
  pageTexts?: string[];
}

export interface PdfTextItemLike {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_LITEPARSE_MAX_PAGES = 1000;

export async function parsePdfBuffer(
  buffer: Buffer,
  filename: string,
  options: PdfParseOptions = {}
): Promise<PdfParseOutput> {
  const provider = options.provider ?? resolvePdfParserProvider();

  try {
    if (provider === 'liteparse') {
      return await parseWithLiteParse(buffer, options);
    }

    return await parseWithPdfParse(buffer, options);
  } catch (error) {
    throw new Error(
      `${provider} 解析失败 (${filename}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function resolvePdfParserProvider(value = process.env.PDF_PARSE_PROVIDER): PdfParserProvider {
  const normalized = value?.trim().toLowerCase();

  if (normalized === 'liteparse' || normalized === 'liteparse-v2') {
    return 'liteparse';
  }

  return 'pdf-parse';
}

export function resolveLiteParseOcrEnabled(value = process.env.PDF_PARSE_OCR_ENABLED): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

async function parseWithPdfParse(
  buffer: Buffer,
  options: PdfParseOptions
): Promise<PdfParseOutput> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });

  try {
    const textResult = await parser.getText();
    let metadata: {
      total?: number;
      info?: Record<string, unknown>;
    } | null = null;

    if (options.includeMetadata) {
      metadata = await parser.getInfo();
    }

    return {
      text: normalizeParsedPdfText(textResult.text || ''),
      pages: textResult.total ?? metadata?.total ?? 0,
      title: getStringMetadata(metadata?.info?.Title),
      author: getStringMetadata(metadata?.info?.Author),
      createdAt: getStringMetadata(metadata?.info?.CreationDate),
      parseMethod: 'pdf-parse-v2',
    };
  } finally {
    await parser.destroy();
  }
}

async function parseWithLiteParse(
  buffer: Buffer,
  options: PdfParseOptions
): Promise<PdfParseOutput> {
  const { LiteParse } = await import('@llamaindex/liteparse');
  const parser = new LiteParse({
    ocrEnabled: options.ocrEnabled ?? resolveLiteParseOcrEnabled(),
    maxPages: options.maxPages ?? DEFAULT_LITEPARSE_MAX_PAGES,
    targetPages: options.targetPages,
    password: options.password,
    outputFormat: 'json',
    quiet: true,
  });

  const result = await parser.parse(buffer);
  const pageTexts = result.pages.map((page) => {
    const readableText = buildReadableTextFromPdfTextItems(page.textItems);
    return readableText || normalizeParsedPdfText(page.text || '');
  });
  const text = normalizeParsedPdfText(pageTexts.join('\n\f\n') || result.text);

  return {
    text,
    pages: result.pages.length,
    pageTexts,
    parseMethod: 'liteparse-v2',
  };
}

function getStringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function normalizeParsedPdfText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(normalizeLetterSpacedLine)
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function buildReadableTextFromPdfTextItems(items: PdfTextItemLike[]): string {
  const lines = groupTextItemsIntoLines(items);
  return normalizeParsedPdfText(lines.map(buildReadableLine).filter(Boolean).join('\n'));
}

function normalizeLetterSpacedLine(line: string): string {
  return line
    .split(/(\s{2,})/)
    .map((segment) => {
      if (/^\s+$/.test(segment)) return segment;
      return segment.replace(/\b(?:[A-Za-z]\s+){2,}[A-Za-z]\b/g, (match) =>
        match.replace(/\s+/g, '')
      );
    })
    .join('')
    .replace(/[ \t]{3,}/g, '  ')
    .trimEnd();
}

function groupTextItemsIntoLines(items: PdfTextItemLike[]): PdfTextItemLike[][] {
  const sortedItems = items
    .filter((item) => item.text.trim())
    .slice()
    .sort((left, right) => left.y - right.y || left.x - right.x);

  const lines: Array<{ y: number; height: number; items: PdfTextItemLike[] }> = [];

  for (const item of sortedItems) {
    const previousLine = lines.at(-1);
    const tolerance = Math.max(2, Math.min(previousLine?.height ?? item.height, item.height) * 0.65);

    if (previousLine && Math.abs(previousLine.y - item.y) <= tolerance) {
      previousLine.items.push(item);
      previousLine.y = (previousLine.y * (previousLine.items.length - 1) + item.y) / previousLine.items.length;
      previousLine.height = Math.max(previousLine.height, item.height);
      continue;
    }

    lines.push({ y: item.y, height: item.height, items: [item] });
  }

  return lines.map((line) => line.items.sort((left, right) => left.x - right.x));
}

function buildReadableLine(items: PdfTextItemLike[]): string {
  if (items.length === 0) return '';

  const characterWidth = getMedian(
    items
      .map((item) => item.width / Math.max(item.text.trim().length, 1))
      .filter((width) => Number.isFinite(width) && width > 0)
  ) ?? 8;
  const positiveGaps = getPositiveGaps(items);
  const medianGap = getMedian(positiveGaps) ?? 0;
  const letterGapThreshold = Math.max(characterWidth * 1.2, medianGap * 2.5, 3);
  const wordGapThreshold = Math.max(characterWidth * 0.3, 1.5);

  let line = items[0].text.trim();

  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    const currentText = current.text.trim();

    if (!currentText) continue;

    const gap = current.x - (previous.x + previous.width);
    if (shouldInsertTextItemSpace(previous.text.trim(), currentText, gap, {
      letterGapThreshold,
      wordGapThreshold,
    })) {
      line += ' ';
    }

    line += currentText;
  }

  return normalizeParsedPdfText(line);
}

function shouldInsertTextItemSpace(
  previousText: string,
  currentText: string,
  gap: number,
  thresholds: {
    letterGapThreshold: number;
    wordGapThreshold: number;
  }
): boolean {
  if (gap <= 0) return false;
  if (/^[,.;:!?%\])}]/.test(currentText)) return false;
  if (/[(\[{]$/.test(previousText)) return false;

  if (isSingleAsciiLetter(previousText) && isSingleAsciiLetter(currentText)) {
    return gap > thresholds.letterGapThreshold;
  }

  return gap > thresholds.wordGapThreshold;
}

function isSingleAsciiLetter(value: string): boolean {
  return /^[A-Za-z]$/.test(value);
}

function getPositiveGaps(items: PdfTextItemLike[]): number[] {
  const gaps: number[] = [];

  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    const gap = current.x - (previous.x + previous.width);
    if (gap > 0) gaps.push(gap);
  }

  return gaps;
}

function getMedian(values: number[]): number | undefined {
  if (values.length === 0) return undefined;

  const sortedValues = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 1) {
    return sortedValues[middle];
  }

  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}
