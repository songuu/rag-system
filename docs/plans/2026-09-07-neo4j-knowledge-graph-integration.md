---
type: sprint
status: in-progress
tasks_completed: 16
tasks_total: 18
task_ids: ["T0","T1","T2","T3","T4","T5","T6","T7","T8","T9","T10","T11","T12","T13","T14","T15","T16","T17"]
open_task_ids: ["T16","T17"]
---

# Neo4j 完整知识图谱接入计划

- 状态：in-progress（16/18）；仅 T0-T15 核心 Neo4j 能力完成，T16/T17、本地 production gate tooling、正文可点击引用及生产验收均未完成，当前不具备 `active` 上线结论
- 日期：2026-09-07
- 范围：知识图谱构建、持久化、版本发布、检索、来源追溯、管理与运维
- 原则：Milvus 继续负责 Passage 向量检索；Neo4j 负责实体、事实、社区和路径；Postgres 负责发布控制和任务状态

## Sprint Think Frame

### 要做

- 在不替换 Milvus 的前提下，补齐 Neo4j 图谱持久化、版本发布、受限多跳检索、原文溯源、管理 API/UI 和故障降级。
- 复用现有 Entity Extraction、MiroFish Artifact 生命周期、RAG Lane、Evidence 和 Retrieval Scope 契约。
- 本地提供可重复启动的 Neo4j 运行环境；生产连接保持配置化，不绑定 Community、Enterprise 或 Aura 专有能力。
- 通过版本化 STAGING/ACTIVE 发布与幂等写入保证迁移可恢复。

### 不做

- 不替换 Milvus Passage 向量检索，不删除现有文件图谱，不执行生产部署或不可逆数据清理。
- 不开放任意 Cypher，不允许 LLM 生成的查询直接进入驱动。
- 第一版不依赖 Neo4j GDS、跨知识库图谱或 Neo4j 专有集群能力。

### 可观察成功标准

1. **WHEN** 应用或 Neo4j 重启，**THE SYSTEM SHALL** 保留已发布图谱，并能恢复同一 Active Snapshot。
2. **WHEN** 关系型或多跳问题触发 Graph Lane，**THE SYSTEM SHALL** 返回经过 tenant/corpus/trust/version 校验且能追溯到 Passage 的 `RagEvidence`。
3. **WHEN** Neo4j 超时、断连或查询预算耗尽，**THE SYSTEM SHALL** 显式记录降级，并在 Dense Evidence 足够时继续完成问答。
4. **WHEN** 同一图谱版本被重复构建、导入或重放，**THE SYSTEM SHALL** 保持节点、事实和来源关系幂等，不产生重复数据。
5. **WHEN** 新图谱版本构建或校验失败，**THE SYSTEM SHALL** 不切换 Active Snapshot，并允许继续读取上一稳定版本。

### 风险与可撤销假设

- 默认本地使用固定版本 Neo4j Docker、单 Database、属性级多租户；实现不得依赖特定商业版能力。
- 图谱规模和生产部署形态未知，第一版以查询预算、分页和端口抽象保留扩展空间。
- Postgres 作为发布控制面是推荐目标；若现有持久层暂不适合新增表，先提供接口与本地实现，但不得弱化版本一致性契约。
- 历史数据迁移只实现和验证幂等工具；在没有单独数据备份与范围确认前，不执行真实清理或覆盖。

## 1. 方案结论

采用“Postgres 控制面 + Milvus 向量检索 + Neo4j 图检索”的三层架构。

Neo4j 不替换 Milvus，也不直接接管最终回答的原文证据。Milvus 继续负责 Passage 语义召回，Neo4j 负责实体、事实、社区、多跳路径和图谱查询；两者通过稳定的 `passageId`、文档版本和租户作用域关联，并在现有 RAG 检索内核中融合。

目标闭环：

```text
文档解析
  → Passage 切块与向量化
  → 实体/关系/事实抽取
  → 实体消歧与社区发现
  → Neo4j 版本化持久化
  → Shadow/Active 发布
  → 图谱检索与多跳推理
  → Passage 原文溯源
  → RAG 证据融合与回答
  → 图谱浏览、审计和运维
```

## 2. 已验证现状

| 能力 | 当前实现 | 差距 |
|---|---|---|
| 实体/关系抽取 | `src/lib/entity-extraction.ts` 已有实体、关系、社区抽取 | 可以复用，但缺少持久化发布闭环 |
| 普通知识图谱 | `src/app/api/entity-extraction/route.ts` 使用进程内缓存 | 重启丢失，不适合多实例 |
| MiroFish 图谱 | `src/lib/mirofish/graph-artifact-store.ts` 提供版本、作用域、激活和回收能力 | 当前主要使用文件存储 |
| 图检索 | `src/lib/rag/retrieval/graph-entity-lane.ts` 在 Node.js 内加载和遍历图谱 | 图谱增大后内存和延迟不可控 |
| 检索编排 | `src/lib/rag/retrieval/retrieval-plan.ts` 已有 `graph-entity` Lane | 目前主要面向 MiroFish global/multi-hop 场景 |
| 安全隔离 | `src/lib/security/retrieval-scope.ts` 已定义 tenant/corpus/trust 契约 | Neo4j 每条查询都必须复用相同约束 |
| 证据校验 | `src/lib/rag/retrieval/lane-executor.ts` 已验证 Evidence 作用域 | 图检索结果应继续进入该校验层 |

## 3. 目标与非目标

### 3.1 目标

1. 图谱数据在 Neo4j 中可靠持久化，应用重启后不丢失。
2. 支持实体、事实、来源、社区、邻居和多跳路径查询。
3. 每条进入 LLM 上下文的图谱证据都能追溯到原始 Passage。
4. 支持租户、知识库、文档版本和可信级别隔离。
5. 支持 STAGING、ACTIVE、SUPERSEDED、FAILED 生命周期。
6. 图谱重建期间继续使用上一稳定版本。
7. Neo4j 故障时普通 Milvus 检索仍能工作。
8. 支持图谱构建进度、版本比较、激活、回滚和清理。
9. 图谱管理页面按需加载局部子图，不加载整个图谱。

### 3.2 第一阶段非目标

1. 不使用 Neo4j 替换 Milvus。
2. 不开放任意 Cypher 查询接口。
3. 不允许 LLM 直接生成并执行 Cypher。
4. 不实现跨租户或跨知识库图谱连接。
5. 不强制引入 Neo4j GDS。
6. 不立即删除现有文件图谱。
7. 不立即迁移全部历史图谱。

## 4. 目标架构

```text
                       ┌────────────────────────┐
文件上传 ──────────────>│ 文档解析 / Passage 切块 │
                       └───────────┬────────────┘
                                   │
               ┌───────────────────┴───────────────────┐
               │                                       │
               ▼                                       ▼
       ┌───────────────┐                    ┌────────────────────┐
       │    Milvus     │                    │ 知识抽取与实体消歧 │
       │ Passage 向量  │                    └─────────┬──────────┘
       │ 原文与元数据  │                              ▼
       └───────┬───────┘                    ┌────────────────────┐
               │                            │       Neo4j        │
               │                            │ Entity / Claim     │
               │                            │ Community / Path   │
               │                            └─────────┬──────────┘
               │                                      │
               └──────────────┬───────────────────────┘
                              ▼
                    ┌────────────────────┐
用户问题 ──────────>│ RAG Retrieval Plan │
                    │ Dense + Graph Lane │
                    └─────────┬──────────┘
                              ▼
                    证据校验、融合、去重
                              ▼
                       LLM 带来源回答

Postgres：构建任务、Outbox、发布状态、Active Snapshot、审计记录
```

## 5. 数据所有权与一致性

| 数据 | 权威来源 | Neo4j 中的形态 |
|---|---|---|
| 原始文件 | 当前文件或对象存储 | 文件引用和内容哈希 |
| Passage 内容 | 当前 Passage 存储/Milvus 投影 | Passage 标识、位置、摘要或可选短文本 |
| Passage 向量 | Milvus | 默认不重复保存 |
| 实体、事实、路径 | Neo4j | 权威图结构 |
| 构建任务 | Postgres | Neo4j 只保留构建版本引用 |
| Active Snapshot | Postgres | 检索请求使用的权威版本号 |
| 文件图谱 | 现有 Artifact Store | 迁移期回滚副本 |

Milvus、Neo4j 和控制面必须共享：

```text
tenantId
corpusId
documentId
documentVersion
passageId
trustLevel
graphVersion
```

同一次问答开始时解析一次 Active Snapshot，并将同一个 `graphVersion` 传给所有检索 Lane，避免请求过程中版本漂移。

## 6. Neo4j 图模型

### 6.1 节点

```text
(:GraphSnapshot)
(:DocumentVersion)
(:Passage)
(:Entity)
(:Claim)
(:Community)
```

### 6.2 关系

```text
(GraphSnapshot)-[:CONTAINS]->(DocumentVersion)
(DocumentVersion)-[:HAS_PASSAGE]->(Passage)
(Passage)-[:MENTIONS]->(Entity)

(Entity)-[:SUBJECT_OF]->(Claim)
(Claim)-[:OBJECT]->(Entity)
(Claim)-[:SUPPORTED_BY]->(Passage)

(Entity)-[:IN_COMMUNITY]->(Community)
(Community)-[:PARENT_OF]->(Community)

(DocumentVersion)-[:SUPERSEDES]->(DocumentVersion)
```

### 6.3 Claim 设计

LLM 抽取的关系不直接转换成动态关系类型，而是使用 `Claim` 节点保存：

- `claimId`
- `predicate`
- `fact`
- `confidence`
- `validFrom` / `validTo`
- `status`
- `extractionModel`
- `promptVersion`
- `createdAt`
- 冲突、失效和替代信息

这样可以支持一个事实对应多个来源、事实时效性和冲突治理，同时避免关系类型无限增长和动态 Cypher 注入。

### 6.4 唯一性约束

```text
Entity:          tenantId + corpusId + entityKey
Passage:         tenantId + corpusId + passageId
Claim:           tenantId + corpusId + claimId
Community:       tenantId + corpusId + communityId
DocumentVersion: tenantId + corpusId + documentId + documentVersion
GraphSnapshot:   tenantId + corpusId + graphVersion
```

普通索引至少覆盖：

- `GraphSnapshot.status`
- `DocumentVersion.documentId`
- `Entity.normalizedName`
- `Entity.entityType`
- `Claim.predicate`
- `Claim.status`
- 所有查询所需的 tenant/corpus/version 字段

全文索引用于 Entity 的 `name`、`aliases` 和 `description`。Neo4j 向量索引仅作为后续实体匹配增强，不作为 Passage 主召回。

## 7. 应用接口边界

新增四个端口：

```ts
interface KnowledgeGraphCommandStore {
  stageGraph(input: StageGraphInput): Promise<StageGraphResult>;
  publishGraph(input: PublishGraphInput): Promise<PublishGraphResult>;
  deleteGraph(input: DeleteGraphInput): Promise<void>;
  getBuildStatus(input: GetBuildStatusInput): Promise<GraphBuildStatus>;
}

interface KnowledgeGraphQueryPort {
  searchEntities(input: EntitySearchInput): Promise<EntitySearchResult>;
  getNeighbors(input: NeighborQueryInput): Promise<NeighborQueryResult>;
  findPaths(input: PathQueryInput): Promise<PathQueryResult>;
  searchCommunities(input: CommunitySearchInput): Promise<CommunitySearchResult>;
}

interface GraphRetrievalPort {
  retrieveGraphEvidence(input: GraphRetrievalInput): Promise<GraphRetrievalResult>;
}

interface PassageEvidenceResolver {
  resolvePassages(input: ResolvePassagesInput): Promise<RagEvidence[]>;
}
```

职责边界：

- `KnowledgeGraphCommandStore`：写入和版本生命周期。
- `KnowledgeGraphQueryPort`：管理页面和图谱探索。
- `GraphRetrievalPort`：面向 RAG 的有界图查询。
- `PassageEvidenceResolver`：将路径上的 `passageId` 还原为原文证据。

`graph-entity` Lane 改为依赖 `GraphRetrievalPort`，不能通过 Store 读取整个图谱后在 Node.js 中遍历。

## 8. 图谱构建流程

```text
1. 文档解析和 Passage 切块
2. 生成稳定 passageId 和 documentVersion
3. Passage 写入 Milvus STAGING 版本
4. LLM 抽取 Entity、Mention、Claim
5. Entity Resolution 归并别名与重复实体
6. Claim 规范化、置信度计算和来源绑定
7. 社区发现与社区摘要
8. Neo4j 批量写入 STAGING GraphSnapshot
9. 校验节点、关系、来源、作用域和孤立数据
10. Postgres CAS 激活新版本
11. 新请求开始使用新 graphVersion
12. 旧版本进入保留期并异步回收
```

写入 ID 必须是确定性的，使同一版本重复执行不会创建重复数据。

## 9. RAG 图检索流程

### 9.1 普通问题

```text
问题 → Milvus Dense/Hybrid → RagEvidence → LLM
```

默认不请求 Neo4j，避免给简单问题增加延迟。

### 9.2 实体、关系和多跳问题

```text
1. Router 将问题分类为 entity / relation / multi-hop
2. Milvus 召回 Passage
3. 从 Passage 元数据读取 entityIds
4. 通过 Neo4j 实体名称和别名索引补充种子实体
5. 在 Neo4j 中执行最多 1～2 跳的固定查询模板
6. 对候选路径进行关系权重、来源数和可信度排序
7. 从 Claim 的 SUPPORTED_BY 取得 passageId
8. PassageEvidenceResolver 获取原文
9. 转换为统一 RagEvidence
10. 进入现有 scope/trust 校验、融合、去重和 Abstention
11. 组装上下文并生成带来源回答
```

限制参数：

- `maxHops`
- `maxSeedEntities`
- `maxPaths`
- `maxClaims`
- `maxPassages`
- `queryTimeoutMs`
- `maxTraversalOperations`

Neo4j 超时或不可用时，Graph Lane 返回明确的 degraded 状态；只要 Dense Lane 有足够证据，问答请求不应返回 500。

## 10. 版本发布与跨数据库一致性

Milvus、Neo4j 和 Postgres 无法共享一个事务，因此采用 Saga + Outbox：

```text
1. Postgres 创建 GraphBuildJob
2. 生成 graphVersion 和 contentHash
3. 写入 Milvus STAGING
4. 写入 Neo4j STAGING
5. 执行完整性校验
6. Postgres 使用 CAS 更新 Active Snapshot
7. 记录 Published 事件
8. 新检索请求使用新版本
9. 旧版本保留并异步清理
```

失败原则：

- 任一步失败都不激活新版本。
- 上一 ACTIVE 版本保持可读。
- Outbox 事件可安全重放。
- STAGING 数据可恢复或定向删除。
- 不允许在未验证的情况下直接双写并覆盖当前版本。

## 11. API 规划

建议新增：

```text
GET    /api/knowledge-graph/health
GET    /api/knowledge-graph/snapshots
POST   /api/knowledge-graph/snapshots/rebuild
POST   /api/knowledge-graph/snapshots/:version/activate
DELETE /api/knowledge-graph/snapshots/:version

GET    /api/knowledge-graph/entities
GET    /api/knowledge-graph/entities/:id
GET    /api/knowledge-graph/entities/:id/neighbors
POST   /api/knowledge-graph/paths/search
GET    /api/knowledge-graph/communities
GET    /api/knowledge-graph/claims/:id/sources
```

所有 API：

- 从服务端安全上下文解析 tenant/corpus，不能相信请求体中的身份字段。
- 强制分页和结果上限。
- 返回稳定错误码和 traceId。
- 不返回 Neo4j 密码、连接串或原始内部异常。
- 不接受任意 Cypher。

## 12. UI 规划

复用现有实体抽取页面和 `KnowledgeGraphViewer`，改造成服务端驱动的图谱浏览器：

1. 图谱构建任务和进度。
2. Snapshot 版本列表、状态、当前 ACTIVE 版本。
3. 实体搜索和类型过滤。
4. 点击实体后按需加载一跳/两跳邻居。
5. 两实体之间的路径查询。
6. Claim 详情、置信度和来源 Passage。
7. 社区层级与社区摘要。
8. 文档、版本、可信级别筛选。
9. Shadow/Active 状态和 Neo4j 健康状态。
10. 激活、回滚、重建等高风险操作的显式确认。

前端不得一次请求整个图谱。

## 13. 配置与运行环境

建议配置：

```env
NEO4J_URI=neo4j://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=change-me
NEO4J_DATABASE=neo4j

RAG_GRAPH_BACKEND=neo4j
RAG_GRAPH_MODE=shadow
RAG_GRAPH_MAX_HOPS=2
RAG_GRAPH_QUERY_TIMEOUT_MS=3000
NEO4J_MAX_TRANSACTION_RETRY_MS=1000
RAG_GRAPH_MAX_ENTITIES=100
RAG_GRAPH_MAX_CLAIMS=300
```

运行规则：

- 应用进程复用一个 Neo4j Driver。
- 每次操作创建并关闭 Session。
- 使用 `executeRead` 和 `executeWrite`。
- 所有值使用 Cypher 参数，禁止字符串拼接。
- Docker 内部连接使用服务名和 `7687` 端口。
- 宿主机连接使用 `127.0.0.1:7687`。
- Neo4j 镜像必须固定测试过的版本，禁止使用 `latest`。
- 密码只能存在服务端环境变量或 Secret Manager。

## 14. 有序实施任务

| ID | 目标 | 文件集合 | 前置依赖 | 风险 | 完成证据 |
|---|---|---|---|---:|---|
| T0 | 冻结现有行为和性能基线 | 现有 graph/retrieval 测试、基准样本 | 无 | L1 | 当前测试、简单问答和多跳问答基线已记录 |
| T1 | 定义图模型、版本模型和端口契约 | 新增 `src/lib/knowledge-graph/contracts.ts`、本计划 | T0 | L2 | 契约测试通过；现有 Artifact 可无损映射 |
| T2 `[P]` | 增加本地 Neo4j 基础设施 | `docker-compose*.yml`、`.env.container.example` | T1 | L2 | 健康检查通过；重启后数据保留 |
| T3 `[P]` | 增加 Driver、配置和健康检查 | 新增 `src/lib/neo4j/config.ts`、`driver.ts`、`health.ts` | T1 | L2 | 连接、超时、关闭和敏感信息隐藏测试通过 |
| T4 | 建立 Schema、约束和索引 | 新增 `src/lib/neo4j/schema.ts` 及测试 | T2、T3 | L3 | 初始化幂等；重复数据显式失败；索引 ONLINE |
| T5 | 实现 Neo4j Command Store | 新增 `neo4j-command-store.ts` | T4 | L3 | 批量写入、事务回滚、重复写入测试通过 |
| T6 | 增加 Postgres 发布控制和 Outbox | `src/lib/persistence/*`、新增 publication 模块 | T1 | L4 | CAS、重放、部分失败恢复测试通过 |
| T7 | 接入文档构建管线 | `src/lib/document-pipeline.ts`、图谱构建适配器 | T5、T6 | L4 | Milvus/Neo4j 版本一致；失败版本不激活 |
| T8 | 实现历史 Artifact 导入器 | 新增 importer 和 CLI 脚本 | T5、T6 | L4 | 重跑幂等；节点、来源和哈希一致 |
| T9 | 实现图谱查询端口 | 新增 `neo4j-query-port.ts` | T4 | L3 | 实体、邻居、路径、社区查询测试通过 |
| T10 | 实现 RAG Graph Retrieval Port | 新增 `neo4j-retrieval.ts`、Passage resolver | T9 | L3 | 只返回 Passage-backed Evidence |
| T11 | 改造 Graph Lane | `graph-entity-lane.ts` 及测试 | T10 | L3 | 不再加载完整图谱；预算和取消信号生效 |
| T12 | 调整 Router 与 Ask API | retrieval plan/router、`ask/route.ts` | T11 | L3 | 多跳触发图检索；普通问题不请求 Neo4j |
| T13 | 增加图谱管理 API | `src/app/api/knowledge-graph/**` | T5、T9 | L3 | 权限、分页、错误码和范围测试通过 |
| T14 | 改造图谱管理 UI | entity-extraction 页面、KnowledgeGraphViewer | T13 | L2 | 支持局部加载、路径查询和来源追溯 |
| T15 | 增加监控和运行手册 | 指标、日志、健康接口、运维文档 | T12、T13 | L2 | 可查看延迟、错误、构建进度和降级状态 |
| T16 | Shadow 对比 | rollout 配置、评估集和比较脚本 | T8、T12 | L3 | 有效果、延迟、安全和一致性报告 |
| T17 | 灰度激活和回滚演练 | 配置、发布脚本、Runbook | T16 | L4 | 灰度通过；关闭 Neo4j 后自动降级 |

`[P]` 只表示 T1 完成后，基础设施和 Driver 开发可以并行。其他任务存在数据或共享文件依赖，必须串行完成。

## 15. 拟新增文件

```text
src/lib/neo4j/config.ts
src/lib/neo4j/driver.ts
src/lib/neo4j/health.ts
src/lib/neo4j/schema.ts

src/lib/knowledge-graph/contracts.ts
src/lib/knowledge-graph/neo4j-command-store.ts
src/lib/knowledge-graph/neo4j-query-port.ts
src/lib/knowledge-graph/neo4j-retrieval.ts
src/lib/knowledge-graph/passage-evidence-resolver.ts
src/lib/knowledge-graph/publication.ts
src/lib/knowledge-graph/artifact-importer.ts

src/app/api/knowledge-graph/health/route.ts
src/app/api/knowledge-graph/snapshots/route.ts
src/app/api/knowledge-graph/entities/route.ts
src/app/api/knowledge-graph/paths/route.ts
src/app/api/knowledge-graph/communities/route.ts

scripts/neo4j-init.ts
scripts/import-mirofish-artifacts.ts
```

## 16. 拟修改文件

```text
package.json
docker-compose.yml
docker-compose.local.yml
docker-compose.cloud.yml
.env.container.example

src/lib/document-pipeline.ts
src/lib/rag/retrieval/graph-entity-lane.ts
src/lib/rag/retrieval/retrieval-plan.ts
src/lib/rag/retrieval/retrieval-router.ts
src/app/api/ask/route.ts
src/app/api/entity-extraction/route.ts
src/app/entity-extraction/page.tsx
src/components/KnowledgeGraphViewer.tsx
```

## 17. Before/After 契约

| 项目 | Before | After | 消费者/一致性验证 |
|---|---|---|---|
| 图谱存储 | 进程内存/文件 | Neo4j 版本化图谱 | 构建任务、图谱 API、Graph Lane |
| 图遍历 | Node.js 加载全图 | Neo4j 服务端有界查询 | Graph Lane 契约测试 |
| Passage 检索 | Milvus | 保持不变 | Dense/Hybrid Lane 回归 |
| 图谱证据 | Artifact 内 Passage | passageId 解析为 RagEvidence | Evidence scope/trust 测试 |
| Active 版本 | 文件 CAS 指针 | Postgres CAS 发布记录 | 发布、并发和回滚测试 |
| 多租户 | 文件/API 检查 | 每条 Cypher 强制 scope | 交叉租户攻击测试 |
| 失败行为 | 图检索失败可能中断 | 可选 Lane 降级到 Milvus | Neo4j 故障注入测试 |
| 管理界面 | 加载完整图谱 | 分页实体、邻居和路径 | UI 集成测试 |

## 18. 测试策略

### 18.1 最窄反馈环

每个模块先写测试再实现：

- 配置解析与秘密隐藏。
- Entity/Claim/Passage 映射。
- 确定性 ID。
- Cypher 参数构造。
- tenant/corpus/trust/version 校验。
- Artifact 兼容映射。
- 查询预算和取消信号。

### 18.2 Neo4j 集成测试

使用隔离的本地 Neo4j 容器验证：

- Schema 重复初始化。
- 事务提交和回滚。
- 批量写入。
- 并发发布。
- CAS 冲突。
- Driver 断线重连。
- 查询超时和取消。
- 数据卷重启后的持久化。

### 18.3 RAG 回归测试

重点扩展：

```text
src/lib/rag/retrieval/graph-entity-lane.test.mjs
src/lib/rag/retrieval/lane-executor.test.mjs
src/lib/rag/retrieval/ask-route-contract.test.mjs
src/lib/mirofish/graph-api-scope.test.mjs
src/lib/mirofish/graph-artifact-store.test.mjs
src/app/api/mirofish/graph/route.test.mjs
```

覆盖：

- 普通问题不触发图检索。
- 多跳问题触发图检索。
- 图谱 Evidence 都有 Passage。
- Neo4j 不可用时自动降级。
- 图结果不能绕过 Abstention。
- 文件与 Neo4j 后端满足相同契约。

### 18.4 安全测试

- tenant A 无法读取 tenant B。
- corpus A 无法遍历 corpus B。
- 不可信文档不能进入受保护上下文。
- Cypher 注入字符串只能作为参数值。
- 超大图、环路和高阶节点受预算限制。
- API 不接受客户端伪造的租户身份。

### 18.5 迁移测试

- 同一 Artifact 导入两次不增加数据。
- 中断后可继续导入。
- 错误版本不能激活。
- 删除 STAGING 不影响 ACTIVE。
- 回滚后检索恢复旧版本。
- Milvus、Neo4j 和发布记录的版本一致。

## 19. 验收门禁

切换到 `active` 前必须满足：

<!-- acceptance-contract:start -->
- [x] 跨租户、跨语料库 Evidence 泄漏为 0（单元测试及真实 Neo4j 混合 trust 图验证）。
- [x] 所有图谱 Evidence 都能追溯到 Passage。
- [x] 重复导入不增加节点和关系数量。
- [x] 构建失败不会切换 Active Snapshot。
- [x] Neo4j 停止后普通问答仍可使用 Milvus（已完成本地真实停库 Ask E2E 及恢复探针）。
- [ ] 简单问题效果不低于当前基线。
- [ ] 多跳问题相对纯 Milvus 有可验证提升。
- [ ] 图查询延迟和超时率满足基线后确定的阈值。
- [ ] Shadow 结果完成安全和质量评审（无副作用等价测试已通过，尚缺生产质量样本）。
- [x] Active 版本回滚演练成功（真实 Neo4j 完成 `v1 → v2 → v1` CAS 回滚）。
- [ ] 旧文件图谱在生产灰度后至少保留一个完整发布周期（当前已保留且未删除或覆盖，时间门禁尚未满足）。
<!-- acceptance-contract:end -->

## 20. 风险与恢复

| 风险 | 防护 | 恢复方式 |
|---|---|---|
| Milvus/Neo4j 双写不一致 | Outbox、STAGING、版本校验 | 不激活并重放事件 |
| 跨租户路径泄漏 | 查询模板强制 scope | 关闭 Graph Lane 并审计数据 |
| 图谱关系质量差 | Claim confidence、来源、状态 | 降权或切回旧 Snapshot |
| 高阶节点造成图爆炸 | hop/row/time/path 预算 | 超时并降级 Milvus |
| LLM 生成非法结构 | 固定 Schema、参数化 Cypher | 拒绝非法 predicate/属性 |
| 历史导入产生重复实体 | deterministic entityKey | 删除未激活版本后重导 |
| 新版本影响回答效果 | Shadow、灰度、版本对比 | CAS 切回旧 Active Snapshot |
| Neo4j 故障 | Graph Lane 可选化 | `RAG_GRAPH_MODE=off` |

回滚配置：

```env
RAG_GRAPH_MODE=off
RAG_GRAPH_BACKEND=file
```

## 21. 待确认项

进入实施前需要确定：

1. 生产环境使用 Neo4j Community、Enterprise 还是 Aura。
2. 预计 Entity、Claim、Passage 数量和增长速度。
3. 实体消歧范围是单文档、单 corpus 还是允许跨 corpus。
4. 是否保存历史事实及时间有效性。
5. 历史 MiroFish Artifact 数量和总大小。
6. Postgres 是否允许增加 Outbox 和 Active Snapshot 表。
7. 生产备份、数据保留期和删除合规要求。
8. Shadow 阶段的质量和延迟阈值。

默认假设：

- 本地开发使用固定版本的 Neo4j Docker。
- 使用单个 Neo4j Database，通过属性实现多租户隔离。
- 每个 tenant+corpus 同时只有一个 Active Snapshot。
- 保留现有文件 Store 作为迁移回滚通道。
- 第一阶段不改变当前 Embedding 模型和 Milvus Collection。

## 22. 下一可执行动作

当前 Neo4j 核心功能与本地 canary 已完成，但生产门禁本身仍有可执行工具缺口。可审计 `supersede` runtime 已实现；迁移事务提交前旧 pointer 仍须保持 `compound/blocked, 16/18`，禁止用 `complete` 把 T16/T17 记成完成。详细后续方案见 owner 已批准、等待事务绑定的 `docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md`：

1. 由正式安装的 workflow authority 运行只读 proposal、精确落盘内容寻址 receipt，再以事务化 supersede 绑定旧/新计划 hash、owner 批准记录和完整任务映射；receipt 与新 pointer 未通过 readback 前不视为已迁移。
2. 在后续 Work 阶段实现分阶段 manifest/validator、secure production Ask runner、不可放宽安全 hard gate、provider-neutral ports/conformance、pre-run authorization、无环 receiptCore/resultAttestation/acceptanceBundle、PublicationIdentity readback、CAS/hash-chain journal、lease/fencing、受限 SafetyRecoveryAuthorization、lineage CAS/流量回滚编排和 retention checker；现有 hermetic fixture CLI 不得冒充这些工具。
3. 同一 Work 阶段补齐标准 Ask/agent 结构化引用、服务端诊断、权威 served-ID 映射、opaque CitationLocator 最小持久化和当前主体重新授权的内部预览。候选或 served-ID 中的重复/缺失 ID 非法，但正文可多次引用同一合法 `[n]`；非法引用保持普通文本，禁止退回原始 `searchResults` 猜测来源。
4. 生产 owner 分阶段提供并批准 T16 roster/阈值/arm、部署侧 ProviderTrustPolicy 与真实 adapter conformance、T17 专用 canary/维护窗口/RampPlan/FaultPlan/回滚条件，并在 T17 authorization 时冻结 Retention policy 和旧 Store identity；后阶段字段不得反向阻塞 T16。
5. T16 执行 `off`/`shadow`，只证明 Shadow SideEffectPolicy 和 Graph 候选诊断；T17 在 lease/fencing、零流量/off 前置下激活，Outbox/PublicationIdentity 对齐后执行放量前 `off`/`active` 多跳质量门禁，再完成 lease-bound 灰度、TTL 故障降级、摘流和 lineage 回滚。每阶段只有完整 acceptanceBundle 才可作为下一阶段输入。
6. 保留文件 Store，按 T17 时冻结的政策完成一个发布周期并生成 retention acceptanceBundle；实际历史数据清理不属于当前 Goal，仍需独立 `validateForCleanup` 和删除授权。

## 23. 2026-09-07 实施与验收记录

### 23.1 任务状态

| 状态 | Task | 说明 |
|---|---|---|
| 完成 | T0-T15 | 行为基线、契约、Docker/Driver/Schema、Command Store、Postgres CAS/Saga/Outbox、MiroFish 构建接入、导入器、查询/RAG、API/UI、监控与 Runbook 已实现 |
| 门禁中 | T16 | Shadow 无副作用契约及本地 5 题 `off`/`shadow`/`active` canary 已执行；4 个多跳题完成 shadow 等价验证，直接数字题因本地生成器超时未形成 shadow 质量样本；仍缺 production Ask target/roster runner、可配置 gate、受控且可验证的 receipt，以及代表性生产样本与冻结阈值 |
| 门禁中 | T17 | 本地持久化、双版本回滚、真实停 Neo4j Ask 降级与恢复探针、临时单 corpus `active` canary 及 CAS 回滚已验证；仍缺生产编排/receipt、Milvus 精确版本 readback 与获批生产单 corpus 灰度 |

### 23.2 已验证事实

- TypeScript 全量检查通过；Neo4j/RAG/API/UI/控制面定向 ESLint 与 `git diff --check` 通过。
- 最新知识图谱、API、UI、导入器与 worker 串行回归 137 项中 135 通过、2 项按真实数据库环境跳过；Ask 路由回归 68/68 通过。更早的 Agentic RAG/Graph Lane 扩展回归 220/220 通过；不可达 Neo4j 继续降级到 Dense/Milvus。
- 真实 Neo4j 生命周期、混合 trust、并发 digest、过期 GC 和双版本回滚 1/1 通过。
- 项目隔离的 PostgreSQL 17 已应用 0001～0005；真实图控制面 CAS、租约、tombstone、Outbox 与应用角色 DML 验收 1/1 通过；控制 worker 真实启动/退出通过。2026-09-08 改用本机 Docker PostgreSQL 后再次验证迁移 `applied=0 skipped=5 seeded=true`，运行时应用角色与回滚式 DML 探针通过。
- Next.js 生产构建与 standalone trace guard 通过，共生成 100 个页面；知识图谱页面、6 个受限 API 路由及 1.7 MB 自包含 `graph-control-worker.cjs` 进入生产产物。本次直接运行 Next 构建，未触发文章生成或 Notion 同步。
- 本地、云 Compose 组合配置可渲染并声明独立 control worker；本 Sprint 早期已验证本地 Neo4j `5.26.30-community` 与 PostgreSQL 17 健康、端口仅绑定 `127.0.0.1` 且使用持久卷。
- 默认历史导入为 dry-run；不会初始化 Schema 或写 Neo4j，`--apply` 还必须启用完整 PostgreSQL 控制面。不可分页源达到上限时在写入前 fail-closed，避免静默漏迁移。
- Shadow 图证据不进入 rerank、abstention、上下文、Prompt、回答或缓存身份；Neo4j 预路由故障降级为 Dense。
- 2026-09-09 完成本地真实停库 Ask E2E：shadow 基线返回 HTTP 200、`mirofish-research`、`graph.executed=true`、`shadowEvidenceCount=1`、3 条 Dense Evidence，耗时 2702 ms；只停止 `rag-system-neo4j-1` 后 Bolt 不可达而 PostgreSQL/Milvus 仍可达，新 Ask 返回 HTTP 200、`milvus-2step`、`graph.executed=false`、3 条 Dense Evidence 和非空答案，耗时 2190 ms；Neo4j 恢复 healthy 后探针再次返回 HTTP 200、`mirofish-research`、`graph.executed=true`、`shadowEvidenceCount=1`，耗时 3379 ms。演练后 Active Graph 指针已恢复为空（revision 4），应用恢复 `RAG_GRAPH_MODE=off` 且 `/api/health` 返回 200，Neo4j 恢复 `running|healthy`。
- 2026-09-09 完成本地 5 题 `off`/`shadow`/`active` canary。`shadow` 的前 4 个多跳问题均返回 HTTP 200、执行 Neo4j 且只产生 `shadowEvidenceCount=1`；其 Dense Evidence ID 与 `off` 逐题完全相同，证明 shadow 未污染主检索、rerank 或生成上下文。第 5 个直接数字题连续两次在本地 `qwen2.5:0.5b` 生成阶段触发约 90 秒 `RAG_GENERATION_TIMEOUT`，明确记录为生成器限制而非 Graph 故障。
- 临时 `active` canary 中，4 个多跳问题均通过 `graph-entity-optional` / `neo4j-knowledge-graph-v1` lane，Graph Evidence 的 scope、版本、trust、Passage ID、Claim ID 与 Entity ID 完整；每条 Graph Evidence ID 都进入 `contextPacking.includedEvidenceIds`、不在 excluded 列表且内容实际出现在顶层生成 `context`。直接数字题继续走 `milvus-2step`，未错误触发 Graph Lane。q1～q3 命中已建图的 `商船 → 黑死病 → 欧洲`、`跳蚤 → 鼠疫杆菌 → 黑死病` 等 Claim；q4 目标中的“人口下降 → 劳动力/工资 → 农奴制”关系尚未建成 Claim，相关答案事实仍由 Dense Evidence 支撑，未计为图链命中。Graph 查询无超时或 5xx。
- 使用本机已有 `qwen3:latest` 做同模型对照后，`active` 的 q1/q2/q4/q5 与 `off` 基本持平，q3 从 `off` 被无关 Dense 片段带偏到“神圣罗马帝国”改进为正确回答“商船将黑死病带到欧洲”，并对证据未提供的具体港口保持克制。warm 请求观测范围为 `active 3454～5060 ms`、`off 2534～5580 ms`；首请求分别受模型加载或 Next.js 编译影响达到 41679 ms 与 46736 ms，均不纳入稳态结论。该结果只证明本地正向 canary，不替代代表性生产评估集或尚未冻结的 P95/P99、质量和超时率阈值。
- canary 结束后先将应用切回 `RAG_GRAPH_MODE=off`，再以 `expectedRevision=5` CAS 停用临时快照；当前 Active Pointer 为 `null`、revision 6。最终 `/api/health` 与 `/rag-api/knowledge-graph/health` 均返回 200，PostgreSQL schema ready，Neo4j connected，PostgreSQL/Neo4j/Milvus 容器均为 healthy。
- 生命周期操作使用数据库侧 availability 过滤的轻量 descriptor，不加载整图；Postgres 激活租约只能更新已注册 staged 记录，删除需二次确认 Neo4j 不存在后才写 tombstone，禁止 ghost activation 和删除假成功。
- 发布 Outbox 逐条 claim，并在 ack 前按严格连续 revision 幂等投影 Neo4j Pointer 与 Snapshot 状态；外部发布 webhook 可选，未配置时仍完成本地投影。BuildJob 只有在显式配置可靠 HTTPS webhook 时才 claim；event/job id 作为幂等键，非 2xx、超时和非法响应均重试或进入显式失败。
- 实体、社区和路径 API 使用字段白名单、引用数量上限与 1 MiB JSON 总预算；超限稳定返回 `KNOWLEDGE_GRAPH_RESPONSE_TOO_LARGE`，不返回模型 attributes 或任意 Cypher 结果。
- 快照读取对 `allowedTrustLevels` 和整图引用闭合执行 fail-closed；Claim 来源采用一条 look-ahead 正确标记响应截断，管理 UI 的快照 key 使用完整不可变身份。
- 2026-09-08 补齐 canonical `/rag-api/pipeline` 的 Milvus 成功提交点：文件、文本、URL、YouTube 与批量入口均在 PostgreSQL 文档资产持久化后自动提交幂等 Graph BuildJob，并返回任务身份；入队失败以稳定 reconciliationId fail-closed，不会把只有向量、没有图任务的状态报告为完整成功。

### 23.3 未验证项与环境阻塞

- 完整 PostgreSQL 持久化集成套件中的本地 backfill 用例仍受 Windows 临时目录符号链接策略阻塞；独立图控制面真实用例已通过，这一阻塞与 Neo4j 接入无关。
- `runtime.store.compareAndSetActive → PostgreSQL Outbox → Neo4j 投影 → RAG retrieval` 真实双数据库集成用例已在本机 Docker PostgreSQL 17 与 Neo4j 上通过；完整 Neo4j 生命周期/回滚与发布投影共 2/2 通过，随机隔离租户在测试结束后完成清理。原 Docker 不可用环境阻塞已解除。
- 未执行真实双 Worker + 慢 Webhook + 租约过期故障注入；Neo4j 从旧备份恢复导致 revision 落后时会 fail-closed，自动重对齐流程待独立设计。
- 缺少生产评估集、流量和阈值，无法宣称简单问题无回归、多跳质量提升或延迟达标；因此 `RAG_GRAPH_MODE` 保持 `off`/`shadow`，不自动切换 `active`。
- 本地停库 E2E 为了隔离故障机制使用已安装的 `qwen2.5:0.5b`；默认 `llama3.1` 在同一本地环境两次触发 90 秒 `RAG_GENERATION_TIMEOUT`。因此本次数据只证明故障隔离与恢复，不作为默认模型的生产质量或延迟结论。
- 未执行历史数据 `--apply` 导入、生产部署、生产数据清理，也未删除旧文件图谱。
- 跨架构复核确认主问答页仍把回答作为纯文本渲染，并只持久化 `retrievalDetails`；API 已返回候选 `evidence` 与权威 served-ID 顺序 `contextPacking.includedEvidenceIds`，但 UI 尚未按该顺序过滤候选集合并建立编号映射。当前 Compound 阶段禁止修改产品代码，因此该本地 P0 未计为完成，也没有用原始 Dense `searchResults` 做错误替代。
- T16 工具复核确认 `scripts/run-rag-eval.mjs` 只注册 hermetic fixture-hash target；production-policy 与 scoped-agent runner 均明确不测生产质量。仓库尚无真实 production Ask target、`off`/`shadow` roster runner、可配置生产阈值 gate 或封存 receipt，因此手工保存 API 响应不能替代完整 T16 验收。
- T17 工具复核确认现有 snapshots API、PostgreSQL CAS/Outbox 与 control worker 可以安全激活并投影 Neo4j，但没有统一生产编排/receipt，也没有受支持的 Milvus 精确 document/index version readback。公开 Milvus health/config 只能证明总体可用，不能证明 Pointer→Outbox→Neo4j→Milvus 使用同一获批发布身份。
- `RAG_GRAPH_MODE` 是进程级开关而非 per-corpus 开关；生产“单 corpus active”必须使用专用 canary 实例，或提供只有获批 corpus 存在 Active Pointer 且未设置 `RAG_MIROFISH_GRAPH_DOCUMENT_ID/VERSION` pin 的证明。禁止在共享 Neo4j 上执行停库故障注入。

### 23.4 拟议生产门禁输入与证据合同（待审批，fail-closed）

下表是待生产治理 owner 审阅的分阶段摘要，不代表已经批准的生产制度；完整合同以未绑定草案 `docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md` 为准。执行前必须冻结合同版本、规范化 hash、owner、批准人与批准时间；相应阶段的启动输入缺失时 fail-closed。完成证据由该阶段执行后产生，不反向作为自身启动前置。仓库内 synthetic fixture、hermetic contract、空占位值或本地 Docker 结果不能替代生产证据。

| 阶段 | 输入或完成证据 | 最低可审计证据 | 当前状态 |
|---|---|---|---|
| T16 启动 | 代表性评估集 | 脱敏数据路径、规范化 hash、版本与 owner；简单题、多跳题、不可答题和安全/注入题分层；沿用现有 V2 schema：可答题具有 `expectedAnswer` 与非空 `goldEvidence`，不可答题为 `expectedAbstain=true` 且 `goldEvidence=[]`，并提供适用的 scope 与安全期望；当前不虚构 `goldClaim` 字段 | 缺失 |
| T16 启动 | 可执行指标与阈值审批 | owner 批准 trial 数及现有 gate 可计算的检索、答案、拒答、引用、安全、`errorRate`、P50/P95 阈值。P99、timeout rate 或 Claim 专项指标若被要求，必须先实现 schema、validator、gate 与测试，再纳入冻结合同 | 缺失 |
| T16 启动 | 生产目标、基线与 arm 身份 | 目标 environment+tenant+corpus、部署侧 target allowlist、冻结基线窗口；相同应用 commit/build/image、模型/Embedding/Reranker/Milvus 身份与 `sharedConfigHash`，以及每 arm 独立的完整 `armConfigHash`、`rolloutMode=off|shadow` 和实际进程回读。Secrets 只由受控 provider 在目标校验后注入 | 缺失 |
| T16 完成 | Shadow 验收凭据 | 同一冻结 roster/shared identity 的 `off`/`shadow` pre/post SideEffectPolicy readback、受控制品、arm hash/mode、machine verdict；先封存 receiptCore，再取得独立 result attestation 与防篡改对象证明并组装 acceptanceBundle。只证明 Shadow 候选诊断，不宣称 Active 答案提升 | 尚未产生 |
| T17 启动 | T16 凭据与变更输入 | 有效 T16 acceptanceBundle；获批单 corpus、ProviderTrustPolicy/真实 adapter conformance、变更单、窗口、on-call、RampPlan/FaultPlan、回滚/rescue owner、SafetyRecoveryPolicy/recovery authority、分布式 lease/fencing 语义和 T17 execution authorization | 缺失 |
| T17 启动 | PublicationIdentity、双 arm 与零流量前置 | 专用 canary/流量选择器、进程 `off` 回读、run lineage/fencing；冻结 `off`/`active` arm 与 retentionPolicy/old Store hash；PublicationIdentity 关联 PG Pointer/Outbox/BuildJob、Neo4j Snapshot/DocumentVersion 与 Milvus exact rows/collection/schema/index manifest | 缺失 |
| T17 完成 | Active、质量、降级与回滚凭据 | 放量前同 roster `off`/`active` 多跳质量/引用/安全/P95/超时 verdict；lease-bound RampPlan、TTL FaultPlan、Outbox ack、摘流/off、rescue、lineage+fencing 回滚、最终 PublicationIdentity readback及 T17 acceptanceBundle | 尚未产生 |
| R18 | 发布周期验收 | 只按 T17 authorization 已冻结的 retentionPolicy/old Store hash 与可信时钟验证完整发布周期，生成 receiptCore/resultAttestation/acceptanceBundle；实际清理另行授权 | 尚未开始计时 |

拟议执行顺序（仅在 owner 批准并冻结上述合同后生效）：

1. 生产治理 owner 审阅提案；批准后冻结合同版本/hash/owner/时间戳。T16 启动输入任一缺失即停止，不触发生产写入或切流。
2. 使用同一 roster、shared identity 和唯一批准的 rolloutMode 差异运行 `off` 与 `shadow`；保存 armConfigHash/实际模式与 SideEffectPolicy readback，只计算冻结合同中已实现的指标，按三层对象形成 T16 acceptanceBundle。
3. T16 通过后，先取得 scope lease/fencing，让专用 canary 零流量且进程为 `off`，建立 run journal/lineage，再 CAS；Outbox ack 与 PublicationIdentity readback 通过后才切换 active，并在放量前完成冻结 `off`/`active` 质量门禁。
4. 仅在放量前门禁通过后按 lease-bound RampPlan 引入受控流量；窗口内只执行签名闭集且具 adapter TTL 的 FaultPlan。回滚先摘流量并切回 `off`，只有 Pointer 仍属于本 run lineage/fencing 才 CAS；失锁时流量 TTL 自动归零、fault 自动撤销，后续仅由取得新 generation、受限 SafetyRecoveryAuthorization 且验证 journal chain/head/live state 的 rescue owner 处理。
5. 灰度后继续保留旧文件图谱；按 T17 时冻结的 policy/Store identity 满一个发布周期并取得 R18 acceptanceBundle。实际历史数据清理继续单独审批。

### 23.5 后续 Work 阶段的本地门禁工具验收

详细任务、依赖、安全边界和完成证据已移入 `docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md` 的 W0-W9、T16、T17、R18。owner 已批准完整范围，但 migration receipt 与新 pointer 完成事务化 readback 前仍不得进入 Work；即使迁移成功，本计划也不构成 T16/T17/R18 的生产执行授权。
