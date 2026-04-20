/**
 * Slide 解析
 *
 * 策略: 复用项目 document-parser,获取整篇纯文本后按启发式切页。
 * - PDF: 优先按 form feed (\f) 分页;无则按连续 2+ 空行段落切
 * - MD/TXT: 按 "---" 或 "## " 切页
 * - 保证至少产出一页
 */

import { parseDocument } from '../document-parser';
import type { SlidePage } from './types';

export interface ParsedSlides {
  filename: string;
  pages: SlidePage[];
  raw_text: string;
}

const MAX_PAGES = 60;
const MIN_PAGE_CHARS = 20;

export async function parseSlides(
  buffer: Buffer,
  filename: string
): Promise<ParsedSlides> {
  const result = await parseDocument(buffer, filename);
  if (!result.success || !result.document) {
    throw new Error(`无法解析 slides: ${result.error ?? 'unknown'}`);
  }

  const raw = result.document.content.trim();
  if (!raw) throw new Error('文档内容为空');

  const chunks = splitIntoPages(raw);
  const pages: SlidePage[] = chunks.slice(0, MAX_PAGES).map((text, i) => ({
    index: i,
    raw_text: text,
    description: '',
    key_points: [],
  }));

  if (pages.length === 0) {
    pages.push({ index: 0, raw_text: raw.slice(0, 4000), description: '', key_points: [] });
  }

  return { filename, pages, raw_text: raw };
}

function splitIntoPages(text: string): string[] {
  if (text.includes('\f')) {
    return text
      .split('\f')
      .map(s => s.trim())
      .filter(s => s.length >= MIN_PAGE_CHARS);
  }

  const mdHeadings = text.split(/\n(?=#{1,3}\s)/);
  if (mdHeadings.length > 1) {
    return mdHeadings.map(s => s.trim()).filter(s => s.length >= MIN_PAGE_CHARS);
  }

  const paraSplit = text.split(/\n{2,}/);
  const pages: string[] = [];
  let buffer = '';
  const targetLen = 600;
  for (const para of paraSplit) {
    buffer += (buffer ? '\n\n' : '') + para.trim();
    if (buffer.length >= targetLen) {
      pages.push(buffer);
      buffer = '';
    }
  }
  if (buffer.trim().length >= MIN_PAGE_CHARS) pages.push(buffer.trim());

  return pages.length > 0 ? pages : [text];
}
