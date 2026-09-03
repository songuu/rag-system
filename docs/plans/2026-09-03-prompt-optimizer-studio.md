---
title: "独立提示词优化工作台"
type: sprint
status: planning
created: "2026-09-03"
updated: "2026-09-03"
checkpoints: 0
tasks_total: 8
tasks_completed: 7
tags: [sprint, feature, prompt-optimizer, ui, postgres, deployment]
aliases: ["提示词优化器", "Prompt Optimizer Studio"]
goal: "实现并部署一个独立、完整、可访问可使用的提示词优化页面：参考指定产品与截图，优化历史按版本存 PostgreSQL，模型配置和选择独立于现有系统并支持本地 Ollama 调试。"
goal_max_iter: 3
goal_until: ""
goal_iteration: 0
goal_status: in-progress
invariants:
  - "提示词优化器的模型档案、选择与调用不得读取或修改现有 RAG 模型选择状态；仅允许复用服务器侧供应商凭据作为兼容回退。"
  - "每次模型优化或人工保存都追加不可变 PostgreSQL 版本；历史版本不得原地覆盖。"
  - "所有持久化行都绑定服务器配置的 tenant/corpus，所有 SQL 使用参数化查询。"
  - "模型 API Key 只来自服务器环境变量，禁止写入 PostgreSQL、日志或公共 DTO。"
  - "Ollama 与 loopback HTTP 端点只允许非生产本地调试；生产运行不依赖 Ollama。"
  - "页面在 RAG_BASE_PATH 下使用相对 API 路径，部署后刷新与直达均可用。"
invariant_tests:
  - scripts/migrate-postgres.test.mjs
  - src/lib/postgres/client.test.mjs
  - src/lib/security/request-validation.test.mjs
  - deploy/songuu/postgres-release-contract.test.mjs
deferred: []
deadcode_until: []
---

# 独立提示词优化工作台

## Phase 1：需求分析

### North star

交付一个位于 `/prompt-optimizer` 的独立生产页面。用户能够输入普通或图像提示词，选择独立模型档案，管理 `{{variable}}` 变量，生成并继续迭代优化结果，在版本间切换和比较；刷新页面后，工作区、版本、变量快照与模型选择仍由 PostgreSQL 恢复。最终通过现有 songuu.top 发布链路部署并完成真实访问验收。

### 本次要做

- 新建独立提示词优化页面与首页可发现入口，不把功能塞入现有 RAG 主聊天页。
- 提供通用优化、结构化优化、图像提示词三种模板；结果包含优化文本、改进摘要、变更点和可解释评分。
- 支持 `{{name}}` 变量自动识别、增删改、预览替换，并把每个版本的变量快照一并持久化。
- 支持模型档案的新增、编辑、选择、连通性状态；档案包含 provider、model、base URL、temperature、top-p、max tokens。
- 模型域与当前 `ModelFactory` / `/api/model-config` 解耦；本地支持 Ollama，生产支持 OpenAI、OpenRouter、受部署白名单约束的 OpenAI-compatible endpoint。
- PostgreSQL 保存工作区、不可变版本链和模型档案；列表、详情、追加版本、重命名、删除均走服务端 API。
- 提供历史抽屉、版本时间线、原文/当前/上一版本比较、复制、导出和继续迭代。
- 完成单元、契约、API、数据库、构建、响应式和生产访问验证，并通过现有 GitHub Actions/songuu.top 路径部署。

### 本次不做

- 不生成图片，不上传参考图，不调用 GPT Image 2 生图；图像站点只用于提示词结构与编辑体验参考。
- 不实现提示词市场、社交分享、收藏社区、计费或多人协同。
- 不执行原始/优化提示词的业务 A/B 回答生成；本期比较提示词本身及其质量维度。
- 不修改现有 RAG/MAIC/MiroFish 模型选择语义，也不把新档案注入现有运行时。
- 不在浏览器或 PostgreSQL 中保存供应商 API Key；生产密钥继续由运行时 secret 管理。

### 成功标准

- [x] 页面可从首页进入，也可直达 `/prompt-optimizer`；桌面双栏、窄屏单栏均无横向溢出。
- [x] 使用可用模型档案优化后创建 v1，再迭代创建 v2；切换/比较/刷新后内容和变量快照一致。
- [x] 模型档案独立保存和选择；本地 Ollama 可调用，生产没有 Ollama 时仍可使用远端供应商。
- [x] PostgreSQL schema/readiness/grant/迁移契约与运行时 store/API 全部通过，历史版本不可原地覆盖。
- [x] 空输入、超长输入、非法变量、无模型、模型超时、错误响应和数据库不可用均返回明确且不泄密的错误。
- [ ] 生产构建、发布工作流和 songuu.top 真实页面/API 冒烟全部通过。

### EARS-lite 验收

1. WHEN 用户提交 1–20,000 字符的提示词并选择可用档案，THE SYSTEM SHALL 返回结构化优化结果并原子追加一个 PostgreSQL 版本。
2. WHEN 用户基于任一历史版本继续迭代，THE SYSTEM SHALL 创建父版本可追溯的新版本，旧版本内容保持不变。
3. WHEN 提示词包含合法 `{{variable_name}}`，THE SYSTEM SHALL 检出变量、允许编辑值，并把解析后的变量快照与版本同时保存；非法名称不得进入调用。
4. WHEN 非生产环境选择 Ollama，THE SYSTEM SHALL 允许 loopback/host.docker.internal 端点；WHEN 生产环境读取同一历史档案，THE SYSTEM SHALL 在调用边界重新校验并拒绝本地端点。
5. WHEN 页面刷新或从历史记录打开工作区，THE SYSTEM SHALL 从 PostgreSQL 恢复原文、所有版本、当前选择、变量和模型档案元数据。
6. WHEN 供应商超时、返回非法结构或数据库不可用，THE SYSTEM SHALL 返回稳定错误码和中文操作提示，且响应/日志不得包含 API Key、完整供应商错误或私有端点凭据。

### 输入边界与失败模式

| 维度 | 冻结规则 |
|---|---|
| 提示词 | trim 后 1–20,000 字符；迭代说明 0–2,000 字符 |
| 变量 | `{{[A-Za-z_][A-Za-z0-9_]{0,63}}}`；最多 50 个；单值最多 4,000 字符 |
| 工作区/历史 | 默认返回最近 30 个工作区；每工作区版本按升序，服务端上限 200 |
| 模型参数 | temperature 0–2；top-p 0–1；max tokens 128–16,384；timeout 1–180 秒 |
| 数据库不可用 | API 503，页面保留当前未提交文本并给出重试提示，不伪装为已保存 |
| 模型失败 | 不追加优化版本；已创建的 v0 工作区可继续重试 |
| 并发优化 | 数据库原子递增版本号；同一父版本可产生并列后继但版本号不冲突 |
| 首次空状态 | 提供示例提示词、模板说明与“新建优化”主操作 |

### 原型/视觉 Preflight

| 项 | 结果 | 处理 |
|---|---|---|
| 设计上下文 | 两张用户截图 + 4 个参考 URL + prompt-optimizer 源码 | 作为结构和交互基线，不复制上游实现 |
| 视觉截图 | 已获取原始 1467×1251 与 1467×1251 附件 | 第一张主导工作台密度；第二张主导纸张/墨色与复制体验 |
| 变量/样式 | 无 Figma Variables/Styles | 建立本页 CSS token fallback，不在业务 JSX 散落颜色/间距 |
| 组件映射 | 无 Code Connect；项目有 Radix Dialog、Lucide | Dialog/图标复用依赖，其余为本页原生组件 |
| 响应式 | 只提供桌面截图 | 断点为工程假设：≥1180 双栏，<1180 上下堆叠，<720 抽屉全屏 |
| 交互态 | 截图未覆盖 hover/focus/disabled/loading | 按 WCAG/项目通用规则补齐并作为验证项 |

### 布局结构

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Prompt Atelier  新建   模式切换        历史   模型档案   返回 RAG   │
├──────────────────────────────┬───────────────────────────────────────┤
│ 原始提示词 / 变量            │ 优化结果 / 版本时间线                 │
│ ┌──────────────────────────┐ │ v0 ─ v1 ─ v2        比较/复制/导出   │
│ │ 编辑器 + 自动变量标记    │ │ ┌───────────────────────────────────┐ │
│ └──────────────────────────┘ │ │ 优化正文（纸张视觉）                │ │
│ 模板 · 模型 · 参数 · 优化    │ │ 摘要 / 变更 / 评分                   │ │
│ 变量表 / 替换预览            │ └───────────────────────────────────┘ │
│ 迭代要求                     │ 原文 ↔ 上一版本 ↔ 当前版本比较         │
├──────────────────────────────┴───────────────────────────────────────┤
│ 保存状态 / PostgreSQL / provider / token usage / 错误提示           │
└──────────────────────────────────────────────────────────────────────┘
```

### 交互方案

| 操作 | 结果 | 置信度 |
|---|---|---|
| 输入 `{{变量}}` | 自动生成变量行并在预览中替换 | ✅ 截图与上游源码确认 |
| 点击优化 | 调用选中独立模型，成功后追加新版本并切换到该版本 | ✅ 用户要求 |
| 填写迭代要求再优化 | 以当前版本为 parent 生成下一版本 | ✅ 上游产品行为 |
| 点击版本节点 | 加载该不可变版本；可选“从此版本继续” | ✅ 版本存储要求 |
| 点击比较 | 展开原文/上一版本/当前版本三列文本比较 | ⚡ 工程假设 |
| 打开模型档案 | 抽屉内新增/编辑/设默认/检测配置状态 | ✅ 用户要求 + 截图 |
| 删除工作区/档案 | 二次确认；有关联版本的档案采用 restrict，不级联删历史 | ⚡ 安全假设 |

### 状态方案

| 状态 | 页面方案 | 置信度 |
|---|---|---|
| 首次使用 | 示例卡 + 空白编辑器 + 本地/生产模型配置提示 | ⚡ 工程假设 |
| 优化中 | 输入保持可读，按钮进度，结果区骨架；禁止重复提交 | ✅ 通用行为 |
| 已保存 | 底栏显示“已保存 vN”及时间 | ⚡ 工程假设 |
| 未保存编辑 | 明确“未保存”标记，可恢复最近服务端版本 | ⚡ 工程假设 |
| 模型不可用 | 档案标记 unavailable，并引导打开模型档案 | ✅ 用户可操作性 |
| 数据库不可用 | 非阻断文本编辑；禁用会伪装持久化的动作 | ✅ 持久化要求 |

### 数据结构推断

```text
prompt_optimizer_model_profiles 1 ─────< prompt_optimizer_versions
prompt_optimizer_workspaces     1 ─────< prompt_optimizer_versions

workspace: tenant/corpus/workspace_id/title/original_prompt/current_version
version:   workspace_id/version_number/parent_version/kind/prompt/analysis/
           variables_snapshot/model_profile_id/template_id/created_at
profile:   profile_id/name/provider/model/base_url/settings/is_default/version
```

### 假设汇总

1. 独立路由为 `/prompt-optimizer`，首页增加入口。
2. “完整”指优化、迭代、变量、版本历史、比较、复制/导出和模型档案；不含实际生图与回答 A/B 执行。
3. 自定义模型设置保存非密钥元数据；API Key 由服务器环境变量管理，不在 UI/PG 中保存。
4. 生产只允许远端 HTTPS 固定供应商或环境白名单 origin；Ollama/HTTP 仅本地开发。
5. 当前单租户 tenant/corpus 是隔离边界；不新增账号体系。
6. 页面从两张图吸收信息架构与视觉语言，但不是对第三方页面做逐像素复制。

## Phase 2：技术方案

### 入场扫描 - Invariants 继承

| 子系统 | 既有 invariant | 本 Sprint 如何保持 |
|---|---|---|
| Runtime configuration | 持久化模型选择是不可信输入；凭据/私有端点服务端所有 | profile 每次读/用重新校验；DTO allowlist；密钥只读 env |
| PostgreSQL | PostgreSQL 是业务持久化面；tenant/corpus 范围、参数化 SQL | 三表均复合 scope；store 封装参数化查询；迁移/readiness/grant 同步 |
| Production activation | library seam 不等于上线；需真实 caller、gate、fallback、文档与 route 回归 | 页面→API→store→provider→version 全链，最后生产 smoke |
| Container deployment | standalone、readiness、runtime secret 分层 | 更新预期 schema、发布契约与 env 示例；不把 key 烘焙进 artifact |
| Final gates | 最后源码修改后重跑 build 并检查产物 | build/postbuild、route NFT/standalone、公开 URL 最终执行 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|---|---|---|---|---|
| 新工作区 | 输入后首次优化/显式新建 | UI → workspace API → store | ✅ PostgreSQL | ✅ 历史与 v0 |
| 优化版本 | 点击优化/迭代 | optimize API → profile validator → provider client → append | ✅ 不可变 version | ✅ 版本时间线 |
| 变量 | 自动检测/编辑 | client validator → optimize request → version snapshot | ✅ JSONB snapshot | ✅ 随版本恢复 |
| 模型档案 | 新增/编辑/设默认 | model API → profile store | ✅ PostgreSQL | ✅ 选择器恢复 |
| 生产配置 | GitHub workflow 发布 | standalone artifact → release migration → PM2/nginx | ✅ PG schema + runtime env | ✅ `/rag-system/prompt-optimizer` |

所有链路在本 Sprint 收口，无 feature-gated dead code。

### 入场扫描 - 半完成债务清单

| 来源 Sprint | 议题 | 本 Sprint 决策 | deadline |
|---|---|---|---|
| 现有 active MiroFish/PDF Sprint | 文档解析、Milvus、模型选择相关未提交改动 | 不触碰；本功能新命名空间实现，构建时仅记录其基线影响 | n/a |
| 前置提示词优化 Sprint | 无 | 无需继承 | n/a |

### 方案概述

采用“独立 bounded context + 服务端 PostgreSQL + 供应商适配器”的实现。React 页面只持有编辑草稿和 UI 状态；工作区、版本链、变量快照和模型档案以 PostgreSQL 为事实源。API route 调用纯服务层，服务层在每次使用档案时重新校验 provider/model/base URL/参数，并从独立 `PROMPT_OPTIMIZER_*` 环境或兼容的服务器供应商密钥读取凭据。

优化结果要求模型返回 JSON contract；解析器先做精确 JSON，再处理 fenced JSON，最后把非结构化文本作为优化正文并生成保守元数据，避免模型格式漂移让版本丢失。追加版本使用单条 PostgreSQL data-modifying CTE 原子递增版本号，历史行只 insert、不 update。

UI 采用“墨色编辑台 + 暖象牙纸张”的编辑出版物方向：左侧是原文、变量、模型与迭代控制，右侧是版本和结构化结果；不使用紫色渐变或通用 hero 卡片。视觉值集中在 CSS module token，Radix Dialog 负责可访问抽屉/弹窗，Lucide 提供图标。

### 模型契约

| Provider | 生产端点 | 凭据来源 | 本地行为 |
|---|---|---|---|
| openai | 固定 `https://api.openai.com/v1` 或部署白名单 origin | `PROMPT_OPTIMIZER_OPENAI_API_KEY`，兼容回退 `OPENAI_API_KEY` | 同生产 |
| openrouter | 固定 `https://openrouter.ai/api/v1` | `PROMPT_OPTIMIZER_OPENROUTER_API_KEY`，兼容回退 `OPENROUTER_API_KEY` | 同生产 |
| compatible | profile base URL 必须命中 `PROMPT_OPTIMIZER_ALLOWED_MODEL_ORIGINS` | `PROMPT_OPTIMIZER_COMPATIBLE_API_KEY`，兼容回退 `CUSTOM_API_KEY` | 可用显式本地开发 origin |
| ollama | 生产调用边界拒绝 | 无 | 默认 `http://localhost:11434` 或 `host.docker.internal`，使用 `/api/chat` |

### 任务拆解

- [x] **Task 1**：先写迁移/授权/readiness 失败测试，再新增 `0003_prompt_optimizer.sql` 三表与同步契约 — 文件：`db/postgres/migrations/0003_prompt_optimizer.sql`, `scripts/migrate-postgres.mjs`, `scripts/migrate-postgres.test.mjs`, `src/lib/postgres/client.ts`, `src/lib/postgres/client.test.mjs`, `deploy/songuu/postgres-release-contract.test.mjs` — 风险：L4 — `[P]` 否，迁移链和授权同一契约。
- [x] **Task 2**：实现类型、输入校验、变量解析、结构化输出解析、PostgreSQL store 与原子版本追加 — 文件：`src/lib/prompt-optimizer/contracts.ts`, `src/lib/prompt-optimizer/contracts.test.mjs`, `src/lib/prompt-optimizer/store.ts`, `src/lib/prompt-optimizer/store.test.mjs` — 风险：L3 — `[P]` 否，依赖 Task 1 schema。
- [x] **Task 3**：实现独立模板与模型 provider 客户端，含生产/本地端点策略、超时、错误净化 — 文件：`src/lib/prompt-optimizer/templates.ts`, `src/lib/prompt-optimizer/providers.ts`, `src/lib/prompt-optimizer/providers.test.mjs`, `.env.container.example` — 风险：L3 — `[P]` 否，安全边界需串行审查。
- [x] **Task 4**：实现模型档案、工作区、版本与 optimize API 及 route 契约测试 — 文件：`src/app/api/prompt-optimizer/**`, `src/lib/prompt-optimizer/service.ts`, `src/lib/prompt-optimizer/service.test.mjs` — 风险：L3 — `[P]` 否，依赖 Task 2–3。
- [x] **Task 5**：实现独立响应式工作台、变量管理、版本时间线/比较、历史与模型抽屉 — 文件：`src/app/prompt-optimizer/page.tsx`, `src/components/prompt-optimizer/PromptOptimizerStudio.tsx`, `src/components/prompt-optimizer/PromptOptimizerStudio.module.css` — 风险：L2 — `[P]` 否，共享同一 studio 状态契约。
- [x] **Task 6**：接首页入口、basePath helper、部署 env/default/profile 配置与使用文档；生成 checkpoint — 文件：`src/app/page.tsx`, `.env.container.example`, `docs/prompt-optimizer.md`, 本 Sprint 文档 — 风险：L2/L3 — `[P]` 否，依赖完整 API/UI 路径。
- [x] **Task 7**：执行 L3/L4 验证：target tests、PostgreSQL 迁移/集成、Ollama 或 mock provider smoke、lint/typecheck/build、同视口截图和响应式交互检查；修复 P0 — 文件：测试/视觉基线与必要修复文件 — 风险：L3 — `[P]` 否，最终组合门。
- [ ] **Task 8**：触发现有 GitHub Actions 发布，等待生产迁移/PM2/nginx/健康门完成，并从公开 URL 验证新页、模型档案与 v0→v1→v2 PostgreSQL 恢复 — 文件：`.github/workflows/deploy.yml`（仅发现缺口时修改）、Sprint 验证记录 — 风险：L4 — `[P]` 否，对外发布强制人工 gate。

Task 数 > 5：Task 5 完成后创建 checkpoint，再继续 Task 6。

### 测试策略

- 单元：变量语法、边界值、模板选择、结构化/非结构化模型输出、端点与 provider revalidation、错误净化。
- Store/迁移：三表约束、scope、参数化查询、原子版本号、不可变历史、profile restrict、readiness checksum、应用/只读角色权限。
- API：合法/非法 payload、503 数据库、404 workspace/profile、模型超时/非法响应、成功追加、密钥/私有错误不出 DTO。
- UI：纯状态 reducer/contract、空/加载/错误/已保存状态、版本切换、变量替换、窄屏；运行后浏览器截图和键盘操作。
- 集成：真实本地 PostgreSQL 执行 0001→0003；可用 Ollama 时走一次真实优化，否则用 mock OpenAI-compatible fixture 并把 Ollama 标为环境阻塞。
- 最终：最后源码编辑后 `pnpm exec tsc --noEmit --pretty false`、scoped ESLint、target tests、`pnpm build`、standalone smoke、生产 URL/API smoke。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 新迁移破坏现有发布/readiness | 中 | 高 | 失败测试先行；checksum、grant、release contract 同步；真实 PG rehearsal |
| 自定义 endpoint 造成 SSRF/密钥泄露 | 中 | 高 | 生产固定/allowlist origin；loopback 仅 dev；凭据 env-only；错误与 DTO allowlist |
| 模型 JSON 漂移 | 高 | 中 | exact→fenced→plain fallback；所有路径有解析测试，不因元数据失败丢正文 |
| 并发创建重复版本 | 中 | 高 | 单 SQL 原子 bump+insert，唯一复合键，冲突测试 |
| 新页面体积和重渲染过重 | 中 | 中 | server page 薄壳、client state 模块化、无 barrel、并行初始 fetch、memo/primitive deps |
| 参考图只有桌面态 | 高 | 中 | 明示响应式假设，补 1180/720 断点与浏览器验证 |
| 现有未提交 RAG 改动影响全量测试 | 中 | 中 | 不修改其文件；targeted gates 优先；全量失败标注归属且不覆盖用户改动 |
| 发布需要远端副作用 | 高 | 高 | 按 auto-mode 在 push/workflow/deploy 前保留人工 gate；部署后不可用则不宣称完成 |

### 预期涉及文件

- `db/postgres/migrations/0003_prompt_optimizer.sql`
- `scripts/migrate-postgres.mjs` 与相关 migration/release tests
- `src/lib/postgres/client.ts` 与测试
- `src/lib/prompt-optimizer/*`
- `src/app/api/prompt-optimizer/**`
- `src/app/prompt-optimizer/page.tsx`
- `src/components/prompt-optimizer/*`
- `src/app/page.tsx`
- `.env.container.example`、必要的 `deploy/songuu/*` 契约与使用文档

### 置信度

技术方案 0.86。开放项只剩产品假设 2–4（功能边界、API Key 策略、生产 endpoint 策略）；当前选择符合用户目标与项目既有安全规则。由于 Task 1/8 为 L4 且包含迁移与正式发布，Plan→Work 与最终部署都必须保留人工 gate。

## Phase 3：实施记录

Task 1–6 已完成：新增 PostgreSQL 0003 迁移和最小权限；完成变量/结构化输出/原子版本 store；完成三类模板、独立 provider、API、独立响应式页面、首页入口与部署说明。生产 build 通过；一次性 PostgreSQL 完成 0001–0003 迁移，真实 Ollama 生成 v1，生产 API 手动追加 v2 并恢复 CURRENT=2。

## Phase 4：审查结果

待实施完成后由 security / architecture / quality / test / design + 集成连续性视角审查。

## Phase 5：复利记录

待完成。

## References

- https://prompt.always200.com/#/pro/variable
- https://github.com/linshenkx/prompt-optimizer
- https://youmind.com/zh-CN/gpt-image-2-prompts
- https://github.com/ZeroLu/awesome-gpt-image
