---
title: "容器化部署支持"
type: sprint
status: completed
created: "2026-06-24"
updated: "2026-06-24"
checkpoints: 1
tasks_total: 7
tasks_completed: 7
tags: [sprint, deployment, docker, cloud-migration]
aliases: ["containerized-deployment"]
invariants:
  - "保持现有 Next.js 服务端运行模式，不影响 STATIC_EXPORT=true 的静态导出路径"
  - "容器镜像不得写入密钥；所有云服务凭据只通过运行时环境变量注入"
  - "本地开发与云端一键迁移路径必须共享同一套环境变量命名"
  - "容器构建不得依赖 Google Fonts 等构建期外网字体下载"
invariant_tests:
  - "pnpm build"
deferred: []
deadcode_until: []
---

# 容器化部署支持

## Phase 1: Think - 需求分析

### 背景

后续存在云服务一键迁移场景，当前仓库没有 Dockerfile、docker compose 或容器部署文档。项目是 Next.js 服务端应用，同时依赖 LLM、Embedding、Milvus/Zilliz、LangSmith、Supabase 等外部服务配置。容器化目标不是只让页面启动，而是让迁移方能用同一份镜像和环境变量在本地、私有云、云托管平台间迁移。

### 已验证事实

| 事实 | 证据 |
|------|------|
| 当前无 Dockerfile / compose 文件 | `rg --files -g '*Docker*' -g 'docker*' -g '.dockerignore' -g '*compose*'` 未返回部署文件；仅 `context-composer.ts` 命中 `*compose*` |
| 构建脚本使用 pnpm + Next.js | `package.json` scripts: `build`, `start`, `dev`; packageManager: `pnpm@11.1.3` |
| Next.js 已有静态导出分支 | `next.config.ts` 使用 `STATIC_EXPORT === 'true'` 切 `output: 'export'` / `basePath: '/rag-system'` |
| 服务端模式已有健康检查 API | `src/app/api/health/route.ts` 返回 RAG 状态和模型配置，失败时返回 500 |
| 云迁移相关配置已文档化 | `ENV_CONFIG_GUIDE.md` 覆盖 `MODEL_PROVIDER`、`EMBEDDING_PROVIDER`、`MILVUS_PROVIDER=zilliz`、API Key 和 collection/dimension 配置 |
| 本地运行默认依赖 Ollama/Milvus 地址 | 多处默认 `OLLAMA_BASE_URL=http://localhost:11434`、`MILVUS_LOCAL_ADDRESS=localhost:19530` |
| 工作树已有无关改动 | `git status --short` 显示多个已修改/未跟踪源码和计划文件，容器 sprint 不应回滚或改写这些改动 |

### Scope

- 增加可生产使用的容器镜像入口，优先支持 Next.js 服务端模式。
- 增加本地/迁移演练用 compose 配置，覆盖 app、Milvus、本地可选 Ollama 或外部云服务变量接入。
- 增加 `.dockerignore`，避免 node_modules、构建产物、上传数据、密钥和缓存进入镜像上下文。
- 增加环境变量样例和容器部署说明，明确本地模式、全云端模式、混合模式。
- 保留 `STATIC_EXPORT=true` 的静态导出能力，不把容器部署与 GitHub Pages 静态部署混在一起。
- 验证容器相关配置能通过本仓库构建链路，至少跑 `pnpm build` 或等价容器构建前置检查。

### Non-scope

- 不迁移数据库数据，不自动创建 Zilliz/Supabase/LangSmith 云资源。
- 不提交真实 API Key、token、数据库密码或云账号配置。
- 不把本地 Ollama 模型打包进应用镜像。
- 不重构 RAG/LLM/Embedding 业务逻辑，除非容器启动必须修复。
- 不清理当前工作树已有无关改动。

### Success

- 仓库存在标准容器部署资产：`Dockerfile`、`.dockerignore`、compose 文件、环境变量样例和部署文档。
- 本地迁移演练路径清晰：开发者能按文档复制 env、选择 local/cloud provider、启动服务、访问 `/api/health`。
- 云服务一键迁移路径清晰：镜像构建、运行时变量、外部托管依赖、健康检查、持久化目录边界均有说明。
- 容器构建不依赖本机绝对路径，不包含密钥，不污染现有静态导出部署。
- 验证结果写回本文档 Phase 3/4。

### Risks

- `next.config.ts` 当前未启用 `output: 'standalone'`，生产镜像可能需要调整；必须确认不破坏 `STATIC_EXPORT=true`。
- `/api/health` 会初始化 RAG 系统，作为容器 healthcheck 可能误把外部云服务短暂失败判成容器不可用；Plan 阶段需区分 liveness/readiness。
- 默认 `localhost` 在容器内语义变化：访问宿主 Ollama/Milvus 需改为 compose service name 或外部 URL。
- native/pdf/canvas 相关依赖可能影响 Alpine 镜像兼容性；应优先评估 Debian slim 基础镜像。
- 当前工作树已有无关源码改动，验证失败时需区分本 sprint 引入问题和既有状态。

## Phase 2: Plan - 技术方案

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| Next.js 部署模式 | `STATIC_EXPORT=true` 走静态导出，服务端模式走 `next start` | 只在非静态导出时启用服务端容器路径；Dockerfile 不设置 `STATIC_EXPORT=true` |
| RAG API 契约 | `/api/ask`、RAG workflow、LangSmith disabled no-op 保持兼容 | 容器化只变启动/环境/部署资产，不修改 RAG API 响应结构 |
| LangSmith | 未配置 API key 时必须 no-op | env sample 明确可选；容器启动不强制 LangSmith 网络可用 |
| 持久化/上传 | 本地 `uploads/` 与 Supabase backend 都存在 | compose 用 volume 保存本地上传；cloud mode 推荐 `RAG_PERSISTENCE_BACKEND=supabase` |
| 容器密钥 | 镜像不得包含密钥 | `.dockerignore` 排除 `.env*`，文档要求运行时注入 secrets |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| Docker 镜像 | `docker build` | pnpm install -> `pnpm build` -> Next standalone/server output | 镜像层只含构建产物，无 secrets | `docker run` 后服务可访问 |
| Compose 本地演练 | `docker compose up` | app -> Milvus service；可选 Ollama/external URL | `uploads` volume + `milvus_data` volume | 重启容器后上传/向量库数据仍存在 |
| 云端全托管模式 | 云平台注入 env | app -> OpenAI/Custom + SiliconFlow + Zilliz/Supabase | 云服务持久化 | 重新部署镜像后仍连接同一云数据 |
| Liveness | 容器 healthcheck | `/api/health/live` | 无 | 容器平台只确认进程可服务 |
| Readiness | 迁移验收手动探测 | `/api/health` | RAG/Milvus/模型配置状态 | 外部依赖异常时明确暴露失败 |

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| 2026-05-25 rerank/capability 债务 | Milvus hybrid sparse + dense 等 RAG 能力债 | 与容器化无关，保留原计划，不纳入本 sprint | 2026-08-01 |
| 本 sprint Phase 1 风险 | `/api/health` 初始化 RAG，不适合 liveness | 本 sprint 收口：新增轻量 `/api/health/live` | 2026-06-24 |
| 本 sprint Phase 1 风险 | 容器内 `localhost` 指向容器自身 | 本 sprint 收口：compose/env 文档显式使用 service name 或外部 URL | 2026-06-24 |

### 技术方案

1. **镜像策略**
   - 使用 multi-stage Dockerfile：`deps` 安装 pnpm 依赖，`builder` 执行 `pnpm build`，`runner` 只复制生产运行所需文件。
   - 基础镜像优先 `node:22-bookworm-slim`，规避 Alpine 与 native/pdf/canvas 类依赖兼容风险。
   - Next.js 服务端镜像优先使用 standalone 输出；`next.config.ts` 只在 `STATIC_EXPORT !== 'true'` 时设置 `output: 'standalone'`，保持静态导出路径不变。
   - 运行用户使用非 root，监听 `PORT=3000`，默认 `HOSTNAME=0.0.0.0`。

2. **健康检查策略**
   - 新增 `src/app/api/health/live/route.ts`：只返回进程级状态、版本/时间戳，不初始化 RAG，不访问 Milvus/LLM/Supabase。
   - Dockerfile `HEALTHCHECK` 使用 `/api/health/live`。
   - `/api/health` 保持 readiness/diagnostics 语义，供部署后人工或自动验收使用。

3. **Compose 本地迁移演练**
   - 增加 `docker-compose.yml`：
     - `app`：构建当前镜像，读取 `.env.container`，挂载 `uploads` 和 `reasoning-uploads` volume。
     - `milvus` 及其依赖：本地向量库演练路径，`MILVUS_LOCAL_ADDRESS=milvus:19530`。
     - `ollama` 使用 profile 或文档说明，不默认拉大模型，避免一键启动变慢。
   - 增加 `docker-compose.cloud.yml` 或 compose profile：只跑 app，连接 Zilliz/Supabase/SiliconFlow/OpenAI 等外部云服务。

4. **环境变量与 secrets**
   - 增加 `.env.container.example`，覆盖三种模式：
     - local: Ollama + Milvus volume。
     - hybrid: 本地/自托管 LLM + SiliconFlow/Zilliz。
     - cloud: OpenAI/Custom + SiliconFlow + Zilliz + Supabase。
   - `.dockerignore` 排除 `.env*`、`node_modules`、`.next`、`uploads`、`reasoning-uploads`、`milvus_data`、临时日志和缓存。

5. **部署文档**
   - 增加 `docs/deployment/container.md`：
     - 本地构建/启动/健康检查命令。
     - 云迁移 checklist：环境变量、外部服务、volume、端口、readiness。
     - 常见陷阱：容器内 localhost、密钥注入、Zilliz endpoint 格式、静态导出 vs 服务端镜像。
   - README 增加最小入口链接，不复制长文档。

### 任务拆解

| Task | 内容 | 风险 | 验收 |
|------|------|------|------|
| T1 | 调整 `next.config.ts`：非 `STATIC_EXPORT` 时启用 standalone，保留静态导出 | L2 | `STATIC_EXPORT=true` 分支配置仍保留；普通 build 可生成服务端产物 |
| T2 | 新增 `/api/health/live` 轻量 liveness route | L1 | route 不 import RAG/Milvus/模型配置；返回 200 JSON |
| T3 | 新增 `.dockerignore` | L0 | 密钥、依赖、构建产物、上传数据不进 build context |
| T4 | 新增 multi-stage `Dockerfile` | L2 | 镜像使用 pnpm、非 root、healthcheck、生产启动命令 |
| T5 | 新增 compose 本地/云迁移配置 | L2 | app/Milvus/volume/env wiring 明确；云模式不强制本地依赖 |
| T6 | 新增 `.env.container.example` | L1 | local/hybrid/cloud 变量齐全，无真实 secrets |
| T7 | 新增容器部署文档并在 README 放入口 | L1 | 一键迁移步骤、健康检查、持久化、故障边界清楚 |

### 验证策略

| 层级 | 命令 | 目标 |
|------|------|------|
| L1 | `pnpm build` | 保证 Next.js 服务端构建仍通过 |
| L1 | `docker version` | 确认当前环境是否能跑容器验证 |
| L2 | `docker build -t rag-system:container-smoke .` | 验证 Dockerfile 与 build context |
| L2 | `docker compose config` | 验证 compose YAML/env 引用结构 |
| L2 | `docker run --rm -p 3000:3000 --env-file .env.container.example rag-system:container-smoke` + `/api/health/live` | 如环境允许，验证容器进程级启动 |

说明：若 Docker daemon 不可用，必须在 Phase 3/4 明确标记为环境阻塞，不把本地 `pnpm build` 当作容器验证完成。

### Gate

Phase 2 完成。回复 `go` 进入 Phase 3: Work；或给修改意见先调整计划。

## Phase 3: Work - 实施记录

### Task 完成情况

| Task | 结果 | 文件 |
|------|------|------|
| T1 | 完成：非 `STATIC_EXPORT` 模式启用 Next.js standalone，静态导出分支保留 | `next.config.ts` |
| T2 | 完成：新增轻量 liveness，不初始化 RAG/Milvus/模型配置 | `src/app/api/health/live/route.ts` |
| T3 | 完成：新增 Docker build context 排除规则 | `.dockerignore` |
| T4 | 完成：新增 multi-stage 生产 Dockerfile，非 root 用户、standalone 产物、healthcheck | `Dockerfile` |
| T5 | 完成：新增基础、本地 Milvus、云服务 overlay compose | `docker-compose.yml`, `docker-compose.local.yml`, `docker-compose.cloud.yml` |
| T6 | 完成：新增容器 env 样例，并允许样例被 Git 跟踪 | `.env.container.example`, `.gitignore` |
| T7 | 完成：新增容器部署文档和 README 入口 | `docs/deployment/container.md`, `README.md` |

### 额外修复 - 构建可复现性

`pnpm build` 首次失败，原因是 `next/font/google` 在构建期请求 Google Fonts 的 `Inter` 失败。容器构建同样会受网络/防火墙影响，所以本 sprint 额外移除构建期字体下载：

- `src/app/layout.tsx` 删除 `next/font/google`。
- `src/app/globals.css` 增加系统字体栈。
- `README.md` 同步说明生产/容器构建不依赖 hosted fonts。

### 验证结果

| 命令 | 结果 | 说明 |
|------|------|------|
| `pnpm build` | pass | Next.js 16.2.6 production build 成功，`/api/health/live` 出现在 route 表 |
| `docker version` | blocked | Docker CLI 存在，但 Docker Desktop Linux daemon 未运行：`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified` |
| `docker compose --env-file .env.container.example -f docker-compose.yml -f docker-compose.local.yml config` | pass | 本地 app + Milvus overlay YAML/变量合成通过 |
| `docker compose -f docker-compose.yml -f docker-compose.cloud.yml config` | pass | 云服务 overlay 默认值为 `openai` + `siliconflow` + `zilliz` + `supabase` |
| `docker build -t rag-system:container-smoke .` | blocked | 需要 Docker daemon；升级审批层拒绝执行，且 daemon 已由 `docker version` 证明不可用 |
| `git diff --check` | pass | 本 sprint 触及文件无 whitespace error；仅 CRLF 工作区提示 |

### 未关闭风险

- Docker image build/run 未完成真实验证，原因是本机 Docker Desktop Linux daemon 未启动且 build escalation 被审批层拒绝。
- `docker-compose.local.yml` 使用固定镜像 tag：`milvusdb/milvus:v2.5.10`、`quay.io/coreos/etcd:v3.5.18`、`minio/minio:RELEASE.2025-04-22T22-12-26Z`；后续云迁移前应按目标环境安全基线刷新镜像 tag。
- `@import` Font Awesome CDN 仍是运行时外部资源，不阻塞 build；若目标云环境完全离线，后续需要本地化图标资源。

### Gate

Phase 3 完成。回复 `go` 进入 Phase 4: Review；或给修改意见先调整实现。
## Phase 4: Review - 审查结果

### 派遣记录

- 评估 risk: L3
- 跑的视角: security, arch, quality, test, integration continuity
- 跳过的视角: perf
- 跳过原因: 本次未改请求热路径、检索算法或渲染性能关键路径；主要风险在部署启动、配置和迁移边界
- Design lens: 静态检查，仅涉及字体栈和 README；无页面布局/交互结构新增
- Status: DONE_WITH_CONCERNS

### Gap Detection Walkthrough

| workflow / invariant | existing coverage | uncovered gap | action |
|----------------------|-------------------|---------------|--------|
| 容器 liveness 不访问外部依赖 | `src/app/api/health/live/route.ts` 只 import `NextResponse`，`pnpm build` route 表包含 `/api/health/live` | none | pass |
| 容器构建不依赖 Google Fonts | `src/app/layout.tsx` 删除 `next/font/google`；`pnpm build` 从失败变为 pass | Font Awesome CDN 仍是运行时外部资源 | P2 residual risk |
| 服务端模式 standalone | `next.config.ts:22` 设置 `output: 'standalone'`；Dockerfile 复制 `.next/standalone` 并运行 `server.js` | `package.json:9` 仍为 `next start`，本地 `pnpm start` 出 Next warning | P1 finding |
| 密钥不进镜像 | `.dockerignore:14-15` 排除 `.env` / `.env.*`；`.env.container.example` 只含 placeholder | none | pass |
| Compose 本地/云迁移配置 | local/cloud `docker compose config` 均 pass | Docker daemon 未运行，无法 build/run 镜像 | residual verification blocker |

### Doc-Code 一致性 Walkthrough

| doc claim | 断言内容 | code 现实 | 状态 | action |
|-----------|----------|-----------|------|--------|
| `docs/deployment/container.md:49` | `/api/health/live` 不访问 RAG/Milvus/LLM/Supabase | `src/app/api/health/live/route.ts:1-9` 只返回 JSON | PASS | none |
| `docs/deployment/container.md:94` | 容器部署走 standalone server output | `next.config.ts:22`, `Dockerfile:29-40` | PASS | none |
| `docs/deployment/container.md:122` | `.dockerignore` 排除 `.env*` | `.dockerignore:14-15` | PASS | none |
| `docs/plans/2026-06-24-containerized-deployment.md:198` | Docker build blocked | `docker version` 输出 daemon pipe 不存在；`docker build` escalation 被拒绝 | PASS | none |

Second pass: none。

### P0 - 必须修复

无。

### P1 - 建议修复

| # | 视角 | 文件:行 | 问题 | 修复建议 |
|---|------|---------|------|----------|
| P1-1 | arch / integration | `package.json:9`, `next.config.ts:22` | 启用 `output: 'standalone'` 后，现有 `pnpm start` 仍调用 `next start`。实测 `pnpm start` 可启动但 Next 16.2.6 明确警告：`next start` 不适用于 standalone，应使用 `node .next/standalone/server.js`。这与 Phase 2 invariant “保持现有 Next.js 服务端运行模式”存在漂移。 | 将 `start` 改为 `node .next/standalone/server.js`，或新增 `start:standalone` 并在 README / container doc 明确 `pnpm start` 不再是 standalone 生产入口。推荐前者，因为当前默认 build 已变成 standalone。 |

### P2 - 可选优化 / 残余风险

| # | 视角 | 文件:行 | 问题 | 修复建议 |
|---|------|---------|------|----------|
| P2-1 | test | 验证环境 | Docker daemon 未运行，`docker build` / `docker run` 无法完成真实镜像验证。当前只有 `pnpm build` 和 compose YAML 验证通过。 | Docker Desktop daemon 可用后补跑 `docker build -t rag-system:container-smoke .` 与 `/api/health/live` 容器 smoke。 |
| P2-2 | quality / deployment | `src/app/globals.css:1` | Font Awesome 仍通过 CDN runtime import。它不阻塞构建，但完全离线云环境会丢图标字体资源。 | 若目标环境要求离线运行，后续把 Font Awesome 本地化或替换为 lucide/react icon。 |

### 5 视角结论

| 视角 | 结论 |
|------|------|
| security | 无硬编码真实密钥；`.dockerignore` 和 `.gitignore` 边界合理；env sample 只用 placeholder |
| arch | 有 1 个 P1：standalone 与 `pnpm start` 契约漂移 |
| quality | Dockerfile/compose/docs 基本清晰；runtime CDN 作为 P2 记录 |
| test | `pnpm build` 和 compose config 覆盖到 L2；Docker build/run 受环境阻塞 |
| integration continuity | 静态导出分支保留；容器 liveness/readiness 分离；P1 未修前不应进入 Compound |

### Gate

Phase 4 Review 初审完成，P1-1 已在 Review 修复记录中收敛。
### Review 修复记录

| Finding | 处理 | 验证 |
|---------|------|------|
| P1-1 standalone 与 `pnpm start` 契约漂移 | `package.json` 的 `start` 改为 `node .next/standalone/server.js`；`docs/deployment/container.md` 增加本机生产启动说明 | `pnpm build` pass；`pnpm start` 启动 standalone server，无 `next start` warning；`Invoke-RestMethod http://localhost:3000/api/health/live` 返回 `{"success":true,"status":"live"}` |

### Review 收敛结论

P1 已修复并验证。P0/P1 清零。残余 P2 仍为：Docker daemon 不可用导致镜像 build/run 未验证；Font Awesome CDN runtime import 在完全离线环境中仍需后续本地化。

### Gate

Phase 4 Review 收敛完成。回复 `go` 进入 Phase 5: Compound。

## Phase 5: Compound - 技术沉淀

### Solution Capture

- 新增 `docs/solutions/2026-06-24-containerized-deployment.md`
- 记录内容：容器化部署背景、根因、落地项、验证命令、经验和残余风险

### Rules Updated

- `.codex/rules/architecture.md`：新增容器部署中 liveness / readiness / runtime secrets 的架构边界
- `.codex/rules/debugging-gotchas.md`：新增 Next standalone 与 `next start` 契约漂移、`next/font/google` 构建期外网依赖的调试经验

### Skill Signals

- `.codex/skill-signals/sprint.jsonl`：新增 1 条 containerized deployment sprint 信号
- `.codex/skill-signals/compound.jsonl`：新增 1 条 containerized deployment compound 信号

### Solution Index

未执行 solution index 同步：本仓库当前没有 `scripts/sync-solution-index.js`，也没有现存 `docs/solutions/index.jsonl`。按 Compound 规则记录为未执行，不伪造索引同步结果。

### Residual Risks

- Docker Desktop Linux daemon 未运行，镜像 `docker build` / `docker run` 尚未完成真实 smoke。
- Font Awesome 仍通过 runtime CDN import；完全离线云环境后续需要本地化图标资源或替换为本地 icon 方案。

### Gate

Sprint 完成。建议在 Docker daemon 可用后补跑容器镜像 smoke，并在任务边界处执行 `/compact`。