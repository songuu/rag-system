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

const { MAIC_SUPPORTED_EXTENSIONS, isMaicSupportedFile } = await import('./upload-validation.ts');

test('MAIC_SUPPORTED_EXTENSIONS 包含 PPTX 和 document-parser 通用类型', () => {
  assert.ok(MAIC_SUPPORTED_EXTENSIONS.includes('.pptx'), 'should include .pptx');
  assert.ok(MAIC_SUPPORTED_EXTENSIONS.includes('.pdf'), 'should include .pdf');
  assert.ok(MAIC_SUPPORTED_EXTENSIONS.includes('.md'), 'should include .md');
  assert.ok(MAIC_SUPPORTED_EXTENSIONS.includes('.txt'), 'should include .txt');
  assert.ok(MAIC_SUPPORTED_EXTENSIONS.includes('.docx'), 'should include .docx');
});

test('isMaicSupportedFile 接受支持的扩展名（含 PPTX）', () => {
  assert.equal(isMaicSupportedFile('lesson.pptx'), true);
  assert.equal(isMaicSupportedFile('Lesson.PPTX'), true, 'extension match is case-insensitive');
  assert.equal(isMaicSupportedFile('notes.pdf'), true);
  assert.equal(isMaicSupportedFile('outline.md'), true);
  assert.equal(isMaicSupportedFile('raw.txt'), true);
});

test('isMaicSupportedFile 拒绝不支持的扩展名', () => {
  assert.equal(isMaicSupportedFile('image.png'), false);
  assert.equal(isMaicSupportedFile('video.mp4'), false);
  assert.equal(isMaicSupportedFile('archive.zip'), false);
  assert.equal(isMaicSupportedFile('binary.bin'), false);
});

test('isMaicSupportedFile 拒绝无扩展名输入', () => {
  assert.equal(isMaicSupportedFile('README'), false);
  assert.equal(isMaicSupportedFile(''), false);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
