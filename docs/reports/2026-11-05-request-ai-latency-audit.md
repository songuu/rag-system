# 请求与 AI 延迟审计及解决方案

日期：2026-11-05（Asia/Shanghai）。范围：当前工作区代码、已安装 SDK、当前本机运行环境。工作区包含大量既有未提交修改，本报告针对读取时的工作树，不代表某个已发布版本。

结论：存在多个能够解释“有时很慢”的机制，优先级最高的是模型资源争用、取消未穿透到传输层、输出预算缺失、主问答不流式，以及健康探针触发重初始化。统一发布检索另有明确的随文档数增长的 RPC 放大。不能将这些问题全部归因为模型本身慢，也不能用增加超时时间解决吞吐与排队。

本轮新增此报告，未修改业务代码、配置或服务状态，未执行真实生成、付费模型调用、发布、commit 或 push。

## 1. 证据与结论边界

| 证据类别 | 本轮结果 | 能证明什么 |
|---|---|---|
| 静态审计 | Ask 普通/Agentic/统一发布、模型工厂、Ollama SDK、检索/存储、首页、探针、部署模板 | 当前实现的等待关系、调用数量、条件性风险 |
| 传输模拟 | 内存 fake fetch，不访问模型服务 | 首包前取消未及时中止传输；maxTokens 未映射 |
| 本机资源快照 | RTX 5070 Ti：16303 MiB 显存，已用15424 MiB，约94.6%；采样瞬时利用率16%。物理内存约31.11 GiB，可用3.57 GiB | 当时资源余量较低；不能单独证明某次请求发生换页或模型置换 |
| Ollama只读状态 | 同时驻留 llama3.1:latest、qwen3:latest、publication专用小模型；size_vram约5.82GB、7.54GB、0.34GB | 多模型同时占用显存；不能认定它们全属于当前项目或可以直接停止 |
| Docker只读状态 | 约28个容器，包含主RAG、隔离发布环境和其他项目；有多套ES/Neo4j/Milvus | 多应用共享主机；未擅自停止任何容器 |
| HTTP小样本 | localhost:3000，/api/health/live TTFB为1259/12/55ms；首页为285/23/26ms；均200 | 当时热路径可较快返回，首次有加载差异；三个样本不能估计p95或证明AI性能 |
| 既有离线测试 | 18项模型/计量测试全通过；33项检索/嵌入测试中32通过、1真实集成测试跳过 | 现有行为及部分安全边界受测试保护；不代表性能达标 |

未知项：发生慢请求时的requestId与分段trace、实际服务进程加载的环境变量、线上生效的网关配置、GPU排队/模型加载时间、真实TTFT/token吞吐、数据库执行计划、浏览器Profiler。磁盘I/O、代理网络和数据库锁尚未被证实为根因。

本地.env白名单读取表明默认模型与embedding provider均配置为ollama；未看到统一发布开关。文件值不等于运行进程的实际环境，隔离发布应用可能单独启用。因此以下严格区分普通路径与`RAG_UNIFIED_PUBLICATION_MODE=active`路径。

## 2. 请求耗时模型

```mermaid
flowchart LR
  A[提交请求] --> B[权限与会话校验]
  B --> C[路由与模型准备]
  C --> D[检索与证据校验]
  D --> E[模型排队与加载]
  E --> F[提示词处理与生成]
  F --> G[引用与发布版本复核]
  G --> H[完整JSON返回]
```

当前主聊天等待完整JSON，因此用户看到答案的时间接近整条链路总耗时。需要同时测量：

- 响应确认时间：服务端确认接收请求，不能当成模型TTFT。
- 端到端TTFT：从用户提交到第一个可见答案token。
- 模型TTFT：从实际派发模型到第一个答案token，排队/加载/思考须另记。
- 完整耗时：从提交到答案、引用、最终校验完成。
- 生成吞吐：输出token数/解码耗时，不包括排队、加载和检索。

有并行阶段时按关键路径或时间区间并集统计，不能直接累加重叠耗时。Ollama的load_duration、prompt_eval_duration、eval_duration、eval_count可用于分解；时间字段单位为纳秒。[Ollama API](https://docs.ollama.com/api/generate)

## 3. 按优先级排序的问题

### P1-1：取消没有完整穿透到底层模型传输

普通/Agentic路径在[运行时2674行](/E:/project/ai/rag/project/rag-nextjs/src/app/api/ask/runtime.ts:2674)、[2603行](/E:/project/ai/rag/project/rag-nextjs/src/app/api/ask/runtime.ts:2603)及[发布问答44行](/E:/project/ai/rag/project/rag-nextjs/src/app/api/ask/publication-runtime.ts:44)创建模型时仅传requestTimeoutMs。模型工厂[599行](/E:/project/ai/rag/project/rag-nextjs/src/lib/model-config.ts:599)支持requestSignal绑定fetch，但这些入口没有使用。

已安装Ollama SDK在等待client.chat及首个stream块期间不能靠invoke.signal立即终止传输。模拟中，传输上限1000ms，开始后立即取消：只传invoke.signal，1022ms后TimeoutError；同时绑定requestSignal，0ms观察到AbortError。这是模拟传输实证，尚未测真实GPU释放时间。

修复：在invokeGenerationWithDeadline回调内部使用它提供的合并signal创建请求专属模型，覆盖普通、Agentic、publication路径；保留requestSignal模型不进入共享缓存的现有行为。所有embedding、检索SDK、worker任务也要审核取消链。

验收：首包前/生成中/排队中取消都终止传输；两个请求取消互不影响；排队任务未开始时直接移除；有请求仍未实际结束时不能提前释放容量。已有detached-work保护继续保留。

### P1-2：输出token上限未落实

[Ollama构造591行](/E:/project/ai/rag/project/rag-nextjs/src/lib/model-config.ts:591)没有把统一maxTokens映射为numPredict。模拟传入maxTokens:77，实际numPredict仍为空；主问答调用本身也没有指定输出预算。context maxTokens=4000限制的是检索上下文，不能限制回答长度。

修复：统一输入、输出、总时限三个预算。普通短答可先试256–512输出token，详细回答512–1024，覆盖判断等结构化步骤64–128；这些是实验起点，必须按中文完整性和引用质量调整。将maxTokens映射为numPredict，并检查真实请求体、停止原因。length截断必须明确标记，不能当成完整回答。推理模型的thinking策略按模型能力验证后设置，不能假设所有模型支持同一参数。

### P1-3：共享GPU缺少跨功能统一容量管理

本机显存高占用是事实；发生置换、CPU offload或排队是待验证假设。Ask的[detached map](/E:/project/ai/rag/project/rag-nextjs/src/app/api/ask/runtime.ts:258)限制的是超时后未结束的工作，并不限制正常请求并发。MAIC的[并行分支](/E:/project/ai/rag/project/rag-nextjs/src/lib/maic/pipeline/prepare-runner.ts:281)和MiroFish的[Promise.all](/E:/project/ai/rag/project/rag-nextjs/src/lib/mirofish/simulation-engine.ts:187)还会一起竞争模型。

修复：按provider endpoint/GPU实例设置共享准入控制，在线问答优先，embedding/备课/图谱/评估设独立配额和公平调度。先以单GPU生成并发1为对照，测试2后再增加；队列有上限、等待期限和取消能力，满载返回明确状态或Retry-After。后台任务批次间可让出，不能无限Promise.all。

模型驻留优先保证一个主生成模型和必要embedding；哪些其他模型可释放须先核对所属任务。keep_alive与上下文大小统一到服务端策略，避免不同入口使用不同num_ctx导致重复分配。Ollama并行上下文增加内存需求，配置必须作用于Ollama服务进程，而非只修改Next的.env。[Ollama FAQ](https://docs.ollama.com/faq)

多进程/多个应用共享同一Ollama时，单个Node内存semaphore不足，容量控制必须放在共同网关或共享调度器。现阶段不建议直接把PM2 instances改成max。

### P1-4：主聊天全量JSON返回，且超时窗口不一致

[首页1029行](/E:/project/ai/rag/project/rag-nextjs/src/app/page.tsx:1029)await response.json后才显示答案。浏览器[预算28行](/E:/project/ai/rag/project/rag-nextjs/src/lib/rag/core/request-budgets.ts:28)为375秒：预热90+检索30+本地生成240+网络余量15。Ask maxDuration=390；[Nginx模板265行](/E:/project/ai/rag/project/rag-nextjs/deploy/songuu/patch-nginx.py:265)proxy_read_timeout=300s。合法长路径若一直无响应字节，网关可能先504。这里只核验模板，未读线上实际配置。

修复分两步：

1. 先提供accepted/queued/loading/retrieving/generating/validating/done/error阶段事件和明确取消；统一绝对deadline，余量从同一个截止时间扣减。超出交互预算的图谱、摄入、长报告走已有worker/作业模式；发布Ask当前不支持旧durable，不能直接切executionMode冒充支持。
2. 普通问答增加SSE或fetch stream，前端30–60ms合并delta刷新，保留最终结构化答案与旧JSON兼容。已发布资料要求最终版本/权限复核：先只流状态；正文提前流出前必须设计读租约/撤销语义，避免最终判定无权返回后已泄露正文。

现有Nginx已关闭proxy_buffering，不应重复归咎缓冲。增加流式后仍需经真实代理验证首包、心跳、断线、取消及绝对deadline；心跳不能延长实际任务预算。流式改善可见等待，不自动提高token/s。[Next.js自托管说明](https://nextjs.org/docs/app/guides/self-hosting)

### P1-5：健康探针可能启动文档向量化

[health85行](/E:/project/ai/rag/project/rag-nextjs/src/app/api/health/route.ts:85)在非统一发布、非vector-disabled路径调用getRagSystem；[rag-instance44行](/E:/project/ai/rag/project/rag-nextjs/src/lib/rag-instance.ts:44)初始化数据库；[rag-system768行](/E:/project/ai/rag/project/rag-nextjs/src/lib/rag-system.ts:768)读取文档、分块并addDocuments。首次探测可能触发embedding、占用资源。初始化已有singleflight，因此不是每30秒必定重建，但失败后可再次尝试。

[Dockerfile54行](/E:/project/ai/rag/project/rag-nextjs/Dockerfile:54)每30秒、5秒超时检查这个重端点，探针超时不意味着服务端初始化停止。

修复：liveness改用已有/api/health/live；readiness只读取初始化状态和有界依赖探测，不创建RAG实例。初始化/预热放到显式启动任务，支持状态与错误回读。用mock保证任何健康检查不调用embedding；冷启动多探针不重复启动工作。

### P1-6：统一发布检索有明显RPC扇出

仅在统一发布路径适用。[publication-retrieval115行](/E:/project/ai/rag/project/rag-nextjs/src/lib/documents/publication-retrieval.ts:115)遍历所有选中文档，只有4篇并发；每篇检索前后各校验ES索引、Milvus collection/schema/index，再独立向量查询。多文档hybrid的全局lexical前后还逐索引验证。

静态推导：N>1、hybrid且无提前失败，约9N+1次ES/Milvus调用，不含PG、embedding和客户端认证；32篇约289次、128篇约1153次。这不是延迟实测。当前publication view最多128文档/4096块。

短期：计数每请求RPC，批量取ES元数据，请求内共享已经验证且仍有效的只读状态，复用同一请求的view/session，限制总并发。中期：评估按corpus generation组织共享collection/索引，按tenant/corpus/document/generation过滤，避免每篇独立collection扇出。

不能直接删身份、封存、撤销和版本校验；需要证明批量/缓存的检查具有等价安全语义。当前FLAT索引被writer和reader契约共同固定，不能仅改环境变量换HNSW；4096块规模下尚无证据表明FLAT是第一瓶颈。扩容时再版本化schema/manifest并测Recall@K。

### P1/P2-7：发布embedding与连接管理增加固定开销

[publication-embedding18行](/E:/project/ai/rag/project/rag-nextjs/src/lib/documents/publication-embedding.ts:18)在已有模型alias的正常查询路径中，resolve读tags/version，embed前后再各读tags/version，合计3次tags+3次version+1次embed，七次顺序HTTP。同请求同embedding配置已有Promise Map去重，不能误报为每文档重复embedding。

[publication-search-runtime71行](/E:/project/ai/rag/project/rag-nextjs/src/lib/documents/publication-search-runtime.ts:71)每请求读CA、新建ES/Milvus client、认证探测，并在finally关闭连接（关闭等待最多2秒）。实际开销需要测，但连接复用缺失已确认。

修复：按endpoint、凭据版本、TLS配置复用只读连接，轮换时失效；禁止混用admin/writer客户端。统一query embedding缓存和singleflight，以完整provider/model digest/revision/dimension/num_ctx/query identity为key，使用有界容量和TTL；敏感输入按tenant/corpus分区。模型身份变化失效，缓存命中仍进行请求权限及发布版本验证。只有在明确身份不可变契约后，才合并或缓存模型身份探测。

摄入每16块一批，每批前后验证，1000块约63批/315次HTTP加初始化；优先批次调度与探测复用，不要简单提高GPU并发。

### P2-8：额外串行模型调用使复杂问题更慢

[Agent374行](/E:/project/ai/rag/project/rag-nextjs/src/lib/rag/agents/scoped-retrieval-agent.ts:374)无补检索预算2次、有补检索最多4次；初始证据已存在，但要求先调用快照工具。[比较回答27行](/E:/project/ai/rag/project/rag-nextjs/src/lib/rag/retrieval/partial-comparison-answer.ts:27)先用回答模型判断覆盖，再生成正文。都是有目的的保护，不能为了速度无条件删除。

方案：简单问题普通RAG；确需多跳才进入Agent。服务端确定性执行快照读取并按现有工具/权限协议提供结果，减少无信息增益的一轮。覆盖判断独立小输出预算，评估轻模型或可靠检索覆盖信号，保留证据不足拒答。每次实验比较调用次数、完整耗时及引用/拒答质量。

### P2-9：legacy检索有非关键等待及候选放大

[dense-retrieval30行](/E:/project/ai/rag/project/rag-nextjs/src/lib/rag/retrieval/dense-retrieval.ts:30)在启用statistics时等待search和statistics一起完成；[collection统计2114行](/E:/project/ai/rag/project/rag-nextjs/src/lib/milvus-client.ts:2114)本身有四次顺序RPC。把非关键统计移到监控/短TTL缓存。问答主分支直接embedQuery，未统一使用已有跨请求query缓存。

legacy文档搜索调用方topK×4，Milvus候选内部又×4，部分范围内候选达用户topK的16倍。统一一处候选预算，按实际召回、去重和rerank需要定上限。已有dense与lexical并行、初始化与embedding并行应保留。

### P2-10：数据库超时止等不一定止工

[Postgres连接池配置78行](/E:/project/ai/rag/project/rag-nextjs/src/lib/postgres/client.ts:78)已有连接池及连接超时；本次应用代码搜索未见statement_timeout/lock_timeout配置，数据库角色级实际值未知。[publicationReadWithin](/E:/project/ai/rag/project/rag-nextjs/src/lib/documents/publication-read-deadline.ts:1)明确说明Promise超时不能取消已发送SQL。

方案：先只读SHOW相关参数，采集pool等待/空闲/总连接、慢SQL、锁等待；对在线查询设置数据库端statement_timeout和更短的lock_timeout，后台迁移/批任务采用不同角色预算。事务内用SET LOCAL避免池复用泄漏。真正取消能力与连接回收按pg支持验证；不要只给Promise.race再加一层。只有取得慢SQL和执行计划后才新增索引。[PostgreSQL超时说明](https://www.postgresql.org/docs/current/runtime-config-client.html)

### P2-11：前端后台查询与长会话渲染会放大负载

[首页486行](/E:/project/ai/rag/project/rag-nextjs/src/app/page.tsx:486)只需summary但读取完整/documents，并每30秒、focus/visibility时刷新；目录默认最多500条，summary存在只统计截断目录的风险。增加有权限边界的summary聚合接口，目录分页，按scope和revision失效，singleflight避免重复刷新。

[首页1527行](/E:/project/ai/rag/project/rag-nextjs/src/app/page.tsx:1527)完整渲染消息列表；[ChatMessage513行](/E:/project/ai/rag/project/rag-nextjs/src/components/ChatMessage.tsx:513)非memo，长会话和流式更新时可能重复解析Markdown/引用。先Profiler验证，再拆输入区与列表、memo稳定消息、按需加载诊断面板，必要时窗口化。QueryAnalysis已动态加载ECharts，不应重复建设。

## 4. 分阶段实施计划

以下为工程工作量估计，基于现有代码；应以实际回归结果调整，不能当交付承诺。

| 阶段 | 主要任务 | 交付及门禁 | 粗估 |
|---|---|---|---|
| A：建立基线与止损 | 分段计时、修复传输取消和输出映射、轻量健康探针、统一deadline | 不真实调用模型的RED/GREEN测试；取消隔离、探针无embedding、输出预算正确；保留旧协议 | 1–2工程日 |
| B：稳定在线容量 | endpoint/GPU统一配额、有界排队、批任务优先级、明确模型驻留与预热 | 混合负载下在线p95/排队可控；多请求取消不泄漏槽位；饱和显式响应 | 2–3工程日 |
| C：降低检索成本 | 只读连接复用、请求内view/session复用、embedding cache/singleflight、批量元数据读取、移除统计等待 | RPC数下降；旧/新检索、撤销、凭据轮换、身份变化、scope隔离全部回归 | 2–4工程日 |
| D：改善可见响应 | 状态流、普通答案token流、前端批量刷新、引用最终事件、错误/取消状态机 | 经代理验证；published正文保持授权一致性；JSON客户端兼容 | 2–4工程日 |
| E：按证据扩容 | corpus generation布局、索引类型、独立模型服务、数据库索引、前端窗口化 | 仅当压测证明需要才做；迁移可回滚、质量和权限门禁通过 | 单独估算 |

建议先完成A与B再判断硬件是否需要升级；先排队和驻留治理，再讨论加并发。无需立即引入新编排框架或Redis；先复用已有worker和Postgres持久能力，仅在跨进程吞吐需要时选择共享调度实现。

## 5. 可观测性与验收设计

每请求统一requestId/traceId，记录route、provider/model digest、冷/热、cache状态、输入输出token、文档数、RPC数、生成调用次数、状态码及取消原因。阶段至少有auth、route、queue_wait、warmup、embedding、dense、lexical、rerank、context、model_first_token、generation、citation、final_check、serialize。另收集Node event-loop延迟/RSS、PG池等待、Docker CPU/内存、GPU显存及推理服务排队。

当前已有trace与评估计量，不能称为完全无监控。但provider-usage-observer的capture目前见于[publication评估入口178行](/E:/project/ai/rag/project/rag-nextjs/src/lib/rag/eval/publication-eval-runtime.ts:178)，普通在线POST没有同样的统一collector；现有统计不等于线上具备完整TTFT/队列观测。复用现有模块接入，避免再建第二套。

候选SLO仅作为试验目标，不是当前能力或本轮测量：

| 场景 | 初始目标 |
|---|---|
| 请求确认/排队状态 | 正常负载下p95≤500ms |
| 热模型普通RAG、固定样本与输出预算 | 检索p95≤2s，端到端TTFT p95≤3–5s，完整回答p95≤15–20s；按模型实测校准 |
| 取消 | 底层传输观察到取消≤1s；真实provider槽位释放另外测量 |
| 过载 | 有界排队，在等待期限内明确排队/拒绝；无无限等待 |
| 冷启动 | 立即有加载状态，单列冷启动指标；超过交互预算转等待就绪/异步流程 |

压测矩阵：普通/Agentic/publication；冷/热；短问/长上下文/比较题；1/8/32/128文档；缓存命中/未命中；并发1/2/4/8；无后台任务/同时摄入或图谱；直连/真实代理。分阶段执行，先1/2并发，确认容量再扩大，避免把测试本身变成额外故障。

每个主要场景先30–100样本看p50/p95与最大值；p99需要更多样本和误差说明。固定语料、问题、模型digest、参数与输出预算，冷热分组，不用截断失败样本美化分位数。

正确性门禁：Recall@K、证据组覆盖、引用有效率、拒答准确率、答案质量不得突破项目已有回归阈值；未知阈值先建立基线。额外覆盖首token前取消、断网、429/503、超时后迟到结果、凭据轮换、发布版本变化、撤销、缓存跨租户隔离、流末校验失败。安全校验不能靠任意TTL缓存替代。

按开关灰度，逐项对比，保留JSON/旧策略回退；出现权限/引用错误立即回退，延迟改善不能抵消正确性失败。缓存键变更需版本化，索引布局迁移保持旧generation可回退，不原地覆盖现有数据。

回滚不得将已启用统一发布的请求切回未受同等权限约束的legacy读路径；旧generation只有在当前授权、撤销状态和发布视图验证通过后才能重新发布或读取。验证失败保持拒绝，不能为恢复可用性重新暴露已撤销资料。

## 6. 本轮验证记录与排除项

执行：

```text
node --test --test-timeout=30000 src/lib/models/langchain-text-model.test.mjs src/lib/rag/core/provider-usage-observer.test.mjs
18 passed / 0 failed

node --test src/lib/documents/publication-retrieval.test.mjs src/lib/documents/publication-embedding.test.mjs src/lib/rag/retrieval/dense-retrieval.test.mjs src/lib/rag/retrieval/milvus-elasticsearch-fusion.test.mjs
32 passed / 1 skipped / 0 failed
```

另以内存fake fetch重现取消传播与numPredict映射问题。未执行生产压测、全量构建或全量回归，因为本轮交付为审计方案且没有业务代码变更。自动沙箱执行曾反复启动失败，经获准的只读执行继续；该工具环境故障未计为项目性能问题。

已存在且应保留：PG连接池复用、RAG初始化singleflight、模型超时、Ollama零重试、Agent步骤上限、detached-work保护、检索并行、发布请求内embedding去重、scope/版本/索引身份验证、前端取消按钮、Ask lazy import及Next外置重SDK。

没有证据支持立即更换框架、盲目增加GPU并发、直接扩PM2多实例、全局放宽数据库连接池或删除安全校验。LangSmith SDK默认批处理；不能仅因源码出现await postRun/patchRun就断言遥测网络阻塞了主链路，需核对运行时背景配置与trace。非主路径的reasoning-rag stream也存在取消缺口，但生产legacy策略默认禁用，应作为仍启用该功能的补充修复，不混入主生产路径根因。
