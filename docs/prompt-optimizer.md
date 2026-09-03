# 提示词优化台

独立页面：`/prompt-optimizer`（生产 basePath 下为 `/rag-system/prompt-optimizer`）。它不读取或修改系统 RAG 的模型选择；优化模型档案、工作区和每次优化版本由独立 API 管理，并持久化到 PostgreSQL。

## 使用

1. 打开“模型设置”，创建 OpenAI、OpenRouter、OpenAI 兼容或本地 Ollama 档案。
2. 输入原始提示词。可用 `{{variable}}` 声明最多 50 个变量，并在变量区试填值。
3. 选择通用、结构化或图像模式，开始优化。
4. 结果会追加为不可变版本；继续迭代或手动修改后“存为新版本”都不会覆盖旧版本。

## 模型与凭证

模型设置抽屉可以为每个档案填写 API Token。Token 使用 AES-256-GCM 加密后存入 PostgreSQL，列表与保存接口只返回 `hasCredential`，不会回传明文。生产环境必须配置并长期保持 `PROMPT_OPTIMIZER_CREDENTIAL_KEY`；宿主机发布脚本会在首次缺失时生成并以 0600 权限持久化。

未填写档案 Token 时，仍可使用服务端共享凭证：

- `PROMPT_OPTIMIZER_OPENAI_API_KEY`（兼容回退 `OPENAI_API_KEY`）
- `PROMPT_OPTIMIZER_OPENROUTER_API_KEY`（兼容回退 `OPENROUTER_API_KEY`）
- `PROMPT_OPTIMIZER_COMPATIBLE_API_KEY`（仅本地开发兼容回退；生产兼容端点必须使用档案 Token）
- `PROMPT_OPTIMIZER_ALLOWED_MODEL_ORIGINS`：生产环境兼容端点的 HTTPS origin 白名单，逗号分隔

Ollama 仅在 `NODE_ENV != production` 时开放，并强制使用 `localhost`、`127.0.0.1` 或 `::1`。例如本地档案可设置模型 `qwen3:8b`，Base URL `http://127.0.0.1:11434/v1`。

## 数据库

迁移 `0003_prompt_optimizer.sql` 创建：

- `prompt_optimizer_model_profiles`
- `prompt_optimizer_workspaces`
- `prompt_optimizer_versions`

三张表都按 tenant/corpus 隔离。应用角色对版本表只有 `SELECT, INSERT`，数据库触发器拒绝 UPDATE；版本号通过单条 CTE 在乐观并发条件下原子递增。

迁移 `0004_prompt_optimizer_credentials.sql` 为模型档案增加加密凭证 envelope，数据库不会保存明文 Token。

## 验证

```bash
node src/lib/prompt-optimizer/contracts.test.mjs
node src/lib/prompt-optimizer/store.test.mjs
node src/lib/prompt-optimizer/templates.test.mjs
node src/lib/prompt-optimizer/providers.test.mjs
node src/lib/prompt-optimizer/credentials.test.mjs
node scripts/migrate-postgres.test.mjs
pnpm exec tsc --noEmit
pnpm build
```
