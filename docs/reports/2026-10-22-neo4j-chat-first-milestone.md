---
type: milestone-report
status: completed
date: 2026-10-22
completed: 2026-10-23
parent: 2026-09-09-rag-neo4j-production-gates-and-citations.md
---

# 普通聊天接入知识图谱：第一个里程碑验收

实施范围见 [里程碑计划](../plans/2026-10-22-neo4j-chat-first-milestone.md)，启用方法见 [运行说明](../runbooks/neo4j-chat.md)。权威 Sprint pointer 仍指向原生产门禁计划的 Work 阶段；本报告不代表整个生产 Sprint 完成。

## 已实现的链路

普通 Milvus/Agent 聊天根据问题组合已有语义检索与服务端固定 scope 的 Graph Lane。实体问题取一跳，关系问题最多两跳；关系保留真实主体、predicate、客体方向。只有每条边的支持片段实际进入最终模型上下文时才提供关系解释，裁剪后的证据不能继续享用完整路径的回答资格。图谱 off 不执行，shadow 不进入生成或引用。

正文编号按最终 served evidence 顺序绑定加密 locator。点击预览重新检查当前主体、tenant/corpus、原 graph/document 版本、PG 资产状态、Strong Milvus 全文与片段摘要、图谱删除状态和有效期。预览只读，不在冷启动时创建 Neo4j 索引或 Milvus collection；失败不使用缓存原文兜底。

Locator 使用共享稳定密钥的 AES-256-GCM，绑定 environment、audience、purpose、key ID、iat/exp/maxTTL/jti。旧验证密钥必须有有界退役配置。引用签发及 durable/IndexedDB 投影排除原始来源地址，避免签名 URL 或 userinfo 被新增持久化；点击授权后才取得来源显示。

聊天入口支持编号点击、原文片段、页码、关系依据和截断提示。身份明确失效时只清理引用，临时身份服务失败停用入口；页面、组件和存储共用服务端校准时间，时钟未知时保留 opaque handle 并禁用点击。

## 验证记录

| 验证 | 结果与边界 |
| --- | --- |
| 图谱、关系上下文、Agent、引用和 Milvus 组合 | 236/236 通过；后续来源隐私收紧后的 locator/preview 组合 22/22 通过 |
| Ask HTTP 全量 | 首轮 96/98，两个 durable 用例返回 500；闭集定向诊断 2/2 通过，冻结后完整 98/98 通过；来源隐私新增用例后最终 99/99 通过 |
| UI 与 IndexedDB | 最终相关组合 30/30 通过，其中本次引用 27 项；6 个来源隐私/异步持久化反例先全部失败，再转绿 |
| 实际 Chromium | 7/7，0 skip，0 pageErrors；真实 ChatMessage 与合成 API，非真实资料端到端 |
| 真实 Neo4j | 2 通过，1 跳过；隔离随机 tenant 的生命周期与真实 Cypher 一/两跳路径通过；既有 publication outbox 用例因未提供 TEST_DATABASE_URL 跳过 |
| 全仓 TypeScript | 最后竞态修复后的 noEmit、incremental=false 检查 exit 0 |
| ESLint | 图谱/Ask 范围 10 个源文件及引用后端无诊断；新 UI 块无诊断。已存在的 ChatMessage 6 errors/1 warning、page 32 errors/10 warnings、IndexedDB 2 errors 保留，未把全仓 lint 记为通过 |

首轮 durable 两项 500 在定向和完整后续运行中均未复现，原失败保留。与历史间歇失败相似不能证明同一根因，本次不作根因结论。测试使用合成内容；闭集诊断未输出原始问答、凭据或私有路径。

浏览器证据在 [.diagnostics/neo4j-chat-browser](.diagnostics/neo4j-chat-browser/result.json)，截图为合成资料，源文件哈希前后相同。真实数据库、HTTP 夹具与组件浏览器的结果分别成立，不能合并成生产端到端认证。

## 独立复审

已修复图谱通道身份、最终上下文裁剪、旧密钥退役、File/高出度关系来源映射、Neo4j 冷预览写入、服务端时钟和原始来源持久化问题。

明确失效的持久清理通过共享任务完成，不随身份 GET 的取消而丢失。新 GET 与启用新身份都等待清理；实际数据库写入按当前 partition、generation 及读取快照代次过滤整份会话，保留正文。延迟保存、旧分析快照和 focus 取消调度均有反例验证。

最终独立安全回归 38/38 通过；独立代码复核确认最后三个修复闭环，结论 APPROVE。本次范围无剩余 P1/P2。该结论不替代原生产门禁验收。

## 部署与使用边界

本次支持当前 corpus 已发布的单文档图谱。原图若没有与原始文档资产匹配的版本/片段映射，需要经正式入库链路重建或迁移后才能核验原文；不能用图内容摘要代替原始 source_hash。

本次未切换生产开关、自动激活现有用户图谱、提交或推送。运行环境需要配置引用密钥，并按现有生产门禁开启图谱 active。未执行三套真实存储加真实模型的生产全链路验证，跨文档聚合、社区总结和任意 Text-to-Cypher 留待后续里程碑。
