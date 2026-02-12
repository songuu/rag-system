# 博客同步到 Notion

生成博客文章时，可自动将 Markdown 同步到 Notion 页面。

## 配置

1. 在 [Notion Integrations](https://www.notion.so/my-integrations) 创建 Integration，获取 **Internal Integration Token**
2. 在 Notion 中创建一个**父页面**（例如「RAG 技术博客」），点击右上角 `...` → **连接** → 选择你的 Integration，授权访问
3. 复制父页面的 ID：
   - 打开父页面，URL 形如 `https://notion.so/工作区/页面标题-30575ad6422580409f56cf86fd99ff98`
   - ID 为 URL **末尾的 32 位十六进制**（如 `30575ad6422580409f56cf86fd99ff98`）
   - 若复制了带前缀的（如 `rag-30575ad6422580409f56cf86fd99ff98`），脚本会自动提取正确 ID

## 环境变量

| 变量 | 说明 |
|------|------|
| `NOTION_TOKEN` | Integration Secret（以 `secret_` 开头） |
| `NOTION_PARENT_PAGE_ID` | 父页面 ID（32 位） |

## 使用方式

### 方式一：仅同步到 Notion（不构建）

```bash
NOTION_TOKEN=secret_xxx NOTION_PARENT_PAGE_ID=xxx pnpm run sync:notion
```

### 方式二：构建时自动同步

在构建前设置环境变量，`generate-articles` 会在生成文章后自动调用同步：

```bash
NOTION_TOKEN=secret_xxx NOTION_PARENT_PAGE_ID=xxx pnpm run build
```

### 方式三： local 环境变量

在项目根目录创建 `.env.local`（不要提交到 Git）：

```
NOTION_TOKEN=secret_xxx
NOTION_PARENT_PAGE_ID=xxx
```

然后执行 `pnpm run sync:notion` 或 `pnpm run build`（Next.js 会加载 `.env.local`，但 Node 脚本需手动加载，可用 `dotenv` 或 `node -r dotenv/config`）。

## 说明

- 每次同步会为每篇文章创建新的子页面
- 重跑会导致重复页面，可在 Notion 中手动删除旧页面
- 父页面必须已 **连接** 你的 Integration，否则 API 会返回 404
