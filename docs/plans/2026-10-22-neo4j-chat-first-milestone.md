---
type: implementation-supplement
status: completed
date: 2026-10-22
completed: 2026-10-23
parent: 2026-09-09-rag-neo4j-production-gates-and-citations.md
---

# 普通聊天的单图实体、关系与原文引用里程碑

用户于 2026-10-22 授权按 `2026-10-22-neo4j-general-usage.md` 实现 U0～U2。当前权威 Sprint 保持原计划的 Work 阶段；本文件细化本次边界，不替换 pointer、不缩减原生产门禁，也不将局部完成算作整个 W8/W9 完成。

## 完成条件

- 服务端固定 scope 和已发布的单文档图谱；普通实体问题、1～2 跳关系问题进入可选图检索；模式 off 不访问图谱，shadow 不影响生成。
- Graph Lane 返回关系的主体、predicate、客体及支持来源；只有来源实际进入模型上下文的关系才用于解释，路径连通不当作因果。
- 同一聊天入口展示结构化引用；正文编号只绑定当次实际提供的合法证据。无编号、非法编号、无来源或缺配置有明确诊断。
- 点击受控内部预览重新授权，固定原 graph/document 版本，检查权威删除/失效状态；不返回客户端缓存原文作兜底。
- Locator 使用跨重启可解析的 AEAD token，绑定主体、environment、audience、purpose、key ID、iat/exp/maxTTL/jti；客户端只存句柄、最少显示信息和分区/TTL。
- 现有策略选择、语义检索和非图谱回答保持兼容；单元/HTTP/前端与安全反例覆盖，并进行独立复审。

## 本次任务

- [x] M1：图谱意图、普通策略组合及就绪诊断，保持 off/shadow 边界。
- [x] M2：Neo4j 与文件图谱的有向关系依据、1～2 跳路径和来源对应。
- [x] M3：模型实际上下文的关系支持筛选与编号引用指引。
- [x] M4：Locator、引用映射、重新授权预览和删除/版本检查。
- [x] M5：聊天中的引用点击、原文与关系展示、最小持久化和分区/TTL 清理。
- [x] M6：组合回归、类型/lint、独立功能与安全复审及运行说明。

## 实施边界

复用 GraphRetrievalPort、MiroFishGraphArtifactStore、RagEvidence、现有 context pack 和安全上下文。普通聊天首先使用现有单图；不实现跨文档聚合、社区全局总结或任意 Text-to-Cypher。不改生产开关，不自动激活用户已有图谱，不提交或推送工作树。

测试先红后绿；涉及引用授权按 L4 验证负例。真实数据库/浏览器验证与合成夹具证据分开报告，未执行项不声称通过。其他会话的 staged/unstaged 改动保留。

## 实际证据

完整命令、测试边界及历史失败记录见 [本次验收报告](../reports/2026-10-22-neo4j-chat-first-milestone.md)，使用前置见 [运行说明](../runbooks/neo4j-chat.md)。本次后端组合 236/236、隐私收紧后 locator/preview 22/22、最终 Ask 99/99、UI 相关组合 30/30、Chromium 7/7、独立安全回归 38/38 通过；最终全仓 TypeScript exit 0。真实 Neo4j 2 通过、1 因未配置独立 PG 测试连接而跳过。末次异步清理/回写和来源隐私反例先红后绿，独立代码与安全复核无本次范围内剩余 P1/P2。全仓既有 lint 问题及首次 durable 500 保留记录，未伪记为全绿。
