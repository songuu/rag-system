---
type: implementation-plan
status: proposed
date: 2026-10-25
revision: 1
scope: plan-only
source_head: 5a28045
first_batch: [graph-extraction, simulation-report]
---

# 多 Agent 拆分方案：图谱知识抽取与报告生成

本方案基于当前工作树，包括尚未提交的改动。当前交付只新增本方案文档；不实施代码、数据库迁移、部署、模型调用或生产开关变更，也不修改既有 Sprint 指针。以下接口、表和新文件均为拟议设计。

首批把图谱知识抽取和 MiroFish 模拟报告生成抽为两个可独立调用、受权限与预算约束的 Agent 能力。采用普通 TypeScript 编排和现有模型工厂；每类业务队列只有一个调度权威，Agent 不自行领取任务、重试或发布。先保持现有生成算法，再以固定样例验证效果。

首批“多 Agent”意味着多种专业能力共用调用协议。两项能力各有业务入口，暂不建立自由对话或自动转交；未来需要协作时，可以通过已校验的产物引用连接。

## 1. 当前事实与拆分边界

| 已核实的实现 | 拆分决定 | 源码 |
| --- | --- | --- |
| 图谱构建已经有 PostgreSQL BuildJob、scope、版本、lease token 和状态流转 | 保留图谱任务存储与 graph-control-worker，不增加第二个图谱任务队列 | [BuildJob](/E:/project/ai/rag/project/rag-nextjs/src/lib/knowledge-graph/postgres-graph-build-store.ts:20) |
| local executor 从精确 Milvus 文档 revision 重建文本，调用 extractGraph，再保存 artifact；重试会先查询已有 staged descriptor | 在 extractGraph 的注入点接 GraphExtractionAgent，保留源校验和 staged 复用 | [local executor](/E:/project/ai/rag/project/rag-nextjs/src/lib/knowledge-graph/local-graph-build-executor.ts:45) |
| extractMiroFishGraphData 已绕开旧 TaskManager，创建独立 EntityExtractor | 复用抽取、合并和社区摘要流程，增加父 deadline、取消及统一用量适配 | [抽取入口](/E:/project/ai/rag/project/rag-nextjs/src/lib/mirofish/graph-builder.ts:827) |
| ReportAgent.generateReport 输入 SimulationInfo、posts、timeline，输出 ReportInfo 主体 | 首批明确为模拟报告；不伪造 simulation_id 来承载文档报告 | [报告核心](/E:/project/ai/rag/project/rag-nextjs/src/lib/mirofish/report-agent.ts:69) |
| 报告 API 用 Map 保存结果，启动未等待的 Promise；详情与报告聊天直接导入这个 Map | 增加持久快照、报告任务和结果；三个 HTTP 读写入口一起迁移到 service | [报告 API](/E:/project/ai/rag/project/rag-nextjs/src/app/api/mirofish/report/route.ts:18) |
| 模拟运行态为内存 Map；SimulationSnapshot 本身是可序列化业务数据 | 保存完成态快照即可支持报告恢复；首批不重做模拟续跑 | [快照类型](/E:/project/ai/rag/project/rag-nextjs/src/lib/mirofish/types.ts:440) |
| 报告解析失败会返回固定占位内容，generateReport 仍给出 completed | 新 Agent 使用显式解析结果，非法输出不得成为成功报告 | [现有回归](/E:/project/ai/rag/project/rag-nextjs/src/lib/mirofish/report-agent.test.mjs:80) |
| 通用 durable Ask 当前只有 execute-ask 单步骤；默认 checkpoint/result 是文件存储 | 本批不把它套在图谱或报告任务外面，也不据此承诺分布式 Agent 恢复 | [durable Ask](/E:/project/ai/rag/project/rag-nextjs/src/lib/rag/core/durable-ask-workflow.ts:669) |

图谱抽取和模拟报告没有直接输入依赖。报告需要模拟帖子和时间线，GraphData 本身不能代替这些输入。将来如要“根据文档图谱生成研究报告”，另增 DocumentReportInput 和产物类型，不改变本批模拟报告语义。

<!-- design-authority:start -->
## 2. Design Authority（shadow）

### 问题与用户价值

将已有智能生成能力从 HTTP route、内存运行态和业务发布流程中分离，形成统一、可测、可诊断的调用边界。图谱保留现有可靠控制面；报告在进程重启后仍能查询和继续处理已经接收的持久任务。

### 范围 / 非目标

范围：两个 Agent 适配器、统一执行接口、服务端授权和预算、图谱原调度接线、模拟完成快照、报告可靠队列及兼容读取、灰度与恢复。

首批不引入新的 Agent SDK、消息中间件、通用任务平台、LLM supervisor、自主递归子任务或任意数据库工具；不改在线 Ask、MAIC、模拟轮次算法、图谱发布权限和引用系统。报告聊天只迁移读取来源，不增加聊天 Agent。报告覆盖范围保持现有上下文选择逻辑并显式记录，不承诺全量帖子进入模型。

### 备选方案、选择与理由

| 方案 | 判断 |
| --- | --- |
| 只给现有函数改名 | 无法解决报告丢失、失败误标和统一约束，范围不足 |
| 统一能力接口，复用图谱 worker，新增窄范围报告 worker | **采用**；两项能力可以渐进迁移，业务调度边界清楚 |
| 把两类任务全部迁到一张通用 agent_runs 队列表 | 放大图谱迁移与发布回归面，首批不采用 |
| 新建独立 Agent 微服务并替换现有模型与存储体系 | 缺少独立伸缩收益证据，后置评估 |

### 组件、消费者接口、状态与错误路径

AgentDefinition 负责类型化执行；AgentExecutor 负责校验、deadline、预算、模型准入和 trace；现有 graph worker 与新 report worker 分别负责 claim、租约、重试和提交；业务 service 负责授权、输入冻结与 HTTP 投影。Agent 只返回生成结果，业务控制面校验后提交。

Agent 执行成功、图谱 staged/validated、图谱 published、报告 completed 是不同事实。失败使用稳定错误码；身份、版本或输入完整性错误停止任务，可用性错误由所属队列在剩余预算内决定重试。

### Acceptance Criteria（唯一语义来源）

- AC-01：WHEN 图谱抽取通过新适配器执行 THE SYSTEM SHALL 沿用原 BuildJob、文档身份、graphVersion、staged 复用和发布控制，且一次图谱任务只有一个 claim/retry/commit owner。
- AC-02：WHEN 调用任一首批 Agent THE SYSTEM SHALL 校验版本化输入输出，返回明确的成功或失败结果；无效模型输出、占位报告和不完整图数据不得被投影为成功产物。
- AC-03：WHEN 接收、执行或读取报告任务 THE SYSTEM SHALL 依据服务端 scope、已登记模拟归属及项目关系进行授权，忽略客户端声明的身份，禁止跨范围读取快照、结果和诊断内容。
- AC-04：WHEN 相同幂等请求重放 THE SYSTEM SHALL 返回同一任务和报告身份；相同 key 对应不同输入摘要或执行版本时拒绝冲突，不覆盖先前产物。
- AC-05：WHEN worker 重启、租约过期、发生取消或旧执行迟到 THE SYSTEM SHALL 仅允许持有有效授权和当前租约的执行提交结果，终态不被旧执行覆盖，已接收的持久报告不依赖原模拟进程存活。
- AC-06：WHEN 执行模型调用 THE SYSTEM SHALL 继承父取消信号与绝对截止时间，对调用次数、输入输出规模及重试累计用量进行限额；预算或取消终止后不启动新调用。
- AC-07：WHEN 新报告任务提交成功 THE SYSTEM SHALL 原子保存完成态快照引用、冻结的执行配置和任务身份，且报告成功结果与任务成功状态原子可见。
- AC-08：WHEN 原报告消费者访问新执行结果 THE SYSTEM SHALL 保留成功回包、ReportInfo、轮询、章节、下载及报告聊天的既有字段，明确投影排队、失败、取消和未完成模拟的结果。
- AC-09：WHEN 新旧路径切换或回滚 THE SYSTEM SHALL 按任务冻结的执行路径和版本处理在途工作，保留已持久化报告的授权读取能力，不双重执行或自动激活图谱。
- AC-10：WHEN 记录执行诊断 THE SYSTEM SHALL 关联 run/step/attempt、业务任务、版本、时间、用量和稳定错误码；外部 trace 不包含原文、帖子、提示词、模型原始输出或凭据。
- AC-11：WHEN 进入默认启用阶段 THE SYSTEM SHALL 通过合同、安全、故障恢复、HTTP 消费者及隔离真实模型验收；固定输入下原有语义能力不退化，且模拟事实、模型推断与覆盖缺口可区分。
- AC-12：WHEN 两类 worker 访问同一模型 THE SYSTEM SHALL 使用共享的模型准入约束或部署为互斥运行；无法确认模型容量或取消遗留调用状态时拒绝新增执行，不能以进程内计数宣称跨进程限流。
<!-- design-authority:end -->

本方案 revision 1 为待确认设计基准。任务只引用 AC 编号；后续修改通过显式 revision 记录。本轮不冻结既有 Sprint 的验收，不启动 Harness，不发送方案给外部 provider。

## 3. 编排与职责

~~~mermaid
flowchart TD
    V["文档向量化 / 图谱构建入口"] --> GQ["现有 graph_build_jobs"]
    GQ --> GW["现有 graph-control-worker"]
    GW --> GS["精确文档版本读取与完整性检查"]
    GS --> GE["AgentExecutor → GraphExtractionAgent"]
    GE --> GV["原 artifact / manifest 校验与 staged 保存"]
    GV --> GP["原 validated / 显式发布流程"]

    S["已完成模拟：绑定 scope 与冻结快照"] --> RQ["报告 service → report_jobs"]
    RQ --> RW["Report worker"]
    RW --> RL["授权重检与快照摘要校验"]
    RL --> RE["同一 AgentExecutor → SimulationReportAgent"]
    RE --> RC["校验并原子提交报告与任务状态"]
    RC --> HTTP["原报告详情 / 下载 / 聊天"]

    GE -. "受限模型调用" .-> M["同一模型工厂、准入和用量约束"]
    RE -. "受限模型调用" .-> M
~~~

| 组件 | 拥有的职责 | 不交给它的职责 |
| --- | --- | --- |
| GraphExtractionAgent | 文本到 GraphData，复用现有抽取与合并 | Milvus 任意查询、artifact 写入、发布和任务重试 |
| SimulationReportAgent | 固定模拟快照到合法报告草稿 | 读取活动 runner、创建任务、写 ReportInfo 状态、挑选租户 |
| AgentExecutor | schema、版本注册、模型调用包装、取消/预算、用量、trace | 数据库任务生命周期、lease 续期、自动重新入队 |
| 图谱 worker | 现有 claim、源验证、stage、validate、重试 | 第二套 Agent 调度 |
| 报告 service / worker | 授权、快照与任务持久化、lease、提交和兼容读取 | 模型自主决定写库或覆盖报告 |
| Registry | 静态注册两个 agentKind 及其可执行版本 | 从请求动态加载代码、任意工具或远端 Agent |

单次调用沿用现有模型工厂，首批不强制把生成函数改为 createAgent 工具循环。graph 能力仍可包含现有多个确定阶段；report 能力保留一次生成。阶段化抽离本身不增加模型调用数。

适配器通过依赖注入使用当次已解析的生成/嵌入端口；不修改全局默认模型来模拟冻结配置，也不允许现有构造函数在后台重新解析另一套默认值。

## 4. 统一接口

以下 TypeScript 仅说明拟议合同，不是本轮新增的运行代码。I/O 分别由各 Agent 的 Zod schema 校验，数据库只保存 JSON DTO 和业务引用。

~~~ts
type AgentKind = 'graph-extraction' | 'simulation-report';

interface AgentArtifactRef {
  type: 'document-revision' | 'simulation-snapshot' | 'graph-artifact' | 'report';
  id: string;
  tenantId: string;
  corpusId: string;
  version: string;
  schemaVersion: string;
  sha256: string;
}

interface AgentExecutionSpec {
  schemaVersion: '1';
  agentKind: AgentKind;
  agentVersion: string;
  promptVersion: string;
  runId: string;                 // 图 BuildJob ID 或报告 Job ID
  stepId: string;                // extract-graph / generate-report
  inputRef: AgentArtifactRef;
  inputDigest: string;
  modelConfigs: {
    generation: { ref: string; digest: string };
    embedding?: { ref: string; digest: string }; // 图谱使用时必须冻结
  };                            // 服务端不可变配置引用，不含凭据
  policyVersion: string;
  deadlineAt: string;            // 跨自动重试保持的总截止时间
}

interface AgentUsage {
  providerCalls: number;
  inputCharacters: number;
  outputCharacters: number;
  inputTokens: number | null;    // provider 未提供则为 null
  outputTokens: number | null;
}

interface AgentRuntimeContext {
  spec: Readonly<AgentExecutionSpec>;
  attemptId: string;
  security: Readonly<RagSecurityContext>; // 受信构造，执行时重验
  signal: AbortSignal;                    // 不序列化
  budget: AgentBudgetPort;                // 总量扣减，不按 attempt 重置
  model: RestrictedModelPort;             // 固定 provider/model，继承准入
  observations: AgentObservationPort;     // 只收结构化脱敏字段
}

type AgentResult<O> =
  | { status: 'succeeded'; output: O; usage: AgentUsage; warnings: string[] }
  | {
      status: 'failed' | 'cancelled' | 'timed_out';
      error: { code: AgentErrorCode; message: string; retryable: boolean };
      usage: AgentUsage;
    };

interface AgentDefinition<I, O> {
  kind: AgentKind;
  version: string;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  execute(input: I, context: AgentRuntimeContext): Promise<AgentResult<O>>;
}
~~~

合同约束：

- inputRef 是定位与一致性信息，不能作为授权凭证；原始正文和快照由 worker 在授权后解析，Agent 收到只读 DTO。AgentResult 不包含可执行 SQL、发布命令或任意磁盘路径。
- GraphExtractionInput 为精确 document identity、source digest 与已校验文本；输出为现有 GraphData。document revision 的 digest 继续采用已有源 hash 规则，不重新定义 graphVersion。
- SimulationReportInput 为 snapshotRef、simulation/project 身份、快照中的 info/posts/timeline 和覆盖描述；输出为 ReportDraft，包含 title、summary、sections、key_findings。report_id、状态、时间和 sentiment_trend 由 service/确定性统计补齐。
- GraphData 的来源关系沿用现有合同；模拟报告使用 snapshotDigest、post ID 和 timeline round 作为来源，不能生成真实文档 citation locator 或把模拟趋势表述为已证实的现实事实。
- 模型配置首次接收任务时分别冻结 generation 和 embedding 的 provider、模型名、endpoint 身份摘要及影响输出的参数；图谱的嵌入不能在执行时回读动态默认配置。worker 根据服务端不可变配置引用取凭据。HTTP modelOverride 继续只接受现有受限字段，禁止客户端传 baseUrl/apiKey。
- 捕获异常统一归一到 AgentResult；程序错误保留内部 cause 和脱敏上下文，对外仅公开 code、简短 message、requestId。retryable 只是提示，队列 owner 决定是否重试。
- 预算至少控制 provider 调用数、输入输出字符数、总 deadline 和业务结果数量；token 记录采用真实 provider 用量。自动重试不能清零已消费用量；崩溃时采用调用前预留的保守上界，避免丢失计数导致无限重试。

三个运行时端口的最小方法边界：AgentBudgetPort 提供 reserveProviderCall、settleUsage、remaining 和 throwIfExhausted；RestrictedModelPort 提供 invokeStructured 与 embed，内部固定模型配置并处理准入、父 signal 和剩余 deadline；AgentObservationPort 提供 startStep、recordUsage、finishStep，只接受白名单元数据。reserve 在调用前持久扣减调用数及字符额度，settle 只能退回已确认未消费的预留量。未知 token 不参与虚构的精确 token 记账。

worker 根据服务身份和已保存的发起者引用重新构造 security；不把数据库中历史 role 字段直接当成当前权限。自动图谱任务沿用现有服务授权和固定文档 scope，报告任务重查项目/模拟归属；不存在授权主体时显式失败。

持久预算由所属业务 JobStore 实现：图谱使用 BuildJob metadata 中版本化账本及条件更新，报告使用 report_jobs 的 usage/预留字段。reserve/settle 都校验当前 lease token 与账本 revision；每次调用有唯一 callId，避免重复 settle。崩溃或丢失结果的调用预留保持已消费状态，只有明确未发出请求或收到实际用量才能归还差额。T1 的内存假实现只用于合同测试，不能替代 T3/T7 的持久账本。

调用顺序固定为：领取模型容量 → 重验业务 lease/取消/deadline → 幂等持久预留预算 → 记录 callId 与 dispatch → 调用 provider。容量竞争和 claim 次数独立计数；只有进入实际执行的 attempt 才消费自动执行配额。业务 lease 丢失后不再发起新调用；已发出的调用保持容量隔离直到确认结束。

### 错误与重试

| 错误码族 | 自动重试 | 行为 |
| --- | --- | --- |
| INPUT_INVALID / OUTPUT_INVALID | 否 | 记录类型化失败；原始错误模型文本不外发 |
| SCOPE_FORBIDDEN / SOURCE_UNAVAILABLE / SOURCE_CHANGED | 否 | 不回退到全局 Map 或其他文档版本 |
| VERSION_UNAVAILABLE / CONFIG_CONFLICT | 否 | 保留任务，报告明确阻塞原因；不换成当前默认模型 |
| PROVIDER_UNAVAILABLE / PROVIDER_RATE_LIMITED | 有界 | 服从剩余 deadline、次数和累计预算 |
| MODEL_BUSY | 有界等待 | 未发起 provider 调用不扣模型次数；等待仍受总 deadline 限制 |
| BUDGET_EXCEEDED / DEADLINE_EXCEEDED / CANCELLED | 否 | 终止并取消子调用；不提交成功结果 |
| LEASE_LOST | 不由旧 attempt 重试 | 丢弃其回写；由当前队列 owner 处理恢复 |

AgentErrorCode 使用上述稳定前缀的枚举，细分原因留在内部诊断。首批不增加模型自主修复循环；格式失败如需重新生成，由用户显式创建新一代请求。

## 5. 图谱抽取接入

1. 原自动/手动入口继续创建 graph_build_jobs，沿用 tenant/corpus/graphVersion 唯一身份。
2. 自动入队和手动构建入口均调用统一的服务端 ExecutionSpec builder，再由 JobStore.enqueue 在创建 Job 的事务内冻结 spec。包括生成和嵌入配置；不能在 worker 首次执行时临时绑定。已有在途任务缺少该字段时按 legacy 路径排空，不静默绑定新模型。
3. graph-control-worker 仍是唯一调度者；local handler 先走原 staged descriptor 复用及源身份校验，再调用适配器。
4. EntityExtractor 的 LLM/embedding 调用接入父取消、剩余 deadline、累计预算和统一模型准入；保留现有实体/关系/计算规模上限。
5. Agent 成功只代表获得 GraphData。local handler 与原 artifactStore 校验、保存；原 worker 完成 manifest 验证并进入 validated。激活继续需要现有显式权限和发布流程。
6. provider 不能及时取消时，旧结果禁止提交；旧模型调用未结束前，同模型新增执行按准入策略阻止。

现有 graphVersion 主要绑定文档身份。本批不修改该算法：同 graphVersion 首次冻结的执行配置不允许被新 Agent 版本静默覆盖。不同模型/提示词的重抽取版本机制另行修订；初期对冲突显式拒绝。取消后重新构建仍沿现有业务合同，不借 Agent 层绕过终态。

租约沿用 local build 的现有配置与边界，不套用在线 Ask 的短请求预算。任务总 deadline 必须短于可用租约并保留提交余量；如增加续租，续租失败立即停止准入，权威业务提交仍由当前 lease fence 约束。

不把 PostgreSQL Job 与 Neo4j staging 描述为一个跨库原子事务。staged artifact 是不可覆盖的候选，同身份不同摘要必须冲突，且不能直接供普通问答使用；只有当前 lease owner 重新核验源、manifest 和选定 digest 后，才能确认 validated 并沿原发布流程推进。旧 attempt 可能留下未被采纳的 staged 候选，但不得改写已绑定产物或活动指针。恢复时可重新校验并采纳既有合法候选；复用的产物记录 reused-staged 和实际已知的来源版本，不伪称本次执行过新 Agent。T3 专项验证首次并发 stage、取消竞态及旧 attempt 竞争。

新 Agent 产物 provenance 绑定 inputDigest、agentVersion、promptVersion、生成/嵌入配置摘要和 policyVersion。新路径只复用匹配此指纹的候选；缺少 provenance 的历史 descriptor 仅供已冻结的 legacy 任务沿原规则复用，新 Agent 任务遇到它返回 CONFIG_CONFLICT，不能补造来源或覆盖同 graphVersion。不同摘要的候选竞争由不可变存储与当前 owner 的显式选定规则处理，测试包含“过期 attempt 先 stage、当前 attempt 后完成”。

## 6. 报告输入、持久化与恢复

### 6.1 冻结模拟输入

首批可靠路径只接收 completed 模拟。对运行中或暂停中的模拟返回 409 / SIMULATION_NOT_COMPLETED；实时中间报告后置。此项是明确的前置条件收紧，其余成功响应字段保持兼容。

模拟创建时服务端解析 scope，并通过 scoped project store 确认项目；登记 simulationId → tenant/corpus/project/创建者 的权威归属。runner.create 不得只信任客户端 project_id。模拟详情、启动/暂停/删除、SSE 和采访使用同一归属校验，这是报告来源可信的必要范围，不改变轮次生成算法。

模拟完成后先保存完整快照，再宣布其可用于持久报告。首批 completed 模拟禁止以同一 simulationId 再次 start；重新模拟须创建新 ID。否则旧的 ready 快照会与同 ID 追加的新帖子分叉。创建、完成及重新启动的 HTTP/runner 合同一并回归。

拟新增三张窄范围表，复用现有 PostgreSQL client 和事务机制：

| 表 | 关键字段 / 约束 | 用途 |
| --- | --- | --- |
| mirofish_simulation_snapshots | tenant_id、corpus_id、simulation_id、project_id、actor_id、state、snapshot_json、snapshot_digest、schema_version、captured_at；scope+simulation_id 唯一 | 创建时登记归属，完成时一次性冻结快照；ready 后正文与摘要不可覆盖 |
| mirofish_report_jobs | id、report_id、scope、actor、simulation_id、generation、snapshot 引用、execution_spec、input_digest、idempotency_key、status、attempts、claim_count、lease_token、lease_expires_at、deadline_at、usage、error_code、result_digest、timestamps | 报告队列、预算和恢复权威 |
| mirofish_reports | report_id、scope、simulation/project、snapshot_digest、report_json、output_digest、agent/prompt/model 版本、coverage、timestamps | 已校验成功报告；同 report_id 结果不可覆盖 |

快照仅保存 info/posts/timeline/stats 等业务 DTO，不保存 listener、AbortController、模型实例或凭据。完成前可以登记 state=registered；转 ready 时一次性写入 snapshot_json/digest，之后通过不可变约束保持固定。模拟执行失败或快照落库失败不得标 ready。

新报告请求在一个事务内确认 ready 快照、执行配置、幂等绑定和队列插入。首次快照冻结可与入队同事务完成，但只允许从已绑定归属的服务端完成态快照导入。缺失归属的历史内存模拟禁止自动认领；开发环境如需迁移，使用显式授权的离线导入，不接受客户端上传快照补齐权限。

不承诺在快照持久化之前恢复模拟本身；已接收报告任务在 worker/API 重启后通过数据库快照恢复。项目删除/撤权按源有效性检查阻止新生成与读取；物理清理和保留期限沿项目数据策略另行执行，不在本批自动删除用户数据。

### 6.2 调度、状态与幂等

Report worker 使用 claim + lease token + fenced commit，参考现有 PG worker 的实现风格；不将任务放进 durable Ask，不由 HTTP 启动 detached Promise。

~~~text
queued → running → succeeded
              ↘ failed / timed_out / cancelled
running → queued  （可重试错误或租约回收，且未超 deadline/次数/预算）
queued → cancelled
~~~

默认建议：报告 provider 调用每次最多 1 次，自动 attempt 上限 3；总调用数仍受任务预算限制。报告总执行 deadline 初始采用 10 分钟的可配置上限作为候选策略，包含排队与重试，真实本地模型验收后再冻结默认值；这不是当前性能保证。图谱沿用现有抽取限制和业务重试策略，不复制报告默认值。

报告租约初始采用 90 秒、每 20 秒续租的可配置策略；续租校验原 token 与未过期状态，失败即取消当前执行并禁止提交。续租不延长任务总 deadline。worker 回收逾期 queued/running 任务时写 timed_out，不能因未再次发起模型调用而让轮询永久停在 generating。

报告幂等指纹包含 scope、snapshotDigest、executionPath、agentVersion、promptVersion、各 modelConfig digest、policyVersion 和显式 generation。普通重复点击复用同 report_id；同 Idempotency-Key 与不同指纹返回 409。显式“重新生成”使用新 generation，不覆盖既有报告；自动恢复保持同一 generation。MODEL_BUSY 在当前 attempt 内有界等待并续租，不反复消耗生成次数或自动 attempt 配额。

数据库设置 UNIQUE(tenant_id, corpus_id, idempotency_key) 和 UNIQUE(tenant_id, corpus_id, simulation_id, generation)。未传 key 的普通请求使用 generation=0 的确定性绑定；显式重新生成由 service 在事务内分配下一代，重复提交仍需同一个 key。相同 simulation/generation 的配置或输入变化返回 409，并要求新 generation，不能把开关或默认模型变化当成覆盖许可。

成功提交在单事务内校验当前 lease、未取消状态、源有效性和输出 schema，插入最终报告并将 job 标 succeeded。提交前崩溃可重新执行生成，可能产生额外 provider 费用；本批保证单个可见成功产物，不承诺模型调用 exactly-once。提交后响应丢失的重试直接读既有结果。

该事务先锁定任务行，要求 status=running、匹配 lease_token 且 lease_expires_at > clock_timestamp()，插入报告和更新 succeeded 均检查影响行数。取消使用同一任务行锁串行竞争：先提交成功则取消返回已有成功结果，先取消则迟到生成不得写入完成态。上述条件由数据库保证，不能只在应用层提交前查询一次。

报告模型输入保留当前统计与采样策略；coverage 记录总帖子数、统计范围、实际提供给模型的帖子 ID/轮次、截断原因及模型输入摘要。确定性统计可覆盖全快照，文本分析只能声称其实际覆盖范围。新增 strict parser 返回带原因的成功/失败结果；不通过识别占位标题字符串来判断失败。

### 6.3 HTTP 与全部消费者的 before / after

| 消费者 | 当前行为 | 目标合同 / 一致性回归 |
| --- | --- | --- |
| POST /api/mirofish/report | simulation_id/project_id，立即返回 success + report_id；内存后台生成 | 保留默认 HTTP 200 与字段，可加 job_id；落库成功后才确认接收。跨项目 ID、未完成模拟、幂等冲突分别显式拒绝 |
| GET /api/mirofish/report | 列出全局 reports Map | 查询当前授权 scope 的持久结果/任务投影，原 reports 数组字段保持；列表有服务端数量上限 |
| GET /api/mirofish/report/[id] | 详情、progress、section、download 读取同一 Map | 统一 ReportService；每种 action 重验 scope，非成功任务不得导出占位报告 |
| POST /api/mirofish/interaction/chat | 导入 reportStore 并检查 completed | 改读同一 service 的已完成报告，保留 answer/timestamp 与既有模型限制 |
| Step4Report / Step5Interaction / console | 以 report_id 轮询、下载和聊天，项目保存 report_id | 保留 report_id 和成功形状；project_id 绑定采用服务端来源，失败信息脱敏 |
| 模拟创建/完成、详情/控制、SSE 与采访 | project 默认 store + 进程内 runner，来源消费者分散 | 共用归属校验，增加完成快照钩子、禁止 completed 同 ID 重启；保持模拟轮次算法 |
| 新增取消入口 | 无 | POST /api/mirofish/report/[id]/cancel：授权后取消排队/执行，成功报告不删除，重复取消幂等 |

旧 ReportInfo.status 的投影固定为：queued/running → generating；succeeded → completed；failed/timed_out/cancelled → failed，并追加稳定 error_code 和可选 job_status。原 UI 能结束轮询，取消不会显示 completed；新 UI 可显示具体取消原因。过期输入、无权资源不泄露存在性，按现有安全响应约定返回 404/403。

授权映射初期复用现有能力：生成和取消要求 ingest，读取/下载/聊天要求 query；取消另校验创建者或 admin/owner。所有请求经 resolveRagSecurityContext，store 按 tenant/corpus 参数化过滤。运行前与提交时重查来源归属和有效性；原来源不再授权时不继续执行或返回旧正文。该映射是本方案选择，不是当前 Report API 已实现的行为。

## 7. 预算、容量、观察与部署

- 图谱和报告共用 AgentExecutor 的模型包装协议；每个任务有独立总预算，同一任务的多阶段/重试共享账本。图谱现有字符/实体/关系限额继续生效，不把 token 估计当真实扣费。
- 初始部署使用服务端资源池约束。Ollama 同 endpoint 的所有生成/embedding 模型默认共一个执行槽，不能通过换模型名绕过同一 GPU 的容量限制；远程 provider 按服务器配置映射资源池。客户端不能选择或扩大资源池。
- 首批共享槽只约束这两个 worker。在线 Ask、模拟角色等既有模型调用尚未接入它；首轮 canary 使用专用模型资源池，或确认已有统一上游准入覆盖所有调用者。未覆盖的共享 endpoint 只能报告本批 worker 的准入情况，不能声称整个系统或 GPU 总并发已受控；本批不为此扩大在线 RAG 改造范围。
- 跨进程准入采用窄型 agent_model_slots 表：resource_group_id、slot_no、state（free/held/suspect）、slot_token、owner_job_kind/job_id/attempt_id、dispatch_id、dispatch_phase、lease_expires_at、heartbeat_at。free→held 在短事务内原子领取；发出 provider 请求前记录 dispatch_id；续租/释放均校验 slot_token 与 attempt。只管理模型调用，不领取业务 Job，不在模型执行期间持有长数据库事务。
- 槽过期或 worker 失联只能转 suspect，不能自动恢复 free。完整 provider 响应、已确认未发出请求，或受控 endpoint 已确认终止该调用时才允许释放；HTTP 超时、abort 或断连本身不构成终止证明。suspect 通过受权恢复脚本和运维确认处理，默认拒绝新准入。互斥部署可用于前期 canary，默认并行启用前必须通过共享槽验收。
- provider 不响应取消、worker 失联或模型状态未知时，输出写入由 fence 拒绝；模型容量按保守策略停止新准入，恢复需确认遗留调用结束。不能承诺 AbortSignal 能终止远端计算。
- worker 独立启动并可停止接收新任务、等待当前调用退出。报告 worker 的 build/start、本地启动器及容器配置在同一集成任务接线；网页进程重启不持有任务运行态。
- 每次执行记录业务 jobId、runId/stepId/attemptId、父 observation、版本、scope 摘要、入队/开始/结束时间、重试原因、用量、input/output digest 与 source ref。正文只保留在授权的业务存储。
- 继续使用现有 content-free 外部 trace 边界，不默认开启完整子 Agent prompt/tool/result 导出。预算未知、模型错误与业务状态都必须可诊断。

## 8. 分阶段实施计划

所有任务当前均未开始。风险说明：L0 文档；L1 局部可逆适配；L2 合同/服务集成；L3 任务恢复与状态迁移；L4 权限、数据完整性及发布边界。以下文件路径集合为拟议修改范围，测试随对应生产模块同任务编写，先用有意义的失败用例定义合同。

| 阶段 / 任务 | 目标与文件集合 | 前置依赖 | 风险 | 完成证据 |
| --- | --- | --- | --- | --- |
| P0 / T0 基线 | 新建首批 fixture 与对照记录；定点读取现有 graph/report 回归；docs/reports/2026-10-25-multi-agent-baseline.md、src/lib/agents/fixtures/ | 方案确认；隔离测试源与模型配置可用 | L1 | AC-11 的固定输入、模型配置、覆盖及失败基线；区分 fake 与真实模型证据 |
| P1 / T1 统一合同 | src/lib/agents/contracts.ts、execution-spec.ts、executor.ts、registry.ts、对应 *.test.mjs；现有模型工厂只通过适配端口使用 | T0 | L2 | AC-02/06/10 的合同、异常、父取消、累计预算测试 |
| P1 / T2 图谱能力适配 | src/lib/agents/graph-extraction-agent.ts、src/lib/mirofish/graph-builder.ts、src/lib/entity-extraction.ts 及对应测试 | T1 | L2 | AC-01/02/06 的固定图输入、输出校验与取消测试 |
| P1 / T3 图谱控制面接线 | src/lib/knowledge-graph/auto-build.ts、src/app/api/knowledge-graph/builds/route.ts、src/lib/knowledge-graph/local-graph-build-executor.ts、postgres-graph-build-store.ts、neo4j-command-store.ts、src/lib/mirofish/graph-artifact-store.ts、scripts/graph-control-worker.ts 及对应测试；预算账本使用现有 metadata，不增加表 | T2 | L4 | AC-01/04/05/06/09；入队后切默认模型、持久预算崩溃预留、staged 复用、旧 lease artifact 竞争和显式发布负例 |
| P2 / T4 报告能力适配 | src/lib/agents/simulation-report-agent.ts、src/lib/mirofish/report-agent.ts、新 report-contracts.ts 及对应测试 | T1 | L2 | AC-02/06/11；严格解析、空/非法结果、统计与 coverage 对照 |
| P2 / T5 报告存储 | db/postgres/migrations/0008_mirofish_report_jobs.sql、src/lib/mirofish/report-store.ts、simulation-snapshot-store.ts、src/lib/postgres/client.ts、scripts/migrate-postgres.mjs、postgres-integration.test.mjs、verify-postgres-runtime.mjs、verify-postgres-public.mjs 与对应 schema/权限/readiness 测试 | T4；迁移编号在执行前核对未占用 | L3 | AC-04/05/07；迁移重放、事务回滚、幂等冲突、结果不可覆盖与 scoped SQL |
| P2 / T6 模拟归属与快照 | src/app/api/mirofish/simulation/route.ts、simulation/[id]/route.ts、simulation/[id]/stream/route.ts、interaction/interview/route.ts、src/lib/mirofish/project-store.ts、simulation-runner.ts、simulation-report-source.ts 及对应测试 | T5 | L4 | AC-03/05/07；所有来源消费者跨 scope、伪造项目/模拟、快照丢失、完成冻结、同 ID 重启和撤权反例 |
| P3 / T7 报告调度 | src/lib/mirofish/report-service.ts、report-worker.ts、report-store.ts、scripts/report-worker-entry.ts 及对应测试 | T6 | L3 | AC-04/05/06/07；claim/lease、持久 reserve/settle 和未知消费不返还、有限重试、取消竞态、提交前后 crash 恢复 |
| P3 / T8 共享模型准入 | src/lib/agents/model-admission.ts、postgres-model-slot-store.ts、对应测试；db/postgres/migrations/0009_agent_model_slots.sql、src/lib/postgres/client.ts、scripts/migrate-postgres.mjs、verify-postgres-runtime.mjs、verify-postgres-public.mjs、recover-agent-model-slot.ts 与 schema/权限/readiness 测试；scripts/graph-control-worker.ts、src/lib/mirofish/report-worker.ts 接线 | T3、T7 | L4 | AC-06/12；同 endpoint 不同生成/嵌入模型竞争、suspect 槽拒绝、旧 token 释放被拒及受权恢复；默认并行启用要求共享槽通过 |
| P3 / T9 消费者一起迁移 | src/app/api/mirofish/report/route.ts、report/[id]/route.ts、新 report/[id]/cancel/route.ts、interaction/chat/route.ts、Step4Report.tsx、Step5Interaction.tsx、console/[projectId]/page.tsx 及测试 | T7、T8 | L4 | AC-03/08/09；列表/轮询/章节/下载/聊天、旧状态投影、跨 scope 全动作测试 |
| P3 / T10 运行接线 | package.json、scripts/start-local-dev.mjs、Dockerfile、docker-compose*.yml、.env.container.example、部署 runtime/依赖检查及对应测试 | T9 | L3 | AC-05/09/12；worker 独立启动、standalone 依赖、停止接收与兼容回滚演练 |
| P4 / T11 综合验收 | scripts 中隔离恢复/E2E 场景、首批 eval fixture、docs/runbooks/multi-agent-capabilities.md、docs/reports 中最终验收 | T10 | L4 | AC-01 至 AC-12 的证据矩阵、真实模型对照、安全复审和灰度决策 |

迁移编号 0008/0009 是当前目录最大编号 0007 后的建议名；执行时若已占用，只追加新的连续编号，不重命名已应用迁移。T5/T8 各自同步当前 schema 版本、schema 存在检查、校验和及角色授权清单，不修改旧迁移历史；bootstrap 如需要改变，仅在对应存储任务内串行处理并更新测试。

依赖主线：T0 → T1 → T2 → T3；T1 → T4 → T5 → T6 → T7；T3 + T7 → T8 → T9 → T10 → T11。T1 完成后 T2/T4 的文件集合互不重叠，可在重新核对工作树与前置依赖后并行；当前不预标 [P]。涉及相同文件、权限或 L3/L4 的任务顺序集成。

阶段出口：P1 证明图谱新路径可替换并保持原发布边界；P2 建立报告的合法、不可变输入与存储；P3 完成可恢复执行及所有消费者兼容；P4 决定是否默认启用。每阶段保留旧路径，对未达到出口条件的能力保持关闭。

## 9. 验证与灰度

按风险从最窄反馈环扩展：

| 验证层 | 场景与方式 | 对应 AC |
| --- | --- | --- |
| 合同单元 | 假模型，合法/非法图与报告、schema/version、strict parser、预算/取消、用量缺失 | 01、02、06、10 |
| 控制面单元 | 假时钟/事务客户端；重复提交、摘要冲突、迟到 attempt、取消后完成、结果已提交但确认丢失 | 04、05、07、09 |
| 隔离 PostgreSQL 集成 | 专用测试库；迁移/权限、两 worker 抢占、lease 过期、事务原子性和结果不可覆盖 | 03、04、05、07、12 |
| HTTP/前端 | POST/列表/详情/各 action/聊天/取消，3 秒轮询终态；source/project 伪造与跨 scope | 03、08、09 |
| 隔离图谱集成 | 精确文档源、已有 staged 复用、非法 manifest、旧 attempt artifact 竞争、无显式激活 | 01、05、09 |
| 真实模型对照 | 相同 fixture、冻结模型/提示词；图谱来源一致与关系正确、报告统计一致与结论支持、覆盖和耗时/用量 | 02、06、10、11 |
| 运维故障演练 | API/worker 重启，模型不可用，不响应取消，切开关，默认模型变化，兼容版本回滚 | 05、09、12 |

现有定点回归入口包含 local-graph-build-executor、postgres-graph-build-store、graph-control-worker、graph-builder、entity-extraction.security、report-agent 及 model-override.security 测试。新增测试沿仓库 node --test 风格；实施时运行相关文件后再扩到 test:knowledge-graph-control、test:rag-security、test:postgres 和类型检查。生产构建与浏览器验收放在消费者/运行接线完成后，不因文档编写运行全仓测试。

真实模型使用已授权的隔离 fixture，不直接读取真实用户帖子。首个 canary 固定样例至少覆盖正常、无数据、非法输出、大输入、取消、跨 scope 和重试恢复；用人工可核查的期望实体/关系及报告统计建立基线。安全越界、重复可见成功结果和旧 lease 覆盖容忍值为 0；语义质量需逐例无新增事实错误。延迟与调用量先记录基线，再在默认启用前明确数值门槛，不编造收益百分比。

拟议开关：

- RAG_GRAPH_EXTRACTION_MODE=legacy|agent：仅作用于已有 local executor；RAG_GRAPH_BUILD_EXECUTOR 的 local/webhook/disabled 选择保持原合同。
- MIROFISH_REPORT_EXECUTION=legacy|agent：只选择报告生成策略。完成 T9 后，两个值的所有新请求都经过同一授权、快照、持久队列、严格结果校验与结果读取；legacy 复用旧生成算法，不保留另一套 Map/detached Promise 存储。已部署前的旧开发接口不作为新读路径的兜底。
- 两者默认 legacy，经过 fake 回归 → 隔离真实模型 → 单 scope canary → 扩大范围。首批不自动双跑真实模型做 shadow，避免重复费用和副作用。

开关值在接收任务时冻结。读路径始终能读取已持久化的新报告，不能随生成开关退回全局 Map。回滚先停止接收新任务，再按已冻结版本排空或取消在途任务，保留结果读取；兼容基线版本必须包含数据库读适配。不能直接回到只认识内存 Map 的旧二进制并声称新报告仍可读。新增表先保留，不执行破坏性 down migration；图谱保留既有显式发布/回滚流程。

## 10. 风险、未知项与下一步

| 项目 | 当前判断 / 处理 |
| --- | --- |
| 报告来源归属尚未统一 | 已从源码确认缺少完整 scope 接线；T6/T9 是生产启用前提，不能只验证输入里的 project_id |
| Graph artifact 的旧 attempt 写入 | 需要专项竞争测试；既有 job completion fence 不能替代 artifact 层不可变提交 |
| provider 调用的 exactly-once | 不承诺；控制重试次数和用量，保证可见业务结果幂等 |
| 两 worker 的模型争用 | T8 明确共享准入与失联处理；仅互斥部署的 canary 不代表已完成并发能力 |
| 历史报告和模拟 | 全局 Map 无可靠归属时不自动迁入多租户；新任务正常运行不依赖批量历史迁移 |
| 现有脏工作树 | 实施前重核当前文件，保留其他会话改动；有冲突的文件串行集成 |
| 未验证环境 | 未连接真实 DB/模型，未核对当前部署 executor 与模型容量；本轮结论属于源码设计 |
| 排期 | 采用依赖和阶段出口管理；真实模型容量与历史数据规模未测，不给日历工期承诺 |

方案确认后下一可执行动作是 T0：固定两类隔离输入和当前行为基线，然后 T1 落统一合同。实现、数据库迁移及部署分别按对应阶段授权执行；本轮到方案文档交付为止。

## 11. 本轮文档检查

- 范围：仅图谱知识抽取、模拟报告生成及其必要执行/授权边界。
- 完整性：明确输入输出、数据/任务 owner、终态、幂等、取消、恢复、全部报告消费者和回滚下限。
- 一致性：两类队列独立；Agent 成功与业务提交分开；新旧状态和版本有确定映射。
- 歧义：首批报告基于完成态模拟；跨能力研究报告、实时模拟报告和 Agent 自由协作后置。
- 验证范围：本轮仅源码核对与方案评审，不把拟议测试写成已通过。

## Related

- [当前 Agentic RAG 架构](/E:/project/ai/rag/project/rag-nextjs/docs/architecture/agentic-rag-current.md)
- [RAG、Neo4j、Elasticsearch 联合方案](/E:/project/ai/rag/project/rag-nextjs/docs/plans/2026-10-22-rag-neo4j-es-intent-and-visualization.md)

