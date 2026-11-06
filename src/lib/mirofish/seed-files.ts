import { REQUEST_LIMITS } from '../security/request-validation';
import { MIROFISH_SEED_EXTENSIONS, MIROFISH_SEED_MAX_FILE_BYTES, MIROFISH_SEED_MAX_FILES, MIROFISH_SEED_MAX_TOTAL_BYTES, type MiroFishSeedFileInfo } from './seed-file-contract';

export class MiroFishSeedFileError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.name = 'MiroFishSeedFileError'; this.code = code; this.status = status; }
}
function fail(code: string, message: string, status = 400): never { throw new MiroFishSeedFileError(code, message, status); }
interface SeedFile { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }
interface SeedDependencies { parsePdf?: (buffer: Buffer, filename: string) => Promise<{ text: string; pages: number }> }

function safeFilename(value: string): string {
  return (value.split(/[\\/]/).at(-1) || 'seed').normalize('NFKC').replace(/[^\w\s\u4e00-\u9fff.-]/g, '').replace(/\s+/g, '_').slice(0, 120);
}
function decodeSeedText(data: Uint8Array): { text: string; encoding: string } {
  const bom = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : undefined;
  for (const encoding of bom ? [bom] : ['utf-8', 'gb18030']) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(data).trim();
      if (text.includes('\u0000')) fail('MIROFISH_SEED_INVALID_FILE', '文本文件包含二进制内容');
      return { text, encoding };
    } catch (error) { if (error instanceof MiroFishSeedFileError) throw error; }
  }
  return fail('MIROFISH_SEED_ENCODING', '无法解码文本文件，请使用 UTF-8、UTF-16 或 GB18030 编码');
}

export async function parseMiroFishSeedFiles(files: SeedFile[], dependencies: SeedDependencies = {}) {
  if (files.length < 1 || files.length > MIROFISH_SEED_MAX_FILES) fail('MIROFISH_SEED_FILE_COUNT', `请选择 1–${MIROFISH_SEED_MAX_FILES} 个 PDF、Markdown 或 TXT 文件`);
  let totalBytes = 0;
  for (const file of files) {
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    if (!MIROFISH_SEED_EXTENSIONS.some(item => item === extension)) fail('MIROFISH_SEED_INVALID_FILE', '仅支持 PDF、Markdown 和 TXT 文件');
    if (!Number.isSafeInteger(file.size) || file.size <= 0) fail('MIROFISH_SEED_EMPTY_FILE', '文件为空或大小无效');
    totalBytes += file.size;
    if (file.size > MIROFISH_SEED_MAX_FILE_BYTES || totalBytes > MIROFISH_SEED_MAX_TOTAL_BYTES) fail('MIROFISH_SEED_FILE_LIMIT', '文件总大小不能超过 50MB', 413);
    const allowed = extension === 'pdf' ? ['', 'application/pdf', 'application/octet-stream'] : ['', 'text/plain', 'text/markdown', 'text/x-markdown', 'application/octet-stream'];
    if (!allowed.includes(file.type.toLowerCase())) fail('MIROFISH_SEED_INVALID_FILE', '文件类型与扩展名不一致');
  }
  const texts: string[] = [];
  const info: MiroFishSeedFileInfo[] = [];
  let characters = 0;
  for (const file of files) {
    const name = safeFilename(file.name);
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.byteLength !== file.size) fail('MIROFISH_SEED_INVALID_FILE', '文件大小与内容不一致');
    let text: string;
    const entry: MiroFishSeedFileInfo = { filename: name, size: file.size };
    if (file.name.toLowerCase().endsWith('.pdf')) {
      if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') fail('MIROFISH_SEED_INVALID_FILE', 'PDF 文件格式无效');
      const parsePdf = dependencies.parsePdf ?? (await import('../pdf-parser')).parsePdfBuffer;
      try { const parsed = await parsePdf(buffer, name); text = parsed.text.trim(); entry.pages = parsed.pages; }
      catch { fail('MIROFISH_SEED_PARSE_FAILED', '无法解析 PDF 文件，请检查文件内容', 422); }
    } else { const decoded = decodeSeedText(buffer); text = decoded.text; entry.encoding = decoded.encoding; }
    if (!text) fail('MIROFISH_SEED_EMPTY_TEXT', '文件未包含可提取的文本，扫描 PDF 需要先进行 OCR', 422);
    characters += text.length;
    if (characters > REQUEST_LIMITS.textCharacters) fail('MIROFISH_SEED_TEXT_LIMIT', '提取文本超过 200 万字符，请分批处理', 422);
    texts.push(text); info.push(entry);
  }
  const combined = texts.length === 1 ? texts[0] : texts.map((text, index) => `=== 文档 ${index + 1}: ${info[index].filename} ===\n${text}`).join('\n\n');
  if (combined.length > REQUEST_LIMITS.textCharacters) fail('MIROFISH_SEED_TEXT_LIMIT', '提取文本超过 200 万字符，请分批处理', 422);
  return { text: combined, texts, files: info, filename: info.map(file => file.filename).join(', '),
    pages: info.reduce((sum, file) => sum + (file.pages ?? 0), 0), size: totalBytes };
}

/** Bound actual multipart bytes as well as the optional declared length. */
export async function readMiroFishSeedForm(request: Request): Promise<FormData> {
  const maxBytes = MIROFISH_SEED_MAX_TOTAL_BYTES + 1024 * 1024;
  const type = request.headers.get('content-type') || '';
  if (!/^multipart\/form-data\s*;/i.test(type)) fail('MIROFISH_SEED_FORM_INVALID', '请使用文件上传表单');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) fail('MIROFISH_SEED_FORM_INVALID', '文件上传长度无效');
  if (declared !== null && Number(declared) > maxBytes) fail('MIROFISH_SEED_FILE_LIMIT', '文件总大小不能超过 50MB', 413);
  if (!request.body) fail('MIROFISH_SEED_FORM_INVALID', '文件上传内容为空');
  const reader = request.body.getReader();
  let bytes = 0;
  let sizeError: MiroFishSeedFileError | undefined;
  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) { controller.close(); return; }
        bytes += item.value.byteLength;
        if (bytes > maxBytes) {
          sizeError = new MiroFishSeedFileError('MIROFISH_SEED_FILE_LIMIT', '文件总大小不能超过 50MB', 413);
          await reader.cancel('seed upload byte limit'); controller.error(sizeError); return;
        }
        controller.enqueue(item.value);
      } catch (error) { controller.error(error); }
    }, cancel(reason) { return reader.cancel(reason); },
  });
  try { return await new Response(limited, { headers: { 'content-type': type } }).formData(); }
  catch { throw sizeError ?? new MiroFishSeedFileError('MIROFISH_SEED_FORM_INVALID', '文件上传表单无效'); }
  finally { reader.releaseLock(); }
}
