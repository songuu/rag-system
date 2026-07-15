import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { assertSafeZipArchive } = await import('./zip-safety.ts');

test('accepts a bounded single-entry ZIP central directory', () => {
  assert.doesNotThrow(() => assertSafeZipArchive(makeZip([
    { data: Buffer.from('bounded archive entry') },
  ])));
});

test('rejects compression bombs, oversized totals, encryption, and exotic methods', () => {
  assert.throws(
    () => assertSafeZipArchive(makeZip([{ data: Buffer.alloc(10_000) }])),
    /compression ratio/
  );
  assert.throws(
    () => assertSafeZipArchive(
      makeZip([
        { data: Buffer.alloc(700, 1) },
        { data: Buffer.alloc(700, 2) },
      ]),
      { maxTotalUncompressedBytes: 1_000, maxCompressionRatio: 1_000 }
    ),
    /total uncompressed/
  );
  assert.throws(
    () => assertSafeZipArchive(makeZip([{ flags: 1, data: Buffer.from('encrypted') }])),
    /Encrypted/
  );
  assert.throws(
    () => assertSafeZipArchive(makeZip([{ method: 99, data: Buffer.from('exotic') }])),
    /compression method/
  );
});

test('rejects forged output sizes before parser allocation', () => {
  assert.throws(
    () => assertSafeZipArchive(
      makeZip([{ data: Buffer.alloc(2_048, 7), declaredUncompressed: 8 }]),
      { maxCompressionRatio: 1_000 }
    ),
    /decompressed output|decompressed size/
  );
});

test('rejects ZIP64 sentinels, excessive entry counts, and trailing ambiguity', () => {
  const zip64 = makeZip([{ data: Buffer.from('zip64') }]);
  zip64.writeUInt16LE(0xffff, zip64.length - 14);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  assert.throws(() => assertSafeZipArchive(zip64), /ZIP64/);

  assert.throws(
    () => assertSafeZipArchive(makeZip([{ data: Buffer.from('entry') }]), { maxEntries: 0 }),
    /positive integer/
  );
  assert.throws(
    () => assertSafeZipArchive(
      makeZip([{ data: Buffer.from('one') }, { data: Buffer.from('two') }]),
      { maxEntries: 1 }
    ),
    /entry count/
  );

  const trailing = Buffer.concat([
    makeZip([{ data: Buffer.from('trailing') }]),
    Buffer.from([0]),
  ]);
  assert.throws(() => assertSafeZipArchive(trailing), /missing|ambiguous/);
});

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  entries.forEach((entry, index) => {
    const filename = Buffer.from(`entry-${index}.xml`);
    const method = entry.method ?? 8;
    const data = entry.data ?? Buffer.from(`entry-${index}`);
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const declaredCompressed = entry.declaredCompressed ?? compressed.length;
    const declaredUncompressed = entry.declaredUncompressed ?? data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(entry.flags ?? 0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(declaredCompressed, 18);
    localHeader.writeUInt32LE(declaredUncompressed, 22);
    localHeader.writeUInt16LE(filename.length, 26);
    const localPart = Buffer.concat([localHeader, filename, compressed]);
    localParts.push(localPart);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(entry.flags ?? 0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(declaredCompressed, 20);
    centralHeader.writeUInt32LE(declaredUncompressed, 24);
    centralHeader.writeUInt16LE(filename.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(Buffer.concat([centralHeader, filename]));
    localOffset += localPart.length;
  });

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}
