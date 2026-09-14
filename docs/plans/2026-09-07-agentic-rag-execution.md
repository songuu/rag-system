# Agentic RAG 后续规划执行

最后更新：2026-09-07。用户已授权按当前架构规划完整实施。架构、模式与复现命令见[当前架构](../architecture/agentic-rag-current.md)。

## 执行范围与验收

1. 恢复本地依赖与验证环境，保留并行 Neo4j 工作；盘点本地 Ollama、Milvus 与持久化服务。
2. 接入 optional rerank lane：服务端 provider、严格同一证据集重排、5 秒上限、取消贯通、非协作工作保留准入、失败保持原排序。
3. 实现 bounded Agent 补搜：先读原证据工具，最多 2 次补搜、4 次模型、3 次工具；query 不能更改 scope，证据只尾部追加且编号固定；无增益、容量、超时退出。
4. canonical API 使用最终交付证据重建引用、context/cache identity；真实轨迹与安全诊断贯通 durable replay。默认 snapshot 保持回滚基线，bounded 模式由服务端启用并通过消融验证。
5. 增加真实 scoped Agent eval adapter、固定 V2 语料和 CLI，比较 snapshot/rerank/iterative；gold 不提供给模型，未知用量不补零，引用身份不冒充语义支持。
6. 执行单元/安全/HTTP/durable/eval/type/lint/build，运行本地 Ollama 真实模型与 Milvus 集成 canary；更新文档与验证证据。

## 不变量

- 服务端 tenant/corpus/trust 与文档身份验证在每个 provider 前执行；安全失败不降级。
- 搜索参数仅含有界 query，不允许模型控制 URL、凭据、scope 或开关。
- 初始零证据保持确定性拒答；新增 evidence 不改变此前已交付的正文、编号、版本或 span。
- 完整生产流量切换需要目标索引和真实质量门禁，不把本地 fixture 质量写作 productionQualityMeasured。
- 不提交、不推送、不写学习记录；所有并行无关修改保留。

## 任务状态

以下勾选表示实现或该项工作已完成，不表示生产流量已激活或最终门禁全部通过。

- [x] 服务盘点与依赖恢复：本地 Milvus healthy，Ollama llama3.1/qwen3 已安装；Neo4j 依赖可用。
- [x] Rerank provider 与 optional lane：5 秒、取消贯通、scope/完整排列校验、未配置跳过与普通失败回退。
- [x] 有界补搜 Agent 与证据追加：先读快照、最多两次补搜、固定证据前缀、重复/冲突/容量检查。
- [x] 主 API、最终快照、缓存和 durable 接线：最终证据重建缓存，模式/提示词版本隔离，安全投影保留真实轨迹。
- [x] 真实 Agent eval adapter、V2 固定语料与三种 variant CLI；`pnpm test:rag-agentic` 纳入专用验证入口。
- [x] 架构、配置、README 与搭建指南同步到本轮实现。
- [x] 本地真实模型原生工具与索引 canary 已执行，完成 rollout 判定；真实模型质量门禁未放行。
- [x] 最终独立审查、RAG 内核/专项回归及生产构建验收。

## 实现边界与 rollout

- 默认 `RAG_AGENTIC_RETRIEVAL_MODE=snapshot`；`bounded` 仅服务端启用，不增加模型对 scope、provider 或 URL 的控制。
- snapshot 为 1 tool / 2 model / recursion 16；bounded 为 3 tool / 4 model / recursion 32，最多 2 次补搜。bounded 累计证据最多 `min(40, 3 × topK)`、4000 估算 token；初始检索 30 秒，生成总计 90 秒，每次补搜含重排 5 秒。
- 提示词身份分别为 `scoped-rag-answer-v3` 与 `scoped-rag-iterative-answer-v2`，读取工具必须显式使用空对象 `{}`，query 仅用于搜索工具。
- CLI 固定 11 个 V2 案例，支持 `--provider fake|ollama`、`--variant snapshot|rerank|iterative`、`--trials 1..10`。安全/预算/执行门禁始终检查；`--gate` 追加严格质量要求。
- 内置检索和重排是 lexical fixture。真实模型有响应可标记 `realModelMeasured=true`，但 `productionQualityMeasured=false`；目标索引及业务质量需要独立验收。

## 首次有界检索实施验证（2026-09-07，后续 v5 见文末）

| 检查 | 最终结果 | 边界 |
| --- | --- | --- |
| TypeScript | `pnpm exec tsc --noEmit --pretty false` 通过；Next 构建内类型检查通过 | 修正并行 Graph rollout 默认 env 投影的类型兼容，不改变图检索逻辑 |
| ESLint | 本轮代码与测试全部定向检查通过 | 全仓扫描仍有 345 errors / 110 warnings，未把历史问题改作本轮范围 |
| Agentic 专项 | `pnpm test:rag-agentic` 194/194 | 覆盖 agent、append、rerank、followup、HTTP/durable 和 eval；与下列套件有重叠 |
| RAG 内核 | `pnpm test:rag-kernel` 659/659 | 包含完整 canonical ask 60/60；修正 Windows CRLF 与 Graph resolver 迁移的两条静态断言 |
| 安全基础回归 | `pnpm test:rag-security` 219/219 | 身份、请求、scope、外部 URL、脱敏、文档与 Milvus 安全契约 |
| 评测基础设施 | `pnpm test:rag-eval` 68/68；`pnpm rag:eval:contracts` 23/23 | 合同验证，不代表生产答案质量 |
| 确定性多轮质量门禁 | `--variant iterative --gate` 11/11 完成，事实覆盖率/引用有效性/引用覆盖率均 1，严格质量、安全与预算门禁通过 | fake 模型与 lexical 检索/重排，只证明可复现工作流 |
| 真实 Qwen | 三种 variant 各 11 案例全部完成；最终 iterative 另重复 3 次，共 33/33 完成；引用编号、安全、预算检查通过 | 三种模式事实覆盖率均 0.8333，最终多跳案例均未主动补搜，严格质量门禁不通过 |
| 真实 Milvus | `RAG_AGENTIC_MILVUS_INTEGRATION=1 pnpm test:rag-agentic:milvus` 3/3 | Windows 请先设置环境变量；localhost 随机合成集合，真实过滤/初检/补检索，fake 模型与固定向量，双引用稳定，已验证集合清理 |
| 生产构建 | `pnpm exec next build` 与三个既有 postbuild 脚本均通过 | Windows native-library 步骤按既有规则跳过；standaloneRaw=0 |
| 独立审查 | APPROVE，无未解决发现 | 修复 active 补检阈值绕过、eval 完整性错误降级、ordered + active 截断不一致；重排 HTTP 错误体等待取消 |

本地原始日志与 JSON 均在 `.codex-tmp/rag-eval/scoped-agent/`：`agentic-tests.log`、`kernel-tests.log`、`eval-tests.log`、`contracts.log`、`security-tests.log`、`next-build.log`、`fake-iterative-gate.json`、`live-qwen3-fixed.json`、`live-qwen3-iterative.json`、`milvus-canary.json`。该目录是本地验证产物，不要求进入版本库。

真实模型首测曾因无参读取工具错误传入 `query` 而失败；补充严格 `{}` 描述后真实 Qwen 可完成工具调用。随后重复试验仍未显示多跳收益，记录失败而不调整 gold 或降低门禁。固定 fake 在多跳中保留可见关联依据和目标事实的两处引用，严格门禁因此可验证完整证据链；真实 Qwen 不使用该 fake。

## 发布判定与额外观察

代码、可复现验证入口和文档已完成；默认保持 `snapshot`，未修改部署环境开启 `bounded`。当前 `productionQualityMeasured=false`。目标业务语料、真实 embedding/商业 reranker、线上延迟成本和更强模型的多跳收益尚未验证，因此生产默认切换门禁未放行。

本次首次 `pnpm build` 触发了项目既有 `generate-articles.mjs` 的 Notion 自动同步分支，日志显示部分页面同步成功。发现后已中止，并确认相关同步子进程不再运行；未回滚外部页面。最终改为直接执行本地 `next build` 和已检查的三个 postbuild 脚本，避免再次触发该外部同步。未提交或推送代码。

## 继续执行：结构化决策与来源协议 v5（2026-09-07）

用户继续授权后，已完成显式决策与来源选择、SDK 适配、API 身份隔离、固定保留集和真实模型配置对照。以下结果是本次继续执行的最终验收；上面的 194/659 等数字保留为此前实施阶段记录。

### 最终实现

- bounded 默认 `RAG_AGENTIC_DECISION_MODE=structured`，`native-tools` 保留对照；外层默认仍为 `snapshot`，未修改部署环境。
- 首轮仍为原生空参数读取。后续沿用同一次模型调用，返回 `{action, query, answer, evidenceNumbers}`。Ollama 的 `oneOf` 三分支按动作约束空字段、文本长度与来源数量；实际 SDK 的 `_llmType()` 是 `ollama`，真实 ChatOllama + mock fetch 测试验证 schema 确实进入请求。
- 来源由模型明确选择；服务端只接受当前交付 context 中的唯一正安全整数，最多 40 项，answer 至少一个来源。正文已有数字引用也必须属于声明集合，未声明或越界引用失败，避免引用诊断把未选择的来源计入覆盖。保留正文，渲染合法声明编号；不自动选择全部 evidence，不声称语义支持已经验证。
- 最终提示词为 `scoped-rag-structured-answer-v5`；模式与提示词共同绑定 cache/durable 身份。搜索、scope、取消和 2 search / 3 tool / 4 model 上限保持原合同。
- CLI 新增 `--decision-mode`、`--think on|off`、`--num-predict 1..8192`。实际模型构造与报告共用配置，HTTP fetch 贯通截止信号；明确 abstain 动作与原生文本规则分开记录。
- 修复过程保留全部失败报告，未调整 gold、降低 E1b 阈值、改写模型事实或补选缺失来源。

### 最终验证

| 检查 | 结果 |
| --- | --- |
| v5 Agentic 全套 | 串行执行相同测试文件，282/282；包含 runtime/helper 135 项、HTTP/durable 68 项、评测/CLI 等 |
| 阶段内核回归 | 恢复执行合计 702 项；第一次有一处临时文件 rename EPERM，单例复测通过，剩余套件全部完成 |
| 评测与生产合同 | 71/71；23/23 |
| 真实 Milvus | v5 canary 3/3；随机合成集合、真实过滤与补检索、fake 模型/固定向量，双来源稳定，确认清理完成 |
| 类型、lint、构建 | v5 Next 生产构建与内置 TypeScript 通过；全部本轮文件定向 ESLint 通过；三个 postbuild 通过，standaloneRaw=0 |
| 独立审查 | code-reviewer 与 security-reviewer 均无遗留发现；类型专项确认 tsc 通过，但其全仓 lint 门禁仍因历史 344 errors / 110 warnings 停止，不把它写作审查批准 |

最终大套件首次并行运行是 281/282，其中 durable replay 首次返回 500；单例立即复测通过。随后以 `--test-concurrency=1` 运行同一 282 项全部通过。没有删除失败断言或放宽测试。机器曾仅剩约 2.4 GiB 可用物理内存，并有模型冷加载；不把这些环境观察当作所有临时失败的确定根因。包管理器包装曾在 `pnpm exec` 前尝试安装缓存依赖并遇到 sharp DLL EBUSY/EPERM，最终检查改为直接调用已有 node CLI，未再次运行该包装器或触发 Notion 同步。

### 真实模型结果与放行结论

固定模型 `qwen3:latest`（8.2B Q4_K_M），temperature=0；检索/重排仍是同一 lexical fixture。来源有效性只验证编号身份，事实覆盖是固定 gold 匹配指标，均不等于生产语义质量。

| 数据集与模型配置 | 完成 | 事实覆盖 | 来源有效性 | 来源覆盖 | 严格门禁 |
| --- | --- | --- | --- | --- | --- |
| 原始 11 例，think=false / numPredict=700，3 轮 | 33/33 | 每轮 1 | 1 | 0.9167 | 未通过：多跳来源链仍有遗漏 |
| 固定中英 8 例，相同配置，3 轮 | 24/24 | 每轮 0.7143 | 1 | 0.8571 | 未通过：部分指引未继续检索，缺失事实案例未明确 abstain |
| 原始 11 例，think=true / numPredict=2048，1 轮 | 11/11 | 0.9167 | 1 | 1 | 未通过：事实、引用精确率、选择性准确率 |
| 固定中英 8 例，相同推理配置，1 轮 | 8/8 | 0.5714 | 1 | 0.7619 | 未通过：召回/事实/来源覆盖及错误拒答 |

默认配置在原始多跳案例实际完成 1 次补搜 / 3 次模型调用；中英集中三文档链实际完成 2 次补搜 / 4 次模型调用并引用三个来源。所有最终运行的执行、安全与既定预算检查通过；CLI 总截止时间不等于生产 90 秒生成时限。原始集首轮包含约 146.7 秒冷加载尾延迟，不能作为生产延迟达标证据。启用 thinking 改善了部分拒答，但没有提高这两组指标，因此未改默认模型配置，也未继续为失败配置重复消耗试验。

保留集在第一次真实评测前固定，未向模型或检索注入 gold。数据集规范化 SHA-256：`f0b6cd70e49c0e2c6fb0a2ac1c7a161336b22cbede2db8d8f30677ba30aefa9c`；原始集为 `67d843ec54d5ef63b919b7d2dfafb361b460cf04947f7a9a2c41dc515c1936fd`。保留集暴露的问题后来用于诊断协议约束，因此最终复测不再声称是一次全新未见集合的泛化证明。

**实施和验证已完成，生产默认切换仍未放行。** 保持 snapshot；structured bounded 可用于受控评估。当前 `productionQualityMeasured=false`，业务语料、真实 embedding/reranker、线上延迟及更合适模型的收益仍未证明。

本地证据位于 `.codex-tmp/rag-eval/scoped-agent/`：

- `structured-v5-agentic-serial.log`、`structured-v5-milvus.log`、`structured-v5-next-build.log`、`structured-v5-eslint.log`。
- `qwen-structured-v5-development-3trials.json`、`qwen-structured-v5-holdout-3trials.json`。
- `qwen-structured-v5-thinking-development.json`、`qwen-structured-v5-thinking-holdout.json`。
- `structured-v5-verification-summary.json` 汇总原始报告与阶段套件统计；较早 v1–v4、探针和失败日志均保留。

复现最终模型对照可使用：

```powershell
node scripts/run-scoped-agent-eval.mjs --provider ollama --model qwen3:latest --variant iterative --decision-mode structured --trials 3 --max-duration-ms 1200000 --gate
node scripts/run-scoped-agent-eval.mjs --provider ollama --model qwen3:latest --variant iterative --decision-mode structured --fixture src/lib/rag/eval/fixtures/scoped-agent-holdout-v1.json --trials 3 --max-duration-ms 1200000 --gate
# 可选对照；本轮实测没有改善整体质量
node scripts/run-scoped-agent-eval.mjs --provider ollama --model qwen3:latest --variant iterative --think on --num-predict 2048 --fixture src/lib/rag/eval/fixtures/scoped-agent-holdout-v1.json --max-duration-ms 900000 --gate
```
