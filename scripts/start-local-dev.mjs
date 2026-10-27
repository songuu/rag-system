import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentServer } from './development-readiness.mjs';
export { warmDevelopmentRoutes } from './development-readiness.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const CONTAINER_ENV_FILE = ".env.container";
const CONTAINER_ENV_EXAMPLE = ".env.container.example";
const LOCAL_IMAGE = "rag-system:local";
const INFRASTRUCTURE_SERVICES = [
  "postgres",
  "etcd",
  "minio",
  "milvus",
  "neo4j",
  "elasticsearch",
];

function log(message) {
  console.log(`\n[local-dev] ${message}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { onStarted, ...spawnOptions } = options;
    const lifecycle = new AbortController();
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      ...spawnOptions,
    });

    child.once("error", (error) => {
      lifecycle.abort(error);
      reject(
        new Error(`无法启动命令 ${command}: ${error.message}`, { cause: error }),
      );
    });
    child.once('spawn', () => {
      if (onStarted) void Promise.resolve().then(() => onStarted(lifecycle.signal, { pid: child.pid })).catch(error => {
        if (lifecycle.signal.aborted) return;
        lifecycle.abort(error);
        child.kill();
        reject(error);
      });
    });
    child.once("exit", (code, signal) => {
      lifecycle.abort(new Error(`命令已退出（${signal || code}），取消启动检测。`));
      if (code === 0) {
        resolve();
        return;
      }

      const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
      reject(new Error(`命令 ${command} ${args.join(" ")} 执行失败（${reason}）`));
    });
  });
}

function runQuiet(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
    ...options,
  });
}

export function buildComposeArgs(args) {
  return [
    "compose",
    "--env-file",
    CONTAINER_ENV_FILE,
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.local.yml",
    ...args,
  ];
}

export function activateElasticsearchMode(contents) {
  if (/^RAG_ELASTICSEARCH_MODE=.*$/m.test(contents)) {
    return contents.replace(
      /^RAG_ELASTICSEARCH_MODE=.*$/m,
      "RAG_ELASTICSEARCH_MODE=active",
    );
  }

  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  return `${contents}${separator}RAG_ELASTICSEARCH_MODE=active\n`;
}

export function parseEnvFile(contents) {
  const values = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex < 1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

export function buildPostgresRuntimeEnv(containerEnv, baseEnv = process.env) {
  const user = containerEnv.POSTGRES_USER || "rag";
  const password = containerEnv.POSTGRES_PASSWORD || "rag_local_password";
  const database = containerEnv.POSTGRES_DB || "rag";
  const port = containerEnv.POSTGRES_HOST_PORT || "5432";
  const postgresUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;

  return {
    ...baseEnv,
    POSTGRES_URL: postgresUrl,
    DATABASE_URL: postgresUrl,
    POSTGRES_SSL_MODE: "disable",
    RAG_DEFAULT_TENANT_ID:
      containerEnv.RAG_DEFAULT_TENANT_ID ||
      baseEnv.RAG_DEFAULT_TENANT_ID ||
      "default",
    RAG_DEFAULT_CORPUS_ID:
      containerEnv.RAG_DEFAULT_CORPUS_ID ||
      baseEnv.RAG_DEFAULT_CORPUS_ID ||
      "default",
  };
}

export function localRuntimeEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    RAG_ELASTICSEARCH_MODE: "active",
    ELASTICSEARCH_URL: "http://127.0.0.1:9200",
    ELASTICSEARCH_ALLOW_INSECURE: "true",
    ELASTICSEARCH_ALLOW_UNAUTHENTICATED: "true",
    MILVUS_PROVIDER: "local",
    MILVUS_LOCAL_ADDRESS: "127.0.0.1:19530",
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  };
}

async function ensureContainerEnv() {
  const targetPath = path.join(PROJECT_ROOT, CONTAINER_ENV_FILE);
  if (existsSync(targetPath)) {
    return parseEnvFile(await readFile(targetPath, "utf8"));
  }

  const examplePath = path.join(PROJECT_ROOT, CONTAINER_ENV_EXAMPLE);
  if (!existsSync(examplePath)) {
    throw new Error(
      `缺少 ${CONTAINER_ENV_EXAMPLE}，无法生成本地容器配置。`,
    );
  }

  await copyFile(examplePath, targetPath);
  const activated = activateElasticsearchMode(await readFile(targetPath, "utf8"));
  await writeFile(targetPath, activated, "utf8");
  log(`已从 ${CONTAINER_ENV_EXAMPLE} 创建 ${CONTAINER_ENV_FILE}`);
  return parseEnvFile(activated);
}

function isDockerReady() {
  return runQuiet("docker", ["info"]).status === 0;
}

async function waitUntil(check, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(2_000);
  }
  throw new Error(failureMessage);
}

async function ensureDockerReady() {
  if (isDockerReady()) {
    return;
  }

  if (process.platform !== "win32") {
    throw new Error("Docker 尚未运行，请先启动 Docker 服务后重试。");
  }

  const dockerDesktopPath = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
  if (!existsSync(dockerDesktopPath)) {
    throw new Error("未找到 Docker Desktop，请先安装或手动启动 Docker。");
  }

  log("Docker 尚未运行，正在启动 Docker Desktop…");
  const dockerDesktop = spawn(dockerDesktopPath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  dockerDesktop.unref();

  await waitUntil(
    isDockerReady,
    120_000,
    "等待 Docker Desktop 就绪超时，请检查 Docker Desktop 状态。",
  );
}

function localImageExists() {
  return runQuiet("docker", ["image", "inspect", LOCAL_IMAGE]).status === 0;
}

async function migratePostgres(containerEnv) {
  log("执行 PostgreSQL 迁移与本地种子初始化…");
  await run(process.execPath, ["scripts/migrate-postgres.mjs"], {
    env: buildPostgresRuntimeEnv(containerEnv),
  });
}

async function startDockerServices({ rebuild }) {
  const composeEnv = localRuntimeEnv();
  await run("docker", buildComposeArgs(["config", "--quiet"]), {
    env: composeEnv,
  });

  log("拉取缺失镜像并启动 PostgreSQL、Milvus、Elasticsearch、Neo4j…");
  await run(
    "docker",
    buildComposeArgs([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      ...INFRASTRUCTURE_SERVICES,
    ]),
    { env: composeEnv },
  );

  if (rebuild || !localImageExists()) {
    log(rebuild ? "正在重建本地 Worker 镜像…" : "首次启动，正在构建本地 Worker 镜像…");
    await run("docker", buildComposeArgs(["build", "app"]), {
      env: composeEnv,
    });
  }

}

export async function startBackgroundWorkers(runCommand = run) {
  log("启动 Elasticsearch 增量索引与图谱构建 Worker…");
  await runCommand(
    "docker",
    buildComposeArgs(["up", "-d", "search-index-worker", "graph-control-worker"]),
    {
      // Compose interpolates this address into the container, whose loopback is not the host.
      env: { ...localRuntimeEnv(), OLLAMA_BASE_URL: "http://host.docker.internal:11434" },
    },
  );
}

async function isHttpReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureOllamaReady() {
  const tagsUrl = "http://127.0.0.1:11434/api/tags";
  if (await isHttpReady(tagsUrl)) {
    return;
  }

  if (runQuiet("ollama", ["--version"]).status !== 0) {
    throw new Error(
      "未检测到 Ollama。请先安装 Ollama，并确保 ollama 命令已加入 PATH。",
    );
  }

  log("Ollama 尚未运行，正在启动本地 Ollama 服务…");
  const ollama = spawn("ollama", ["serve"], {
    cwd: PROJECT_ROOT,
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  ollama.on("error", () => {});
  ollama.unref();

  await waitUntil(
    () => isHttpReady(tagsUrl),
    60_000,
    "等待 Ollama 就绪超时，请检查 11434 端口或 Ollama 日志。",
  );
}

async function canListenOnPort(port) {
  const canBind = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => {
      if (['EADDRINUSE', 'EACCES'].includes(error.code)) resolve(false);
      else reject(error);
    });
    // Match Next's unspecified hostname (IPv6 dual-stack when available), so an
    // IPv4-only probe cannot select a port that Next will fail to bind on ::.
    server.listen(port, () => server.close(error => error ? reject(error) : resolve(true)));
  });
  if (!canBind) return false;
  // Windows can permit overlapping binds, including a dual-stack probe beside
  // an existing single-stack listener. Check both loopbacks before selecting it.
  const listeners = await Promise.all(['127.0.0.1', '::1'].map(host => new Promise(resolve => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = occupied => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  })));
  return !listeners.some(Boolean);
}

export async function selectDevelopmentPort(explicitPort, probe = canListenOnPort) {
  if (explicitPort !== undefined) {
    if (!/^\d+$/u.test(explicitPort) || Number(explicitPort) < 1 || Number(explicitPort) > 65535) throw new Error('PORT 必须为 1–65535 的整数。');
    const port = Number(explicitPort);
    if (!await probe(port)) throw new Error(`指定端口 ${port} 不可用，请检查端口占用或系统保留范围。`);
    return port;
  }
  for (let port = 3000; port < 3100; port++) if (await probe(port)) return port;
  throw new Error('3000–3099 没有可用开发端口，请显式设置 PORT。');
}

export function selectDevelopmentBundler(explicitBundler, platform = process.platform) {
  // Prefer Webpack after measured Turbopack cold-start stalls on the Windows
  // filesystem; an explicit override keeps both development modes available.
  const bundler = explicitBundler || (platform === 'win32' ? 'webpack' : 'turbopack');
  if (!['webpack', 'turbopack'].includes(bundler)) {
    throw new Error('NEXT_DEV_BUNDLER 仅支持 webpack 或 turbopack。');
  }
  return bundler;
}

async function startNextDev() {
  const nextCli = path.join(PROJECT_ROOT, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextCli)) {
    throw new Error("未找到 Next.js，请先执行 pnpm install。");
  }

  log("依赖服务已就绪，正在启动 Next.js…");
  const bundler = selectDevelopmentBundler(process.env.NEXT_DEV_BUNDLER);
  const port = await selectDevelopmentPort(process.env.PORT);
  log(`使用开发端口 ${port}，开发编译器 ${bundler}。`);
  await run(process.execPath, [nextCli, "dev", `--${bundler}`, "--port", String(port)], {
    env: { ...localRuntimeEnv(), PORT: String(port) },
    onStarted: async (signal, { pid }) => {
      log(`Next.js 启动进程 PID=${pid}；正在等待框架加载与端口监听。`);
      const basePath = (process.env.RAG_BASE_PATH || '').replace(/\/+$/, '');
      const baseUrl = `http://127.0.0.1:${port}${basePath}`;
      await prepareDevelopmentServer(baseUrl, {
        signal, log, warn: message => console.warn(`\n[local-dev] ${message}`),
      });
    },
  });
}

export async function main(argv = process.argv.slice(2)) {
  const knownArguments = new Set(["--infra-only", "--rebuild"]);
  const unknownArguments = argv.filter((argument) => !knownArguments.has(argument));
  if (unknownArguments.length > 0) {
    throw new Error(`不支持的启动参数：${unknownArguments.join(", ")}`);
  }

  const infraOnly = argv.includes("--infra-only");
  const rebuild = argv.includes("--rebuild");
  const containerEnv = await ensureContainerEnv();

  await ensureDockerReady();
  await startDockerServices({ rebuild });
  await migratePostgres(containerEnv);
  await ensureOllamaReady();
  await startBackgroundWorkers();

  if (infraOnly) {
    log("本地依赖服务已全部就绪。");
    return;
  }

  await startNextDev();
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`\n[local-dev] 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
