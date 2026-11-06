# RAG 实库验证记录

日期：2026-11-05（Asia/Shanghai）。首轮实库验证已完成，结论为**部分通过**：真实 Ask、CLI、用量采集、ES/Milvus 核对已跑通；Neo4j 配置封印摘要失配，完整三库验收未通过。这是待人工审核的诊断样本验证，不能据此声明正式业务准确率或优化收益。

## 已验证结果

| 验证项 | 真实结果 | 结论边界 |
| --- | --- | --- |
| 隔离发布库 CLI | `--check-runtime` 成功，退出码 0 | 不是模拟 runtime |
| 发布资料问答 | 5/5 HTTP 200，均返回真实发布分块 | 仅 1 份资料、1 个分块，无法代表多文档检索质量 |
| 有答案样本 | 4/4 包含预期字面事实，1/4 输出有效引用编号 | 字面断言不是语义准确率；引用缺失仍需处理 |
| 无答案样本 | 退款金额/期限未提供，回答“无法确认” | 单样本，不代表整体拒答正确率 |
| 闲聊样本 | HTTP 200，0 条证据、0 次嵌入、1 次生成 | 真实 fast model 调用用量已采集 |
| 运行一致性 | 发布视图与配置运行前后一致 | 固定快照可复现机制已接通 |
| 三库发布完整性 | 1 个真实 active 文档，ES/Milvus verified；Neo4j 配置封印失配 | 整体 accepted=false，物理图内容尚未核对 |
| 语义评审 | 真实模型 2/2 调用与结构校验通过 | 未经人工校准；其中拒答被错分为 `answer` |
| 主服务初次探测 | 5/5 HTTP 200；3 条旧样例的预期来源未进入上下文 | 旧样例均被禁用检索，不计为 Recall 失败 |
| 主服务可见资料补测 | 作者、出版社/出版时间 2/2 命中版权页并包含预期事实；1/2 有引用 | ISBN 请求返回模型不一致 409，批次按失败退出 |
| 主服务当前模型独立补测 | ISBN 回答 `9787301347492`，引用可用；dense/lexical 各 5 个候选 | 与原批次分开记录，只确认该请求前后模型配置相同 |

隔离环境为已有 sandbox `372b94728dedfdab252e037f`，scope 为 `publication-demo-tenant / publication-demo-corpus`。验证恢复了既有服务，使用当前动态端口，仅在验证进程内设置配置；未修改主库发布开关或知识库内容。

发布视图：`sha256:896a4a7eeb738ec895edb374535c3b2d6686f1c0b965836c47048dcef8241184`。问答模型 `llama3.1` 对应 digest `46e0c10c039e019119339687c3c1757cc81b9da49709a3b3924863ba87ca666e`；嵌入使用发布记录固定的 `nomic-embed-text` 模型版本别名。

## 三库完整性阻塞

另行复用既有发布核对逻辑，以强制只读 PostgreSQL 会话执行了两轮核对。真实 active 文档数为 1，发布视图前后 digest 稳定、heads 不变，ES 与 Milvus 均 `verified`。

Neo4j 的 snapshot、manifest、版本及三项内容摘要预检均通过；仅当前连接配置指纹与封印的 `graph_configuration_digest` 不一致，`configurationDigestMatches=false`。既有核对逻辑因此在 `executeRead` 之前拒绝继续，整体 `accepted=false`。不能据此断言 Neo4j 连接、认证或数据缺失，也不能声称物理图内容已验证。未绕过校验、修改封印或写入知识库；后续需先核对封印对应的连接配置，再完成该项验收。

## 发布库样本与用量

| 样本 | 观测 | 引用状态 | 总时延 |
| --- | --- | --- | ---: |
| 三个数据库名称 | Elasticsearch、Milvus、Neo4j 均出现 | missing | 26.529 s |
| 原子切换由谁负责 | PostgreSQL，并带 `[1]` | available | 0.541 s |
| 向量化与三库写入顺序 | 回答向量化在前 | missing | 0.470 s |
| 仅两库通过能否可见 | 回答只有全部三库通过才可见 | missing | 0.701 s |
| 退款金额与期限 | 回答无法确认 | missing | 0.284 s |
| “我今天很开心” | 直接对话，无检索 | unavailable | 4.162 s |

这 6 次真实调用共观测到生成 6 次、嵌入 5 次、重排 0 次；生成提供方报告输入 3,056 Token、输出 211 Token。未配置计价数据，成本保持未测；本地调用不能换算成零成本。首次运行、模型加载和短样本会显著影响时延，以上不是稳定吞吐或 p95 结论。

此前另有一条冷启动验证：关于资料何时对用户可见的问题返回正确条件，HTTP 200，1 条证据，但缺少引用；输入 575、输出 82 Token，总时延 76.230 s。该条保留为单独诊断，不并入上表统计。

评审器使用同一 `llama3.1` 模型和 `rag-eval-semantic-rubric/v2`，不具备独立人工标注地位。对原子切换样本返回有证据支持、引用支持；对退款样本把拒答判为 `answer`。缺少审核真值的事实正确性、要点覆盖率、业务正确性均保留 `null`。这次发现说明不能用模型自评分替代人工校准。

## 主服务诊断

现有主服务未开启统一发布模式；其默认 Milvus 集合 `rag_documents` 有 42 条旧记录。初次探测使用 `llama3.1 / nomic-embed-text`、topK=5、阈值 0.1。响应显示 dense 候选为 0，Elasticsearch 词法候选为 5，实际上下文为《重构契丹早期史.epub》，并使用现有 SiliconFlow 重排配置。公共 HTTP 响应没有暴露完整的请求级提供方用量，该部分保持未知。

已用只读 PG、Milvus、ES 查询确认：这 42 条记录来自的 5 份旧文档均为 `retrieval_enabled=false`，与当前可检索文档白名单交集为 0；加白名单后 Milvus 实际 `count(*)=0`。ES 同 scope 共 697 行，包含旧样例；其中契丹书 645 行。旧样例未命中由可见性过滤解释，不是本次发现的召回缺陷。黑死病病原体样本在上下文不相关时仍输出了老鼠/跳蚤等知识，需作为忠实度人工复核候选。

随后从书籍当前版本的版权页导出作者“苗润博”、出版社“北京大学出版社”、出版时间“2024年2月”、ISBN“9787301347492”，生成 3 条 `needs-review` 草稿。前两个问题均检索到了版权页，字面事实核对通过；作者回答缺少引用，出版社/出版时间回答有 `[1]`。ISBN 请求返回 `409 EMBEDDING_INDEX_CHANGED`，服务端检查到请求模型与当前运行时不一致，整个补测脚本按失败退出。后续只读 health 显示当前模型为 `qwen3-embedding:latest / 4096`，而该批请求为 `nomic-embed-text / 768`。不能将 409 当作回答错误，也不能把变化前后的批次合并为冻结配置实验。

可见书籍的 645 条分块在另一个 4096 维集合；上述两个使用 768 维请求的成功问答实际由 ES 召回，未验证书籍的 dense 通道。书籍原始入库模型尚未从版本证据中核实，不仅凭维度推断模型。

按 health 返回的当前模型另发一条独立 ISBN 请求，未修改服务配置：HTTP 200，回答 `9787301347492`，版权页证据在召回与重排中均为第 1 位，进入上下文并被引用。实际使用集合 `ragidx_e90dbd90410f4e19b3ab21407d6ae67a`、4096 维，dense/lexical 各召回 5 条，SiliconFlow 重排生效；请求前后 health 模型配置相同，总时延 59.280 s。该条覆盖了真实 dense 与重排调用，但未冻结主服务全部配置与知识库，不作为 A/B 对照。

初版诊断的原始 JSON 摘要因 Milvus 返回对象字段顺序不同而报告 `corpusUnchanged:false`。原始报告未覆盖；补充核对按记录 ID 与对象键排序后，42 条记录前后完全一致，规范化摘要均为 `5b6e4910a79846fc312d5b4464b9c83a02091b3005a59a40006ba9b8d3c0aa52`。后续脚本已使用稳定摘要，并将 HTTP 失败、样本未跑满或快照变化计入失败退出码。

## 本次修复与代码验证

真实 `node --import tsx` 会把部分 TypeScript 命名导出包装在 `default` 下，导致原先只在注入依赖测试中通过的加载路径实跑失败。新增运行时模块导出归一化，并接入发布 runtime、CLI、评审器 lazy imports；保留真正命名导出的优先级。

- `pnpm test:rag-eval-completion`：87/87 通过，包含真实 tsx 子进程与禁止服务 IO 的 CLI 加载回归。
- 本轮文件 scoped ESLint 通过；代码复审与 TypeScript 专项复审通过。
- 全项目 `tsc --noEmit --incremental false` 未通过：当前无关 MiroFish 改动在 `config-planner.ts:24` 和 `simulation-policy.ts:55` 有类型错误；本次未修改这两个文件。

## 正式评测仍待完成

1. 核对隔离发布库 Neo4j 连接配置与封印身份，完成三库发布完整性验收。
2. 人工审核已导出的 3 条真实书籍问答草稿，扩展为 V2 基准集，补齐安全标注、独立业务真值及无答案/歧义/资料冲突标签。
3. 针对引用缺失和评审器拒答误分类，先建立人工标注与校准集，再决定提示词或模型调整。
4. 扩展多文档、多分块样本，实际覆盖召回、重排、证据齐全性与上下文截断。
5. 在同一冻结快照和评测集上运行 baseline/candidate，补齐定价与线上反馈回归；本次未执行正式 A/B。

## 原始证据

所有诊断产物位于 [rag-evaluation-live-20261105](.diagnostics/rag-evaluation-live-20261105/)。关键文件：

- [CLI 就绪](.diagnostics/rag-evaluation-live-20261105/cli-readiness.json)
- [发布语料快照](.diagnostics/rag-evaluation-live-20261105/published-corpus.json)、[6 条发布路径观测](.diagnostics/rag-evaluation-live-20261105/published-report.json)、[独立冷启动观测](.diagnostics/rag-evaluation-live-20261105/published-first-case.json)
- [真实评审模型结果](.diagnostics/rag-evaluation-live-20261105/judge-report.json)
- [主服务初次探测](.diagnostics/rag-evaluation-live-20261105/legacy-report.json)、[主库快照稳定性补充核对](.diagnostics/rag-evaluation-live-20261105/legacy-corpus-reconciliation.json)
- [主库可见性与库存诊断](.diagnostics/rag-evaluation-live-20261105/legacy-retrieval-diagnosis-9eabcc96-bb48-4e70-ab8b-779ff00b1dec.json)
- [当前版本版权页等前八块原文](.diagnostics/rag-evaluation-live-20261105/visible-khitan-reference-extract-9d2667ab-3e2a-4d6f-92be-fe4736c03b19.json)、[3 条待人工审核草稿](.diagnostics/rag-evaluation-live-20261105/visible-khitan-reference-draft-00ce66f5-9635-414a-9db5-202dd9e7874f.json)
- [可见资料补测与 409 原始结果](.diagnostics/rag-evaluation-live-20261105/visible-main-report.json)、[后续主服务模型健康信息](.diagnostics/rag-evaluation-live-20261105/main-health-after-visible.json)
- [按当前模型独立补测 ISBN](.diagnostics/rag-evaluation-live-20261105/visible-isbn-refreshed.json)
- [三库首轮只读核对](.diagnostics/rag-evaluation-live-20261105/three-store-reconciliation-cf8201a0-08ec-4ebe-8272-fe5088c19861.json)、[Neo4j 配置封印阻塞诊断](.diagnostics/rag-evaluation-live-20261105/three-store-reconciliation-diagnosis-7a9400d3-5a8d-4219-a9d9-e9dbd92e8b13.json)
