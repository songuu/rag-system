# RAG 评测：真实链路、质量标注与回归

本流程把“检索到了哪些资料”“答案是否正确且有依据”“用户最终得到什么结果”分开观察。离线单元测试验证评测器的计算和边界；真实准确率必须通过人工审核基准集，在实际发布知识库与模型上运行后才能报告。

## 支持范围与当前边界

| 优先顺序 | 能力 | 当前可用范围 |
| --- | --- | --- |
| 1 / P0 | 真实 RAG 入口 | 进程内调用真实 Ask `POST`，使用 `NextRequest`、实际鉴权和发布知识库；当前仅支持统一发布 `active` 与本地 Ollama。 |
| 2 / P0 | 人工审核基准集 | V2 数据集绑定证据、版本、作用域、策略和安全标注；运行前要求显式人工审核。工具不替人生成审核结论。 |
| 3 / P0 | 配置固定 | 实验契约记录数据集/语料摘要、实现、提示词、模型 revision、索引、检索、重排、上下文和缓存配置；运行前后重新观察，漂移会使执行失败。 |
| 4 / P1 | 分阶段检索评分 | 通用目标支持 `candidates`、`reranked`、`context` 的 Recall@K、MRR@K、nDCG@K，以及显式证据组完整性。缺少阶段观测时保留 `null`。 |
| 5 / P1 | 确定性事实核对 | 对有明确标签的数值、金额、日期、状态作保守核对；不能明确提取时返回 `unknown`，不把子串包含当正确。 |
| 6 / P1 | 语义质量与校准 | 可选独立评审模型分别评分，并输出逐项结论/证据；校准工具报告与人工标签的差异和覆盖率。 |
| 7 / P1 | 业务正确性 | 独立业务参考答案加时间/用户条件，区别于对检索资料的忠实度；缺少真值或适用性不明确时不出业务正确性分数。 |
| 8 / P2 | 时延、用量、成本 | 计量模型区分提供方实测、部分计量、估算和缺失；按阶段汇总时延和可观测用量；费用估算要求显式费率。 |
| 9 / P2 | 反馈回归 | 从显式导出的 Trace、反馈和语料快照生成待审草稿，人工补标后才可导出执行集，保留审核摘要与来源。 |

统一发布 Ask 当前没有重排步骤，因此实际 live 报告的 `reranked` 为未观测，不生成虚构的重排收益。`searchResults` 是发布检索入口暴露的融合候选列表，不是各路 ANN/BM25 的原始完整候选集。若要评估更早的各路召回，需要由真实检索入口提供对应阶段观测。

真实 live 入口使用进程内 `AsyncLocalStorage` 采集已接线的提供方调用：发布问答和文本模型适配器的 generation 调用、`conversation-chat` 的分类/闲聊回复、`semantic-conversation-router` 的候选分类，以及发布 embedding 的 `/api/embed` 请求。`/api/tags`、`/api/version`、模型复制和契约核验不计作 embedding。Token 汇总 generation 返回的 LangChain `usage_metadata` 或 Ollama 原始 `prompt_eval_count/eval_count`；原始 HTTP 响应仅读取有界 clone，原 Response 和产品 JSON 保持不变。某次调用缺失字段时降为 `partial` 或 `unavailable`，不会填造完整 Token。

采集结果通过 `WeakMap` 关联原始 `Response`，不向产品 API JSON 添加评测字段。并发 Ask 相互隔离，取消或结束后的迟到结果不进入后续请求。当前发布入口没有 rerank，因此观测到的重排调用次数为 0；没有 generation 调用时可确认 Token 为 0，有调用时必须依赖提供方的实际字段，不能默认补零。`usageObservation` 的总墙钟计时仅包实际 Ask `POST`，不含此前源码/模型/视图预检；generation 阶段耗时采用重叠调用的墙钟并集，避免并行调用时间累加超过总时长。其他尚未接线的目标仍应按未计量解读，优先读取 `usageObservation` 与 `summary.measurements` 的来源和覆盖率。

## 先准备真实、可审核的 V2 数据集

现有 `RagDatasetBuilder` 生成的 JSON 是 V1 草稿。它可以帮助整理问题、原文区间、参考答案和答案要点，但不能直接充当已审核的真实 live 基准集。

准备步骤：

1. 选定实际发布知识库快照，保存原始 chunk 的 `evidenceId`、`documentId`、`documentVersion`、`source`、`content`、租户、语料库和可信级别。必须与 Ask 实际返回的身份和原文一致，不能只复制文件名或重建自定义 chunk ID。
2. 语料快照需包含预期可能检索到的候选资料，而不只是 gold 片段。真实入口若返回快照外的候选或内容变更，评测会失败，不能把它悄悄忽略。
3. 将 `schemaVersion` 显式改为 `rag-eval-dataset/v2`，补齐每题 `scope`、`allowedPolicies`、`allowedLanes`、`securityExpectations`。允许列表和禁止项是审核标签，不能从历史输出自动当作正确答案。
4. 人工核对问题是否可独立理解，gold 是否足够支持参考答案，`spans` 是否确为原文字符区间，以及要点是否含否定、条件和单位。
5. 分别加入可回答、无答案、应澄清、资料冲突和多资料样本。用 `expectedDisposition: "answer" | "abstain" | "clarify"` 区分动作；后两者的 `expectedAbstain` 均为 `true`，且 `goldEvidence` 必须为空。
6. 审核完成后才把该题的 `needs-review` 标签替换为 `human-reviewed`，记录真实审核人和时间。代码只检查声明与完整性，不认证审核人的身份，也不能证明人工确实审核过。

下面是**纯合成的结构示例**。它刻意保留 `needs-review`，不能通过 live 冻结。实际使用时替换为真实发布资料及其身份，不能把示例改个标签当成真实样本。

```json
{
  "schemaVersion": "rag-eval-dataset/v2",
  "datasetId": "synthetic-policy-example",
  "datasetVersion": "1",
  "corpus": [
    {
      "evidenceId": "example-policy-chunk",
      "documentId": "example-policy",
      "documentVersion": "example-revision-1",
      "tenantId": "example-tenant",
      "corpusId": "example-corpus",
      "trustLevel": "reviewed",
      "source": "synthetic-policy.txt",
      "content": "退款期限：30天。退款金额：100元。生效日期：2026-11-01。订单状态：已完成。"
    }
  ],
  "cases": [
    {
      "id": "policy-summary",
      "query": "政策规定的退款期限、退款金额、生效日期和订单状态分别是什么？",
      "tags": ["synthetic", "needs-review"],
      "goldEvidence": [
        {
          "evidenceId": "example-policy-chunk",
          "relevance": 3,
          "spans": [{ "startOffset": 0, "endOffset": 44 }]
        }
      ],
      "expectedAnswer": {
        "referenceAnswer": "退款期限为30天，退款金额为100元，生效日期为2026-11-01，订单状态为已完成。",
        "requiredFacts": [["30天"], ["100元"], ["2026-11-01"], ["已完成"]]
      },
      "expectedAbstain": false,
      "expectedDisposition": "answer",
      "scope": {
        "tenantId": "example-tenant",
        "corpusId": "example-corpus",
        "allowedTrustLevels": ["trusted", "reviewed", "external"]
      },
      "allowedPolicies": ["milvus-2step"],
      "allowedLanes": ["document-search"],
      "securityExpectations": {
        "forbiddenEvidenceIds": [],
        "forbiddenAnswerPatterns": ["SYNTHETIC_PRIVATE_SECRET_CANARY"]
      },
      "requiredEvidenceGroups": [["example-policy-chunk"]]
    }
  ]
}
```

`spans` 使用 JavaScript 字符串偏移量，左闭右开。相关性 `relevance` 是 1（相关）、2（重要）、3（直接回答）。`requiredEvidenceGroups` 外层表示必须齐全的证据组，内层是同一组可替代的证据 ID；完整性要求每组至少命中一项，按对应阶段前 K 条判断。若没有显式标注证据组，完整性为未标注，不推断所有相关片段都不可替代。

默认真实入口从认证上下文创建作用域，允许 `trusted/reviewed/external`，不会接受评测输入自行授权租户。数据集作用域必须与真实认证范围完全一致；跨租户或额外收窄可信级别不会由适配器伪造执行。

## 冻结、离线校验和运行

先确认已有 `.env.local` 和项目依赖。真实运行要求：

- `RAG_UNIFIED_PUBLICATION_MODE=active`，回答与 embedding 提供方均为 Ollama。
- Ollama 位于 loopback 地址；回答模型、可选评审模型、启用语义路由时的 `FAST_LLM_MODEL` 都已安装，并可从 `/api/tags` 核实 digest。
- PostgreSQL 可读取认证范围内的发布视图，Milvus/Elasticsearch 发布读服务及其授权已就绪。
- 发布视图非空，所有文档使用一致的内容寻址 embedding alias、revision、维度和索引 schema。
- 单租户 token 模式使用 `RAG_EVAL_TOKEN` 或 `RAG_SINGLE_TENANT_TOKEN`；不要将 token 写进基准集、契约、命令参数或报告。

适配器不会复制模型、创建发布版本或自动修复数据库。真实请求通过 Ask 的鉴权路径执行。每次观测/调用有 180 秒上限，不重试；超时和身份漂移按失败处理。

先用已审核真实数据集准备 `review.json`：

```json
{
  "reviewer": "填写实际审核人",
  "reviewedAt": "2026-11-05T09:00:00.000Z"
}
```

日期与名字只是格式示例，必须填本次真实审核信息。冻结同时会只读核实当前发布视图、模型 digest、源码与配置，不是仅把用户输入抄进 JSON。

```powershell
pnpm rag:eval:live --freeze --dataset ./reviewed-v2.json --review ./review.json --model MODEL --top-k 5 --output ./experiment-baseline.json

pnpm rag:eval:live --validate-only --dataset ./reviewed-v2.json --contract ./experiment-baseline.json

pnpm rag:eval:live --dataset ./reviewed-v2.json --contract ./experiment-baseline.json --output ./run-baseline.json
```

将 `MODEL` 替换为本机已安装的回答模型标签。执行模式不需要 `--run` 开关：不带 `--freeze` 或 `--validate-only` 就是运行。`--validate-only` 只验证本地数据和契约摘要，不证明实时服务可用。

可直接使用等价 Node 入口，显式在导入运行模块前装载环境：

```powershell
node --env-file=.env.local --import tsx scripts/run-live-rag-eval.mjs --help
```

所有输出使用新文件名，已有文件不会覆盖。live 运行失败样本会保留失败信息，CLI 返回非零退出码；不要只用成功子集的均值宣称优化收益。

## 质量 sidecar 与业务上下文

质量标注与基础数据集分开保存，避免把评审规则传入待评 RAG。`datasetSha256` 必须填冻结契约或离线校验输出的实际数据集摘要；下面的全零摘要只是占位符，会在真实运行中被拒绝。

`quality.json` 的完整小示例：

```json
{
  "schemaVersion": "rag-eval-quality/v1",
  "datasetSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "cases": {
    "policy-summary": {
      "expectedDisposition": "answer",
      "referenceAnswer": "退款期限为30天，退款金额为100元，生效日期为2026-11-01，订单状态为已完成。",
      "requiredFacts": [["30天"], ["100元"], ["2026-11-01"], ["已完成"]],
      "facts": [
        { "id": "deadline", "label": "退款期限", "kind": "number", "expected": 30, "unit": "天" },
        { "id": "amount", "label": "退款金额", "kind": "amount", "expected": 100, "unit": "元", "tolerance": 0.01 },
        { "id": "effective-date", "label": "生效日期", "kind": "date", "expected": "2026-11-01" },
        { "id": "order-state", "label": "订单状态", "kind": "status", "expected": "已完成", "aliases": ["完成"] }
      ],
      "businessReferenceAnswer": "在本示例独立业务真值中，中国大陆标准用户的已完成订单仅适用14天退款期限，其余条件另行核对。",
      "applicability": {
        "validFrom": "2026-11-01",
        "validUntil": "2026-12-31",
        "attributes": { "region": ["CN"], "tier": ["standard"] }
      }
    }
  }
}
```

`quality-context.json`：

```json
{
  "asOf": "2026-11-05T09:00:00.000Z",
  "userAttributes": { "region": "CN", "tier": "standard" }
}
```

该例刻意区分旧资料的“30天”和独立业务真值的“14天”，用于说明维度，不能用于真实业务结论。业务参考答案应来自独立维护、人工核对的权威真值；来源、审核依据和有效期应保留在标注记录中，不应简单复制待评检索结果。缺少 `asOf` 或用户属性时，适用性可为 `unknown`；明确过期或条件不符时为 `inapplicable`。这两种情况下 `businessCorrectness` 不计分。

确定性核对要求答案含能匹配 `label` 的明确分句；`clause` 可额外指定文字定位。它不是通用语义理解：例如同一句里混有多个不同数值、条件或范围时，会保守判未知或冲突。没有匹配标签不等于回答错误。数值不会因“100”出现在“1000”里就算正确。

只运行规则评分：

```powershell
pnpm rag:eval:live --dataset ./reviewed-v2.json --contract ./experiment-baseline.json --quality ./quality.json --quality-context ./quality-context.json --output ./run-rules.json
```

启用评审模型时，**冻结和运行必须同时指定同一个 `--judge-model`**：

```powershell
pnpm rag:eval:live --freeze --dataset ./reviewed-v2.json --review ./review.json --model MODEL --judge-model JUDGE --output ./experiment-judge.json

pnpm rag:eval:live --dataset ./reviewed-v2.json --contract ./experiment-judge.json --quality ./quality.json --quality-context ./quality-context.json --judge-model JUDGE --output ./run-judge.json
```

评审模型分别输出 `[0,1]` 分数：`factualCorrectness`、`relevance`、`keyPointCoverage`、`citationEntailment`、`faithfulness`、`businessCorrectness`。缺少所需资料时维度为 `null`。结论的 `evidenceIds` 只能引用送入评审的证据；正向引用支持分不能使用答案未引用的证据。模型评分仍是辅助判断，需要人工校准。

基础 `requiredFactCoverage` 仍是文本要点覆盖，不是语义事实正确率。引用编号的 `reference-only` 验证只说明引用身份/编号，不证明对应结论被支持；不能据整段引用伪造精确原文跨度的 precision、coverage 或 IoU。需要结合逐项结论、证据语义和人工审核判断支持度。

语义 rubric `rag-eval-semantic-rubric/v2` 还会返回 `observedDisposition`（answer / abstain / clarify / null）。真实入口缺少结构化决策时，可以用它辅助统计错误拒答和应拒答却作答；这类结果标记 `quality.disposition.source: "judge"`，需要人工校准，不会改写运行时决策或把未知状态当作错误。结构化决策优先于评审推断。

## 评审模型的人工校准

先用与最终评测集不重叠的一批校准题，分别保存同题、同维度的人类分数和模型分数。模型 revision、rubric 和人工标注方法应一起记录；不要在留出评测集上反复调评分规则。

`calibration.json` 的合成格式示例：

```json
{
  "schemaVersion": "rag-eval-judge-calibration/v1",
  "judgeId": "示例judge-id与实际revision记录",
  "calibrationCaseIds": ["calibration-policy-1"],
  "evaluationCaseIds": ["policy-summary"],
  "judgeScores": [
    { "caseId": "calibration-policy-1", "dimension": "factualCorrectness", "score": 0.7 },
    { "caseId": "calibration-policy-1", "dimension": "citationEntailment", "score": null }
  ],
  "humanScores": [
    { "caseId": "calibration-policy-1", "dimension": "factualCorrectness", "score": 0.8 },
    { "caseId": "calibration-policy-1", "dimension": "citationEntailment", "score": 0.9 }
  ],
  "tolerance": 0.1
}
```

```powershell
pnpm rag:eval:calibrate --input ./calibration.json --output ./calibration-report.json
```

输出包含 `inputSha256` 和 `calibration` 下的 `pairedDimensions`、`labelledDimensions`、`coverage`、`meanAbsoluteError`、`agreementWithinTolerance`。配对数是“题目 × 维度”的观测数；缺失模型分数不会被当作 0。工具报告一致性，不自动学习新评分器，也不会仅因运行过校准就把任意 live 报告标记为“已校准”。应核对模型 revision/rubric，并保留校准报告作为发布评审依据。

## 从线上反馈建立回归样本

先显式导出 Trace 和用户反馈，连同当时的版本化语料快照写成 `rag-feedback-export/v1`。工具不自动连接生产日志，也不把低分反馈或历史回答当作参考答案。

输入结构示例，`corpus` 使用前面 V2 示例中的完整文档结构：

```json
{
  "schemaVersion": "rag-feedback-export/v1",
  "datasetId": "feedback-regression",
  "datasetVersion": "1",
  "snapshotId": "实际知识库快照标识",
  "snapshotVersion": "实际快照版本",
  "corpus": [
    {
      "evidenceId": "example-policy-chunk",
      "documentId": "example-policy",
      "documentVersion": "example-revision-1",
      "tenantId": "example-tenant",
      "corpusId": "example-corpus",
      "trustLevel": "reviewed",
      "source": "synthetic-policy.txt",
      "content": "退款期限：30天。"
    }
  ],
  "traces": [
    {
      "traceId": "example-trace-1",
      "query": "退款期限是多少？",
      "answer": "退款期限：60天。",
      "snapshotId": "实际知识库快照标识",
      "snapshotVersion": "实际快照版本",
      "evidenceIds": ["example-policy-chunk"],
      "scope": {
        "tenantId": "example-tenant",
        "corpusId": "example-corpus",
        "allowedTrustLevels": ["trusted", "reviewed", "external"]
      },
      "feedback": { "value": -1, "comment": "请核对期限。" }
    }
  ]
}
```

```powershell
pnpm rag:eval:regression prepare --input ./feedback-export.json --output ./feedback-draft.json
```

输出草稿的 `annotation` 和 `review` 初始为 `null`。相同 Trace 的精确重复会去重，冲突的重复 Trace 会报错。每个 Trace 必须明确绑定输入快照；无法把当前快照冒充历史快照。

审核人读取草稿中的实际 `cases[].id`，创建 `human-reviews.json`：

```json
{
  "schemaVersion": "rag-feedback-review/v1",
  "reviews": [
    {
      "caseId": "替换为草稿里的实际case-id",
      "reviewer": "填写实际审核人",
      "reviewedAt": "2026-11-05T09:00:00.000Z",
      "annotation": {
        "disposition": "answer",
        "goldEvidence": [
          { "evidenceId": "example-policy-chunk", "relevance": 3, "spans": [{ "startOffset": 0, "endOffset": 9 }] }
        ],
        "expectedAnswer": { "referenceAnswer": "退款期限为30天。", "requiredFacts": [["30天"]] },
        "allowedPolicies": ["milvus-2step"],
        "allowedLanes": ["document-search"],
        "securityExpectations": {
          "forbiddenEvidenceIds": [],
          "forbiddenAnswerPatterns": ["SYNTHETIC_PRIVATE_SECRET_CANARY"]
        }
      }
    }
  ]
}
```

若审核决定为 `abstain` 或 `clarify`，填空 `goldEvidence: []`、明确 `reason`，不填 `expectedAnswer`，并仍补齐策略/通道/安全约束。

```powershell
pnpm rag:eval:regression review --input ./feedback-draft.json --annotations ./human-reviews.json --output ./feedback-reviewed.json

pnpm rag:eval:regression export --input ./feedback-reviewed.json --output ./feedback-regression-v2.json
```

只有全部保留题目都完成审核才能导出执行集。修改问题、观测、标注、语料快照或审核身份后，审核摘要会失效，需要重新审核。导出包含 `regressionProvenance`，保存 Trace、快照、审核人、时间和摘要。审核摘要是本地防止误用旧标注的绑定，不是审核人身份认证或生产数据来源认证。

## 计量与费用的读取

Token 的 `measurement` 分为 `provider`、`partial`、`estimated`、`unavailable`；成本分为 `provider`、`configured-estimate`、`unavailable`。`null`、字段缺失和覆盖率 0 表示未计量，不表示免费或零调用。提供方 Token 与估算 Token 分开汇总，部分计量不会混入完整 Token 总量。

使用显式 `--pricing pricing.json` 时，文件格式为：

```json
{
  "inputUsdPerMillion": 0.2,
  "outputUsdPerMillion": 0.8,
  "version": "示例费率版本；使用前替换为真实计价依据"
}
```

这些数字仅演示格式。当前估算只计算 generation 费用，需有完整输入/输出 Token；不能把它冒充 embedding、rerank 或全链路账单。Ollama 本地推理也不能因没有云账单就自动写成 0 成本。

```powershell
pnpm rag:eval:live --dataset ./reviewed-v2.json --contract ./experiment-baseline.json --pricing ./pricing.json --output ./run-priced.json
```

优先检查 `summary.measurements` 中各阶段的 `observedCount`、`coverageRatio`、计量来源与成本范围，再解释 P50/P95、Token 或费用。如果真实 Ask 没有暴露相应计量，提供费率也不能补造 Token。

## 比较优化前后

先为两组实验声明同一组 `variablePaths`，其余配置必须保持一致。允许的顶层变量为：

`implementationSha256`、`promptSha256`、`model`、`embedding`、`index`、`retrieval`、`rerank`、`context`、`cache`。

例如仅更换回答模型，可在两次冻结时均声明 `--vary model`；保持知识库、问题集、质量 sidecar、用户上下文、评审模型和 rubric 一致。两份实际报告可导入 `/rag-evaluation` 页面查看配对对比。

不能通过 `--vary` 跳过当前运行身份核验：它只声明“跨两次已冻结运行允许比较的变量”。每次运行仍必须匹配自己的完整契约。

具体约束：

- 数据集或语料快照不同，不能算同一问题集上的优化差值。
- 修改提示词也会改变源码摘要；只声明 `promptSha256` 不足以忽略实现变更，需要在实验设计中同时明确实现因素。
- 环境摘要位于 `model.parameters.environmentSha256`，相关配置变化可能同时改变 `model` 因素。不要为了让报告可比较而手改摘要；应重新冻结并说明实验变量为何变化。
- `model` 是顶层因素，放开它也放开其中参数的差异；应人工检查实际变化是否只有预期模型，特别是回答、路由、评审模型及相关环境。
- 当前展示层仍要求相同 TopK。即使契约声明 `retrieval` 为变量，TopK 不同的报告也不会展示可比差值；比较检索算法时先固定 K。

报告还保存 `configuration.evaluatorImplementationSha256`、标注与业务条件摘要、评审模型 revision/rubric 和显式价格口径。评分器实现或这些评分输入变化时，面板拒绝直接计算优化差值。CLI 在最后一题评审完成后再次核验运行时与评分器身份，避免最后一次评审期间的漂移漏检。

在准备审核数据前，可先执行只读就绪检查：

```powershell
node --env-file=.env.local --import tsx scripts/run-live-rag-eval.mjs --check-runtime --model MODEL
```

当前工作区的就绪检查因 `RAG_UNIFIED_PUBLICATION_MODE` 未设置而返回 `unsupported-runtime`。此结果只说明 live 强版本评测入口尚未就绪，不代表现有旧版问答不可用；工具不会为了评测自动切换发布模式、迁移知识库或伪造审核记录。
- 标注、上下文、评审模型/rubric或计量覆盖不一致，以及执行失败，都会影响可比性。不要因失败样本退出均值就报告提升。
- 资料忠实、业务正确、少拒答、低时延和低成本分别报告；任何单项改善都不能替代端到端业务目标。

## 验证与交付证据

```powershell
pnpm test:rag-eval-completion
```

该命令运行本次新增评测能力的定向自动测试，不是一个新的准确率指标，也不访问真实知识库来生成业务成绩。测试通过后仍需保存：人工审核基准集、审核声明、冻结契约、质量标注/上下文、实际运行报告，以及使用评审模型时对应的校准报告。

未运行真实 Ollama 与发布数据库时，应明确报告“实现与离线验证完成，真实业务准确率未测”。模拟 fixture、离线单测、运行器成功启动，以及报告中的声明字段，都不能单独作为真实准确率已达标的证据。
