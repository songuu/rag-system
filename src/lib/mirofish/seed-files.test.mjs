import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { parseMiroFishSeedFiles, readMiroFishSeedForm } = await import('./seed-files.ts');

test('seed upload accepts multiple Markdown/text files and preserves document boundaries', async () => {
  const result = await parseMiroFishSeedFiles([
    new File(['# Heading\nFirst fact'], 'report.md', { type: 'text/markdown' }),
    new File(['Second fact'], 'notes.txt', { type: 'text/plain' }),
  ]);
  assert.deepEqual(result.texts, ['# Heading\nFirst fact', 'Second fact']);
  assert.match(result.text, /report\.md[\s\S]*First fact[\s\S]*notes\.txt[\s\S]*Second fact/);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].encoding, 'utf-8');
});

test('seed text decodes common BOM and Chinese legacy encodings without replacement loss', async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文事实', 'utf16le')]);
  const result = await parseMiroFishSeedFiles([
    new File([utf16], 'utf16.txt'), new File([new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])], 'gbk.txt'),
  ]);
  assert.deepEqual(result.texts, ['中文事实', '中文']);
  assert.deepEqual(result.files.map(file => file.encoding), ['utf-16le', 'gb18030']);
});

test('PDF seed compatibility keeps pages and sanitized filename without accepting spoofed binaries', async () => {
  let parses = 0;
  const parsePdf = async () => { parses++; return { text: 'PDF fact', pages: 3 }; };
  const result = await parseMiroFishSeedFiles([new File(['%PDF-stub'], '../private.pdf', { type: 'application/pdf' })], { parsePdf });
  assert.equal(result.text, 'PDF fact');
  assert.equal(result.pages, 3);
  assert.equal(result.filename, 'private.pdf');
  await assert.rejects(parseMiroFishSeedFiles([new File(['not pdf'], 'spoof.pdf', { type: 'application/pdf' })], { parsePdf }), error => error.code === 'MIROFISH_SEED_INVALID_FILE');
  assert.equal(parses, 1);
});

test('seed validation rejects missing, empty, unsupported and over-budget data before parsing', async () => {
  const bad = [[], [new File([], 'empty.txt')], [new File(['abc'], 'script.exe')], [new File(['a\0b'], 'binary.txt')]];
  for (const files of bad) await assert.rejects(parseMiroFishSeedFiles(files));
  await assert.rejects(parseMiroFishSeedFiles([{ name: 'large.pdf', type: 'application/pdf', size: 50 * 1024 * 1024 + 1,
    async arrayBuffer() { throw new Error('must reject before reading'); } }]), error => error.status === 413);
  await assert.rejects(parseMiroFishSeedFiles([new File(['x'.repeat(2_000_001)], 'huge.txt')]), error => error.code === 'MIROFISH_SEED_TEXT_LIMIT');
});

test('multipart ingestion enforces declared byte limits and preserves repeated files fields', async () => {
  let reads = 0;
  const request = new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=abc', 'content-length': String(60 * 1024 * 1024) },
    body: new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array([1])); } }), duplex: 'half' });
  await assert.rejects(readMiroFishSeedForm(request), error => error.status === 413);
  await request.body.cancel();
  assert(reads <= 1);
  const form = new FormData(); form.append('files', new File(['a'], 'a.txt')); form.append('files', new File(['b'], 'b.md'));
  const decoded = await readMiroFishSeedForm(new Request('http://localhost/upload', { method: 'POST', body: form }));
  assert.equal(decoded.getAll('files').length, 2);
});
