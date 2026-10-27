# 普通聊天中的实体、关系和原文引用

本功能使用当前知识库已发布的单文档图谱。普通聊天可回答“张三是谁”“张三负责哪些项目”“解释 A 与 B 的关系”等问题，并在有来源支持时解释 1～2 跳关系。跨文档图谱聚合和社区全库归纳不属于这一里程碑。

## 数据与运行前置

1. 按 [Neo4j 运行手册](neo4j-local.md) 配置 PostgreSQL、Milvus 和 Neo4j，完成 Schema 初始化。
2. 文档通过持久化入库链路生成图谱，构建到 `validated` 后显式发布到对应 tenant/corpus；确认发布事件已投影至 Neo4j。
3. 使用 `RAG_GRAPH_BACKEND=neo4j`。`RAG_GRAPH_MODE=off` 不执行图谱检索，`shadow` 只记录候选，`active` 才允许图谱证据参与回答。生产开关仍沿现有发布门禁操作。
4. 原文预览要求 PostgreSQL 中该文档资产处于 ready 状态，原始 `source_hash`、trust、分块数与 Strong Milvus 读回的完整文档一致，图谱未删除且版本匹配。

旧版手工图谱可能使用图内容摘要作为 `documentVersion`，不一定能对应原始文档资产。此类图谱仍可能参与检索，但不能据此伪造原文预览；需通过带原始文档版本和分块映射的入库链重建或迁移。缺少可核验来源时，界面会明确显示预览不可用。

## 引用密钥配置

各应用实例共享稳定配置；不要在每次启动时重新生成密钥。密钥通过运行环境的秘密配置注入，不写入 Git、日志、前端环境变量或构建参数。

| 配置 | 含义 |
| --- | --- |
| `RAG_CITATION_KEYS` | JSON 对象，key ID 对应一个标准 Base64 编码的 32 字节随机密钥 |
| `RAG_CITATION_ACTIVE_KEY_ID` | 当前签发密钥 ID |
| `RAG_CITATION_ISSUER` | 稳定签发方标识 |
| `RAG_CITATION_ENVIRONMENT` | 部署环境标识，跨环境重放会被拒绝 |
| `RAG_CITATION_TTL_SECONDS` | 新引用寿命，默认 86400 秒 |
| `RAG_CITATION_MAX_TTL_SECONDS` | 最大寿命，默认 604800 秒，硬上限 30 天 |
| `RAG_CITATION_REVOKED_KEY_IDS` | 立即吊销的 key ID，以逗号分隔 |
| `RAG_CITATION_KEY_RETIREMENTS` | 旧验证密钥的退役边界，见下文 |

生成密钥时使用密码学随机源。测试中的固定字节密钥仅用于合成夹具，不能用于运行环境。

轮换时原子切换 active key，并为保留验证的旧 key 配置 `issuedBefore` 和 `verifyNotAfter`（Unix 毫秒）：退役时刻之后签发的旧 key token 被拒绝，验证截止不得晚于退役时刻加最大 TTL，原 token 的 `exp` 不延长。仅支持一个 active key 加有明确退役边界的旧 key，不能无退役配置预加载未来 key。验证窗口结束后移除旧 key；怀疑泄漏时立即吊销，不等待 TTL。

配置缺失或无效时，问答仍可返回答案及明确引用诊断，预览不会使用临时密钥或缓存原文兜底。

## 本机开发启用

Next 开发应用读取被 Git 忽略的 `.env.local`。在该文件中使用本机数据库地址、现有图谱所属 tenant/corpus，并设置 `RAG_GRAPH_BACKEND=neo4j`、`RAG_GRAPH_MODE=active` 和上表引用配置。不要从容器环境直接复制数据库主机名或 scope；先读回当前已发布图谱及原文资产。已有有效引用密钥应复用，重新生成会使旧句柄失效。

本次本地实例已补齐稳定引用配置，保持既有 `local-dev` 开发认证，仅监听 loopback。运行前先确认现有 PostgreSQL、Milvus、Neo4j 可达；Docker Desktop 未启动时恢复已有引擎与容器即可，不需要重建卷或重新入库。

依赖就绪后只启动应用：

```powershell
pnpm dev:app --webpack --hostname 127.0.0.1 --port 3000
```

打开 `http://127.0.0.1:3000`。完整的 `pnpm dev` 还会执行迁移、种子和 worker 启动；单纯验证现有数据时无需重跑这些步骤。当前 Windows 环境下曾出现 Turbopack 重路由首次编译长期等待，Webpack 已使引用身份、图谱快照、模型配置与首页真实请求正常返回。首次编译与模型加载应单独预热，再测聊天请求，不能用进程打印 Ready 代替功能验证。

不要把开发认证或未加密本机 Neo4j 连接复制到生产；生产继续使用原门禁、受控认证和 TLS 配置。本次本地启用没有修改 `.env.container` 或生产环境。

## 用户看到的行为

- 正文中合法的 `[1]` 或 `[1, 2]` 与本次实际提供给模型的证据对应后，才成为来源按钮。代码块、Markdown 链接和未知编号保持原文。
- 点击后只向内部预览接口提交 opaque locator。服务端重新检查当前身份、原图谱/文档版本、资产状态、Strong Milvus 原文和图谱删除状态，再返回对应片段与有来源的关系。
- 关系保留主体、predicate、客体方向。两跳关系的每条边都需要来源实际进入模型上下文，缺失或被裁剪后不沿用完整路径的回答资格；关系连通不代表因果。
- 片段超过预览预算会明确提示截断。预览失败不回退聊天记录中的缓存原文。
- 聊天和 durable 引用只持久化编号、页码、加密句柄、分区与有效期；原始来源地址可能含签名参数，因此不保存在引用字段中。来源显示在点击后的授权预览中获取。
- 账号/知识库切换、明确退出或权限撤销会清理引用句柄并保留聊天内容。临时网络失败仅停用来源入口。有效期使用服务端校准时钟判断。

## 诊断

普通 Ask 的 `retrievalDetails.graph` 提供本次意图、是否计划/实际执行图谱通道、可用状态，以及 `servedEvidenceCount`、`citedEvidenceCount`。返回候选不等于模型看到了候选，也不等于答案引用了它。

`citations.diagnostics.reason` 区分：没有正文编号、引用密钥配置不可用、来源无法核验、已签发可用引用。引用验证只核对编号和来源身份，不声称自动证明答案的语义正确性。

`GET /rag-api/ask/citations/preview` 返回当前主体的 opaque 分区及服务端时间；`POST` 接受且仅接受 `{ "locator": "..." }`。两者均重新鉴权，响应禁止缓存。首次预览不会自动创建 Neo4j 索引或 Milvus collection；缺少基础设施时显式失败。

## 本地验证

图谱、上下文与普通 HTTP 测试使用隔离夹具：

```powershell
node --test src/lib/knowledge-graph/query-intent.test.mjs src/lib/knowledge-graph/graph-evidence.test.mjs src/lib/knowledge-graph/neo4j-retrieval-port.test.mjs src/lib/rag/retrieval/graph-entity-lane.test.mjs src/lib/rag/retrieval/graph-context.test.mjs
node --test src/app/api/ask/route.test.mjs
node --test src/lib/rag/citations/citation-locator.test.mjs src/lib/rag/citations/preview.test.mjs src/lib/rag/citations/http.test.mjs src/lib/rag/citations/milvus-preview-readonly.test.mjs src/app/api/ask/citations/preview/route.test.mjs
node --test src/components/chat-citations.test.mjs src/lib/indexeddb-citations.test.mjs
```

真实 Neo4j 验证仅创建并清理随机测试 tenant，不使用现有用户图谱：

```powershell
$env:RAG_NEO4J_INTEGRATION='1'
node --test src/lib/knowledge-graph/neo4j.integration.test.mjs
```

实际 Chromium 验证使用真实聊天组件与合成 API，不连接真实资料：

```powershell
$env:RAG_CHAT_BROWSER_E2E='1'
node --test scripts/neo4j-chat-browser.test.mjs
```

浏览器脚本优先查找已有 Playwright/Chromium 运行环境，不安装包；其截图与摘要保存在 `docs/reports/.diagnostics/neo4j-chat-browser/`。数据库、HTTP 夹具和浏览器合成 API 的结果需分别记录，不能合并声称生产端到端验收。
