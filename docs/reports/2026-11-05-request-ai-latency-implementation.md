# 请求与 AI 延迟优化实施记录

最后更新：2026-11-06（Asia/Shanghai）。对应[审计报告](2026-11-05-request-ai-latency-audit.md)，记录本轮工作树中的实现及验证结果，不代表应用代码已部署；第四批已获授权并实际修改本机 Ollama 容量配置。当前本机为 `NUM_PARALLEL=1 / MAX_LOADED_MODELS=2 / MAX_QUEUE=16`，版本 `0.40.15`；下文 `1 / 1 / 16` 为第一次保守基线。

第一批按 A → B → C → D 顺序落实关键保护、进程内 Ollama 容量控制、发布检索客户端复用和真实阶段进度。第二批进一步减少发布检索 RPC、重复 embedding 和非关键统计请求。第三批接入普通问答的真实答案增量，补齐 Ollama 服务端容量启动契约，并取得两次轻模型冷/热请求数据。第四批继续减少发布身份检查 RPC，处理大语料请求长度边界，修复 UI 生命周期、旧模型预热与构建追踪问题，并实际配置本机 Ollama；该批的延迟和引用数据保留在历史章节。

第五批增加缺少引用的界面提示和 v11 引用生成规则，限制预热为当前选择的两个模型，并避免隐藏页面主动发起新预热。最新 20 个顺序开发环境请求的首正文 P50/P95 为 518/2882 ms、总耗时 P50/P95 为 1112/3591 ms；另测一组 2 请求并发，22 条均 HTTP 200，引用状态为 13 条 available、9 条 missing。不能将 HTTP 成功视为完整引用质量通过，也不能将本次小样本等同生产 SLO 或受控提速实验。客户端取消、退出与突发恢复已完成；用户随后要求相关数据不得放 C 盘，C 盘副本方案已撤回，运行库继续使用原 E: 路径。

## A. 请求取消、输出预算与耗时记录

- 普通问答、Agentic 和统一发布问答在生成预算范围内创建请求专属模型，将当前请求的取消信号传到模型传输层。取消后拒绝迟到的成功结果；协作式取消最多保留 100 ms，以收集脱敏的 499 部分诊断，绝对截止时间仍返回 504。
- `maxTokens` 映射到 Ollama `numPredict`；回答输出上限为 1024 tokens，对比覆盖判定为 128 tokens。模型以 `length` / `max_tokens` 结束时，返回 `RAG_GENERATION_OUTPUT_LIMIT`（502），不把截断片段发布为完整答案。
- 服务端整条 Ask 请求使用 285 秒绝对截止时间，浏览器为 300 秒；预热、检索、生成仍有独立预算，但不能通过串联这些预算突破总截止时间。
- 记录实际 provider 调用及 usage，包括 Agent 多轮生成与 embedding；JSON 响应提供 `Server-Timing`。阶段计时与状态事件用于区分排队、检索和生成，不能替代模型 TTFT 或 GPU 指标。
- Docker 存活探针使用 `/api/health/live`，不触发 RAG 初始化。`/api/health` 读取状态；Milvus/Zilliz 控制面就绪不再要求本进程已有 RAG 单例，必要时明确返回 `control_plane_ready` 与 `ragSystem.initialized: false`；混合后端仍保守判断。

源码入口：[模型配置](../../src/lib/model-config.ts)、[输出完整性](../../src/lib/models/answer-output.ts)、[请求预算](../../src/lib/rag/core/request-budgets.ts)、[请求执行](../../src/lib/rag/core/request-execution.ts)、[provider 计量](../../src/lib/rag/core/provider-usage-observer.ts)、[Ask](../../src/app/api/ask/route.ts)、[健康检查](../../src/app/api/health/route.ts)、[Dockerfile](../../Dockerfile)。

## B. Ollama 进程内容量控制

同一 Node.js 进程按可信 Ollama endpoint 共享执行槽位，默认并发 1、最多等待 16 个请求、排队最多 30 秒。已接入对话模型、embedding、原始会话/语义请求、预热和发布 embedding。交互请求优先；连续调度三个交互请求后，允许等待中的后台请求获得一次机会。

槽位覆盖响应体的实际读取、取消和失败，不在收到响应头时提前释放。队列满或排队超时分别返回 `PROVIDER_QUEUE_FULL` / `PROVIDER_QUEUE_TIMEOUT`（503，`Retry-After: 3`）。排队期间取消的请求不会再启动模型调用。

Embedding 请求默认总超时 30 秒（包含排队），SDK `maxRetries: 0`。缓存的 embedding 实例在每次调用时读取当前 Ask 取消信号，避免复用前一个请求的上下文。Ollama SDK 内层并发锁已让位于共享准入队列，实际并发仍受上述槽位限制。共享预热使用独立取消边界，单个等待者取消不影响其他等待者。

| 配置 | 默认值 | 范围 |
| --- | --- | --- |
| `PROVIDER_ADMISSION_OLLAMA_CONCURRENCY` | `1` | 1–16 |
| `PROVIDER_ADMISSION_MAX_QUEUE` | `16` | 0–128；0 表示忙时拒绝 |
| `PROVIDER_ADMISSION_WAIT_MS` | `30000` ms | 1–60000 ms |
| `OLLAMA_EMBEDDING_REQUEST_TIMEOUT_MS` | `30000` ms | 1000–90000 ms |

这四项已写入[环境配置指南](../../ENV_CONFIG_GUIDE.md)、[容器模板](../../.env.container.example)和部署参数白名单。本轮仅接通 Ollama；通用准入模块存在非 Ollama 配置入口，但其他 provider 工厂未接入，不应视为已经生效。

边界：不同 PM2 worker、容器和其他应用不会共享此队列。第三批新增同一 Ollama daemon 的原生容量部署契约，约束跨进程的实际推理容量；这不等于新增全局公平队列。第三批当时尚未修改宿主，第四批的实际配置与验收边界见下文。

源码入口：[准入队列](../../src/lib/models/provider-admission.ts)、[embedding](../../src/lib/embedding-config.ts)、[预热](../../src/lib/ollama-readiness.ts)、[发布 embedding](../../src/lib/documents/publication-embedding.ts)、[部署配置](../../deploy/songuu/run-rag-system.cjs)。

## C. 发布检索客户端安全复用

ES/Milvus 只读客户端使用有引用计数的租约缓存，最多 4 项，空闲 60 秒后回收。缓存身份包含完整连接配置、凭据和 CA 内容的哈希，凭据或 CA 变化会产生新的缓存身份。

缓存只复用连接资源。每次请求仍执行 PostgreSQL capability、ES authenticate/privileges、Milvus 探测，以及发布视图和最终版本/权限校验；不会缓存权限、撤销或发布有效性判断。

并行读取统一由回调式 `Promise.allSettled` 辅助函数管理，确保同步 SDK 抛错或一个分支失败后，已启动的其他 RPC 完成前不会释放租约。关闭失败的客户端被隔离且继续计入容量；显式重试关闭成功后才归还容量。部分创建成功的资源同样受到跟踪。

第一批止于客户端连接复用，当时尚未改变 dense 检索统计契约、候选预算、身份批量 RPC 算法或语料集合布局，也未引入跨请求 embedding 缓存。审计推导的多文档 hybrid 路径约 `9N+1` 次 ES/Milvus 调用，以及发布 embedding 正常查询中的 `3 × tags + 3 × version + 1 × embed` 七次顺序 HTTP，作为第二批优化前的基线保留；第二批变化见下文。这些是特定路径的静态调用次数，不是延迟实测。

源码入口：[租约缓存](../../src/lib/documents/publication-reader-client-cache.ts)、[并行读取](../../src/lib/documents/publication-parallel-reads.ts)、[发布检索运行时](../../src/lib/documents/publication-search-runtime.ts)、[发布检索](../../src/lib/documents/publication-retrieval.ts)。

## D. 真实阶段进度与前端恢复

客户端通过 `Accept: text/event-stream` 协商 SSE；默认 JSON 接口保持兼容。服务端发送接收确认、真实阶段状态、心跳和最终 `result` / `error`；最终事件携带原业务 HTTP 状态，前端恢复原有错误及身份失效处理。

界面展示实际认证、路由、预热、排队、embedding、检索、重排、生成、引用与版本核验阶段。活动阶段栈保证排队结束后恢复生成状态；解析器覆盖 UTF-8 跨块、异常帧、缺少终态、取消及流式 409。

**第一、二批实现为状态流。** 第三批仅为符合条件的普通问答新增答案草稿增量，见下文；统一发布检索仍须在最终权限和版本校验通过后才输出正文与证据。接收确认时间与 SSE 首包时间不能称为答案 TTFT。

源码入口：[Ask 路由](../../src/app/api/ask/route.ts)、[前端流解析](../../src/lib/rag/ask-progress-client.ts)、[聊天页面](../../src/app/page.tsx)。

## 第一批验证结果与已知限制

以下保留第一批执行记录，不作为后续批次修改后的最终验证结果。测试套件间存在重叠，不应累加为独立覆盖数量。

| 验证 | 结果 | 证明范围 |
| --- | --- | --- |
| `pnpm test:latency` | 182 项：181 通过、1 跳过、0 失败，约 13.3 秒 | 精选延迟回归串行执行，覆盖预算、传输、准入、缓存和进度等边界 |
| UI 引用/会话测试 | 38 通过 | 前端相关回归；包含工作区其他既有/并行修改 |
| Ask 定向测试 | 24 通过 | 生成、答案与取消路径 |
| 完整 Ask 测试文件 | 独立执行 `--test-timeout=90000`：106 通过、0 失败、0 取消，约 56.55 秒 | 新增 route 测试 fixture 使用 `t.after` 清理后，全文件回归通过 |
| Agent online usage 定向测试 | 1 通过 | 两次实际 handler 调用的 usage 汇总 |
| 相关 TypeScript 检查 | 单入口及依赖 0 诊断 | observer 回调 `async` 类型修复后；不等同于全仓构建 |
| 最终 TypeScript 静态复核 | 三处修复复核无阻断项 | 静态审查，不替代运行时及真实负载验证 |
| 本地 JSON HTTP | 200，`success: true`，`direct-conversation`；`Server-Timing` auth 6.5 ms、total 10.3 ms | 确定性问题“3+2是多少”，未调用 LLM/embedding；客户端总耗时 10332 ms，外层首次编译等成本尚未归因 |
| 本地 SSE HTTP | 200，`text/event-stream`；响应头约 314 ms、总耗时约 316 ms；有 status/result，无 error | 同一确定性问题，证明协议与结果交付，不代表真实 AI 性能 |

完整 Ask 测试文件此前触发过 30 秒文件超时，不能抹去该记录。新增 route 测试 fixture 残留已通过 `t.after` 清理修复；独立全文件复跑在 90 秒预算内以 106/106 通过。该运行约 56.55 秒，确认 30 秒文件预算不足，但额外加载和框架耗时尚未细分，不应将此时长等同于单次 Ask 延迟。真实集成测试有跳过；未宣称全仓测试或完整生产构建通过。

## 第二批：减少重复调用与前端统计等待

### 发布检索元数据批处理

多文档 hybrid 全局词法检索前后，将逐索引 ES 元数据读取合并为各一次批量请求。返回索引集合必须与请求集合完全一致，并逐项验证 UUID、owner 和写封存状态；缺失、额外索引或别名展开均拒绝。

在审计同一口径（`N > 1`、hybrid、无提前失败，不含 PostgreSQL、embedding 和客户端认证）下，ES/Milvus 调用从 `9N+1` 降至 `7N+3`。两篇文档的 mock 计数已验证由 19 次降至 17 次；32 篇由 289 次降至 227 次是公式推导。各文档的其余身份和 Milvus 检查仍在，尚未消除随文档数线性增长的扇出。

### 完成向量缓存与身份读取并行

发布 query embedding 新增进程内 LRU，只保留已完成且校验通过的向量：最多 128 项、向量数据最多 4 MiB、TTL 60 秒。键绑定可信服务端 tenant/corpus/trust/scope、endpoint、模型 digest、runtime、revision、dimension、`num_ctx`、schema 和原始 query 的哈希身份。没有隔离 scope 的调用不使用该缓存。

命中仅省去 GPU embed 调用，每次 query 前后的当前模型身份检查和最终发布权限检查均保留。两次相同 query 的测试中，embed 请求从 2 次降至 1 次。每轮 `tags` 与 `version` 通过 `allSettled` 并行读取，检查次数不减；正常已有模型 alias 路径仍有六次身份 HTTP，未命中时另有一次 embed。缓存不共享进行中的请求，避免跨请求取消和 usage 上下文串扰。

### 复用本次检索签发的视图

服务端新增 `searchPublishedDocumentsForAnswer`，让 Ask 复用检索刚签发的 publication view，消除重复 capability 检查和 initial `readView`。每请求仍执行检索入口的 capability/初始视图检查，检索后、生成后、引用后的三道新鲜度检查均保留。普通 search JSON 不暴露内部 view，也未增加跨请求权限缓存。

### 移除非关键统计与合并计数刷新

非隔离 local-dev 检索不再启动非关键 stats RPC。未采集的总文档量显示“未统计”，真实数值 `0` 仍显示为 0；不将未知计数伪装成空知识库。

首页文档计数刷新合并同一进行中的请求，单次截止时间为 10 秒，并非缓存结果 10 秒。auth/corpus 变更失效；focus/storage 引起的身份复核与计数读取绑定，迟到响应不能覆盖新身份的计数。等待身份的回调通过 `useCallback` 保持稳定。代码审查发现的跨标签页身份 P2 问题已修复并复核关闭。

源码入口：[发布检索批处理](../../src/lib/documents/publication-retrieval.ts)、[query 向量缓存](../../src/lib/documents/publication-query-vector-cache.ts)、[发布 embedding](../../src/lib/documents/publication-embedding.ts)、[服务端视图接口](../../src/lib/documents/publication-search-runtime.ts)、[Ask 发布运行时](../../src/app/api/ask/publication-runtime.ts)、[Ask 统计](../../src/app/api/ask/runtime.ts)、[聊天页面](../../src/app/page.tsx)、[统计展示](../../src/components/ChatMessage.tsx)。

### 第二批验证结果与边界

| 验证 | 当前结果 | 边界 |
| --- | --- | --- |
| 相关回归测试 | 48 项：47 通过、1 跳过 | 不等同于全部测试通过 |
| 缓存/search/upload 测试 | 33 通过 | 与其他套件可能重叠 |
| stats 定向测试 | 4 通过 | 非关键统计请求及数据语义 |
| dense/UI 回归 | 53 通过 | 新增 identity 用例另列，避免混淆执行范围 |
| TypeScript | 9 文件范围及其依赖 0 诊断 | 类型检查为该时点快照；最后 page 身份补丁已静态复核，尚无补丁后 TypeScript 重跑结论 |
| page/ChatMessage lint | 38 errors、11 warnings | 未通过；尚未将问题全部区分为既有或新增，不能归为全是旧问题 |
| 新增 UI identity 用例 | 同进程预加载后 5 项全部通过；测试约 1.721 秒、进程约 13.816 秒 | 保留此前 30/90 秒文件超时记录，加载耗时见下文 |
| 第二批完整 Ask 回归 | `--test-concurrency=1 --test-timeout=90000`：108/108 通过、0 失败、0 取消，约 76.031 秒 | 包含两个新增去 stats 用例；独立于第一批 106/106 记录 |
| 扩展 `pnpm test:latency` | 265 项：264 通过、1 真实集成跳过、0 失败、0 取消，104.782 秒，exit 0 | 已加入缓存、并行读取、dense/UI 边界；覆盖当前第二批工作树，包括最后 page `useCallback`/identity 补丁 |

UI identity 超时经独立诊断定位到 jsdom 加载波动：单独 20 秒 `require(jsdom)` 诊断也超时，模块仍在持续加载，未定位到 `act` 或数据库死锁。最终同进程预加载耗时 11.649 秒（其中 interfaces 11.317 秒），随后五项用例通过。诊断未修改依赖或 lockfile，也没有残留进程；不能把这一测试环境加载时间当作应用请求耗时。

扩展 `test:latency` 首次使用 30 秒文件预算时，193 项通过、两个文件被取消、0 断言失败；`chat-citations` 与 `publication-retrieval` 均在子测试开始前发生文件超时。仅将该测试脚本的文件预算调整为 90 秒后，组合复跑取得上表最终结果；产品请求预算保持不变。保留这些历史超时，不将最终测试通过解释为 lint 全绿、最新全仓类型检查通过或真实负载性能达标。

本机 Ollama 只读检查：`version` 返回 200，约 82 ms；`ps` 返回 200 且 `models: []`；`tags` 在 5 秒后出现 `TimeoutError`。未运行真实模型负载；此快照不足以将超时归因于本轮代码，也不能推导模型吞吐或线上 p95。

## 第三批：普通答案增量与服务端容量契约

### 真实生成流与最终答案边界

只有通过准备、身份验证和路由选择的普通同步 Milvus 问答，且执行策略为 `milvus-2step`、客户端协商 SSE 时，才调用真实的 `llm.stream`。默认 JSON 请求继续使用 `invoke`。统一发布、混合问题、Agent、自适应实体、durable 和 memory 路径不启用答案增量；覆盖判定的结构化 JSON 也不进入答案事件。

`answer_delta` 携带本次 `requestId`、连续递增的 `sequence` 和正文。解析器校验请求身份、顺序、单块 16 Ki 字符及总量 256 Ki 字符上限；请求取消或完成后不再接受迟到的正文。该上限按 JavaScript 字符串长度计数，不是 token 或 UTF-8 字节预算。

模型流聚合保留 usage 和终止元数据，正文排除 reasoning 元数据/内容块及 `<think>`、`<analysis>` 区段；普通答案意外出现工具调用时明确失败。静默 EOF、取消、未知或不成功的终态不能成为成功答案，输出长度截断仍由原有完整性检查返回 502。审查发现 OpenAI Responses 使用 `response_metadata.status` 而非普通聊天流的 `finish_reason`，兼容补丁已完成并通过专项测试：接受 `completed`，`incomplete` 且原因为 `max_output_tokens` 时映射到输出上限错误，其他失败或未知终态拒绝。最终代码复核已关闭该 HIGH 问题。

客户端使用独立临时状态，每 40 ms 批量展示纯文本草稿，标记“正在生成，完成后保存”。草稿不进入 `messages`、模型会话历史、IndexedDB 或引用数据。身份复核开始时立即隐藏；同一身份验证通过后才恢复缓冲内容，身份改变或失效、取消、断流、错误、终态及卸载都会清理草稿和定时器。最终完整响应继续经过原有身份校验、引用处理和持久化流程。

源码与回归入口：[流聚合](../../src/lib/models/answer-stream.ts)、[Ask 执行分支](../../src/app/api/ask/runtime.ts)、[请求级门控](../../src/app/api/ask/route.ts)、[SSE 执行](../../src/lib/rag/core/request-execution.ts)、[客户端解析](../../src/lib/rag/ask-progress-client.ts)、[草稿界面](../../src/app/page.tsx)、[入口矩阵测试](../../src/app/api/ask/answer-stream-entry.test.mjs)、[UI 行为测试](../../src/components/chat-citations.test.mjs)。

### 跨进程容量的部署契约

同一 GPU 的应用、worker 和其他调用方应指向同一个受管 Ollama daemon，以其原生调度约束实际推理容量，进程内队列继续提供前置背压。新启动的本地 `ollama serve` 默认使用 `OLLAMA_NUM_PARALLEL=1`、`OLLAMA_MAX_LOADED_MODELS=1`、`OLLAMA_MAX_QUEUE=16`；合法显式值保留，扩大容量时提示。启动器改用轻量 `/api/version` 探活，避免模型枚举慢时尝试启动第二个 daemon。

已经运行的服务只复用并提示无法核验容量，不重启、不覆盖配置，也不把应用环境变量当成服务端已生效配置。新增 [systemd 模板](../../deploy/ollama/capacity.conf)包含 `KillMode=control-group`，用于服务替换时结束旧 runner；具体安装、Windows 托盘版设置、回滚和验收见 [Ollama 容量部署说明](../deployment/ollama-capacity.md)。第三批当时未修改宿主；第四批另外经用户授权配置并重启本机 Windows Ollama，没有部署 Linux 模板。

原生容量不提供跨进程的租户配额或 interactive/background 公平性，`MAX_QUEUE` 也不是整个 daemon 所有未完成 HTTP 请求的严格总上限。限制同时加载一个模型可能增加 embedding 与生成切换时的加载成本，因此它是保守的容量起点，不是已经证实更快的配置。本轮未引入会因应用崩溃、数据库断连或 TTL 到期而提前释放的 GPU 租约；如确需全局公平调度，后续仍需所有调用方必经的网关及相应网络边界。

源码与测试：[本地启动器](../../scripts/start-local-dev.mjs)、[启动器回归](../../scripts/start-local-dev.test.mjs)。

### 本机实测与环境边界

2026-11-06 10:04，只读检查的 Ollama 版本为 `0.40.14`：`/api/version` 200、34 ms；`/api/tags` 200、32 ms；`/api/ps` 200、10 ms，已加载模型为空。第二批 `tags` 的 5 秒超时在这次检查中未复现。该快照的宿主服务启动日志白名单值为 `NUM_PARALLEL=1`、`MAX_LOADED_MODELS=0`、`MAX_QUEUE=512`、`CONTEXT_LENGTH=262144`；第三批当时未改变这些运行值。宿主默认上下文不等于每条请求的实际上下文：fast conversation、semantic 路径显式使用 `num_ctx=2048`，预热也显式传入上下文配置，不能仅凭宿主快照判断这些路径使用 262144。

随后对本机已安装的 `qwen2.5:0.5b` 顺序执行两次 `/api/chat` 短输出请求：固定提示“只回答：你好”，`stream: true`、`keep_alive: 1m`、`num_predict: 16`、`num_ctx: 2048`、`temperature: 0`，单次总预算 30 秒且不重试。首字指收到首个非空正文的时刻，不是响应头或状态包。

| 样本 | 首个正文 | 客户端总耗时 | provider 加载 | prompt eval | 生成 eval | 输出与终态 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 第一次，冷请求 | 13059 ms | 13072 ms | 12872 ms | 143 ms | 19 ms | 3 tokens，`stop` |
| 紧接的第二次，热请求 | 9 ms | 12 ms | 2 ms | 2 ms | 3 ms | 3 tokens，`stop` |

这两条样本表明该次冷请求的等待主要在模型加载阶段。它们不包含认证、检索或引用处理，不代表默认 `llama3.1`、真实 RAG 端到端性能、并发 P95，也不是本轮代码变更前后的性能对照。

第三批当时的应用 HTTP 验证有环境阻塞：一次本机 3000 端口 `/api/health/live` 检查在 5003 ms 超时；稍后确定性问题“2+3”的 SSE 探测在约 20 ms 返回 fetch `TypeError`，未取得 HTTP 响应。原因尚未确认，不能记为协议或应用回归通过，也不能仅凭这些快照归因代码。该批未重启服务。当前环境未开启统一发布 `active`，也未准备本轮有界审核样本，因此正式发布 RAG 实验未运行。

### 第三批验证快照

| 验证 | 已取得结果 | 边界 |
| --- | --- | --- |
| 流聚合 helper | 最终 14/14 通过，约 0.235 秒 | 已包含 OpenAI Responses 完成、截断及失败状态形状回归 |
| 完整 Ask 回归 | 111/111 通过，约 11.468 秒 | Responses 最终补丁前快照；包含真实 runtime SSE 增量、usage、截断和结构化 JSON 不外发 |
| Responses 截断 route 定向回归 | 最终 1/1 通过；内部两个请求均为 502、无成功 `result` | 覆盖有部分正文及空正文的截断；用例约 51.7 ms，含冷加载的进程约 66.674 秒，不可等同于请求延迟 |
| 完整 UI 引用/会话文件 | 55/55 通过，约 6.876 秒 | 新增 10 条草稿行为测试，覆盖成功、错误、取消、断流、身份复核及卸载 |
| 本地启动器 | 22/22 通过，约 4.59 秒 | 注入依赖验证启动契约，未启动或重配真实服务 |
| TypeScript | 6 个后端目标和最终页面目标均 0 诊断；直接全仓 `tsc --noEmit --incremental false -p tsconfig.json` exit 0；最终 helper 独立 strict 检查 0 诊断 | 全仓及后端检查早于最终 Responses 兼容补丁，随后补跑 helper；不是生产构建验证 |
| 本轮后端/启动器 lint | 直接 ESLint 检查 `answer-stream`、observer、request-execution、parser、route、starter 六个文件，exit 0、无诊断 | 全仓 ESLint 未取得完成结果，不能宣称全仓 lint 通过 |
| 扩展 `test:latency` | 318 项：317 通过、1 真实集成跳过、0 失败、0 取消，约 104.369 秒，exit 0 | 直接 Node 执行脚本的相同参数；包含最终 14 条 helper、入口矩阵、22 条启动器及最新 UI；不等同于真实模型负载验收 |
| 代码与安全审查 | 代码审查最终 APPROVE；唯一 HIGH（Responses 终态兼容）已修复并复核关闭；本轮增量安全审查未发现可确认的新增问题 | 安全审查核对当前 helper/observer/executor/parser 及共享的最终 route/page 补丁，不代表全仓审计或额外完整环境验收 |

第三批的 `pnpm exec eslint` 曾在工具启动阶段长时间无输出，并按本次进程身份核验后停止；这不是 lint 通过，也不是代码断言失败。该批直接调用已安装 ESLint 的六文件检查已通过，全仓 ESLint 长等待后取消、没有完整结果。组合延迟回归改为直接 Node 执行 `package.json` 中 `test:latency` 的相同参数，避免包管理器初始化停顿。历史 lint 失败与测试加载波动仍保留；第四批取得的全仓结果另列下文。

## 第四批：剩余代码、宿主容量与验收收口

### 发布检索的外层身份检查与有界传输

多文档检索改为在所有 dense/lexical 读取前执行一次完整 ES 身份检查，在所有已启动操作完成后再执行一次。同步抛错、异步失败和取消均先等待已启动操作结束，不能提前释放租约。每个文档的 Milvus 前后身份检查、精确索引身份、owner/alias/write-seal、来源验证和最终发布视图校验仍然保留。两文档 hybrid mock 的调用数由 17 降至 13。

审查发现 128 个合法文档索引组成的编码 URI 约 7 KiB，可能超过 ES 默认 4 KiB HTTP 请求行限制。修复按**完整编码请求目标不超过 3 KiB**拆分 ES 元数据检查，前后两轮都等待全部批次完成；这不是依赖 SDK 自动分批，当前安装的 transport 也未默认开启路径长度保护。全局 lexical 查询遇到长 URI 时改用只有一个检索项的 `_msearch`，NDJSON header 保留全部精确索引和 `dfs_query_then_fetch`，不拆分排名域。响应必须恰好包含一个子结果，内部错误、失败状态、超时或不完整分片均明确失败。

修复后的 hybrid 调用次数为 `5N + 2B + 1`，其中 N 为文档数，B 为一次 ES 元数据检查的批次数。32 文档、1 批为 163 次，128 文档、3 批为 647 次。它们是静态与 mock 调用次数，不是端到端延迟或提速比例。安装版本 SDK 的离线连接测试验证了完整请求目标、两行 NDJSON、128 个精确索引和查询参数；未向真实 ES 发送压测流量。

源码与回归：[发布检索](../../src/lib/documents/publication-retrieval.ts)、[发布检索测试](../../src/lib/documents/publication-retrieval.test.mjs)。

### 全仓 lint 与 UI 生命周期

首次取得完整 ESLint 结果为 1141 个文件、542 个 error、1524 个 warning。其中临时生成的 graph worker 目录内 9.8 MB esbuild bundle 贡献 472 个 error、1473 个 warning。只为 `.tmp-codex-graph-worker-*/**` 增加生成物排除，未移动或删除目录，也未忽略业务源码或降低规则。

其余 70 个源码 error 通过共享聊天类型和 React 生命周期修复解决：模型默认选择避免重复请求；思考内容追加不再反复重置展示；课程 key 隔离旧测验和 SSE；模拟讨论首轮能够启动，循环读取最新消息，重置时取消待执行定时器。主页还移除了读取最近会话前冗余的全会话读取。最终全仓快照为 1142 个文件、0 个 error、49 个 warning，exit 0；保留 warning，不能称为零诊断。该全仓快照早于最后的 Ask 预热和构建配置小补丁，随后追加的六文件定向 ESLint 也已 exit 0。

相关入口：[聊天共享类型](../../src/lib/rag/chat-types.ts)、[主页](../../src/app/page.tsx)、[UI 生命周期回归](../../src/components/ui-lifecycle.test.mjs)。

### 旧 embedding 参数在预热前失败

本轮真实 HTTP 检查中，3000 端口 `/api/health/live` 返回 200，耗时 3472 ms；3001 端口连接被拒绝。一次使用旧 embedding 参数的真实 Ask 请求最终返回 409 `EMBEDDING_INDEX_CHANGED`，客户端总耗时 52253 ms、接收确认 14855 ms，无答案或证据。`Server-Timing` 记录预热 37061.4 ms、服务端总耗时 37409.4 ms。这是一次失败请求，不能计入成功 RAG 的首字或延迟分位数。

读取配置确认当前模型为 `llama3.1`，embedding 为 `qwen3-embedding:latest`、维度 4096。旧请求参数原先在模型预热后才被拒绝；普通同步 legacy Ollama 路径现已在预热前核对当前 embedding，沿用 `:latest` 归一化规则和原有 409 错误。runtime 中原有检查继续覆盖预热期间切换模型的情况。入口测试先复现 503 而非预期 409，再验证修复后直接返回 409 且零 fetch；发布路径仍使用其固定身份，不读取 legacy 配置。

修复后对相同旧参数再次发出真实请求，仍正确返回 409 `EMBEDDING_INDEX_CHANGED`，客户端总耗时 2220 ms（开发环境首次编译对应的响应等待约 2212 ms）；`Server-Timing` 为 auth 7.1 ms、route 0.5 ms、total 12.9 ms，不再包含 warmup。结果保存于本机 `.codex-tmp/latency-live-rag-stale-after.json`。对比原样本总耗时 52253 ms、预热 37061.4 ms，只能证明这一次无效请求消除了预热，不能推导成功问答的整体提速比例。

另一次 15 秒配置预检超时发生在发起 RAG POST 前，不构成 RAG 推理样本。

### 单模型驻留下的真实 RAG 基线

在 Ollama `0.40.14`、容量 `1 / 1 / 16` 下，使用 `llama3.1` 与 `qwen3-embedding:latest` 发出的真实 Ask 请求返回 200，取得 5 条证据且引用状态为 `available`。客户端首个答案正文为 71438 ms，总耗时 71865 ms；本机结果保存于 `.codex-tmp/latency-live-rag-current.json`。随后服务自动更新为 `0.40.15`，在仍为 `1 / 1 / 16` 时补采相同问题，返回 200、首正文 94351 ms、总耗时 96318 ms，仍为 5 条证据、引用 `available`，保存于 `.codex-tmp/latency-live-rag-baseline-v15.json`。

| 服务端阶段 | `0.40.14` 单次样本 | `0.40.15` 单次样本 |
| --- | ---: | ---: |
| 预热 | 29663.4 ms | 39446.2 ms |
| 检索 | 848.3 ms | 19303.1 ms |
| embedding | 267.2 ms | 18832.8 ms |
| 生成 | 34365.5 ms | 35293.7 ms |
| 引用 | 239.0 ms | 273.5 ms |

这些阶段存在嵌套，不能简单相加为客户端总耗时。`0.40.14` 服务日志另记录 embedding 加载约 29.10 秒、llama 加载约 32.60 秒；只读硬件检查确认模型所在 E: 为 WDC WD20EZAZ HDD，GPU 为 RTX 5070 Ti、16303 MiB。该样本的主要等待证据指向大模型加载和切换，不能把单模型容量配置记成已提速。后续双模型驻留的实际配置和显存验证见下节。

两个基线的作者字面匹配检查通过，但问题与期望来自源文档，并非独立人工审核的质量 gold。答案字符长度从 35 变为 162，外部负载也未隔离，不能用两个单次样本计算严格的版本或配置提速倍率；它们仅验证真实检索、生成和引用链路可完成，不构成召回质量评测、热请求对照或并发 p50/p95。

### 本机 Ollama：保守基线与最终双模型驻留

用户明确允许短暂中断并重启 Ollama。本轮首次备份原始值后，将三个用户环境变量设为保守基线 `1 / 1 / 16`，并向新进程显式传入同样的环境。原始 User、Machine 和当时 Process 三个作用域均未设置这三项；原服务有效值为 `1 / 0 / 512`。备份位于本机 `.codex-tmp/ollama-capacity-backup-20261106T040938139.json`，未修改项目的真实环境文件。

电脑控制工具因 Windows sandbox 的 `helper_unknown_error` 无法启动，因此使用已核验可执行文件路径、父子关系和监听端口的原生进程管理。第一次 guard 在发现 conhost 时停止，未修改服务；第二次停止遇到已自行退出的子进程后中断，随后依据备份核验剩余进程及端口，再完成配置和启动。没有把这次恢复过程记为正常托盘退出。

第一次保守基线的托盘进程 PID 为 32044。`server.log` 在 `2026-11-06T12:10:49.535+08:00` 的启动记录确认 `OLLAMA_NUM_PARALLEL=1`、`OLLAMA_MAX_LOADED_MODELS=1`、`OLLAMA_MAX_QUEUE=16`；`/api/version` 返回 200、版本 `0.40.14`。这些 PID、版本和配置属于该次历史验收，不是最终运行状态。

随后在本机时间 12:41:09–12:41:20，分别以两个独立 Node 子进程同时提交同模型生成，以及生成/embedding 请求。验收前确认 app PID 32044、daemon PID 32460，备份中记录的旧进程已无残留。两组共四个子进程全部 HTTP 200、exit 0，无超时、失败或取消，结果保存于本机 `.codex-tmp/latency-capacity-results.json`：

| 组别与请求 | 首个正文 | 客户端总耗时 | provider 加载 | 输出 |
| --- | ---: | ---: | ---: | --- |
| 同模型，`qwen2.5:0.5b` 请求 A | 4186 ms | 4288 ms | 4038 ms | 64 tokens，`length` |
| 同模型，`qwen2.5:0.5b` 请求 B | 4293 ms | 4383 ms | 4038 ms | 64 tokens，`length` |
| 跨模型，`qwen2.5:0.5b` 生成 | 5543 ms | 5637 ms | 5447 ms | 64 tokens，`length` |
| 跨模型，`nomic-embed-text` embedding | 不适用 | 3813 ms | 3678 ms | 768 维 |

这些直接 provider 请求以 64 tokens 限制负载，三个生成均以 `length` 结束，只用于容量 smoke，不能视为应用发布了完整答案。22 次 `/api/ps` 采样均成功，最多观察到一个模型，但只捕捉到 qwen 驻留，不能证明任意时刻只有一个模型或物理 GPU 严格单并发。跨模型样本的 provider 加载耗时接近总耗时，说明这次测量有明显加载成本；外部开发请求未隔离，不能据此推导真实 RAG P95 或设置变更的净收益。取消、客户端故障、过载与公平性尚未完成真实验收，详见[部署记录](../deployment/ollama-capacity.md)。

真实 RAG 暴露单模型上限造成的反复加载后，进一步执行带自动回退的双模型驻留试验。前两次分别受托盘自动升级、升级后 GUI 进程身份/退出保护影响，均未发出预热请求，不能记为显存不足或双驻留失败。最终只为明确路径、Microsoft 有效签名且属于 Ollama 后代的 WebView 增加精确兼容，保留进程身份、runner 退出、端口释放、版本和回退校验。

最终试验成功，未触发回退：版本前后均为 `0.40.15`，托盘 PID 22676、daemon PID 34088；`2026-11-06T13:34:38.147+08:00` 的新日志确认 `1 / 2 / 16`。事务及备份前缀为本机 `.codex-tmp/latency-residency-20261106T053413491`。预热请求使用 `keep_alive=15m`，embedding 空输入请求 200、26815 ms，llama 空生成请求 200、30663 ms、终态 `load`；接口未返回 provider timing，不能把客户端耗时直接称为 provider 加载耗时。

本机 User 已持久化 `1 / 2 / 16`，通用启动默认和模板仍保留保守的 `1 / 1 / 16`，未修改 `.env.local`。已打开的 Windows 终端或 Codex 父进程可能仍持有旧环境；后续从这些进程重启时应重新打开终端，或显式向新 daemon 传入本机 `1 / 2 / 16`，最终以新启动日志为准，避免旧环境或启动默认覆盖已验证配置。

| 预热验收驻留模型 | `size` 与 `size_vram` | 实测 context | 日志 GPU 层 |
| --- | ---: | ---: | --- |
| `llama3.1` | 两者均为 5951214059 B | 8192 | 33/33 |
| `qwen3-embedding:latest` | 两者均为 6348645334 B | 8192 | 37/37 |

57 次 GPU/驻留采样无错误，预热验收时 GPU total 16303 MiB、reserved 396 MiB、used 14327 MiB、free 1581 MiB，该试验最低 free 同为 1581 MiB，未观察到 OOM。`/api/ps` 与加载日志同时支持这两个模型完整驻留 GPU。剩余显存余量有限，不能据此无限扩大上下文或并发；`NUM_PARALLEL=1` 是每模型并行上限，双驻留不保证全局 GPU 单并发。此处的 8192 context 属于预热验收快照，`15m` 是请求值，预热记录未采集 `expires_at`。

13:43:11+08 的只读收尾再次确认版本 `0.40.15`、User 与启动日志均为 `1 / 2 / 16`，两个目标模型仍完整驻留 GPU、context 均 8192，runner PID 28272/19328 未更换。覆盖本轮 RAG 窗口的追加日志没有模型重载标记或 OOM；GPU used 14347 MiB、free 1561 MiB。此次实际读取的到期时间为 llama 约 13:52:04+08、embedding 约 13:52:03+08，属于有限驻留时间，不是永久常驻承诺。本轮容量、驻留和 RAG 辅助进程活跃数为 0，正常 Ollama 服务保留；证据为 `.codex-tmp/latency-residency-final-check.json`。后续真实 RAG 的顺序与并发小样本结果如下。

### 双模型驻留后的真实 RAG 小样本

本机时间 2026-11-06 13:36:45.026–13:37:04.280，在既有开发 HTTP 服务上执行 20 个顺序请求及一组 2 请求并发。模型为 `llama3.1` 与 `qwen3-embedding:latest`，Ollama `0.40.15`、容量 `1 / 2 / 16`；模型已预热，外部负载未隔离。运行 exit 0，22 个请求均 HTTP 200，每条取得 5 条证据；6 个驻留检查点的版本一致且两个模型均在场。本机证据文件为 `.codex-tmp/latency-rag-residency-results.json`。

| 测量范围 | 首个答案正文 | 客户端总耗时 | 统计边界 |
| --- | --- | --- | --- |
| 20 个顺序请求 | P50 470 ms；P95 539 ms | P50 846 ms；P95 1565 ms | 最近秩分位数，20/20 传输成功；引用 available 8、missing 12 |
| 单组 2 请求并发 | 分别 498、883 ms | 分别 994、1060 ms | 两个单独观测值，不报告并发 P95；引用 available 1、missing 1 |

以下阶段分位数覆盖全部 22 个请求，包含并发样本，与上表顺序集合不同：

| 服务端阶段 | P50 | P95 |
| --- | ---: | ---: |
| 预热 | 2.8 ms | 4.6 ms |
| 检索 | 173.3 ms | 257.1 ms |
| embedding | 20.6 ms | 28.6 ms |
| 生成 | 555.3 ms | 1045 ms |

预热阶段最小 0.5 ms、最大 27.6 ms。阶段计时存在嵌套，不能相加为端到端耗时。与单模型驻留下数十秒的加载记录相比，这组预热后样本未再出现同量级的预热等待，支持保留本机双模型驻留配置；它不消除 daemon 重启、模型过期或其他模型挤出后的冷加载成本，也不是严格控制变量的提速倍率实验。

质量边界必须单列：29/29 个源文档派生字面检查匹配，但没有独立人工 gold；22 个响应中引用状态为 **9 个 `available`、13 个 `missing`**。9 个 `available` 样本包含 1 个并发请求，最大首正文 925 ms、最大总耗时 1727 ms，低延迟并不只出现在缺失引用的响应中；这组混合小样本不另报 P95。取得证据、字面匹配或 HTTP 200 均不能替代完整引用与答案质量验收。此处只报告开发环境小样本延迟，不宣称生产负载 SLO、长答案、更多问题类型或异常容量场景已通过。

只读代码核对确认，legacy 路径的 `missing` 表示最终答案没有解析器可识别的编号引用：解析器只认正文中的 ASCII `[n]` / `[n,m]`，忽略代码、链接和转义内容，因此不等同于文本完全没有类似标记。第四批当时 `ChatMessage` 没有 `missing` 专用提示，仍存在可追溯引用覆盖不足；第五批新增提示见下文。该核对不代表已经排除所有回归，也不能将其记为质量通过。

### 构建守卫与第四批验证快照

首次 Next.js 核心生产构建已 exit 0，后续 standalone SDK、链接与运行时检查通过，但 trace 守卫检出 13 个原始 multimodal 源码/测试文件。定位到新增 `/api/documents` 和 `/api/documents/publications` 两个路由的追踪入口后，只对这两条路由添加源码扩展名排除，并补充配置契约测试；未放宽守卫，也未删除产物来制造通过。

最终 `npm run build` 的完整 `prebuild → build → postbuild` 生命周期 exit 0：编译约 58 秒，TypeScript 检查约 29.6 秒，生成 113 个静态页面。最终 trace 守卫检查 115 个 manifest，`privateReferences=0`、`standaloneRaw=0`；运行时依赖从 standalone 内加载成功，没有借用工作区依赖。该结果验证生产产物及现有构建守卫，不代表真实业务全量 E2E 或负载性能验收。

| 验证 | 已取得结果 | 边界 |
| --- | --- | --- |
| 发布检索与大 URI 边界 | 53 项：52 通过、1 真实集成跳过；目标 TypeScript/lint 无诊断 | 包含实际 SDK 离线传输验证；不等于真实 ES 压测 |
| 页面与 UI/持久化 | 主页 56/56；UI 与持久化组合 113/113；新增生命周期 4/4 | 用例集合有重叠，不能相加为唯一测试总数 |
| 测试命名及 mock 客户端清理 | 17 项：16 通过、1 真实集成跳过 | 客户端只关闭本用例持有的资源 |
| 旧模型预热前拒绝 | 入口组合 21/21 通过；真实同输入复测 409、客户端 2220 ms、服务端 12.9 ms，无 warmup | 原样本总耗时 52253 ms；单样本只证明消除无效预热，不代表整体提速比例 |
| Next.js 配置与构建守卫 | 27/27 通过，定向 lint 无诊断；完整生产构建与 postbuild exit 0 | 115 个 manifest，私有引用与 standalone 原始源码均为 0；不等于真实业务 E2E |
| 全仓 ESLint | 1142 个文件，0 error、49 warning，exit 0；最后六文件定向检查 exit 0 | 全仓快照与末尾增量分别验证；不是零 warning |
| 扩展 `test:latency` | 335 项：334 通过、1 真实集成跳过、0 失败、0 取消；33.530 秒，exit 0 | 含最终入口、URI 与 UI 回归；不是实际模型负载或速度对照 |
| 代码与 TypeScript 审查 | 发布检索及 UI 修复通过；大 URI HIGH 已修复复核；旧模型拒绝与构建追踪修复通过代码审查 | 审查与行为回归不代替实际服务验收 |
| 宿主容量 | 最终 `0.40.15 / 1 / 2 / 16` 已生效；两模型完整 GPU 驻留；13:43 收尾无模型重载/OOM，free 1561 MiB，辅助进程活跃数 0 | 预热试验 57 次采样最低 free 1581 MiB；不保证全局 GPU 单并发或永久驻留，取消/故障/过载未验收 |
| 单模型驻留真实 RAG 基线 | `0.40.14` 总耗时 71865 ms；`0.40.15` 总耗时 96318 ms；均 200、5 条证据、引用 available | 两个单次源文档派生样本，非独立质量 gold；版本/答案长度/外部负载不同，不是严格 A/B |
| 最终配置真实 RAG 小样本 | 20 顺序请求首正文 P50/P95 470/539 ms、总耗时 P50/P95 846/1565 ms；一组 2 并发也均 200 | 最近秩开发环境热样本，外部负载未隔离；22 条引用 available 9、missing 13，不是完整质量或生产 SLO 验收 |

## 第五批：引用提示、按需预热与冷启动准备

### 引用缺失可见化与 v11 生成契约

`ChatMessage` 已为 assistant 消息增加 `citations.status=missing` 的专用提示，使“检索到了证据但最终正文缺少可识别编号引用”的状态可以被用户看见。`ask-route-contract` 升为 v11，要求逐事实及短答案在正文中使用 ASCII 编号引用，并明确不能为没有依据的内容强补来源。生成温度仍为 0.7，没有通过自动附加引用、额外 LLM 重试或修改解析器来掩盖缺失。

ISBN 的独立真实诊断确认，失败样本的普通正文完全没有编号，并非数字紧邻引用触发的解析缺陷；8 个离线形状检查通过。该证据只说明这次样本的缺失发生在生成内容中，不等于已排除所有生成或引用回归。新增提示改善可见性，v11 提示仍不保证模型每次遵循规则。

源码与回归：[ChatMessage](../../src/components/ChatMessage.tsx)、[引用界面测试](../../src/components/chat-citations.test.mjs)、[Ask 路由契约](../../src/lib/rag/retrieval/ask-route-contract.ts)、[契约测试](../../src/lib/rag/retrieval/ask-route-contract.test.mjs)。

### 仅预热所选模型，隐藏页面不新增工作

`/api/model-warmup` 只预热当前选择的 embedding 和 LLM，移除了默认第三个 classifier 模型的预热，避免它挤占双模型驻留预算。页面隐藏时不发起初次或每 5 分钟的新预热；重新可见与 focus 事件通过 `wasHidden` 和进行中请求合并，避免重复发起。页面隐藏不会取消已经开始的共享预热 job；Retry、切换模型选择和卸载都隔离旧响应，防止旧任务覆盖当前状态。

GET 返回 `ready` 仍表示该预热 job 历史上已完成，不是模型持续驻留的证明。真实端点验证经历 202 → ready，耗时 36.664 秒，最终只观察到所选两个目标模型，context 均 8192、完整 GPU 驻留；不能把一次 ready 当成之后模型不会过期或被挤出。

源码与回归：[预热 API](../../src/app/api/model-warmup/route.ts)、[预热 API 测试](../../src/app/api/model-warmup/route.test.mjs)、[主页](../../src/app/page.tsx)、[页面预热回归](../../src/components/chat-citations.test.mjs)。

### v11 真实 RAG 复测与质量边界

继续使用 `llama3.1`、`qwen3-embedding:latest`、Ollama `0.40.15` 和 `1 / 2 / 16`，对同一组 3 个源文档派生问题执行 20 个顺序请求及一组 2 请求并发。22 条均 HTTP 200，字面检查 29/29 匹配；记录位于本机 `.codex-tmp/latency-fifth-rag-results.json`。

| 范围 | 首个答案正文 | 客户端总耗时 | 边界 |
| --- | --- | --- | --- |
| 20 个顺序请求 | P50 518 ms；P95 2882 ms | P50 1112 ms；P95 3591 ms | 最近秩分位数，本机开发服务，外部负载未隔离 |
| 单组 2 请求并发 | 535、762 ms | 689、1193 ms | 两个单独观测值，不报告并发 P95 |

引用状态为 **13 个 `available`、9 个 `missing`**，其中 7 个 ISBN 问题样本全部 `missing`。这些是源文档派生字面检查，不是人工审核 gold；不能据此称完整引用质量通过。与第四批的 9/13 相比，可用引用数量增加，但生成温度、开发环境和样本条件未受控，不能宣称引用显著改善或整体提速。首个样本的接收确认耗时 4614 ms，包含开发编译等待，不能把它单独归因为检索或模型耗时。

### 第五批代码验证

| 验证 | 结果 | 边界 |
| --- | --- | --- |
| v11 提示契约 | 2 个新增契约用例先失败后通过，文件 10/10 通过 | 约束提示内容，不保证模型每次遵循 |
| 预热与页面生命周期 | 3 个新增回归先失败，修复后组合 71/71 通过 | 与完整组合存在重叠，不累加为唯一总数 |
| 完整 `test:latency` | 349 项：348 通过、1 真实集成跳过、0 失败 | 增加 2 个测试文件；本机日志 `.codex-tmp/latency-fifth-tests.log` |
| 完整生产构建 | `npm run build` exit 0；115 个 manifest、private references 0、standalone raw 0；standalone SDK 验证通过 | 本机日志 `.codex-tmp/latency-fifth-build.log`；不是生产业务 E2E |
| 定向 lint 与审查 | lint 0 error，保留既有 warning；代码与 TypeScript 审查 APPROVE | 不把本次目标 lint 宣称为重新完整扫描全仓 |

### SSD 试验与用户要求的非 C 盘边界

此前曾向本轮独立目录 `C:\Users\Administrator\.ollama\models-ssd-20261106` 复制原库 `E:\project\ai\models`。复制于本机 15:02:23–15:11:29 完成，65/65 个文件通过 SHA-256 重读校验，总计 73806023717 B（约 68.74 GiB）；源与目标依赖闭包均为 16 个 manifest、58 个 descriptor，包含无 size 的 v2 索引/manifest layer 与 cloud `layers: null`。源文件清单未变化，`serviceChanged=false`、`originalStorePreserved=true`；证据为 `.codex-tmp/latency-fifth-model-copy-results.json` 的 `copy-verified-not-activated` 状态。

用户随后明确要求相关数据不得放 C 盘，因此该方案已撤回，不再要求用户选择 C 盘目录。运行库从未切换，仍使用原 E: 库。本机 15:20:46.074–15:20:46.304 仅删除本轮创建的上述独立副本目录，exit 0、确认目标不再存在；删除前后原 E: 库均为 65 个文件、73806023717 B，size/mtime 未变，`serviceChanged=false`，其他 C 盘目录未改。撤销证据为 `.codex-tmp/latency-fifth-model-copy-rollback.json`，状态 `created-copy-removed-original-preserved`。SSD 从未激活，也未验证 SSD 冷启动收益。

磁盘清点确认 NVMe `GIGABYTE AG470E1TB` 仅有 C: 分区；E: 与 F: 都在同一块 `WDC WD20EZAZ` SATA HDD 上，当前没有非 C 盘 SSD。因此保留 `E:\project\ai\models`，改到 F: 不能获得 SSD 读取收益；后续存储提速需要符合用户要求的非 C 盘高速存储条件。

本机模型目录来自 GUI 的 `db.models`。Ollama `0.40.15` 仅在该设置为空时回退到 `OLLAMA_MODELS`，非空 GUI 设置会覆盖新 daemon 的同名环境变量；因此第四批提出的“只切换环境变量”不足以完成这台机器的迁移。若以后具备符合用户要求的非 C 盘目标，需先准备并校验副本，再通过受支持的 Settings → Model location → Browse 切换；该操作重启 daemon，不负责复制模型文件。源码与具体操作边界见[容量部署说明](../deployment/ollama-capacity.md)。

本轮桌面工具仍因 `helper_unknown_error` 无法初始化，GUI 设置 API 没有会话 cookie 时返回 403；未读取 cookie/token，也未通过直接写私有 SQLite 绕过界面。当前没有待执行的 C 盘界面切换；非 C 盘迁移如继续实施，仍需受支持的界面操作及新 daemon 路径、模型身份和冷启动验证。

### 有界取消、客户端退出与突发请求验收

本机 14:59:39.907–14:59:55.544 共执行 25 次有界请求，覆盖客户端取消、结束本轮所属客户端子进程、20 请求并发突发三组。取消发生在首正文后，客户端得到 `AbortError`、未观察到业务终态；被结束的子进程已 close、信号为 `SIGKILL`。每组后续恢复请求均成功，恢复计时如下：

| 场景后的恢复请求 | 首个答案正文 | 客户端总耗时 |
| --- | ---: | ---: |
| 客户端取消后 | 617 ms | 985 ms |
| 所属客户端子进程退出后 | 299 ms | 1123 ms |
| 20 请求突发结束后 | 310 ms | 1199 ms |

20 并发全部进入终态，17 个成功、3 个 SSE 终态过载拒绝，错误均为 `PROVIDER_QUEUE_FULL`。三个拒绝的传输层 HTTP 均为 200，SSE 业务终态为 503，总耗时分别 742、718、706 ms；成功请求最长 10591 ms，不能把三条拒绝写成 HTTP 503。它们验证的是应用准入背压，不证明命中了 Ollama 原生 `MAX_QUEUE` 的全局等待上限。

报告的 `executionCompletedSafely` 和 `allRequestedCoverage` 均为 true；主测试进程 exit 0，15:02:30 的独立进程审计确认本轮故障辅助进程残留为 0。证据为 `.codex-tmp/latency-fifth-fault-results.json` 与 `.codex-tmp/latency-fifth-fault-final-check.json`。此轮没有另外采集终末 GPU/驻留状态；取消或客户端退出后的恢复不证明远端 GPU 在退出瞬间已经停止，也不等于全局 GPU 单并发、公平性或生产 SLO 验收。

15:20:04+08 的另一次只读检查确认 Ollama 仍为 `0.40.15`，原 E: 库的 `llama3.1` 和 `qwen3-embedding` digest 均匹配；此时 `/api/ps` 为空，处于 15 分钟闲置驻留期到期之后。检查没有发出新推理或预热，不能把此前成功的双模型 GPU 驻留写成此刻仍然常驻。容量 `1 / 2 / 16` 未变，保留双驻留能力；证据为 `.codex-tmp/latency-fifth-e-store-check.json`。

## 后续实施条件

| 尚未完成 | 继续实施前需要的证据或设计 |
| --- | --- |
| 跨进程容量的剩余边界 | 已完成正常请求、客户端取消、所属客户端进程退出及 20 请求突发恢复，3 个过载拒绝属于应用 SSE 业务终态。仍需核验所有调用方指向同一 daemon、服务端故障、跨进程公平性与受控生产负载；本轮不证明原生队列总上限或全局 GPU 单并发 |
| 减少 embedding 身份探测、扩大缓存范围 | 发布 query 完成向量缓存已落地；进一步减少身份检查需要模型身份不可变及撤销时效契约，扩大范围前需隔离等价性与真实命中率证据 |
| 进一步减少发布 RPC、共享语料集合 | 全局 ES 元数据批处理、外层身份检查与完整 URI 上限已落地；仍需测量逐文档 Milvus 检查等剩余扇出，在最终授权等价条件下继续优化。集合变更需要迁移与回滚方案 |
| FLAT → HNSW 等索引迁移 | 发布 reader 当前约束 v1 FLAT/COSINE manifest，不能只切换环境变量。先用真实语料比较召回、内存与 p95，明确 schema/manifest 兼容及重建成本 |
| HDD 冷加载优化（当前无可用目标） | 用户要求相关数据不得放 C 盘，已撤回该副本方案；NVMe 仅 C:，E:/F: 同属一块 HDD，无可用非 C 盘 SSD。继续使用原 E: 库，当前没有待执行的目录切换；待用户提供非 C 盘 SSD 后再评估副本、切换和冷启动收益。GUI `db.models` 优先于 User 环境变量，双驻留不消除重启、到期或挤出的冷启动 |
| 统一发布检索的答案增量 | 普通 legacy 问答已新增草稿流；发布检索继续只输出状态。提前输出发布正文仍需明确读取租约、撤销与版本语义，不能直接移除最终校验 |
| 正式 RAG 性能与质量验收 | 已完成第四、第五批开发环境 20 顺序 + 2 并发小样本，最新 v11 仍有 9 条 missing，其中 7 个 ISBN 样本全部 missing。缺失提示已显示，仍需人工质量集、引用完整性与受控生产负载、冷启动、足量并发、长答案及 tokens/s/队列/GPU 指标，不能把字面匹配记为质量通过 |

本轮未执行 commit、push 或正式应用部署，保留现有未提交改动；本机 Ollama 为 `0.40.15 / 1 / 2 / 16`，模型库继续使用原 E:。第五批引用提示、所选模型预热、349 项延迟回归、完整生产构建及有界取消/客户端退出/突发恢复已验证。C 盘副本方案按用户要求撤回；生产 SLO、非 C 盘冷启动优化、公平性和完整引用质量仍需对应条件与证据，不宣称全部目标已经完成。
