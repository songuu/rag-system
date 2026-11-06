import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const code = buildSync({ entryPoints: [new URL('./SearchHighlight.tsx', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' }).outputFiles[0].text;
const fixtureModule = { exports: {} };
vm.runInNewContext(code, { module: fixtureModule, exports: fixtureModule.exports, require: createRequire(import.meta.url) });
const Highlight = fixtureModule.exports.SearchHighlight;
const render = (text, ranges, query) => renderToStaticMarkup(React.createElement(Highlight, { text, ranges, query }));

test('renders all validated matches safely and preserves the complete text', () => {
  assert.equal(render('契丹<script>契丹', [{ start: 0, end: 2 }, { start: 10, end: 12 }]),
    '<mark>契丹</mark>&lt;script&gt;<mark>契丹</mark>');
  assert.equal(render('😀契丹人', [{ start: 2, end: 4 }]), '😀<mark>契丹</mark>人');
});

test('ignores invalid ranges and displays unhighlighted semantic results', () => {
  assert.equal(render('abc', [{ start: -1, end: 2 }, { start: 2, end: 9 }]), 'abc');
  assert.equal(render('原文', undefined), '原文');
});

test('falls back to literal query matches for semantic or degraded results', () => {
  assert.equal(render('契丹人在哪里？契丹人在哪里？', undefined, '契丹人在哪里？'),
    '<mark>契丹人在哪里？契丹人在哪里？</mark>');
  assert.equal(render('人和人', [], '人'), '<mark>人</mark>和<mark>人</mark>');
  assert.equal(render('a+b A+B', undefined, 'a+b'), '<mark>a+b</mark> <mark>A+B</mark>');
  assert.equal(render('abcd', [{ start: 0, end: 1 }], 'bc'), '<mark>a</mark>bcd');
  assert.equal(render('unrelated', undefined, 'missing'), 'unrelated');
  assert.equal(render('abc 与 def，ABC', undefined, 'abc def'), '<mark>abc</mark> 与 <mark>def</mark>，<mark>ABC</mark>');
  assert.equal(render('a+b 与 c', undefined, 'a+b c'), '<mark>a+b</mark> 与 <mark>c</mark>');
  assert.equal(render('abc def abc', undefined, 'abc def'), '<mark>abc def</mark> <mark>abc</mark>');
});
