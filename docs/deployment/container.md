# 容器化部署指南

本指南用于后续云服务一键迁移：同一份镜像可在本地 Docker、私有云、云容器平台运行。镜像只包含应用代码和构建产物；LLM、Embedding、Milvus/Zilliz、Supabase、LangSmith 等服务通过运行时环境变量接入。

## 部署资产

| 文件 | 用途 |
|------|------|
| `Dockerfile` | Next.js 服务端生产镜像，使用 standalone 输出和非 root 用户 |
| `.dockerignore` | 排除依赖、构建产物、上传数据、密钥和缓存 |
| `docker-compose.yml` | 应用基础服务、端口、volume、healthcheck wiring |
| `docker-compose.local.yml` | 本地迁移演练：app + Milvus standalone 依赖栈 |
| `docker-compose.cloud.yml` | 云服务模式：app 连接 Zilliz/Supabase/云模型服务 |
| `.env.container.example` | 容器运行时变量样例，不含真实密钥 |

## 快速本地演练

1. 准备环境变量：

```powershell
Copy-Item .env.container.example .env.container
```

2. 如果使用默认 local 模式，先确保宿主机 Ollama 正在运行，并已准备模型：

```powershell
ollama pull llama3.1
ollama pull nomic-embed-text
```

3. 启动 app + Milvus：

```powershell
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.local.yml up --build
```

4. 验证进程级 liveness：

```powershell
Invoke-RestMethod http://localhost:3000/api/health/live
```

5. 验证应用 readiness / 外部依赖：

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

`/api/health/live` 只证明容器进程可服务，不访问 RAG、Milvus、LLM 或 Supabase。`/api/health` 才用于迁移验收和外部依赖诊断。

## 云服务迁移模式

1. 复制 `.env.container.example` 为 `.env.container`。
2. 注释 local 模式变量，启用 cloud 或 hybrid 段。
3. 填入运行时密钥，不提交 `.env.container`。
4. 本地模拟云模式：

```powershell
docker compose --env-file .env.container -f docker-compose.yml -f docker-compose.cloud.yml up --build
```

5. 云平台部署时使用同一镜像，将 `.env.container` 中的变量逐项配置到平台 secrets/env，不要把密钥 bake 到镜像。

## 关键环境变量

| 类别 | 变量 |
|------|------|
| LLM | `MODEL_PROVIDER`, `OPENAI_API_KEY`, `CUSTOM_API_KEY`, `CUSTOM_BASE_URL`, `OLLAMA_BASE_URL` |
| Embedding | `EMBEDDING_PROVIDER`, `SILICONFLOW_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `CUSTOM_EMBEDDING_DIMENSION` |
| Milvus/Zilliz | `MILVUS_PROVIDER`, `MILVUS_LOCAL_ADDRESS`, `MILVUS_ZILLIZ_ENDPOINT`, `MILVUS_ZILLIZ_TOKEN`, `MILVUS_DEFAULT_DIMENSION` |
| API 安全边界 | `RAG_ACCESS_MODE`, `RAG_SINGLE_TENANT_TOKEN`, `RAG_TENANT_ISOLATION_REQUIRED`, `RAG_ALLOWED_LLM_MODELS`, `RAG_ALLOWED_EMBEDDING_MODELS` |
| Supabase | `RAG_PERSISTENCE_BACKEND`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DEFAULT_TENANT_ID`, `SUPABASE_DEFAULT_CORPUS_ID` |
| LangSmith | `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` |
| Uploads | `REASONING_RAG_UPLOAD_DIR`, app volume `/app/uploads`, `/app/reasoning-uploads`, `/app/adaptive-rag-uploads` |

完整变量含义见 `ENV_CONFIG_GUIDE.md`。

## API 身份、租户与语料库边界

`/api/ask`、`/api/pipeline` 和 `/api/milvus` 统一使用服务端派生的安全上下文，客户端
`userId` / `tenantId` 不作为授权依据。

- `RAG_ACCESS_MODE=local-dev`：只允许非 production，保留本地无登录开发体验。
- `RAG_ACCESS_MODE=single-tenant-token`：生产过渡模式；必须设置长随机
  `RAG_SINGLE_TENANT_TOKEN` 与固定 tenant/corpus，请求使用
  `Authorization: Bearer <token>`。
- `RAG_ACCESS_MODE=supabase`：使用 Supabase 用户 JWT；服务端通过 publishable key +
  用户 JWT 验证 Auth user、RLS 可见 corpus 和 tenant membership，不回退 service role。

`single-tenant-token` 面向受信服务端调用或会注入 Authorization 的反向代理，不能把共享
token 下发到浏览器。当前第一方演示 UI 不发送生产 bearer/session，且首页默认 memory
policy；它只适用于 `local-dev`。认证模式的浏览器体验必须先接入同源 BFF/session，或由受信
反向代理在服务端注入身份，并把默认策略限制为 scoped Milvus。

应用层硬边界覆盖 canonical API：`/api/ask`、`/api/pipeline`、`/api/milvus`。旧的
`rag-milvus`、Milvus sync/visualize、agentic/adaptive/reasoning/self-RAG、upload/files 与
reinitialize 路由在 production 或显式认证模式统一返回 410，只在非 production 的
`local-dev` 保留。生产网关仍应使用 route allowlist 作为纵深防御；当前 compose 不包含
身份代理，不能仅复制示例环境变量后直接把演示 UI 作为生产入口。

生产环境应设置 `RAG_ALLOWED_LLM_MODELS` 和 `RAG_ALLOWED_EMBEDDING_MODELS`（逗号分隔）。
外部 URL ingestion 默认只允许 HTTPS；仅在明确接受风险时设置
`RAG_EXTERNAL_URL_ALLOW_HTTP=true`。

新建 Milvus collection 会包含 `tenant_id`、`corpus_id`、`document_id`、
`trust_level` 标量字段。旧 collection 不具备这些字段；启用
`RAG_TENANT_ISOLATION_REQUIRED=true` 前，必须通过受控重建或 shadow collection 回填迁移，
否则服务会按 fail-closed 策略拒绝读写，避免静默跨租户检索。

## 持久化边界

本地 compose 使用 Docker volumes 保存：

- `/app/uploads`
- `/app/reasoning-uploads`
- `/app/adaptive-rag-uploads`
- Milvus/MinIO/etcd 数据 volume

云迁移建议：

- 文件/manifest：设置 `RAG_PERSISTENCE_BACKEND=supabase`。
- 向量库：设置 `MILVUS_PROVIDER=zilliz` 或后续接入 `RAG_VECTOR_BACKEND`。
- 不依赖容器本地磁盘保存长期业务数据，除非平台显式绑定持久卷。


## 本机生产启动

服务端模式启用 Next.js standalone 输出。生产启动前必须先构建：

```powershell
pnpm build
pnpm start
```

`pnpm start` 会运行 `.next/standalone/server.js`；静态导出仍使用 `STATIC_EXPORT=true pnpm build` 生成 `out/`。

## 静态导出与容器镜像

`STATIC_EXPORT=true` 仍用于静态站点导出，输出 `out/` 并使用 `/rag-system` base path。容器部署走服务端模式，不设置 `STATIC_EXPORT=true`，Next.js 会生成 standalone server 输出。

## 常见问题

### 容器内 localhost 连接不到宿主机 Ollama

容器内 `localhost` 指向 app 容器自身。默认 local compose 使用：

```text
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

Linux Docker 通过 `extra_hosts: host.docker.internal:host-gateway` 提供这个地址。

### `/api/health/live` 通过但 `/api/health` 失败

这是预期边界：liveness 只证明进程活着，readiness 会初始化 RAG 并读取模型/向量库配置。排查 `.env.container`、Ollama/Zilliz/Supabase 连接和 API Key。

### Zilliz endpoint 是否需要 `https://`

不需要。按现有配置指南，`MILVUS_ZILLIZ_ENDPOINT` 使用 SDK endpoint 形态，例如：

```text
in01-xxx.api.gcp-us-west1.zillizcloud.com:443
```

### 能否把 `.env.container` 打进镜像

不能。镜像必须可复用，密钥只通过运行时 env/secrets 注入。`.dockerignore` 已排除 `.env*`。

## 验证命令

```powershell
pnpm build
docker version
docker build -t rag-system:container-smoke .
docker compose --env-file .env.container.example -f docker-compose.yml -f docker-compose.local.yml config
docker compose -f docker-compose.yml -f docker-compose.cloud.yml config
```

如果 Docker daemon 不可用，只能说明本地代码构建通过，不能宣称容器验证完成。
