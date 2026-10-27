This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## 本地一键启动

首次使用前安装 Docker Desktop、Ollama，并执行一次 `pnpm install`。之后只需：

```powershell
pnpm dev
```

该命令会自动完成以下工作：

- Docker 未运行时启动 Docker Desktop；
- 从 `.env.container.example` 创建缺失的 `.env.container`；
- 拉取并启动 PostgreSQL、Milvus、Elasticsearch、Neo4j、MinIO、etcd；
- 执行 PostgreSQL 迁移；
- 启动本地 Ollama（已安装但未运行时）；
- 启动 Elasticsearch 增量索引与图谱构建 Worker；
- 所有依赖就绪后启动 Next.js。

默认打开 [http://localhost:3000](http://localhost:3000)，端口被占用时以终端显示的地址为准。启动器先确认端口监听，再等待健康接口和问答接口串行编译；看到“问答入口预编译完成，可以开始提问”表示准备完成。每个接口的冷编译最多等待 180 秒，超时会提示具体接口并保留开发服务，方便查看编译日志和继续修复；此时不能把端口开放当作问答已就绪。后续启动会复用已有镜像和数据卷；首次启动因为需要拉取镜像，耗时会更长。

Windows 下启动器默认使用 Webpack，其他平台默认使用 Turbopack；可通过 `NEXT_DEV_BUNDLER=webpack` 或 `NEXT_DEV_BUNDLER=turbopack` 显式选择。首次等待端口监听的预算为 180 秒，每 15 秒提示一次等待进度，并显示 Next.js 启动进程 PID；进程异常退出会立即取消检测。

其他开发入口：

```powershell
pnpm dev:infra   # 只启动依赖服务，不启动 Next.js
pnpm dev:app     # 只启动 Next.js，不检查或启动依赖
pnpm dev:rebuild # Worker 代码或依赖变化后，重建本地镜像再完整启动
```

This project uses a system font stack so production and container builds do not depend on fetching hosted fonts.

## Architecture and Practice Guides

- [当前 Agentic RAG 架构与实践对照（2026-09-07）](docs/architecture/agentic-rag-current.md) — canonical 可选重排、snapshot/bounded 工具循环、最终证据/缓存、引用与用量诊断及验收边界。
- [Agentic RAG 实施与验收计划](docs/plans/2026-09-07-agentic-rag-execution.md) — 本轮实现进度、真实模型/索引 canary 与尚待完成的验收。
- [Neo4j 知识图谱运行手册](docs/runbooks/neo4j-local.md) — 本地/云连接、Schema、历史导入、Shadow、发布回滚与故障恢复。
- [Complete LangChain `createAgent` RAG implementation, architecture, and setup guide](LANGCHAIN_LANGGRAPH_GUIDE.md) — the actual `/api/ask` and ingestion paths, Kernel/Policy/Lane design, scoped model-tool-model loop, privacy boundaries, from-zero setup, deployment, rollback, and verification matrix.
- [Environment configuration guide](ENV_CONFIG_GUIDE.md)
- [PostgreSQL deployment guide](docs/deployment/postgresql.md)

## Agentic RAG 验证

最后更新：2026-09-07。默认 `RAG_AGENTIC_RETRIEVAL_MODE=snapshot`，服务端设为 `bounded` 后允许读取快照后最多两次同 scope 补搜。bounded 默认采用显式 `answer/search/abstain` 结构化决策，服务端可用 `RAG_AGENTIC_DECISION_MODE=native-tools` 回退对照。配置说明见[环境指南](ENV_CONFIG_GUIDE.md#agentic-rag-运行时)。

```powershell
pnpm test:rag-agentic
pnpm rag:eval:agent
pnpm rag:eval:agent --provider ollama --model llama3.1 --variant iterative --trials 3 --max-duration-ms 600000 --gate
```

评测默认使用 fake 模型，比较 snapshot/rerank/iterative；指定 Ollama 才测真实本地模型。内置检索与重排始终使用固定 lexical fixture，不能据此声明生产质量；`--gate` 额外要求严格质量门禁通过。结果和 rollout 要求见[架构验收](docs/architecture/agentic-rag-current.md#验收与复现)。

首页导航的「效果评测」进入 `/rag-evaluation`。导入 `pnpm rag:eval:matrix`、`pnpm rag:eval:agent` 或单次评测生成的 JSON，可对照 Recall@K、MRR@K、NDCG@K、事实与引用覆盖、拒答、P95 延迟、Token 和费用，并展开逐题回答与证据排名。文件仅在浏览器内读取，不上传或保存；默认报告输出到 `.codex-tmp/rag-eval/`。

对照要求相同的数据集快照、Top K 和问题集合；执行失败、标注覆盖不同或计量口径不同会阻止对应差值计算。事实覆盖为文本匹配，引用覆盖为标注区间匹配，均不能替代语义正确性与忠实度评估。canonical Milvus 新请求的检索详情另显示实际重排前后排名、上下文入选和回答中的引用编号；旧记录、其他未记录轨迹的路径以及 durable 的安全回放不补造排名，显示未记录 / 未评测。

`pnpm test:rag-evaluation` 验证报告导入、配对口径、页面交互和单次检索诊断。

## 问答能力路由

同步问答入口使用统一能力路由。日期/星期/时区、独立算术与当前模型配置直接由可信工具回答；文档和不明确问题保留知识库检索。实时数据缺失时明确说明，不用文档或模型猜测。实现边界和回归命令见[问答入口能力路由](docs/architecture/conversation-routing.md)；运行 `pnpm test:conversation-routing` 验证。

## Container Deployment

Containerized deployment assets are available for local migration rehearsal and cloud runtime migration:

- [Container deployment guide](docs/deployment/container.md)
- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.local.yml`
- `docker-compose.cloud.yml`
- `.env.container.example`

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
