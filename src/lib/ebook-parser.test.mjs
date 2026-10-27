import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { makeEpub, makeMobi, makeHuffMobi, makeZip } from './ebook-fixtures.test-support.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { parseDocument, isSupportedFile } = await import('./document-parser.ts');
const { loadDocument, splitDocument } = await import('./document-pipeline.ts');

test('EPUB extracts Chinese text in spine order, preserving paragraph boundaries and metadata', async () => {
  const result = await parseDocument(makeEpub(), '测试.EPUB');
  assert.equal(result.success, true, result.error);
  assert.equal(isSupportedFile('测试.EPUB'), true);
  assert.equal(result.document.metadata.extension, '.epub');
  assert.equal(result.document.metadata.parseMethod, 'epub');
  assert.match(result.document.content, /第一章\n中文正文 & 内容。\n第二段\n下一行\n+第二章\n后续正文。/);
  assert.doesNotMatch(result.document.content, /隐藏|<[^>]+>/);
  const loaded = await loadDocument(makeEpub(), { filename: '测试.EPUB' });
  assert.equal(loaded.metadata.type, 'epub');
  assert.equal(loaded.metadata.title, '测试电子书');
  assert.equal(loaded.metadata.author, '测试作者');
  assert.equal(loaded.content, result.document.content);
  const chunks = await splitDocument(loaded, { chunkSize: 100, chunkOverlap: 10 });
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].metadata.type, 'epub');
});

for (const compression of [1, 2]) {
  test(`MOBI compression ${compression} extracts Chinese正文 through both parser entry points`, async () => {
    const buffer = makeMobi({ compression });
    const result = await parseDocument(buffer, '测试.MOBI');
    assert.equal(result.success, true, result.error);
    assert.equal(isSupportedFile('测试.MOBI'), true);
    assert.match(result.document.content, /中文书籍\n第一段 & 内容。\n+下一章\n第二段。/);
    assert.doesNotMatch(result.document.content, /<[^>]+>|BOOKMOBI/);
    const loaded = await loadDocument(buffer, { filename: '测试.MOBI' });
    assert.equal(loaded.metadata.type, 'mobi');
    assert.equal(loaded.content, result.document.content);
  });
}

test('damaged and encrypted ebooks fail explicitly instead of becoming binary text', async () => {
  for (const filename of ['bad.epub', 'bad.mobi']) {
    const result = await parseDocument(Buffer.from('not an ebook'), filename);
    assert.equal(result.success, false);
    assert.match(result.error, /解析失败/);
    await assert.rejects(loadDocument(Buffer.from('not an ebook'), { filename }), /解析失败/);
  }
  const encrypted = await parseDocument(makeMobi({ encrypted: true }), 'protected.mobi');
  assert.equal(encrypted.success, false);
  assert.match(encrypted.error, /加密|DRM/);
  const epub = await parseDocument(makeEpub({
    'META-INF/encryption.xml': '<encryption><EncryptedData><EncryptionMethod Algorithm="urn:drm"/><CipherData><CipherReference URI="OPS/chapters/第一.xhtml"/></CipherData></EncryptedData></encryption>',
  }), 'protected.epub');
  assert.equal(epub.success, false);
  assert.match(epub.error, /加密|DRM/);
});

test('MOBI files without optional EXTH metadata still extract正文', async () => {
  const buffer = makeMobi();
  buffer.writeUInt32BE(0, buffer.readUInt32BE(78) + 128);
  const result = await parseDocument(buffer, 'legacy.mobi');
  assert.equal(result.success, true, result.error);
  assert.match(result.document.content, /中文书籍/);
  assert.equal(buffer.readUInt32BE(buffer.readUInt32BE(78) + 128), 0, 'input bytes stay unchanged');
});

test('EPUB rejects compression bombs and missing spine resources', async () => {
  const bomb = await parseDocument(makeZip({ payload: Buffer.alloc(1_048_576) }), 'bomb.epub');
  assert.equal(bomb.success, false);
  assert.match(bomb.error, /安全校验失败/);
  const missing = await parseDocument(makeEpub({ 'OPS/chapters/第一.xhtml': undefined }), 'missing.epub');
  assert.equal(missing.success, false);
});

for (const endian of ['LE', 'BE']) {
  test(`EPUB decodes UTF-16${endian} package and Chinese chapter resources`, async () => {
    const encode = text => {
      const bytes = Buffer.from(`\ufeff${text}`, 'utf16le');
      return endian === 'BE' ? bytes.swap16() : bytes;
    };
    const { unzipSync } = await import('fflate');
    const files = unzipSync(makeEpub());
    const overrides = Object.fromEntries(Object.entries(files)
      .filter(([name]) => /\.(?:xml|opf|xhtml)$/.test(name))
      .map(([name, bytes]) => [name, encode(Buffer.from(bytes).toString('utf8'))]));
    const result = await parseDocument(makeEpub(overrides), `unicode-${endian}.epub`);
    assert.equal(result.success, true, result.error);
    assert.match(result.document.content, /第一章\n中文正文 & 内容。/);
    assert.doesNotMatch(result.document.content, /�|<[^>]+>/);
  });
}

test('HUFF/CDIC MOBI extracts Chinese text after bounded dictionary preflight', async () => {
  const result = await parseDocument(makeHuffMobi(), 'compressed.mobi');
  assert.equal(result.success, true, result.error);
  assert.match(result.document.content, /中文书籍\n第一段 & 内容。/);
});

test('malformed HUFF codes and recursive dictionaries reject without blocking the event loop', { timeout: 3000 }, async () => {
  let ticked = false;
  const tick = setTimeout(() => { ticked = true; }, 0);
  try {
    for (const options of [{ zeroWidth: true }, { recursive: true }]) {
      const result = await parseDocument(makeHuffMobi(options), 'malformed.mobi');
      assert.equal(result.success, false);
      assert.match(result.error, /压缩正文损坏|解析限制/);
    }
    assert.equal(ticked, true);
  } finally { clearTimeout(tick); }
});

test('PalmDOC actual expansion cannot exceed its record budget despite a small declared text length', async () => {
  const base = makeMobi();
  const header = Buffer.from(base.subarray(0, base.readUInt32BE(86)));
  const start = header.readUInt32BE(78);
  header.writeUInt16BE(2, start);
  header.writeUInt32BE(1, start + 4);
  const payload = Buffer.concat([
    Buffer.from('<html><body><p>A'),
    Buffer.from(Array.from({ length: 500 }, () => [0x80, 0x0f]).flat()),
    Buffer.from('</p></body></html>'),
  ]);
  const result = await parseDocument(Buffer.concat([header, payload]), 'expansion.mobi');
  assert.equal(result.success, false);
  assert.match(result.error, /解析限制/);
});

test('HUFF intermediate phrase caches are bounded even when final text fits the budget', { timeout: 3000 }, async () => {
  const { MOBI_PARSER_WORKER_SOURCE } = await import('./mobi-parser-worker.ts');
  const worker = new Worker(MOBI_PARSER_WORKER_SOURCE, {
    eval: true, execArgv: [],
    workerData: {
      buffer: makeHuffMobi({ dictionaryChain: 32 }),
      maxTextBytes: 8192,
      tempDir: tmpdir(),
      parserPath: createRequire(import.meta.url).resolve('@lingo-reader/mobi-parser').replace(/\.js$/, '.mjs'),
    },
  });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    assert.equal(result.ok, false, '4096-byte text cannot populate 32 copies in the dictionary cache');
  } finally { await worker.terminate(); }
});

test('MOBI worker reports missing runtime dependency as a loading failure', { timeout: 3000 }, async () => {
  const { MOBI_PARSER_WORKER_SOURCE } = await import('./mobi-parser-worker.ts');
  const worker = new Worker(MOBI_PARSER_WORKER_SOURCE, {
    eval: true, execArgv: [],
    workerData: {
      buffer: makeMobi(), maxTextBytes: 32 * 1024 * 1024,
      parserPath: '/missing-mobi-runtime/index.node.mjs', tempDir: tmpdir(),
    },
  });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'parser-loading');
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'phase']);
  } finally { await worker.terminate(); }
});
