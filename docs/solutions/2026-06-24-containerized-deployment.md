# 容器化部署支持

## 背景

后续云服务一键迁移需要一个可复用的容器部署入口。此前仓库只有 Next.js 本地/静态构建路径，没有 Dockerfile、Compose 编排、容器环境变量样例或轻量健康检查，迁移时容易把本地开发配置、云端凭据和运行时依赖混在一起。

## 根因

- Next.js 默认生产启动脚本没有容器边界，启用 `output: 'standalone'` 后需要同步调整 `pnpm start` 契约。
- 原 `next/font/google` 会在构建期访问 Google Fonts，容器和受限网络环境下不可重复。
- 健康检查如果复用 readiness 或业务查询路径，会误触发 Milvus、LLM、Supabase 等外部依赖。
- 本地 Milvus 栈和云端 Zilliz/Supabase/LLM provider 没有共享的环境变量迁移说明。

## 已落地

- 新增多阶段 `Dockerfile`，使用 `pnpm build` 生成 Next standalone 输出，并以非 root 用户运行 `server.js`。
- 新增 `.dockerignore`，排除依赖、构建产物、上传文件、缓存和 `.env*`，避免密钥与本地状态进入镜像。
- 新增 `docker-compose.yml`、`docker-compose.local.yml`、`docker-compose.cloud.yml`，将通用 app 服务、本地 Milvus 栈和云端托管服务覆盖层分开。
- 新增 `.env.container.example`，提供 local / hybrid / cloud 三类部署参数，所有真实凭据都保留为 placeholder。
- 新增 `src/app/api/health/live/route.ts`，只返回进程存活状态，不初始化 RAG、Milvus、LLM 或 Supabase。
- `next.config.ts` 在非 `STATIC_EXPORT` 时启用 standalone；`package.json` 的 `start` 同步为 `node .next/standalone/server.js`。
- 移除 `next/font/google`，在 `globals.css` 改用系统字体栈，保证容器构建不依赖构建期外网字体下载。
- 新增 `docs/deployment/container.md`，记录本地、混合云、云端迁移、健康检查、持久化、静态导出和验证命令。

## 验证

- `pnpm build`：pass，Next production build 成功，路由表包含 `/api/health/live`。
- `pnpm start`：pass，standalone server 启动，无 `next start` standalone 警告。
- `Invoke-RestMethod http://localhost:3000/api/health/live | ConvertTo-Json -Compress`：pass，返回 `{"success":true,"status":"live"}`。
- `docker compose --env-file .env.container.example -f docker-compose.yml -f docker-compose.local.yml config`：pass。
- `docker compose -f docker-compose.yml -f docker-compose.cloud.yml config`：pass。
- `docker version`：blocked，Docker CLI 存在但 Docker Desktop Linux daemon 未运行。
- `docker build -t rag-system:container-smoke .`：blocked，镜像构建需要 Docker daemon；当前环境未完成真实 build/run smoke。
- `git diff --check`：pass，只有工作区 CRLF 提示。

## 经验

- 对 Next standalone 项目，`output: 'standalone'`、Docker `CMD` 和 `package.json` 的生产启动脚本必须保持同一契约。
- 容器 liveness 要与 readiness 分离；liveness 只证明进程活着，不能访问外部服务。
- 云迁移配置应先稳定环境变量命名，再通过 Compose overlay 或平台 env 注入切换本地/云端后端。
- 容器构建路径里不要保留构建期外网字体下载；需要可重复构建时优先使用系统字体或本地字体资源。

## 残余风险

- Docker daemon 未运行，真实 `docker build` / `docker run` 尚未验证。
- `globals.css` 仍有 Font Awesome CDN runtime import；它不阻塞构建，但完全离线云环境会丢图标字体资源。