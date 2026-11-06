# 文本模型调用边界

本层用于单次文本生成；当前默认实现仍是现有 LangChain 模型工厂，没有引入 Pi。

## 责任

- models/text-model.ts 定义框架无关的消息、调用、结果、用量与错误合同。
- models/langchain-text-model.ts 转换 LangChain 响应：保留字符串；数组响应只提取文本块，不序列化非文本推理块或任意 provider metadata。
- model-config.ts 的 createTextModelClient 复用现有模型选择、凭据、超时及重试策略；createLLM 保持兼容。
- MiroFish 的 createTextModelClientFromOverride 复用原有 override 解析，不另建配置中心。

调用方提供静态 operation 名称和可选 AbortSignal。调用前检查取消，将信号传给 provider，并在返回后再次检查，防止接受已取消的迟到结果。provider 的 AbortError 保持原样；普通调用失败包装为 TextModelError，带 operation/code/cause，但公共 message 不包含 provider 原始文本。

这不是抢占式执行器：若 provider 完全忽略信号，等待何时结束仍取决于 provider 和工厂的传输超时。本层不启动额外重试，不另建 deadline、任务调度或后台执行循环。

结果包含 text、stopReason 和 usage。缺失用量标记 unavailable，部分用量标记 partial；零是有效测量值，不补造缺失 token 数。stopReason 是观测字段，是否接受截断结果仍是领域策略。文本接口拒绝工具请求，不能用于执行 Agent 工具循环。

## 当前消费者

- MiroFish ReportAgent 的 generateReport/chat：保留报告上下文、JSON 领域解析、固定安全回退与返回字段。
- MAIC BaseAgent.respond：保留角色、发言归一化和普通 provider 故障的领域回退；显式取消向外传播。

消费者可以注入 TextModelClient，测试无需连接模型服务。现有调用签名兼容，末尾可选 options 可传 signal。调用方未传信号时，不会自动拥有 HTTP 生命周期取消能力。

## 扩展边界

新实现应满足同一消息、文本、取消和用量合同，并通过相同测试。先验证真实第二种实现的需求再接入。当前未迁移多模态、stream、结构化原生协议或受限 Agent runtime；它们继续使用既有路径，避免丢失 provider 能力和 RAG 证据/安全合同。

RAG Kernel、publication 视图、证据、引用、缓存、durable、课堂调度与仿真状态仍由各业务模块负责。

## 验证

运行 pnpm test:model-client。该入口已加入 test:model-runtime；测试使用 fake provider，覆盖工厂接线、消息、文本块、部分用量、取消、错误、工具请求拒绝和业务回归。
