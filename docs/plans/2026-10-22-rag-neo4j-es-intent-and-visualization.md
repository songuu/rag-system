---
type: architecture-proposal
status: proposed
date: 2026-10-22
revision: 1
scope: analysis-and-plan-only
local_base_commit: 5a28045
reference_commit: 6d91e2ec76f70dd604b8a897a63b2ac6fba3ec95
---

# RAG、Neo4j、Elasticsearch：意图编排与双链路可视化方案

本方案基于当前工作树的源码调查，包含尚未提交的改动；不代表这些改动已经发布。用户确认同时需要「RAG 执行链路」和「业务/代码依赖图」。本轮只分析、验证现有隔离测试并编写方案；实施在方案确认后启动。

## 1. 架构结论

保留 PostgreSQL 的权威数据与发布控制、Milvus 的向量召回、Elasticsearch 的词法检索、Neo4j 的关系查询，在现有 RAG Kernel 上形成统一的意图决策、检索计划、证据和 Trace 契约。

最高优先级不是增加数据库连接，而是完成以下闭环：

**用户问题 → 可解释的意图决策 → 可执行检索计划 → 文本和关系证据 → 带引用的回答 → 同一次请求的执行图与证据图。**

代码/业务依赖分析沿用同一闭环，额外接入版本化的静态解析结果、接口契约和运行时观测。三种关系必须区分：源码确定或推断的调用、真实观测到的调用、文档描述的业务关联。

首批交付单文档问答与执行链路闭环，随后交付知识库级关系与本仓库 TypeScript/Next.js 代码依赖图。跨语言解析和全局社区归纳放到后续，不阻塞前两批。

## 2. 参考项目：哪些值得借鉴，哪些必须改造

核对对象为 [honeyandme/RAGQnASystem](https://github.com/honeyandme/RAGQnASystem)，远端 HEAD 于本轮读取为 6d91e2ec76f70dd604b8a897a63b2ac6fba3ec95。已直接读取该提交的四个核心源文件，避免仅依据 README 或网页缓存。

| 实际实现 | 借鉴方式 | 不能直接照搬的原因 |
| --- | --- | --- |
| BERT/RNN、词典匹配、TF-IDF 实体对齐 | 将 mention 抽取和标准实体定位拆成两个步骤 | 当前领域和语言不同，不能假定医疗 NER 模型适用 |
| IntentSpec 表绑定意图、实体槽位和查询种类 | 建立版本化 IntentSpec + QueryTemplateRegistry | 参考实现仍按模型原始文本的子串匹配，解释文本也可能误触发 |
| KGClient 集中封装图查询，查询和提示拼接分离 | 复用本项目已有 QueryPort、RetrievalPort 分层 | 参考实现字符串插值 Cypher；异常与空结果都折叠成空值 |
| 显示识别实体、意图和检索提示 | 在回答旁展示结构化决策与证据 | 当前 UI 是文本回显和 Neo4j Browser 链接，没有本项目所需的统一执行 DAG |
| 根据图谱提示约束答案 | 继续实行证据约束、引用和拒答 | 提示词不能替代来源校验和答案支持性评测 |

进一步核实的局限：

- README 称 16 类意图，当前 IntentSpec 表有 15 项；症状反查在 webui 中另行处理。应统一注册表与提示 schema，避免数量和执行能力漂移。
- 实体对齐输出按实体类型存一个值，同类型多个实体可能被后者覆盖；复杂问题必须保留实体数组、角色和候选列表。
- 症状反查存在 random.choice 选择疾病的逻辑；本项目遇到歧义应澄清或保留候选，不随机选实体。
- 本次核查的核心流水线中未见 ES/Milvus 混合召回、跨源版本一致性或代码调用图实现。参考项目适合作为「领域意图到图查询」的设计案例，不能作为完整联合架构模板。
- README 的实体规模与 NER F1 是作者报告，本轮没有复现实验，不作为本项目收益预测。

证据：[intent_router.py](https://github.com/honeyandme/RAGQnASystem/blob/6d91e2ec76f70dd604b8a897a63b2ac6fba3ec95/intent_router.py)、[kg_client.py](https://github.com/honeyandme/RAGQnASystem/blob/6d91e2ec76f70dd604b8a897a63b2ac6fba3ec95/kg_client.py)、[ner/inference.py](https://github.com/honeyandme/RAGQnASystem/blob/6d91e2ec76f70dd604b8a897a63b2ac6fba3ec95/ner/inference.py)、[webui.py](https://github.com/honeyandme/RAGQnASystem/blob/6d91e2ec76f70dd604b8a897a63b2ac6fba3ec95/webui.py)。

## 3. 当前项目的事实与优化优先级

以下是源码事实或据此提出的风险；运行配置、数据库规模和线上性能尚未核验。

| 优先级 | 已核查现状 | 优化点及原因 |
| --- | --- | --- |
| P0 | conversation-router、semantic-conversation-router、intent-router、retrieval-router、query-intent 和查询分析模块并存 | 不把不同层全部合成一个分类器；建立同一次请求的统一 QueryUnderstanding，记录各层决策的职责和来源 |
| P0 | 普通实体/关系图查询与聊天引用已经有在途实现 | 先验收这些改动，再补联合架构；不能用早先文档里“尚未支持实体问答”的描述覆盖新源码事实 |
| P0 | Milvus 和 ES 已在 retrieveMilvusElasticsearch 内并行，应用侧 RRF 融合；外层仍登记为 dense-vector lane | 先拆出真实 provider spans 和 fusion span，保持现有行为；后续再升级计划 DAG |
| P0 | Graph Lane 读取 priorEvidence 的 passage 种子并返回关系来源，单个请求仍携带单文档 graphArtifactIdentity | 先复用单图闭环，再新增知识库级 snapshot selector，保留旧接口适配 |
| P0 | RagEvidence、ContextComposer、graph-context、citations 已有来源和上下文筛选能力 | 统一保留“被检索、被融合、入上下文、被引用”四个集合，不能把检索命中直接标为答案依据 |
| P0 | LangSmithReactFlowGraph 有 parentId，但缺失时按数组前后顺序连边 | 用真实执行依赖表达分叉/汇合；未知父子关系显示未知，不伪造调用 |
| P1 | 图实体匹配使用中文单字/双字 token 与 CONTAINS；已建 Neo4j fulltext 索引，但所查检索路径未使用它 | 优先标准实体 ID、精确名/别名，再进行受控候选搜索；性能影响需 EXPLAIN/PROFILE 验证 |
| P1 | ES 当前索引主要为 content/source 的 CJK 文本；metadata 不可检索 | 增加实体、符号、接口、错误码等专用可检索字段和独立候选索引，不把代码标识符仅当自然语言分词 |
| P1 | Neo4j 和 ES 都已有 PostgreSQL outbox/worker | 复用现有投影机制，增加跨源发布清单与就绪检查，避免各源读取到不同文档代际 |
| P1 | KnowledgeGraphConsole 及实体/路径/来源接口已存在；控制台仅非 production 可用 | 保留管理入口边界，为聊天提供最小只读查询视图；不能简单取消整个控制台生产限制 |
| P1 | Trace 有 parentObservationId、PG 持久化和 LangSmith mirror；lane 记录主要有 latencyMs | 统一时间戳、执行状态、依赖 links、证据引用和后端错误，逐步适配现有 Trace |
| P1 | 搜索 src/scripts/package.json 未发现 CodeSymbol/CALLS/IMPORTS 或 OTel 接入实现；instrumentation 目前做 embedding 状态恢复 | 代码依赖提取与运行时关联按新增能力规划；这不等于确认仓库外没有相关系统 |

主要源码入口：

- [Ask runtime](E:/project/ai/rag/project/rag-nextjs/src/app/api/ask/runtime.ts:446)、[联合召回接线](E:/project/ai/rag/project/rag-nextjs/src/app/api/ask/runtime.ts:2228)、[检索计划](E:/project/ai/rag/project/rag-nextjs/src/lib/rag/retrieval/retrieval-plan.ts:70)。
- [图意图分类](E:/project/ai/rag/project/rag-nextjs/src/lib/knowledge-graph/query-intent.ts:1)、[Neo4j 检索](E:/project/ai/rag/project/rag-nextjs/src/lib/knowledge-graph/neo4j-retrieval-port.ts:217)、[图契约](E:/project/ai/rag/project/rag-nextjs/src/lib/knowledge-graph/contracts.ts:88)。
- [Milvus/ES 融合](E:/project/ai/rag/project/rag-nextjs/src/lib/rag/retrieval/milvus-elasticsearch-fusion.ts:17)、[ES mapping 与过滤](E:/project/ai/rag/project/rag-nextjs/src/lib/elasticsearch/lexical-index.ts:33)、[图索引](E:/project/ai/rag/project/rag-nextjs/src/lib/neo4j/schema.ts:14)。
- [执行图连边](E:/project/ai/rag/project/rag-nextjs/src/components/LangSmithReactFlowGraph.tsx:247)、[Trace 契约](E:/project/ai/rag/project/rag-nextjs/src/lib/observability.ts:8)、[上下文编排](E:/project/ai/rag/project/rag-nextjs/src/lib/rag/core/context-composer.ts:66)。

<!-- design-authority:start -->
## 4. Design Authority（shadow）

### 问题与用户价值

用户需要在同一个聊天入口查询文档事实、关系、代码调用和影响范围，并能解释系统识别了什么、调用了什么、为什么采用这些证据。架构必须保证图关系可追溯、链路记录真实、故障可诊断。

### 范围 / 非目标

范围包括联合检索、结构化多意图、实体消歧、发布一致性、RAG 执行图、证据子图、TypeScript/Next.js 静态调用图与选定运行时调用的关联。

首轮不迁移向量库，不引入 Python 微服务，不开放任意 Text-to-Cypher，不训练新的 NER 模型，不承诺全语言或所有动态调用解析，不把本地验证等同生产上线。全局社区总结后置。

### 备选方案、选择与理由

| 方案 | 优点 | 代价/结论 |
| --- | --- | --- |
| 维持单文档图谱，只增强展示 | 最快 | 无法解决跨文档和业务/代码依赖问题；只作为第一批增量 |
| 在现有 Kernel/端口上增量统一意图、证据与 Trace | 复用现有投入，允许渐进迁移 | **采用**；需先固化契约与回归基线 |
| 直接迁入参考项目 Python/NER 流水线 | 领域例子清晰 | 模型、权限、发布与前端都需重接；不采用 |
| 向量全部迁入 ES 或 Neo4j | 可减少一种数据库 | 当前未测得迁移收益，会放大回归面；作为未来独立评估 |
| 自由 Agent + 自动生成 Cypher | 灵活 | 难控制成本、查询边界和重现；首轮用确定性模板和有界补检索 |

### 组件、消费者接口、状态与错误路径

QueryUnderstanding 负责语义识别；PlanCompiler 结合服务端范围、发布版本、能力和预算生成只读计划；现有检索端口执行计划；EvidenceBundle 保留来源；ExecutionTrace 为 UI 和观测适配器提供共同事实。

输入、语义决策和数据库授权分离。状态明确区分 waiting/running/succeeded/empty/skipped/degraded/failed/cancelled。可用性故障按计划回退；授权、来源冲突或版本完整性异常不得伪装成“无结果”后继续使用问题证据。具体异常和取消必须携带 operation、backend、traceId 与可公开的 errorCode。

### Acceptance Criteria（唯一语义来源）

- AC-01：WHEN 同一请求经过多层路由 THE SYSTEM SHALL 产生一个版本化 QueryUnderstanding，保留多意图、实体候选、槽位、简短决策理由及来源，且 UI 展示的决策与执行计划一致。
- AC-02：WHEN 语义输出非法、缺槽位或实体有歧义 THE SYSTEM SHALL 按场景澄清或采用可解释的保守回退，不执行任意模型生成查询，不随机选择实体。
- AC-03：WHEN 执行联合检索 THE SYSTEM SHALL 按服务端固定的 scope/publication/预算调用获准后端，记录每个实际 provider 调用和融合步骤，且每个 request-local 计划无环、有界、可取消。
- AC-04：WHEN 多路召回含同一证据 THE SYSTEM SHALL 校验来源一致、去重并保留各源排名与贡献，不直接混加 BM25、向量和图分数，也不重复计算已经融合的同一信号。
- AC-05：WHEN 答案解释一条关系路径 THE SYSTEM SHALL 保留有方向、有 predicate 的关系及每条边实际入上下文的支持证据；缺边、截断或撤销来源时不得呈现为完整证明。
- AC-06：WHEN scope、权限、删除或发布状态变化 THE SYSTEM SHALL 在检索和引用预览时重新执行授权与有效性校验；任何返回片段、路径或调试数据均不得越界。
- AC-07：WHEN 源数据更新、删除或投影失败 THE SYSTEM SHALL 通过可重试且幂等的现有投影流程维护版本清单，查询固定一个可验证发布视图，识别滞后并按能力降级。
- AC-08：WHEN 展示执行链路 THE SYSTEM SHALL 使用真实时间、父子关系和依赖 links，区分计划与执行、并行与串行、跳过与失败、shadow 与 active；未知关系不按数组顺序伪造。
- AC-09：WHEN 用户从答案进入诊断 THE SYSTEM SHALL 关联同一 trace 的意图、后端候选、融合结果、上下文、引用和证据子图，并通过授权的版本化定位查看原文。
- AC-10：WHEN 查询代码/业务调用与影响范围 THE SYSTEM SHALL 标注仓库/版本/环境、调用方向、来源位置以及 static/runtime/documented 证据类型；无法解析的动态调用和覆盖缺口显式可见。
- AC-11：WHEN 任一可选检索源超时或不可用 THE SYSTEM SHALL 仅按声明的回退策略返回有依据的结果，标明覆盖损失；必需关系证据缺失、完整性错误或取消不得静默继续。
- AC-12：WHEN 从旧接口迁移或灰度启用 THE SYSTEM SHALL 保持旧响应兼容、off 行为及 shadow 隔离，经固定语料评测、真实隔离集成和浏览器验收后才进入下一发布阶段。
<!-- design-authority:end -->

该区块在用户确认后冻结为 revision 1 的设计基准。后续变更明确修订版本；以下任务只引用 AC 编号，不另造验收语义。没有启动 Harness 或改变已有 Sprint 指针。

## 5. 目标架构与存储职责

~~~mermaid
flowchart TD
    Q[聊天问题与会话上下文] --> S[服务端授权与发布视图]
    S --> U[QueryUnderstanding<br/>规则与结构化语义识别]
    U --> P[PlanCompiler<br/>能力、模板、预算、依赖]
    P --> E[ES 词法与标识符召回]
    P --> V[Milvus 语义召回]
    P --> L[实体定位与消歧]
    L --> G[Neo4j 关系与路径查询]
    E --> Seed[可选的片段到实体种子]
    V --> Seed
    Seed --> G
    E --> F[候选合并、来源校验与重排]
    V --> F
    G --> F
    F --> C[上下文与完整关系证据包]
    C --> A[生成、引用映射、支持性检查]
    A --> UI[答案 + 意图 + 执行链路 + 证据子图]
    P -.执行事件.-> T[统一 Trace<br/>PG 持久化]
    E -.执行事件.-> T
    V -.执行事件.-> T
    G -.执行事件.-> T
    A -.执行事件.-> T
    T --> UI
~~~

这表示可选择的依赖，实际请求不会固定执行所有分支。有明确实体 ID 的图查询可以与文本检索并行；需要 passage seeds 的图扩展必须等待对应召回。计划编译器必须为单次请求选定一种无环依赖。

| 组件 | 权威职责 | 不承担的职责 |
| --- | --- | --- |
| PostgreSQL/现有内容存储 | 原文、元数据、权限/删除状态、发布清单、outbox、Trace 持久化 | 在线图遍历或大规模词法排序 |
| Milvus | 现有向量语义召回及向量版本 | 关系真值、调用链拓扑 |
| ES | BM25、精确标识符、代码/实体候选查找；后期可投影 Trace 搜索 | 关系路径真值、权限权威源 |
| Neo4j | Entity/Claim/Passage 图、方向与路径、代码/服务依赖 | 存放全部逐 token 日志；替代原文引用和授权 |
| RAG Kernel | 计划、预算、召回、融合、上下文与回答编排 | 以 LLM 判断代替授权 |

Trace 起步继续存 PG；ES 的 Trace 索引仅在检索量证明必要时追加，使用独立 mapping、保留周期和权限。Neo4j 可存服务依赖汇总与 Trace 引用，原始高频 Span 不默认全量入图。

## 6. 意图识别与执行规划

### 6.1 保留层次，统一输出

L0 会话能力路由继续处理寒暄、时间、计算等明确需求。显式文档问题仍进入 RAG。

L1 识别语义任务：fact_lookup、entity_profile、relation_path、dependency_upstream、dependency_downstream、impact_analysis、comparison、aggregate、global_summary、trace_diagnosis。允许多标签，每个子问题带自己的实体角色和约束。

L2 根据可用数据和任务要求决定 ES、Milvus、图模板、Trace 读取、顺序上下文等执行能力。已有 chat/fast_rag/reasoning 的复杂度分类作为策略输入，不再独立覆盖检索事实。

最小 QueryUnderstanding 包含：

~~~json
{
  "schemaVersion": "query-understanding/v1",
  "decisionId": "request-local-id",
  "intents": ["dependency_upstream", "impact_analysis"],
  "mentions": [
    {
      "text": "支付服务",
      "role": "target",
      "type": "service",
      "candidateEntityIds": ["service:payments"],
      "resolution": "resolved"
    }
  ],
  "relationConstraints": {
    "predicates": ["CALLS"],
    "direction": "incoming"
  },
  "requestedView": ["answer", "dependencyGraph"],
  "clarification": null,
  "decisionSource": "rules+semantic",
  "reasonCodes": ["explicit_impact_question"]
}
~~~

示例中的 entity ID 仅为说明。scope、可信级别、publication、数据库名、索引名和查询模板授权由服务端补入执行计划，模型不能授予这些能力。

### 6.2 决策策略

1. 规则处理明确标识符、接口、错误码、方向词和已知槽位。
2. 有需要时最多调用一次结构化语义识别；复用现有模型选择和结构化输出设施，用 schema 校验枚举、实体数组和最大子问题数。
3. 规范名/别名精确匹配优先；候选不足时用 ES 实体候选索引或受控 Neo4j fulltext，结合类型、所在模块、会话中已确认实体消歧。
4. 低置信度、同名冲突、代码版本/环境歧义优先澄清；普通文档事实可回退文本检索。置信度来自校准与规则证据，不将 LLM 自报值当概率。
5. 决策失败显示原因和保守路线，不重复重试整个对话链。意图缓存绑定会话消歧上下文、模型/schema 版本及 scope 分区。
6. 决策解释只展示简短原因、命中规则和候选结果；不要求或存储模型私有思维链。

### 6.3 首批路由表

| 用户问题 | 主执行方式 | 补充与回退 |
| --- | --- | --- |
| “ERR_PAYMENT_402 是什么？” | ES 精确标识符 + 词法，按需 Milvus | 保留原始错误码，不把分词近似当精确命中 |
| “张三负责哪些项目？” | 消歧 → 关系模板 → 来源原文 | 图不可用时文本回答并说明范围 |
| “A 和 B 通过什么联系？” | 双实体定位 → 有界路径 | 每条边可查来源；无路径不编造关联 |
| “谁调用支付服务？” | CALLS 入向路径 | static/runtime 分层和环境过滤 |
| “这个方法改动会影响哪些接口？” | 反向调用/依赖闭包，受深度和类型约束 | 返回影响候选与覆盖边界，不保证所有运行时影响 |
| “这次回答为什么没有用 Neo4j？” | 根据当前 trace 读取决策与执行状态 | 不重新猜测原意图，不重新运行原问答 |
| “两个文档里的客户是不是同一个？” | 多文档实体候选与来源比对 | 不同标识或歧义时保留不同实体 |
| “这些材料整体讲了什么？” | 有界完整语料读取；后期社区归纳 | 明示覆盖比例，TopK 结果不冒充全库总结 |
| “有多少接口依赖该服务？” | 授权范围内固定去重聚合模板 | 截断列表不提供精确总数 |

## 7. 联合检索与 Neo4j 优化

### 7.1 渐进接线，避免一次重写执行器

第一步保持当前 lane 接口，在 dense 内部记录 milvus.search、es.search、fusion.rrf 三个真实子 Span；给 Graph Lane 增加 seed 来源与关系模板诊断。这样先获得准确可视化和测量基线。

第二步给计划增加 dependsOn、operationKind、requiredCapabilities、failurePolicy、providerBudget。保留 legacy sequential adapter，将旧 lanes 转成串行依赖；新计划只并行无依赖节点。不能直接 Promise.all 所有 lanes，因为图扩展依赖召回种子、重排依赖完整候选。

现有 durable workflow 仍负责持久执行状态；新 planner 编译为现有执行设施可消费的步骤，不再引入第二套通用 Agent 调度框架。

### 7.2 召回和融合

- ES 负责名称、编号、路径、错误码、符号等精确/词法需求；Milvus 负责同义表达和语义相似；Neo4j 负责类型化关系与路径。
- 实体明确时优先实体 ID 入图，避免每次扫描中文单字匹配；通用问答可利用 ES/Milvus 召回的 passage IDs 找种子。
- 候选窗口与最终 context TopK 分离，初始可配置为文本各 30～50、图证据最多 20、上下文 8～12 个证据组，最终值经数据和 token 预算测量后冻结。
- 将图召回映射回 canonical passage ID，形成 dense、lexical、graph 三路原始排名。以应用侧 RRF 为基线，不把已融合的 dense+ES 排名当一个新通道再重复累计原通道。
- 标准 RRF 为各源 1/(k+rank) 之和；意图加权属于后续实验，不能默认声称优于等权。记录 source rank、命中原因、graph seed 来源及新增证据。
- Graph 由文本种子派生时，两路并非独立证据；保留依赖关系，分别评估新增来源与单纯重复加权的收益。
- 同 ID 的内容/版本/来源不一致视为完整性错误。重排只处理统一候选，关系证明按 group 保留；token 裁剪若破坏路径完整性，则移除该路径解释或显示未完成。
- 图关系若只来自模型抽取，应标注 extracted/documented，不提升为已验证业务事实。
- 图上连通只证明存在所列关系；因果、影响传播或控制流结论必须符合专用 predicate 的语义。精确聚合默认指“该授权发布图中已收录的数量”，只有覆盖证据充分时才表述为全业务总数。

RRF 的算法依据参考 [Elastic RRF 文档](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)；本项目继续应用侧实现，不把 ES 原生 RRF 的版本或许可作为前提。外部召回后追加图查询的组合方式可参考 [Neo4j GraphRAG 检索指南](https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html)，不要求引入其 Python 包。

### 7.3 图查询模板与性能

首批模板：entity_profile、neighbors_by_predicate、relation_path、dependency_upstream、dependency_downstream、impact_candidates、bounded_aggregate。输入仅为已校验实体 ID、允许的 predicate、方向、scope、版本、深度和数量。

当前 Entity → Claim → Entity 结构中，一个业务关系对应两条物理边，现有 1～2 跳不能直接改成任意 Cypher 深度。业务关系通常保持 1～2 跳；代码依赖通过独立模板允许配置到 4 跳，必须有 cycle detection、visited/node/edge/result/time 限制，返回 coverage/truncated。

优先优化顺序：

1. 对规范名、alias 和标准 ID 的命中质量建基线；词法种子需稳定排序和确定性截断。
2. 为新的代码 symbolKey/serviceKey 和固定版本查找设计复合索引，按实际查询计划决定，不先堆索引。
3. 大图使用实体候选索引后按 ID 入图；若直接用 Neo4j fulltext，授权过滤和有效候选窗口必须联合处理，禁止全库 TopK 后才过滤造成跨租户干扰或召回饥饿。
4. 每个模板运行真实 EXPLAIN/PROFILE，记录 rows/dbHits/耗时/截断；LIMIT 只限制结果，不保证遍历工作量有界。
5. 复用现有 driver/session/read transaction timeout；查询取消不等同一定终止服务端工作，需要验证超时与残留任务，继续保留全局预算。
6. 缓存绑定 scope、publication、图版本、模板版本、实体/方向/深度、撤销代际；不能只按问题文本缓存。

### 7.4 ES mapping 与版本

保留现有 rag_chunks_v1，新增版本索引与 alias 切换，不原地更换 analyzer。新增字段按需求显式声明：entity_ids、entity_aliases、symbol_key、qualified_name、repository_id、source_revision、service、endpoint、error_code；标识符采用 keyword 子字段，中文描述继续文本分词。

候选实体索引、代码 chunk 索引和可选 Trace 搜索索引分开。所有索引保留 tenant/corpus/version/trust 与来源定位；不把生成摘要冒充原文。样例测试需覆盖中文、人名别名、camelCase、snake_case、文件路径、URL 路由和错误码。分片/副本按真实部署容量调整；当前 mapping 的 1 shard/0 replica 只是已见代码默认，不能据此推断生产拓扑。

## 8. 发布一致性与数据流

~~~mermaid
flowchart LR
    D[文档与批准的代码快照] --> P[PG 权威记录与版本清单]
    P --> O[现有 Outbox 与 worker]
    O --> E[ES 投影]
    O --> V[Milvus 投影]
    O --> G[Neo4j 图谱构建与投影]
    E --> R[按能力验证就绪]
    V --> R
    G --> R
    R --> A[CAS 更新已发布视图]
    A --> Q[请求固定 PublicationView]
~~~

复用已有 graph publication 与 ES outbox，新增联合 PublicationView，至少含 corpusPublicationId、documentVersion 清单摘要、lexicalIndexGeneration、vectorCollection/index 版本、graphSnapshotId、schema/extractor 版本及各能力 ready 状态。

不宣称跨数据库 ACID。采用可重试投影、幂等事件、发布屏障和权威视图验证。文本版本可先发布为 text-ready；图谱只有与该视图来源兼容才标 graph-ready。若新文本已发布而图投影滞后，关系查询暂降级或保留上一完整发布视图，由显式策略决定，不能默默混读。

读取不要求每个问题把三库全部读遍：先固定权威视图，再让参与该计划的后端执行对应版本筛选和结果校验。ES 返回 document_version 但当前查询未按完整发布清单过滤，该缺口需要补上；Milvus 和图查询用相同权威版本约束。

删除/权限撤销优先写权威 tombstone/授权代际；异步删除尚未完成时也不能返回已撤销来源。跨源不一致、失效引用、索引滞后与无命中分别记录。旧版索引/快照保留受控回滚窗口，执行物理清理前沿用原计划的保留与删除门禁。

## 9. 双链路模型与可视化

### 9.1 RAG 执行链路

ExecutionTrace 增量扩展现有 Trace/Observation：

| 对象 | 主要字段 |
| --- | --- |
| Trace | traceId、requestId、sessionId、policyVersion、publicationId、scope 分区、status、start/end |
| Step/Span | stepId、parentSpanId、dependsOnStepIds、attempt、operation、provider、start/end、status、errorCode |
| 决策 | decisionId、intent/slot 摘要、reasonCodes、选中与跳过能力、预算 |
| 证据流 | retrievedIds、fusedIds、contextIds、citedIds、claim/path IDs、排除原因 |
| 计量 | 查询与模型耗时、token/cost 的 measured/estimated/unknown、候选数、重排数、超时和降级 |

parentSpanId 表示嵌套所有权，dependsOnStepIds 表示执行依赖，二者不能互相替代。跨服务以后通过 W3C/OTel context 传播，对应关系参考 [OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/)；先建兼容的数据适配，不要求第一批部署额外 Collector/APM。

节点时间必须在真实执行边界记录。当前通过总耗时反推起始时间的 projection 只能作为 legacy estimate，不能用于新 DAG 的并行关键路径计算。总墙钟时间、关键路径耗时与各节点累计耗时分别展示。

前端在同一回答详情中提供四个视图：

| 视图 | 展示内容 | 交互 |
| --- | --- | --- |
| 意图与计划 | 主/次意图、实体候选、歧义、模板、选路原因、跳过原因 | 点实体看消歧；查看原始规则/结构化输出摘要 |
| 执行 DAG / 瀑布图 | 意图、embedding、ES、Milvus、图查询、融合、重排、生成 | 真实并行分支与汇合；节点耗时、状态、候选流转 |
| 证据子图 | 本次回答相关 Entity/Claim/Passage | 点边看支持片段；只高亮被当前回答采用的路径 |
| 证据列表 | 原文、版本、各源排名、是否进入上下文/引用 | 双向定位答案编号、Span 和图节点 |

展示“计划使用 Neo4j，但未发布而跳过”“shadow 已执行但未进入答案”“图扩展找到证据但被 token 预算排除”等真实原因。

沿现有 HTTP 响应逐步增加 traceRef/diagnostics，不破坏旧客户端。实时需求明确后使用带序号的事件流，支持断线后从持久化快照恢复；浏览器断连、重试与重复事件需有明确行为。第一批可先完成终态回放，再实现实时增量。

### 9.2 业务/代码依赖图

起步限定本仓库 TS/TSX 和 Next.js 服务端入口，利用已存在的 TypeScript 编译器 API。静态解析先覆盖 import/export、可解析函数调用、route handler、显式 fetch URL/SDK 调用及配置注入；动态 import、反射、运行时构造 URL、回调绑定不强行猜测。

| 节点 | 关系 | 来源 |
| --- | --- | --- |
| RepositoryVersion、File、Module、Symbol | CONTAINS、IMPORTS、EXPORTS、CALLS | 固定 sourceRevision、相对文件、符号标识、行列 |
| Service、Endpoint、Database/Index | EXPOSES、CALLS、READS、WRITES、DEPENDS_ON | 接口契约、静态调用、运行时 span |
| BusinessProcess、BusinessStep、DomainEntity | IMPLEMENTED_BY、USES、DEPENDS_ON | 结构化业务配置或经复核的文档来源 |
| Claim/SourceLocation | SUPPORTED_BY | 代码片段、契约字段、文档片段或受控 Trace 引用 |

保留现有 Entity/Claim 表达来源的能力；类型化节点/关系通过版本化 adapter 映射，避免第一步复制完整图存储框架。为性能建立的 CALLS 等直接边属于可重建投影，必须保留对应 Claim/source IDs。

静态符号身份由 repositoryId + sourceRevision + modulePath + qualifiedName + kind 构成；行号只是 locator，不作为跨版本稳定 ID。重载、匿名函数、重命名必须处理冲突和不确定性。当前 dirty workspace 如需被分析，生成独立 manifest/digest 并标注 working-tree snapshot，不能伪称某个 Git commit 的内容。

调用边记录 evidenceKind=static-resolved/static-possible/runtime-observed/documented、sourceRevision、environment、validity、locator。运行时观测有采样、时间窗口和版本限制；“未观测到”不等于“不调用”。业务 DEPENDS_ON 也不直接等价代码 CALLS。

视图支持上游/下游、predicate、版本、环境和证据类型过滤，循环折叠、按模块聚合、按需展开。默认最多约 100 节点/200 边，超限展示截断与继续展开入口；实际阈值由目标机器浏览器测量确定。复用现有 React Flow/Canvas，先完成数据正确性，不引入第二套前端图技术栈。

### 9.3 两类图如何联动

点击 RAG DAG 的 neo4j.path 节点，定位本次检索路径；点击“支付服务”节点，切换到指定版本的服务依赖子图；点击其中 runtime-observed 边，按权限查看样本 Trace；从答案引用跳到原始代码行或文档位置。

这四类 ID 必须显式映射：trace/step、entity/claim/path、canonical evidence、source locator。执行图中的 ES 节点代表这次检索调用；业务图中的 ES 节点代表被业务服务依赖的资源，不能因为名称相同自动合并。

## 10. 契约迁移与消费者一致性

| 契约 | Before | After | 消费者与一致性验证 |
| --- | --- | --- | --- |
| 意图 | 多处字符串分类 | QueryUnderstanding + 旧字段 projection | Ask、Agent、QueryAnalysis、Intent 面板；同请求投影一致 |
| 检索计划 | lanes 顺序列表 | v2 DAG + legacy sequential adapter | Kernel、lane executor、durable workflow、测试夹具；无环/取消/预算/旧计划等价 |
| 后端诊断 | dense lane 内藏 ES 与融合 | provider spans + fusion span | Trace、metrics、UI；真实调用次数与显示一致 |
| 图身份 | 单 document/version | corpus publication selector + 旧单图适配 | Ask、GraphRetrievalPort、build、query API、引用；旧身份仍可解析 |
| Evidence | 单 laneId + metadata | canonical evidence + 多路贡献/路径组 | 融合、重排、context、Agent、citations；同 ID 不丢来源 |
| 图来源 | 文档 passage 为主 | 可验证文档/代码/观测 source locator | 图构建、源码预览、引用授权；版本/权限/删除负例 |
| Trace | Observation 树及扁平 lane latency | 真实 span 时间与依赖 links | PG store、LangSmith adapter、UI、历史回放；unknown/estimated 显式展示 |
| 发布 | 各投影独立状态 | 联合 PublicationView，按能力 ready | PG/outbox、ES/Milvus/Neo4j、cache；更新/延迟/重放/删除测试 |

schema、类型与浏览器响应分别做受控投影。调试输出按权限提供脱敏摘要，不能把内部 Cypher 参数、原文全集或密钥作为通用 telemetry 输出。traceId 只是定位 ID，不是访问凭证。

## 11. 分阶段实施任务

本轮没有开始以下任务。路径均相对仓库根 E:/project/ai/rag/project/rag-nextjs；带“新增”的文件是拟议边界。每项包含实现和同名隔离测试。共享文件修改串行，不以分析阶段的绿测替代实施验收。

| ID / 阶段 | 目标与文件集合 | 依赖 | 风险 | 完成证据 |
| --- | --- | --- | --- | --- |
| T0 / 基线 | 核对在途单图/引用里程碑与本方案冲突；新增 docs/reports 的基线报告、rag/eval/fixtures 联合场景集 | 方案确认 | L1 | 当前行为矩阵、固定语料/版本、已知失败和 AC 映射 |
| T1 / 意图 | 新增 src/lib/rag/query-understanding/{contracts,analyzer,entity-resolver}.ts；适配 query-intent.ts、retrieval-router.ts；对应 tests | T0 | L2 | AC-01/02；复合意图、同名、方向、无槽位、非法 JSON、会话承接红绿测试 |
| T2 / 可观测底座 | 新增 src/lib/rag/observability/{execution-events,legacy-adapter}.ts；扩展 core/types.ts、observability.ts、trace-mirror.ts、postgres-trace-store.ts 及迁移 | T0 | L3 | AC-08；真实时间、父子/依赖、重试与历史 trace 回放 |
| T3 / 单图闭环接线 | ask/runtime.ts、milvus-elasticsearch-fusion.ts、graph-entity-lane.ts、graph-context.ts、context-composer.ts、rag/citations/；复用在途实现 | T1、T2；现有单图引用验收 | L3 | AC-03/04/05/06/09/11；三源真实子 span 与回答引用一致 |
| T4 / 执行与证据视图 | LangSmithReactFlowGraph.tsx、LangSmithTraceViewer.tsx、QueryAnalysis.tsx、ChatMessage.tsx；新增 EvidenceSubgraphPanel.tsx 与只读 trace DTO | T3 | L2 | AC-08/09；并行/汇合、shadow、故障、截断和原文跳转浏览器验收 |
| T5 / 联合发布与多文档 | knowledge-graph/{contracts,publication-identity,postgres-publication-store}.ts、elasticsearch/{lexical-index,postgres-outbox-store}.ts、图/索引 worker、core/cache-identity.ts、迁移 | T0、T3 | L4 | AC-06/07/12；投影延迟/重放、版本切换、旧图兼容、撤销即时生效 |
| T6 / 图查询与实体定位 | knowledge-graph/{neo4j-retrieval-port,neo4j-query-port}.ts、neo4j/schema.ts；新增 query-template-registry.ts；ES 实体候选索引模块 | T1、T5 | L3 | AC-02/05/10/11；参数化、方向、真实 PROFILE、授权候选窗口与遍历预算 |
| T7 / 联合 DAG 与融合 | retrieval/{retrieval-plan,lane-executor,milvus-elasticsearch-fusion}.ts、core/durable-* 适配；新增 evidence-fusion.ts；ask/runtime.ts | T3、T5、T6 | L3 | AC-03/04/11/12；旧计划等价、真实并行、必需/可选降级、证据组完整 |
| T8 / 代码静态图 | 新增 src/lib/code-graph/{snapshot,typescript-extractor,contracts,projector}.ts、scripts/index-code-graph.ts 及夹具；适配图构建与 ES 代码索引 | T5、T6 | L3 | AC-06/10；固定快照、符号身份、循环、重载、未解析动态调用、源码 locator |
| T9 / 业务与运行时关联 | 新增 code-graph/{service-catalog,runtime-observation-adapter}.ts；instrumentation.ts、内部 provider spans、受控只读 Trace 关联接口 | T2、T8 | L3 | AC-06/08/10；版本/环境匹配、静态与观测分层、采样缺口与数据授权 |
| T10 / 依赖图与问答联动 | KnowledgeGraphConsole.tsx、KnowledgeGraphViewer.tsx；新增 CodeDependencyPanel.tsx；最小只读图 API，Ask 只读工具适配 | T4、T7、T8、T9 | L3 | AC-09/10/11；影响问答→图路径→代码/Trace，版本切换和大图限额 |
| T11 / 联合验收与发布准备 | rag/eval/、scripts/run-rag-eval.mjs、HTTP/集成/浏览器场景、docs/runbooks；原生产门禁适配 | T4～T10 | L4 | AC-01～12；配对评测、隔离真实 PG 与三种检索后端、故障注入、类型/lint/build，保留原生产 gate |
| T12 / 后续扩展 | 社区归纳、深层业务聚合、其他语言 extractor | T11 后明确数据与收益 | L3 | 独立增量设计与评测；不算入首批完成承诺 |

T2、T3、T7、T9 等共享 Trace/runtime 文件，安排顺序合并。T5、T6、T8 共享图契约与投影边界，先确定 schema 再开发消费者。本方案不授权自动并行启动代理。

交付划分：

- M1 = T0～T4：普通聊天里的意图、三源调用、单图关系、引用、执行回放闭环。
- M2 = T5～T7：知识库级发布一致性、多文档关系与可组合计划。
- M3 = T8～T10：本仓库代码/业务依赖问答与双图联动。
- M4 = T11：集成验收与原发布流程衔接。

初步工作量仅用于排期讨论：单名熟悉仓库的工程师约 25～40 个工作日，包含测试与联调，不含外部系统接入等待、标注集准备和原生产门禁未完成项。T0 后按实际在途完成度重估，不能把该范围作为上线日期承诺。用户可在 M1 后先验收可用价值，不必等所有后续扩展。

## 12. 验证与发布门槛

### 12.1 固定评测集

建议起步建立 100～150 条人工核对问题，按事实、精确标识符、实体、关系、多跳、跨文档、代码上下游、影响分析、Trace 诊断、无答案/歧义分别分层。开发集和冻结验证集分开，记录相关证据、预期路径/方向、允许替代答案及权限范围。

比较四组：Milvus；Milvus+ES；Milvus+Neo4j；Milvus+ES+Neo4j。固定文档/代码快照、embedding/LLM、prompt、token 预算和重排设置，逐例配对并重复测量波动。另测 ES-only/Graph-only 的可选降级路径。未知或不可用的能力显式标出，不用总平均掩盖关系题退化。

| 层面 | 指标 |
| --- | --- |
| 意图 | macro-F1、多意图 exact match、槽位/方向准确率、实体 Top1、澄清正确率 |
| 检索 | Recall@K、MRR/nDCG、图新增有效来源比例、关系路径完整支持率 |
| 回答 | 事实支持率、引用正确/覆盖率、无依据断言率、正确拒答率 |
| 链路 | 实际调用与展示一致率、失联 Span、错误连边、未知时间比例 |
| 代码图 | static-resolved 精度、标注集覆盖率、动态未解析率、影响候选 precision/recall |
| 运维 | p50/p95/p99、首 token、后端/模型成本、并发吞吐、超时率、投影 lag |

零越权、零来源冲突被接受、零 shadow 证据进入答案、零取消后继续生成是硬门槛。其他数值在 T0 基线后、调参前冻结：普通事实不超过预设非劣界；关系/代码题达到预设提升或达到质量目标；延迟在场景预算内。若没有可重复收益则不激活对应增强。当前没有真实基线，不能编造提升百分比。

### 12.2 测试顺序

1. 意图/slot、计划无环、fusion、path 支持、source identity 的纯函数测试先红后绿。
2. Provider port contract：超时、空、错误、跨 scope、版本冲突、重复 ID、取消、重试。
3. 隔离真实 PostgreSQL/Neo4j/ES/Milvus：schema、真实 Cypher、查询计划、worker、重启和删除传播；不能由 mock 测试替代。
4. HTTP/浏览器：同一回答跳转意图/DAG/图边/原文、历史引用、授权撤销、刷新/断线恢复、大图截断和键盘可访问性。
5. 运行匹配变更范围的现有脚本，再到联合测试、类型、lint、生产 build。修复新失败后才扩大范围。
6. 真实生产 shadow/active 沿用现有生产门禁计划；本方案不替代其未满足的前置条件。

### 12.3 预算与故障策略

先复用当前 request budgets；新增每类计划可配置的子预算与取消。初始建议作为测试配置：语义路由最多 1 次模型调用；图查询默认 1～2 业务跳；只读补检索最多 1 轮；关系候选、代码节点和返回字节都设上限。具体毫秒预算按目标设备与模型冷/热启动数据确定。

| 失败 | 行为 |
| --- | --- |
| ES 不可用 | 允许的计划回退 Milvus；记录 lexical 不可用 |
| Neo4j 不可用 | 普通事实可文本回答；必须图证明的路径/影响问题提示证据不足 |
| Milvus 不可用 | 当前实现会失败；将来只在已声明的词法/图独立计划中回退，不隐式改变所有旧策略 |
| LLM 意图识别失败 | 规则保守路线或澄清，记录 semantic unavailable |
| 图未发布/版本滞后 | 显示 unavailable/stale；选择可证明一致的文本或旧发布视图 |
| 跨 scope、ID 来源冲突 | 拒绝问题结果，不按普通超时处理 |
| 循环/超深/高出度 | 停止扩展、返回明确截断与覆盖范围 |
| 模型引用不存在证据 | 不生成伪定位；诊断无效引用，按回答策略修复或说明证据不足 |

off/shadow/active 沿用现有开关，新能力独立切换但由 PlanCompiler 校验组合。回滚应用代码/计划版本和发布指针即可恢复旧链路；索引/图数据保留兼容窗口。删除与 schema 不兼容迁移需要单独执行门槛。

## 13. 与当前在途工作的关系

- [普通聊天单图里程碑](E:/project/ai/rag/project/rag-nextjs/docs/plans/2026-10-22-neo4j-chat-first-milestone.md) 的实现作为 M1 依赖；本轮已看到 query-intent、graph-evidence、graph-context、citations 等未提交改动，不能重新实现另一套引用。
- [通用 Neo4j 使用方案](E:/project/ai/rag/project/rag-nextjs/docs/architecture/2026-10-22-neo4j-general-usage.md) 提供前期场景方向；其中部分现状已被在途代码推进，本方案按本轮源码更新事实。
- [原生产门禁计划](E:/project/ai/rag/project/rag-nextjs/docs/plans/2026-09-09-rag-neo4j-production-gates-and-citations.md) 继续约束生产执行与引用安全。联合发布需补 ES 和代码来源消费者，不能因新方案简化原已确认门槛。
- 不改变旧 Sprint 的任务计数、pointer、完成状态，不提交、不推送、不改生产开关。

## 14. 本轮证据、未知项与下一动作

已完成：参考项目固定提交源码调查；当前工作树的 Ask、图查询、ES 融合、意图、执行器、Trace、可视化与投影代码调查；现有定向测试 **26/26 通过，0 失败、0 跳过**。

本轮测试命令：

~~~powershell
node --test src/lib/knowledge-graph/query-intent.test.mjs src/lib/knowledge-graph/neo4j-retrieval-port.test.mjs src/lib/rag/retrieval/milvus-elasticsearch-fusion.test.mjs src/lib/elasticsearch/lexical-index.test.mjs src/lib/rag/retrieval/retrieval-router.test.mjs
~~~

这些是隔离/假客户端测试，不证明真实数据库、生产配置、整体在途引用工程或浏览器行为已验收。存在 Node module-type 提示，测试仍成功；本轮不顺带更改 package 类型。

未核验：当前部署的各 backend/mode、索引与图数据量/完整性、真实延迟并发、模型质量、已有服务契约与 OTel 数据、除本仓库之外的目标代码仓库与语言。方案默认先覆盖当前 TS/Next.js 仓库，接外部业务系统时再明确接入清单。

沙箱命令执行器与 node_repl 曾因 setup refresh 错误无法启动，已通过经审核的沙箱外只读命令完成调查及隔离测试；不代表生产环境故障。

下一动作是用户评审本方案的范围、阶段与设计取舍。确认后从 T0 开始，以 M1 作为第一个可验收交付；本轮没有实施功能或迁移数据。

