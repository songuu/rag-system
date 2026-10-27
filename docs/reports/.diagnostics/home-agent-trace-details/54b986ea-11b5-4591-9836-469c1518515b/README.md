# 首页 Agent 步骤详情验证

真实 localhost:3000 首页，启用 Agent 后提交问题，展开 Trace Viewer，再逐项点击四个步骤。未模拟服务响应，原有文档状态未修改。

根因：旧详情组件只显示 input/output，而 canonical Agent 仅记录状态、耗时及部分 metadata；模型步骤缺少公开摘要，持久化回放也清理 metadata，导致展开后空白。

修复：服务端记录实际证据数量、通道数、模型调用序号、工具调用次数和回答字符数；持久化仅保留明确的计数及停止原因。前端展示执行概览，旧记录没有保存详细输入输出时明确说明。

| 步骤 | 实际耗时 | 接口摘要与页面逐项匹配 |
| --- | --- | --- |
| retrieve_original | 321ms | {"evidenceCount":3,"laneCount":2} |
| agent_model_request_tool | 108758ms | {"modelCallIndex":1,"toolCallCount":1,"evidenceCount":3} |
| read_scoped_rag_context | 0ms | {"evidenceCount":3} |
| agent_model_answer | 1229ms | {"modelCallIndex":2,"toolCallCount":0,"evidenceCount":3,"answerCharacterCount":49} |

本次模型：{"llm":"llama3.1","embedding":"qwen3-embedding:latest"}。模型第一次调用耗时较长，表中为实际观测值；没有用模拟耗时覆盖。

211 项 Agent、时间线、持久化与问答回归测试通过，TypeScript、ESLint 和补丁格式检查通过。中间一次旧的最小 checkpoint 用例返回 500，追加失败诊断后完整复跑通过，未复现原因。

原始接口响应留在临时目录；此目录仅保存不含令牌的验证结果和四张步骤截图。

截图：[retrieve_original](retrieve_original.png)、[agent_model_request_tool](agent_model_request_tool.png)、[read_scoped_rag_context](read_scoped_rag_context.png)、[agent_model_answer](agent_model_answer.png)。
