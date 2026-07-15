import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { parseDocument } = await import('./document-parser.ts');

for (const extension of ['.docx', '.xlsx']) {
  test(`parseDocument rejects a high-ratio ${extension} archive before library parsing`, async () => {
    const result = await parseDocument(
      makeSingleEntryZip(Buffer.alloc(1_048_576), 'payload.xml'),
      `archive-bomb${extension}`
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /安全校验失败.*compression ratio/);
  });
}

function makeSingleEntryZip(data, name) {
  const filename = Buffer.from(name);
  const compressed = deflateRawSync(data);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(filename.length, 26);
  const local = Buffer.concat([localHeader, filename, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(filename.length, 28);
  centralHeader.writeUInt32LE(0, 42);
  const central = Buffer.concat([centralHeader, filename]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
