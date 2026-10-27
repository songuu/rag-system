import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from "node:test";
import { setTimeout as sleep } from 'node:timers/promises';
import { prepareDevelopmentServer } from './development-readiness.mjs';

import {
  activateElasticsearchMode,
  buildComposeArgs,
  buildPostgresRuntimeEnv,
  localRuntimeEnv,
  parseEnvFile,
  warmDevelopmentRoutes,
  selectDevelopmentPort,
  startBackgroundWorkers,
  run,
} from "./start-local-dev.mjs";

test('本地启动同时拉起搜索索引和图谱构建 worker', async () => {
  const calls = [];
  await startBackgroundWorkers(async (command, args, options) => {
    calls.push({ command, args, env: options.env });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'docker');
  assert.deepEqual(calls[0].args, buildComposeArgs([
    'up', '-d', 'search-index-worker', 'graph-control-worker',
  ]));
  assert.equal(calls[0].env.OLLAMA_BASE_URL, 'http://host.docker.internal:11434');
});

test('worker 启动失败时中止启动并保留 Docker 错误上下文', async () => {
  const failure = new Error('docker compose up graph-control-worker exited with code 1');
  await assert.rejects(startBackgroundWorkers(async () => {
    throw failure;
  }), error => error === failure);
});

test('预编译超时后真实子服务保持响应，直到正常关闭', { timeout: 10_000 }, async () => {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  let verified = false;
  await run(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => {
      if (req.url === '/shutdown') { res.end(); server.close(); return; }
      if (req.method === 'OPTIONS') return;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, status: 'live' }));
    });
    server.listen(${port}, '127.0.0.1');
  `], {
    stdio: 'ignore',
    onStarted: async signal => {
      const readiness = await prepareDevelopmentServer(baseUrl, {
        signal, compilationTimeoutMs: 40, log: () => {}, warn: () => {},
      });
      assert.equal(readiness.ready, false);
      const response = await fetch(`${baseUrl}/api/health/live`, { signal });
      assert.equal(response.status, 200);
      verified = true;
      await fetch(`${baseUrl}/shutdown`, { signal });
    },
  });
  assert.equal(verified, true);
});

test('子进程提前退出时保留退出原因并取消未完成的启动探测', async () => {
  let startupSignal;
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)'], {
    stdio: 'ignore',
    onStarted: async signal => {
      startupSignal = signal;
      await sleep(10_000, undefined, { signal });
    },
  }), /退出码 7/);
  assert.equal(startupSignal.aborted, true);
});

test('开发启动端口避开被占用或系统保留的端口，显式端口不静默切换', async () => {
  const attempted = [];
  assert.equal(await selectDevelopmentPort(undefined, async port => {
    attempted.push(port); return port !== 3000 && port !== 3001;
  }), 3002);
  assert.deepEqual(attempted, [3000, 3001, 3002]);
  await assert.rejects(selectDevelopmentPort('3001', async () => false), /3001.*不可用/);
  await assert.rejects(selectDevelopmentPort('invalid', async () => true), /PORT/);
});

test('Windows 开发启动默认使用 Webpack，允许显式切回 Turbopack', async () => {
  const { selectDevelopmentBundler } = await import('./start-local-dev.mjs');
  assert.equal(typeof selectDevelopmentBundler, 'function');
  assert.equal(selectDevelopmentBundler(undefined, 'win32'), 'webpack');
  assert.equal(selectDevelopmentBundler(undefined, 'linux'), 'turbopack');
  assert.equal(selectDevelopmentBundler('turbopack', 'win32'), 'turbopack');
  assert.equal(selectDevelopmentBundler('webpack', 'linux'), 'webpack');
  assert.throws(() => selectDevelopmentBundler('invalid', 'win32'), /NEXT_DEV_BUNDLER/);
});

test('端口探测拒绝仅在 IPv6 上占用的端口，与 Next 默认监听一致', async t => {
  // Windows may share binds within one process. A separate owner reproduces
  // the conflict that the Next child process actually encounters.
  const listener = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:net';
    const server = createServer();
    server.on('error', error => process.send({ code: error.code }));
    server.listen({ port: 0, host: '::', ipv6Only: true }, () => process.send({ port: server.address().port }));
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  try {
    const [message] = await once(listener, 'message', { signal: AbortSignal.timeout(5000) });
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(message.code)) {
      t.skip('当前环境不支持 IPv6 回环地址');
      return;
    }
    assert.equal(message.code, undefined);
    await assert.rejects(selectDevelopmentPort(String(message.port)), /不可用/);
  } finally {
    if (listener.exitCode === null && listener.signalCode === null) {
      const exited = once(listener, 'exit');
      listener.kill();
      await exited;
    }
  }
});

test('启动预编译只使用无副作用的 OPTIONS 请求', async () => {
  const calls = [];
  await warmDevelopmentRoutes('http://127.0.0.1:3000', async (url, options) => {
    calls.push({ url, method: options.method });
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(calls.map(call => call.method), ['OPTIONS', 'OPTIONS', 'OPTIONS']);
  assert.ok(calls.some(call => call.url.endsWith('/api/ask')));
  await assert.rejects(warmDevelopmentRoutes('http://127.0.0.1:3000', async () => new Response(null, { status: 500 })), /预编译/);
});

test('开发预编译串行执行并保留超时的接口上下文', async () => {
  let inFlight = 0;
  const completed = [];
  await warmDevelopmentRoutes('http://127.0.0.1:3000', async url => {
    assert.equal(inFlight++, 0);
    await new Promise(resolve => setImmediate(resolve));
    completed.push(url.split('/').at(-1));
    inFlight--;
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(completed, ['ask', 'model-selection', 'model-warmup']);
  await assert.rejects(warmDevelopmentRoutes('http://127.0.0.1:3000', async () => {
    throw new DOMException('signal timed out', 'TimeoutError');
  }), /ask.*180 秒.*内存和磁盘/);
});

test("buildComposeArgs 始终加载基础与本地 Compose 配置", () => {
  assert.deepEqual(buildComposeArgs(["up", "-d", "postgres"]), [
    "compose",
    "--env-file",
    ".env.container",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.local.yml",
    "up",
    "-d",
    "postgres",
  ]);
});

test("activateElasticsearchMode 会启用本地 Elasticsearch 且不重复变量", () => {
  assert.equal(
    activateElasticsearchMode("POSTGRES_DB=rag\nRAG_ELASTICSEARCH_MODE=off\n"),
    "POSTGRES_DB=rag\nRAG_ELASTICSEARCH_MODE=active\n",
  );
  assert.equal(
    activateElasticsearchMode("POSTGRES_DB=rag\n"),
    "POSTGRES_DB=rag\nRAG_ELASTICSEARCH_MODE=active\n",
  );
});

test("parseEnvFile 支持常见 dotenv 值", () => {
  assert.deepEqual(
    parseEnvFile('POSTGRES_USER=rag\nPOSTGRES_PASSWORD="p@ss word"\n# ignored\nEMPTY=\n'),
    {
      POSTGRES_USER: "rag",
      POSTGRES_PASSWORD: "p@ss word",
      EMPTY: "",
    },
  );
});

test("buildPostgresRuntimeEnv 为宿主机迁移生成可转义的连接地址", () => {
  const result = buildPostgresRuntimeEnv(
    {
      POSTGRES_USER: "rag user",
      POSTGRES_PASSWORD: "p@ss/word",
      POSTGRES_DB: "rag-db",
      POSTGRES_HOST_PORT: "55432",
      RAG_DEFAULT_TENANT_ID: "tenant-local",
      RAG_DEFAULT_CORPUS_ID: "corpus-local",
    },
    { PATH: "test-path" },
  );

  assert.equal(
    result.POSTGRES_URL,
    "postgresql://rag%20user:p%40ss%2Fword@127.0.0.1:55432/rag-db",
  );
  assert.equal(result.POSTGRES_SSL_MODE, "disable");
  assert.equal(result.RAG_DEFAULT_TENANT_ID, "tenant-local");
  assert.equal(result.RAG_DEFAULT_CORPUS_ID, "corpus-local");
  assert.equal(result.PATH, "test-path");
});

test("localRuntimeEnv 为本地进程启用 Milvus、Elasticsearch 与 Ollama", () => {
  const result = localRuntimeEnv({ PATH: "test-path" });

  assert.equal(result.RAG_ELASTICSEARCH_MODE, "active");
  assert.equal(result.ELASTICSEARCH_URL, "http://127.0.0.1:9200");
  assert.equal(result.MILVUS_PROVIDER, "local");
  assert.equal(result.MILVUS_LOCAL_ADDRESS, "127.0.0.1:19530");
  assert.equal(result.OLLAMA_BASE_URL, "http://127.0.0.1:11434");
  assert.equal(result.PATH, "test-path");
});

test("默认开发命令使用一键启动器，同时保留纯应用启动命令", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(packageJson.scripts.dev, "node scripts/start-local-dev.mjs");
  assert.equal(packageJson.scripts["dev:app"], "next dev");
  assert.equal(
    packageJson.scripts["dev:infra"],
    "node scripts/start-local-dev.mjs --infra-only",
  );
});
