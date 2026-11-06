# 对话路由离线评测

本评测只运行分类，不执行模型候选中的动作，不访问知识库，也不发送用户问题。输入固定为仓库中人工合成的 [标注样例](../../src/lib/rag/eval/fixtures/conversation-routing-v1.json)；输出包含样例 ID、聚合指标、数据集 SHA-256，不包含问题文本或模型响应。请勿把真实用户输入或敏感内容加入 fixture。当前 18 条是回归与流程样例，不足以衡量开放域准确率，也不是独立盲测集。

```powershell
node --test src/lib/rag/eval/conversation-routing-eval.test.mjs
node scripts/eval-conversation-routing.mjs rules
node scripts/eval-conversation-routing.mjs mock-candidate
node scripts/eval-conversation-routing.mjs ollama-candidate
```

`rules` 是确定性规则基线。`mock-candidate` 使用 fixture 中有意设计的模拟模型响应，用于验证评测和误跳过统计，不能作为真实模型效果。`ollama-candidate` 将人工合成问题发送给本机 Ollama，需自行准备并启动所选模型；默认模型 `qwen2.5:0.5b`，可用 `FAST_LLM_MODEL` 指定，`OLLAMA_BASE_URL` 仅允许本机 loopback。需要启用语义路由且 `MODEL_PROVIDER` 未设置或为 `ollama`。命令不会启动或预热服务，不会自动保存报告。

候选模式是在规则未直接识别时假设采纳模型输出，目的是测量候选的潜在风险；当前生产路由并不因该候选跳过检索。`noCandidate` 包含规则排除、模型超时、不可用及无效响应，不能单独据此判断超时次数。针对可用性和超时率，需要补充可区分这些状态的分类器接口或独立观测。

`knowledgeSkip` 是需知识库的问题被预测为直接回答的数量及比例。`routePrecision` / `routeRecall` 只检查 direct 路由：分母分别是预测 direct 和标注 direct 的数量，分子为两者都为 direct 的数量。`strictPrecision` / `strictRecall` 分母相同，但分子还要求动作顺序和全部参数严格匹配。`actionExact` 以路由正确的 direct 样例为分母，检查动作和参数是否完全匹配；复合问题漏掉一项即失败。空分母输出 null。分类错误仅输出 ID 和错误类别。`latencyMs` 是逐题串行的分类耗时，包含规则快路径，首题不等于冷启动；真实测试应另行记录模型版本、机器、模型是否已驻留和请求负载，分别重复冷/热测量。

下一步要用更大的人工标注语料，并按问题来源或改写家族划分开发集与独立盲测集，覆盖方言、错字、混合意图、隐含文档引用和时区/算式参数。分别报告各类样本数和置信区间；只有在真实部署环境中测量的结果才能支持性能和质量结论。现有测试不能替代权限隔离、真实知识库和端到端验收。

## 多轮会话对比

```powershell
node src/lib/rag/eval/run-conversation-multiturn.mjs rules
node src/lib/rag/eval/run-conversation-multiturn.mjs shadow
node src/lib/rag/eval/run-conversation-multiturn.mjs active
```

这三个目标分别运行确定性路由、模型分类候选及当前闲聊处理函数；后两者只允许本机 Ollama。输入是 13 条人工合成样例，包含改名、撤回、冲突、助手虚构身份、混合问题与历史注入；输出仅含匿名 ID、哈希和聚合数字，不保存或输出对话正文。`knowledgeSkip` 衡量标注需知识库却进入闲聊的样例；`sourceExact` 检查预期用户轮次，`invalidUserSources` 检查引用轮次角色，`omittedRequests`、`verifiedIdentityClaims` 是适配器的有限规则检查，并非完整的生成回答语义评价。`active` 仅调用闲聊函数，不包含完整 HTTP、鉴权或 RAG，`shadow` 使用未经授权的候选，不等于生产决策。输出中的分类错误及计时只适用于小规模合成集，不能代替独立盲测、人工逐条核查或冷/热及并发负载测试。
