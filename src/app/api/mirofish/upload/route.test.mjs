import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier.startsWith('@/')) return next(pathToFileURL(path.resolve('src', `${specifier.slice(2)}.ts`)).href, context);
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
process.env.NODE_ENV = 'test';
const { POST } = await import('./route.ts');

test('upload endpoint accepts repeated seeds and preserves original PDF-compatible response fields', async () => {
  const form = new FormData();
  form.append('files', new File(['# Evidence\nOne'], 'one.md', { type: 'text/markdown' }));
  form.append('files', new File(['Second document'], 'two.txt', { type: 'text/plain' }));
  const response = await POST(new Request('http://localhost/api/mirofish/upload', { method: 'POST', body: form }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.files.length, 2);
  assert.equal(body.texts.length, 2);
  assert.match(body.text, /One/);
  assert.match(body.text, /Second document/);
  assert.equal(typeof body.filename, 'string');
  assert.equal(typeof body.size, 'number');
});

test('upload endpoint rejects unsupported files and declared oversized multipart bodies', async () => {
  const form = new FormData();
  form.append('file', new File(['private binary'], 'payload.exe'));
  const invalid = await POST(new Request('http://localhost/api/mirofish/upload', { method: 'POST', body: form }));
  assert.equal(invalid.status, 400);
  const oversized = await POST(new Request('http://localhost/api/mirofish/upload', { method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=test', 'content-length': String(60 * 1024 * 1024) }, body: 'x' }));
  assert.equal(oversized.status, 413);
});
