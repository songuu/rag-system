# MiroFish 上游集成说明

本工作台对照 [MiroFish 固定版本 7657031](https://github.com/666ghj/MiroFish/tree/7657031ac01184afe2cb220f5ee3545573b5e843) 实现用户功能，沿用项目现有 Next.js、模型适配器、PostgreSQL 和 Neo4j。上游来源为 `666ghj/MiroFish`，许可证为 AGPL-3.0；既有代码中的来源注释保留。

截至本次核对，最新 release 仍为 v0.1.2。相对上次基线 b5b53acc 的四次提交只更新 star-history 数据及图片，因此这次主要补齐上次选择性移植留下的功能缺口。[对比记录](https://github.com/666ghj/MiroFish/compare/b5b53acc57189a4a42e44a23e149dc655c98fe82...7657031ac01184afe2cb220f5ee3545573b5e843)

## 使用入口

进入 `/mirofish` 创建项目，可以一次上传 PDF、Markdown、TXT，再依次完成图谱、环境、模拟、报告和交互。文件支持 UTF-8、带 BOM 的 UTF-16，以及 GB18030；最多 10 个文件、合计 50 MiB，抽取文本仍遵守现有请求预算。解析、超限、模型输出和状态保存失败都会显式显示。

环境准备会保存任务进度、人设、所选实体和生成配置。人设默认包含性格、观点、示例发言，并保持图谱实体 UUID。配置中的虚拟时间、角色活跃时段、种子事件、平台推荐及行为参数参与实际运行。

运行支持开始、暂停、恢复、停止、重新运行；保存每轮提交后的快照、行为和角色观察。可按平台、角色和轮次筛选，导出快照、行为 CSV、配置与平台人设。图谱侧栏显示原文图谱和独立的模拟观察，支持分屏、图谱和工作区三种布局。

报告会规划目录，逐章执行有预算的研究循环，调用 `quick_search`、`panorama_search`、`insight_forge` 和 `interview_agents`。目录、已完成章节、工具结果、日志和来源均保存，可恢复、重生成和下载。交互支持报告问答、单人采访、角色子集和逐人问卷，按对象保留会话与来源。

首页历史按真实模拟运行展示，同一项目可以有多次运行。运行冻结自己的需求、种子文件信息、图谱版本和运行批次，重启同一模拟后的会话也不会串到上一个批次。历史深链形式为 `/mirofish/console/<projectId>?simulationId=<id>&reportId=<id>&step=4`；历史模式不开放修改当前项目的前两阶段。界面语言切换保存在浏览器中。

## 运行边界

- 模拟引擎是当前项目的原生实现，界面明确标注；没有安装或冒充 CAMEL/OASIS，也不连接真实社交账号。
- 部署模式使用现有 PostgreSQL `object_blobs` 保存模拟、准备、报告、采访状态；显式 local 模式仍是进程内开发存储。
- 执行任务由单个进程拥有。数据库快照提供恢复能力，不是跨实例任务租约；没有声明支持多个实例同时执行同一任务。
- 模拟图记忆写入独立的 `MiroFishSimulationRun` / `MiroFishSimulationFact` 标签，带 tenant/corpus/simulation/run 身份和 `canonical=false`。它们不会变成原始文档或 RAG 引用事实。
- 所有运行消费者重新验证保存的来源身份及当前授权。缺少可证明来源的旧运行明确拒绝恢复；来源被撤销后不能通过报告、历史或下载绕过。
- 项目重置保留种子和历史来源工件，清除当前生成关联；活动任务会阻止重置或删除。未运行的已中断准备、报告任务会转成可恢复失败状态。
- 上游声明但未实际消费的 `scheduled_events`、部分推荐配置和独立 reflection 常量，不被当成上游已实现行为。这里实际消费的种子事件和推荐策略属于原生实现。

## 验证入口

执行 `npm run test:mirofish` 运行全部模块、API 和组件回归。`src/lib/models/provider-admission.test.mjs` 额外覆盖模型结束帧、真实 HTTP 尾部分片、取消与并发容量。

真实数据库测试需显式指定本机测试开关：

```powershell
$env:RAG_MIROFISH_LOCAL_TEST='1'
node --env-file=.env.local --experimental-strip-types --test src/lib/mirofish/runtime-store.postgres.test.mjs src/lib/mirofish/simulation-memory.neo4j.test.mjs
```

PostgreSQL 使用随机 scope 并全部回滚；Neo4j 仅清理本次随机四重身份下的模拟标签节点，不修改用户源图。完整验收记录和逐项功能矩阵见 [实施计划](plans/2026-11-05-mirofish-upstream-complete-integration.md)。

2026-11-06 验收完成：324 项功能回归和 46 项模型/传输回归通过，真实 PostgreSQL、Neo4j 验证通过；真实模型完成四章报告、四类工具、双平台采访及报告问答。刷新恢复和历史深链通过，临时验收项目与其 8 条运行记录已清理，原项目和来源图谱保留。当天重新比较上游 `main`，与固定提交完全一致。
