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

const { extractPptxAnimationsFromSlideXml } = await import('./pptx-parser.ts');
const { buildDefaultSlideAnimations, getSlidePointElementId } = await import('./slide-animation.ts');

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

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
