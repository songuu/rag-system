import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { prepareDevelopmentServer, waitForDevelopmentListener } from './development-readiness.mjs';

test('冷编译超过旧的两秒探测期限仍只发一次健康请求并完成预编译', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push([request.method, request.url]);
    if (request.url === '/api/health/live') {
      await sleep(2_100);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, status: 'live' }));
    } else {
      response.writeHead(204).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const messages = [];
  const result = await prepareDevelopmentServer(`http://127.0.0.1:${server.address().port}`, {
    log: message => messages.push(message),
  });
  assert.equal(result.ready, true);
  assert.deepEqual(requests, [
    ['GET', '/api/health/live'], ['OPTIONS', '/api/ask'],
    ['OPTIONS', '/api/model-selection'], ['OPTIONS', '/api/model-warmup'],
  ]);
  assert.ok(messages.some(message => /可以开始提问/.test(message)));
});

test('健康接口编译超时保留服务并明确说明尚未就绪', async () => {
  const warnings = [];
  const result = await prepareDevelopmentServer('http://127.0.0.1:3000', {
    probe: async () => true,
    compilationTimeoutMs: 20,
    fetchRoute: async (_url, { signal }) => {
      await sleep(1_000, undefined, { signal });
    },
    log: () => {}, warn: message => warnings.push(message),
  });
  assert.equal(result.ready, false);
  assert.match(warnings[0], /health\/live.*20 毫秒/);
  assert.match(warnings[0], /服务继续运行.*尚未就绪/);
});

test('端口开放不能代替有效的健康响应', async () => {
  for (const response of [new Response(null, { status: 500 }), Response.json({ status: 'unrelated' })]) {
    const warnings = [];
    const result = await prepareDevelopmentServer('http://127.0.0.1:3000', {
      probe: async () => true, fetchRoute: async () => response,
      log: () => {}, warn: message => warnings.push(message),
    });
    assert.equal(result.ready, false);
    assert.match(warnings[0], /health\/live/);
  }
});

test('健康响应头已返回但响应体卡住，也受同一个编译期限约束', async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const warnings = [];
  const result = await prepareDevelopmentServer(`http://127.0.0.1:${server.address().port}`, {
    compilationTimeoutMs: 30, log: () => {}, warn: message => warnings.push(message),
  });
  assert.equal(result.ready, false);
  assert.match(warnings[0], /health\/live.*30 毫秒/);
});

test('业务预编译超时不把监听中的 Next.js 判为启动失败', async () => {
  const warnings = [];
  const requests = [];
  const result = await prepareDevelopmentServer('http://127.0.0.1:3000', {
    probe: async () => true, compilationTimeoutMs: 20,
    fetchRoute: async (url, { signal }) => {
      requests.push(url);
      if (url.endsWith('/health/live')) return Response.json({ success: true, status: 'live' });
      await sleep(1_000, undefined, { signal });
    },
    log: () => {}, warn: message => warnings.push(message),
  });
  assert.equal(result.ready, false);
  assert.equal(requests.length, 2);
  assert.match(warnings[0], /ask.*服务继续运行/);
});

test('端口未监听具有独立期限并报出地址', async () => {
  await assert.rejects(waitForDevelopmentListener('http://127.0.0.1:3000', {
    probe: async () => false, listenerTimeoutMs: 20, retryIntervalMs: 5,
  }), /127\.0\.0\.1:3000.*监听.*20 毫秒/);
});

test('冷启动等待输出阶段进度，并在监听出现后继续而不是提前失败', async () => {
  const messages = [];
  const started = Date.now();
  await waitForDevelopmentListener('http://127.0.0.1:3034', {
    probe: async () => Date.now() - started >= 50,
    listenerTimeoutMs: 500, retryIntervalMs: 5, progressIntervalMs: 10,
    log: message => messages.push(message),
  });
  assert.ok(messages.length > 0);
  assert.ok(messages.every(message => /3034.*尚未监听.*已等待.*最多/.test(message)));
});

test('服务在启动等待中退出时保留原始退出原因', async () => {
  const controller = new AbortController();
  const failure = new Error('Next CLI exited with code 7');
  await assert.rejects(waitForDevelopmentListener('http://127.0.0.1:3034', {
    signal: controller.signal,
    probe: async () => { controller.abort(failure); return false; },
  }), error => error === failure);
});

test('服务退出的取消信号中断编译，不输出仍在运行的误导警告', async () => {
  const controller = new AbortController();
  const failure = new Error('Next.js exited');
  const warnings = [];
  const preparation = prepareDevelopmentServer('http://127.0.0.1:3000', {
    probe: async () => true, signal: controller.signal,
    fetchRoute: async (_url, { signal }) => {
      controller.abort(failure);
      await sleep(1_000, undefined, { signal });
    },
    log: () => {}, warn: message => warnings.push(message),
  });
  await assert.rejects(preparation, error => error === failure);
  assert.deepEqual(warnings, []);
});
