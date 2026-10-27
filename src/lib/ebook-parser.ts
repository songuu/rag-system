import { load, type CheerioAPI } from 'cheerio';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { Worker } from 'node:worker_threads';
import { assertSafeZipArchive } from './security/zip-safety';
import { EbookParseError } from './ebook-parser-error';
import { MOBI_PARSER_WORKER_SOURCE } from './mobi-parser-worker';
import { resolveMobiParserPath } from './mobi-parser-runtime';

export interface ParsedEbook {
  content: string;
  title?: string;
  author?: string;
  chapterCount: number;
  parseMethod: 'epub' | 'mobi';
}

const MAX_EBOOK_TEXT_BYTES = 32 * 1024 * 1024;

export async function parseEbookBuffer(buffer: Buffer, format: 'epub' | 'mobi'): Promise<ParsedEbook> {
  try {
    const parsed = format === 'epub' ? await parseEpub(buffer) : await parseMobi(buffer);
    if (!parsed.content.trim()) {
      throw new EbookParseError(`${format.toUpperCase()} 解析失败：未找到可提取的正文。`);
    }
    if (Buffer.byteLength(parsed.content, 'utf8') > MAX_EBOOK_TEXT_BYTES) {
      throw new EbookParseError(`${format.toUpperCase()} 解析失败：正文超过 32MB 限制。`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof EbookParseError) throw error;
    throw new EbookParseError(`${format.toUpperCase()} 解析失败：文件损坏或格式不受支持。`, { cause: error });
  }
}

function elements($: CheerioAPI, localName: string) {
  return $('*').filter((_, node) => 'name' in node && node.name.split(':').pop() === localName);
}

function htmlToText(html: string): string {
  const $ = load(html);
  $('head, script, style, noscript, template').remove();
  $('br').replaceWith('\n');
  $('p, div, section, article, h1, h2, h3, h4, h5, h6, li, tr, blockquote, pre').prepend('\n').append('\n');
  $('td, th').append(' ');
  return $('body').text().replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean).join('\n');
}

function epubPath(base: string, reference: string): string {
  const decoded = decodeURIComponent(reference.split(/[?#]/)[0]);
  if (!decoded || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(decoded) || decoded.includes('\\')) {
    throw new Error('Invalid EPUB resource reference.');
  }
  const resolved = posix.normalize(posix.join(posix.dirname(base), decoded));
  if (resolved === '..' || resolved.startsWith('../')) throw new Error('EPUB resource escapes its container.');
  return resolved;
}

async function parseEpub(buffer: Buffer): Promise<ParsedEbook> {
  // Reuse bounded inflation checks before the ZIP library allocates resources.
  try { assertSafeZipArchive(buffer); }
  catch (error) {
    throw new EbookParseError('EPUB 解析失败：压缩文档安全校验失败。', { cause: error });
  }
  const { unzipSync } = await import('fflate');
  const files = unzipSync(new Uint8Array(buffer));
  const read = (name: string) => {
    if (!Object.hasOwn(files, name)) throw new Error('EPUB resource is missing.');
    const bytes = files[name];
    // EPUB XML/XHTML permits UTF-16 as well as UTF-8. Detect both BOM and the
    // XML opening '<' signature so valid Chinese chapters never become mojibake.
    const encoding = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
      ? 'utf-16le'
      : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)
        ? 'utf-16be'
        : 'utf-8';
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  };
  if (read('mimetype').trim() !== 'application/epub+zip') throw new Error('Invalid EPUB mimetype.');
  const container = load(read('META-INF/container.xml'), { xmlMode: true });
  const packageRef = elements(container, 'rootfile').filter((_, node) =>
    container(node).attr('media-type') === 'application/oebps-package+xml'
  ).first().attr('full-path');
  if (!packageRef) throw new Error('EPUB package is missing.');
  const packagePath = epubPath('', packageRef);
  const $ = load(read(packagePath), { xmlMode: true });
  const manifest = new Map(elements($, 'item').toArray().map(node => [$(node).attr('id'), node]));
  const chapterPaths = elements($, 'itemref').toArray().map(node => {
    const item = manifest.get($(node).attr('idref'));
    const href = item && $(item).attr('href');
    if (!href || !/^(?:application\/xhtml\+xml|text\/html)$/.test($(item).attr('media-type') ?? '')) {
      throw new Error('EPUB spine resource is invalid.');
    }
    return epubPath(packagePath, href);
  });
  if (Object.hasOwn(files, 'META-INF/encryption.xml')) {
    const encryption = load(read('META-INF/encryption.xml'), { xmlMode: true });
    const encryptedText = elements(encryption, 'CipherReference').toArray().some(node => {
      const reference = encryption(node).attr('URI');
      return reference && [packagePath, ...chapterPaths].includes(epubPath('', reference));
    });
    if (encryptedText) throw new EbookParseError('EPUB 解析失败：正文已加密（DRM），请上传无加密版本。');
  }
  return {
    content: chapterPaths.map(name => htmlToText(read(name))).filter(Boolean).join('\n\n'),
    title: elements($, 'title').first().text().trim() || undefined,
    author: elements($, 'creator').toArray().map(node => $(node).text().trim()).filter(Boolean).join(', ') || undefined,
    chapterCount: chapterPaths.length,
    parseMethod: 'epub',
  };
}

function prepareMobi(buffer: Buffer): Buffer {
  if (buffer.length < 94 || buffer.toString('ascii', 60, 68) !== 'BOOKMOBI') {
    throw new Error('Invalid MOBI container.');
  }
  const count = buffer.readUInt16BE(76);
  const tableEnd = 78 + count * 8;
  if (count < 2 || tableEnd > buffer.length) throw new Error('Invalid MOBI record table.');
  let previous = tableEnd - 1;
  for (let index = 0; index < count; index++) {
    const offset = buffer.readUInt32BE(78 + index * 8);
    if (offset <= previous || offset >= buffer.length) throw new Error('Invalid MOBI record bounds.');
    previous = offset;
  }
  const start = buffer.readUInt32BE(78);
  const end = buffer.readUInt32BE(86);
  if (end - start < 40 || buffer.toString('ascii', start + 16, start + 20) !== 'MOBI') {
    throw new Error('Invalid MOBI header.');
  }
  const headerSize = buffer.readUInt32BE(start + 20);
  if (headerSize < 232 || start + 16 + headerSize > end) throw new Error('Invalid MOBI header size.');
  if (buffer.readUInt16BE(start + 12) !== 0) {
    throw new EbookParseError('MOBI 解析失败：文件已加密（DRM），请上传无加密版本。');
  }
  const textLength = buffer.readUInt32BE(start + 4);
  const textRecords = buffer.readUInt16BE(start + 8);
  if (!textRecords || textRecords >= count) throw new Error('Invalid MOBI text records.');
  if (textLength > MAX_EBOOK_TEXT_BYTES || textRecords * 4096 > MAX_EBOOK_TEXT_BYTES) {
    throw new EbookParseError('MOBI 解析失败：正文超过 32MB 限制。');
  }

  const exthStart = start + 16 + headerSize;
  const flags = buffer.readUInt32BE(start + 128);
  if (!(flags & 0x40)) {
    // mobi-parser 0.4.6 assumes EXTH exists even though the format makes it optional.
    // Add an empty header in a private copy, keeping text and record indexes intact.
    const emptyExth = Buffer.alloc(12);
    emptyExth.write('EXTH');
    emptyExth.writeUInt32BE(12, 4);
    const normalized = Buffer.concat([buffer.subarray(0, exthStart), emptyExth, buffer.subarray(exthStart)]);
    normalized.writeUInt32BE(flags | 0x40, start + 128);
    for (let index = 1; index < count; index++) {
      normalized.writeUInt32BE(buffer.readUInt32BE(78 + index * 8) + 12, 78 + index * 8);
    }
    const titleOffset = buffer.readUInt32BE(start + 84);
    if (titleOffset >= 16 + headerSize) normalized.writeUInt32BE(titleOffset + 12, start + 84);
    return normalized;
  }

  if (exthStart + 12 > end || buffer.toString('ascii', exthStart, exthStart + 4) !== 'EXTH') {
    throw new Error('Invalid MOBI EXTH header.');
  }
  const exthSize = buffer.readUInt32BE(exthStart + 4);
  const exthCount = buffer.readUInt32BE(exthStart + 8);
  const exthEnd = exthStart + exthSize;
  if (exthSize < 12 || exthEnd > end || exthCount > (exthSize - 12) / 8) {
    throw new Error('Invalid MOBI EXTH bounds.');
  }
  let offset = exthStart + 12;
  const normalized = Buffer.from(buffer);
  for (let index = 0; index < exthCount; index++) {
    if (offset + 8 > exthEnd) throw new Error('Invalid MOBI EXTH record.');
    const size = buffer.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > exthEnd) throw new Error('Invalid MOBI EXTH record size.');
    if (buffer.readUInt32BE(offset) === 121) {
      if (size !== 12) throw new Error('Invalid MOBI compatibility boundary.');
      // In combined MOBI/KF8 books, keep the complete MOBI rendition rather than
      // letting the MOBI HTML reader accidentally switch to KF8's binary layout.
      normalized.writeUInt32BE(0xffffffff, offset + 8);
    }
    offset += size;
  }
  return normalized;
}

async function parseMobi(buffer: Buffer): Promise<ParsedEbook> {
  const normalized = prepareMobi(buffer);
  let parserPath: string;
  try { parserPath = resolveMobiParserPath(); }
  catch (error) {
    throw new EbookParseError('MOBI 解析失败：服务端解析组件未正确安装或加载。', { cause: error });
  }
  const parsed = await new Promise<{ chapters: string[]; title?: string; author: string[] }>((resolve, reject) => {
    const worker = new Worker(MOBI_PARSER_WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      // Native typed arrays are separately bounded by the worker's decompression
      // preflight. Heap limits alone cannot bound HUFF dictionary expansion.
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      workerData: {
        buffer: normalized,
        parserPath,
        maxTextBytes: MAX_EBOOK_TEXT_BYTES,
        tempDir: tmpdir(),
      },
    });
    let settled = false;
    const finish = (error?: Error, result?: { chapters: string[]; title?: string; author: string[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const timer = setTimeout(() => finish(new EbookParseError('MOBI 解析失败：解析超时或文件损坏。')), 10_000);
    worker.once('message', result => {
      if (result.ok) { finish(undefined, result); return; }
      const message = result.phase === 'parser-loading'
        ? 'MOBI 解析失败：服务端解析组件未正确安装或加载。'
        : result.phase === 'parsing' || result.phase === 'text-extraction'
          ? 'MOBI 解析失败：解析组件无法读取此文件的正文结构。'
          : 'MOBI 解析失败：压缩正文未通过校验或超出解析限制。';
      finish(new EbookParseError(message));
    });
    worker.once('error', () => finish(new EbookParseError('MOBI 解析失败：文件损坏或超出解析资源限制。')));
    worker.once('exit', () => finish(new EbookParseError('MOBI 解析失败：解析进程异常退出。')));
  });
  return {
    content: parsed.chapters.map(htmlToText).filter(Boolean).join('\n\n'),
    title: parsed.title || undefined,
    author: parsed.author.filter(Boolean).join(', ') || undefined,
    chapterCount: parsed.chapters.length,
    parseMethod: 'mobi',
  };
}
