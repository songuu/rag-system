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

const { extractPptxAnimationsFromSlideXml, parsePptxSlides } = await import('./pptx-parser.ts');
const {
  buildDefaultSlideAnimations,
  getSlidePointElementId,
  shouldHoldFocus,
} = await import('./slide-animation.ts');

test('PPTX timing XML is converted to OpenMAIC-style PPTAnimation metadata', () => {
  const xml = `
    <p:sld>
      <p:timing>
        <p:tnLst>
          <p:par>
            <p:cTn nodeType="clickEffect">
              <p:childTnLst>
                <p:animEffect transition="in" filter="fade">
                  <p:cBhvr>
                    <p:cTn dur="700"/>
                    <p:tgtEl><p:spTgt spid="4"/></p:tgtEl>
                  </p:cBhvr>
                </p:animEffect>
              </p:childTnLst>
            </p:cTn>
          </p:par>
        </p:tnLst>
      </p:timing>
    </p:sld>
  `;

  const animations = extractPptxAnimationsFromSlideXml(xml, 2);

  assert.deepEqual(animations, [
    {
      id: 'pptx_anim_2_0',
      elId: 'pptx-sp-4',
      effect: 'fade',
      type: 'in',
      duration: 700,
      trigger: 'click',
    },
  ]);
});

test('default slide animations expose stable local slide element ids', () => {
  const animations = buildDefaultSlideAnimations(3, 2);

  assert.equal(animations[0].elId, 'slide-3-description');
  assert.equal(animations[1].elId, getSlidePointElementId(3, 0));
  assert.equal(animations[2].type, 'attention');
});

test('spotlight focus defaults to a persistent hover during playback', () => {
  assert.equal(
    shouldHoldFocus({
      id: 'focus_1',
      type: 'spotlight',
      title: '聚光重点',
    }),
    true
  );
  assert.equal(
    shouldHoldFocus({
      id: 'focus_2',
      type: 'spotlight',
      title: '短暂强调',
      focusHold: 'duration',
    }),
    false
  );
});

test('PPTX parsing rejects high-ratio archives before slide extraction', () => {
  assert.throws(
    () => parsePptxSlides(
      makeSingleEntryZip(Buffer.alloc(1_048_576), 'ppt/slides/slide1.xml'),
      'archive-bomb.pptx'
    ),
    /compression ratio/
  );
});

test('PPTX parsing rejects forged decompressed-size declarations', () => {
  assert.throws(
    () => parsePptxSlides(
      makeSingleEntryZip(
        Buffer.from('<p:sld><a:t>oversized output</a:t></p:sld>'.repeat(32)),
        'ppt/slides/slide1.xml',
        8
      ),
      'forged-size.pptx'
    ),
    /decompressed output|decompressed size/
  );
});

function makeSingleEntryZip(data, name, declaredUncompressed = data.length) {
  const filename = Buffer.from(name);
  const compressed = deflateRawSync(data);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(declaredUncompressed, 22);
  localHeader.writeUInt16LE(filename.length, 26);
  const local = Buffer.concat([localHeader, filename, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(declaredUncompressed, 24);
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
