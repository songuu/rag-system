import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

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

const {
  buildReadableTextFromPdfTextItems,
  normalizeParsedPdfText,
  parsePdfBuffer,
  resolveLiteParseOcrEnabled,
  resolvePdfParserProvider,
} = await import('./pdf-parser.ts');

test('PDF parser provider defaults to pdf-parse unless liteparse is explicitly requested', () => {
  assert.equal(resolvePdfParserProvider(undefined), 'pdf-parse');
  assert.equal(resolvePdfParserProvider(''), 'pdf-parse');
  assert.equal(resolvePdfParserProvider('pdf-parse'), 'pdf-parse');
  assert.equal(resolvePdfParserProvider('unknown'), 'pdf-parse');
  assert.equal(resolvePdfParserProvider('liteparse'), 'liteparse');
  assert.equal(resolvePdfParserProvider('liteparse-v2'), 'liteparse');
  assert.equal(resolvePdfParserProvider('  LiteParse  '), 'liteparse');
});

test('LiteParse OCR stays opt-in', () => {
  assert.equal(resolveLiteParseOcrEnabled(undefined), false);
  assert.equal(resolveLiteParseOcrEnabled('false'), false);
  assert.equal(resolveLiteParseOcrEnabled('0'), false);
  assert.equal(resolveLiteParseOcrEnabled('true'), true);
  assert.equal(resolveLiteParseOcrEnabled('1'), true);
  assert.equal(resolveLiteParseOcrEnabled('yes'), true);
  assert.equal(resolveLiteParseOcrEnabled('on'), true);
});

test('letter-spaced PDF text is normalized for RAG input', () => {
  assert.equal(
    normalizeParsedPdfText('A G E N T WAY / C O M P A R A T I V E  H A R N E S S  N O T E S'),
    'AGENT WAY / COMPARATIVE  HARNESS  NOTES'
  );
});

test('LiteParse text items are rebuilt without false spaces between letters', () => {
  const items = [];
  let x = 0;

  function addText(text, gap = 3) {
    x += gap;
    const width = text.length === 1 ? 8 : text.length * 8;
    items.push({ text, x, y: 10, width, height: 10 });
    x += width;
  }

  for (const char of 'AGENT') addText(char);
  addText('WAY', 18);
  addText('/', 14);
  for (const char of 'COMPARATIVE') addText(char, char === 'C' ? 14 : 3);
  for (const char of 'HARNESS') addText(char, char === 'H' ? 18 : 3);
  for (const char of 'NOTES') addText(char, char === 'N' ? 18 : 3);

  assert.equal(
    buildReadableTextFromPdfTextItems(items),
    'AGENT WAY / COMPARATIVE HARNESS NOTES'
  );
});

test('PDF parse errors include provider and filename context', async () => {
  await assert.rejects(
    () => parsePdfBuffer(Buffer.from('not a pdf'), 'bad-upload.pdf', { provider: 'pdf-parse' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /pdf-parse/);
      assert.match(error.message, /bad-upload\.pdf/);
      return true;
    }
  );
});

test('LiteParse provider is loadable and keeps error context', async () => {
  await assert.rejects(
    () => parsePdfBuffer(Buffer.from('not a pdf'), 'bad-liteparse.pdf', { provider: 'liteparse' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /liteparse/);
      assert.match(error.message, /bad-liteparse\.pdf/);
      return true;
    }
  );
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
