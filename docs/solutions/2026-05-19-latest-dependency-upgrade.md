# Latest Dependency Upgrade - 2026-05-19

## 目标

将项目直接依赖、开发依赖和 `packageManager` 升级到 npm registry 当前 latest，并验证现有应用代码在最新栈下仍可构建。

## 已升级

- `packageManager`: `pnpm@10.33.0` -> `pnpm@11.1.3`
- Next / React: `next@16.2.6`, `react@19.2.6`, `react-dom@19.2.6`
- LangChain / LangGraph: `@langchain/core@1.1.47`, `@langchain/langgraph@1.3.1`, `@langchain/community@1.1.28`, `@langchain/openai@1.4.6`, `@langchain/ollama@1.2.7`
- Milvus SDK: `@zilliz/milvus2-sdk-node@3.0.0`
- Tooling: `typescript@6.0.3`, `eslint@10.4.0`, `eslint-config-next@16.2.6`, `tailwindcss@4.3.0`, `@tailwindcss/postcss@4.3.0`
- UI / runtime libs: `lucide-react@1.16.0`, `jsdom@29.1.1`, `tailwind-merge@3.6.0`, `uuid@14.0.0`, plus existing latest packages retained.

## 清理

- 移除 deprecated stub `@types/uuid`，因为 `uuid` 自带类型。
- `pnpm outdated --format json` 返回 `{}`，说明当前 package.json 的直接依赖和开发依赖没有落后项。

## ESLint 10 兼容处理

`eslint-config-next@16.2.6` 仍依赖 `eslint-plugin-react@7.37.5`，该插件 peer range 尚未声明 ESLint 10，并且部分 `react/*` 规则在 ESLint 10 rule context API 下会崩溃。

本次处理方式：

- 保持 `eslint@10.4.0` 最新。
- 在 `eslint.config.mjs` 中暂时关闭 Next config 注入的 `react/*` 规则。
- 继续保留 TypeScript、Next、React Hooks 等其他规则。

后续当 `eslint-plugin-react` 发布兼容 ESLint 10 的版本后，可以移除这段兼容 override。

## 验证

- `pnpm outdated --format json` - pass，输出 `{}`。
- `npx tsc --noEmit --pretty false --incremental false` - pass。
- targeted `pnpm lint -- ...` - pass。
- `node scripts\generate-articles.mjs` - pass。
- `pnpm build` - pass，Next.js 16.2.6 / Turbopack 构建成功。

## 升级后使用面复核

- LangChain / LangGraph / LangSmith / Milvus / uuid / React / ReactFlow / lucide 的 ESM 导入 smoke 均通过。
- `src/lib/milvus-client.test.mjs` 与 `src/lib/langsmith/config.test.mjs` 共 8 个专项测试通过。
- Milvus SDK 3 的 `MilvusClient` 构造会尝试连接配置地址；本次只做纯导入和配置解析验证，未在无 Milvus 服务的本机执行真实查询。
- `pnpm why eslint-plugin-react` 确认 `eslint-plugin-react@7.37.5` 来自 `eslint-config-next@16.2.6`，所以 `react/*` 兼容 override 是临时生态适配。
- `pnpm why @browserbasehq/stagehand` 确认它来自 `@langchain/community@1.1.28`，项目当前未直接调用 Stagehand API。
- 全量 `npm run lint -- --quiet` 当前仍有 386 个既有错误；本轮触达文件的 targeted `pnpm lint -- ...` 通过。
- 使用 `npm run ...` 会出现 `supportedArchitectures` unknown config 告警，来源是项目 `.npmrc` 中的 pnpm 专用配置；项目已声明 `packageManager: pnpm@11.1.3`，验证和日常命令优先使用 `pnpm ...`。

## 已知状态

- 全量 `npm run lint` 仍会失败，主要是既有代码里的 `no-explicit-any`、`prefer-const`、React compiler 新规则等历史问题，不是本轮依赖升级触达文件的编译/构建阻断。
- `pnpm update/remove` 在默认沙箱下会留下 0 字节 `_tmp_*` 临时文件，已在沙箱外清理。
