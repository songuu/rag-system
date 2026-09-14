This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

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
