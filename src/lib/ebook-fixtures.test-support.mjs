import { zipSync } from 'fflate';

export function makeZip(files) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [name, name === 'mimetype'
      ? [Buffer.from(value), { level: 0 }]
      : Buffer.from(value)]))));
}

export function makeEpub(overrides = {}) {
  return makeZip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OPS/book.opf': `<package xmlns:dc="http://purl.org/dc/elements/1.1/">
      <metadata><dc:title>测试电子书</dc:title><dc:creator>测试作者</dc:creator></metadata>
      <manifest>
        <item id="second" href="chapters/second.xhtml" media-type="application/xhtml+xml"/>
        <item id="first" href="chapters/%E7%AC%AC%E4%B8%80.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="first"/><itemref idref="second"/></spine>
    </package>`,
    'OPS/chapters/第一.xhtml': '<html><head><title>隐藏标题</title><style>隐藏样式</style></head><body><h1>第一章</h1><p>中文正文 &amp; 内容。</p><p>第二段<br/>下一行</p><script>隐藏脚本</script></body></html>',
    'OPS/chapters/second.xhtml': '<html><body><h1>第二章</h1><p>后续正文。</p></body></html>',
    ...overrides,
  });
}

export function makeMobi({ compression = 1, encrypted = false, text = '<html><head></head><body><h1>中文书籍</h1><p>第一段 &amp; 内容。</p><mbp:pagebreak/><h2>下一章</h2><p>第二段。</p></body></html>' } = {}) {
  const raw = Buffer.from(text);
  // PalmDOC literal runs exercise decompression while preserving UTF-8 bytes.
  const payload = compression === 2
    ? Buffer.concat(Array.from({ length: Math.ceil(raw.length / 8) }, (_, index) => {
        const part = raw.subarray(index * 8, index * 8 + 8);
        return Buffer.concat([Buffer.from([part.length]), part]);
      }))
    : raw;
  const record = Buffer.alloc(16 + 232 + 12);
  record.writeUInt16BE(compression, 0);
  record.writeUInt32BE(raw.length, 4);
  record.writeUInt16BE(1, 8);
  record.writeUInt16BE(4096, 10);
  record.writeUInt16BE(encrypted ? 2 : 0, 12);
  record.write('MOBI', 16);
  record.writeUInt32BE(232, 20);
  record.writeUInt32BE(2, 24);
  record.writeUInt32BE(65001, 28);
  record.writeUInt32BE(6, 36);
  record.writeUInt32BE(0xffffffff, 108);
  record.writeUInt32BE(0x40, 128);
  record.writeUInt32BE(0xffffffff, 244);
  record.write('EXTH', 248);
  record.writeUInt32BE(12, 252);
  return makeMobiRecords([record, payload]);
}

function makeMobiRecords(records) {
  const header = Buffer.alloc(78 + records.length * 8 + 2);
  header.write('BOOKMOBI', 60);
  header.writeUInt16BE(records.length, 76);
  let offset = header.length;
  records.forEach((record, index) => {
    header.writeUInt32BE(offset, 78 + index * 8);
    offset += record.length;
  });
  return Buffer.concat([header, ...records]);
}

export function makeHuffMobi({ zeroWidth = false, recursive = false, dictionaryChain = 0 } = {}) {
  const base = makeMobi({ compression: 17480 });
  const header = Buffer.from(base.subarray(base.readUInt32BE(78), base.readUInt32BE(86)));
  const text = base.subarray(base.readUInt32BE(86));
  header.writeUInt32BE(2, 112);
  header.writeUInt32BE(2, 116);
  const huff = Buffer.alloc(24 + 1024 + 256);
  huff.write('HUFF');
  huff.writeUInt32BE(24, 4);
  huff.writeUInt32BE(24, 8);
  huff.writeUInt32BE(1048, 12);
  for (let i = 0; i < 256; i++) {
    huff.writeUInt32BE(zeroWidth ? 0x80 : recursive ? 0x81 : (255 << 8) | 0x88, 24 + i * 4);
  }
  const count = dictionaryChain || (recursive ? 1 : 256);
  const values = Array.from({ length: count }, (_, index) => {
    if (dictionaryChain && index === 0) return Buffer.from('<html><body>' + 'A'.repeat(4070) + '</body></html>');
    return Buffer.from([dictionaryChain ? 255 - (index - 1) : recursive ? 0 : 255 - index]);
  });
  const cdic = Buffer.alloc(16 + count * 2 + values.reduce((sum, value) => sum + value.length + 2, 0));
  cdic.write('CDIC');
  cdic.writeUInt32BE(16, 4);
  cdic.writeUInt32BE(count, 8);
  cdic.writeUInt32BE(Math.ceil(Math.log2(count)), 12);
  let offset = count * 2;
  for (let i = 0; i < count; i++) {
    cdic.writeUInt16BE(offset, 16 + i * 2);
    const compressed = recursive || (dictionaryChain && i > 0);
    cdic.writeUInt16BE((compressed ? 0 : 0x8000) | values[i].length, 16 + offset);
    values[i].copy(cdic, 16 + offset + 2);
    offset += 2 + values[i].length;
  }
  return makeMobiRecords([header,
    dictionaryChain ? Buffer.from([255 - (count - 1)]) : recursive || zeroWidth ? Buffer.from([0]) : text,
    huff, cdic]);
}
