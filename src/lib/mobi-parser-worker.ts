// Keep this self-contained so Next can bundle the worker source without relying
// on a source .ts file being present in the standalone server.
export const MOBI_PARSER_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const input = Buffer.from(workerData.buffer);
const first = input.readUInt32BE(78);
const count = input.readUInt16BE(76);
const textRecords = input.readUInt16BE(first + 8);
const compression = input.readUInt16BE(first);
let phase = 'validation';
const offsets = Array.from({length: count}, (_, i) => input.readUInt32BE(78 + i * 8));
const record = index => {
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('Invalid record');
  return input.subarray(offsets[index], offsets[index + 1] ?? input.length);
};
const fail = () => { throw new Error('Invalid or oversized compressed MOBI text'); };
const bounded = size => { if (size > 4096) fail(); return size; };
function textRecord(index) {
  let data = record(index);
  const flags = input.readUInt32BE(first + 240);
  for (let bits = flags >>> 1; bits; bits >>>= 1) {
    if (!(bits & 1)) continue;
    let size = 0;
    for (const byte of data.subarray(-4)) {
      if (byte & 128) size = 0;
      size = (size << 7) | (byte & 127);
    }
    if (!size || size > data.length) fail();
    data = data.subarray(0, data.length - size);
  }
  if (flags & 1) {
    const size = (data[data.length - 1] & 3) + 1;
    if (size > data.length) fail();
    data = data.subarray(0, data.length - size);
  }
  return data;
}
function palmSize(data) {
  let size = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte > 0 && byte <= 8) {
      if (i + byte >= data.length) fail();
      size += byte;
      i += byte;
    } else if (byte >= 128 && byte <= 191) {
      if (++i >= data.length) fail();
      const pair = (byte << 8) | data[i];
      const distance = (pair & 16383) >>> 3;
      if (!distance || distance > size) fail();
      size += (pair & 7) + 3;
    } else size += byte >= 192 ? 2 : 1;
    bounded(size);
  }
  return size;
}
function huffCounter() {
  const start = input.readUInt32BE(first + 112);
  const num = input.readUInt32BE(first + 116);
  if (num < 2 || start <= textRecords || start + num > count) fail();
  const huff = record(start);
  if (huff.length < 24 || huff.toString('ascii', 0, 4) !== 'HUFF') fail();
  const offset1 = huff.readUInt32BE(8), offset2 = huff.readUInt32BE(12);
  if (offset1 + 1024 > huff.length || offset2 + 256 > huff.length) fail();
  const table1 = Array.from({length: 256}, (_, i) => huff.readUInt32BE(offset1 + i * 4));
  if (table1.some(value => !(value & 31))) fail();
  const table2 = [[0, 0], ...Array.from({length: 32}, (_, i) =>
    [huff.readUInt32BE(offset2 + i * 8), huff.readUInt32BE(offset2 + i * 8 + 4)])];
  const dictionary = [];
  let dictionaryBytes = 0;
  for (let i = 1; i < num; i++) {
    const cdic = record(start + i);
    if (cdic.length < 16 || cdic.toString('ascii', 0, 4) !== 'CDIC') fail();
    const header = cdic.readUInt32BE(4), entries = cdic.readUInt32BE(8), bits = cdic.readUInt32BE(12);
    if (header < 16 || header > cdic.length || bits > 16 || entries < dictionary.length) fail();
    const n = Math.min(2 ** bits, entries - dictionary.length);
    if (header + n * 2 > cdic.length) fail();
    for (let j = 0; j < n; j++) {
      const offset = header + cdic.readUInt16BE(header + j * 2);
      if (offset < header + n * 2 || offset + 2 > cdic.length) fail();
      const value = cdic.readUInt16BE(offset), end = offset + 2 + (value & 32767);
      if (end > cdic.length) fail();
      // Duplicate offsets still cause separate native ArrayBuffer copies in the
      // library. Budget all phrases before it materializes the dictionary.
      dictionaryBytes += value & 32767;
      if (dictionaryBytes > workerData.maxTextBytes) fail();
      dictionary.push({data: cdic.subarray(offset + 2, end), size: value & 32768 ? value & 32767 : undefined});
    }
  }
  const visiting = new Set();
  let decodedDictionaryBytes = 0;
  function decodedSize(data, depth = 0) {
    if (depth > 64) fail();
    let size = 0;
    for (let bit = 0; bit < data.length * 8;) {
      let window = 0n;
      for (let j = 0; j < 5; j++) window = (window << 8n) | BigInt(data[(bit >>> 3) + j] ?? 0);
      const value = Number((window >> BigInt(8 - (bit & 7))) & 0xffffffffn);
      const lookup = table1[value >>> 24];
      let length = lookup & 31, max = lookup >>> 8;
      if (!(lookup & 128)) {
        while (length <= 32 && (value >>> (32 - length)) < table2[length][0]) length++;
        if (length > 32) fail();
        max = table2[length][1];
      }
      bit += length;
      if (bit > data.length * 8) break;
      const index = max - (value >>> (32 - length));
      const entry = dictionary[index];
      if (!entry || visiting.has(index)) fail();
      if (entry.size === undefined) {
        visiting.add(index);
        entry.size = decodedSize(entry.data, depth + 1);
        visiting.delete(index);
        // The library memoizes every expanded phrase, including intermediate
        // phrases in recursive chains. Bound those native caches separately.
        decodedDictionaryBytes += entry.size;
        if (decodedDictionaryBytes > workerData.maxTextBytes) fail();
      }
      size = bounded(size + entry.size);
    }
    return size;
  }
  return decodedSize;
}
async function parse() {
  const huffSize = compression === 17480 ? huffCounter() : undefined;
  if (![1, 2, 17480].includes(compression)) fail();
  let total = 0;
  for (let i = 1; i <= textRecords; i++) {
    const data = textRecord(i);
    const size = huffSize ? huffSize(data) : compression === 2 ? palmSize(data) : bounded(data.length);
    total += size;
    if (total > workerData.maxTextBytes) fail();
  }
  phase = 'parser-loading';
  const { initMobiFile } = await import(require('node:url').pathToFileURL(workerData.parserPath).href);
  phase = 'parsing';
  const book = await initMobiFile(new Uint8Array(input), workerData.tempDir);
  try {
    phase = 'text-extraction';
    const chapters = book.getSpine().map(chapter => chapter.text);
    if (chapters.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > workerData.maxTextBytes) fail();
    const metadata = book.getMetadata();
    parentPort.postMessage({ok: true, chapters, title: metadata.title, author: metadata.author});
  } finally { book.destroy(); }
}
parse().catch(() => parentPort.postMessage({ok: false, phase}));
`;
