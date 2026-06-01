---
title: "PDF 解析迁移 LiteParse 调研"
type: sprint
status: completed
created: "2026-05-28"
updated: "2026-05-28"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, research, implementation, pdf, rag, liteparse]
aliases: ["PDF LiteParse research", "PDF parser migration"]

invariants:
  - "PDF 上传和解析 API 必须运行在 Node.js runtime"
  - "现有 10MB 上传限制和非空文本校验语义不应被解析器替换破坏"
  - "MAIC 同文件解析缓存仍以文件内容 hash 命中, parser 替换不应改变缓存身份"
  - "普通 RAG 与 Reasoning RAG 仍保存 raw 文件和 parsed txt 双产物"

invariant_tests:
  - "pnpm exec tsc --noEmit --pretty false"
  - "node --experimental-strip-types --test src/lib/maic/parsed-slides-cache.test.mjs"
  - "node --experimental-strip-types --test src/lib/maic/upload-validation.test.mjs"
---

# PDF 解析迁移 LiteParse 调研

## Phase 1: Think

### Scope

- 研究当前项目内 PDF 解析方式、调用路径和部署约束。
- 核验 `@llamaindex/liteparse` 是否适合替换或补充当前 `pdf-parse`。
- 输出迁移可行性、收益、风险、建议路径和后续任务拆解。

### Non-scope

- 本轮不替换业务代码,不修改 `package.json` 和 lockfile。
- 本轮不引入 OCR 流程、不改变上传大小限制、不调整前端交互。
- 本轮不做真实 PDF benchmark,因为仓库内未发现可复用 PDF fixture。

### Success

- 能回答“是否能改成 LiteParse”。
- 能指出需要改哪些文件和为什么不能只改一处。
- 能给出保守、可回滚的迁移方案。

### Risks

- LiteParse v2 刚发布不久,Node 绑定最新版本为 2026-05-27 的 `2.0.1`,需要锁版本并做部署验证。
- LiteParse Node 包包含 native optional dependencies,Next/Turbopack/Vercel 打包边界需要专门处理。
- OCR 默认开启会改变性能曲线和文本输出,直接替换可能影响 chunk、检索召回和 MAIC 分页。

## Phase 2: Plan

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|---|---|---|
| MiroFish PDF upload | PDF 上传路由必须 `runtime = 'nodejs'` | LiteParse Node 绑定同样按 Node runtime 评估,不考虑 Edge 直接接入 |
| MAIC parse speed | PDF 热路径避免额外阻塞,同一文件解析结果缓存 | 建议默认 `ocrEnabled: false` 先对齐当前文本抽取,后续再把 OCR 作为显式选项 |
| RAG uploads | raw 文件与 parsed txt 双产物保持 | adapter 返回同样的 `content/pages/parseMethod` 元数据,不改存储结构 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|---|---|---|---|---|
| 普通上传 PDF | `/api/upload` formData | `parseDocument -> parsePdfFile` | `uploads/*` raw + parsed txt + manifest | 是 |
| Reasoning RAG PDF | `/api/reasoning-rag/files` formData | `parseDocument -> parsePdfFile` | `reasoning-uploads/*` raw + parsed txt | 是 |
| MAIC PDF/PPT-like material | `/api/maic/upload` formData | `parseSlides -> parseDocument -> parsePdfFile` | MAIC store + parsed cache + RAG mirror | 是 |
| Pipeline PDF | `/api/pipeline` multipart | `DocumentPipeline -> loadDocument -> loadPdfFile` | Milvus chunks | 是,取决于 Milvus |
| MiroFish PDF seed | `/api/mirofish/upload` formData | route 内直接 `PDFParse` | 前端 texts state | 否,当前是种子文本填充 |

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|---|---|---|---|
| 2026-04-15 MiroFish PDF | direct route 内 `pdf-parse` 与共享 parser 分叉 | 后续迁移时一并收敛到 adapter | 2026-06-15 |
| 2026-04-28 MAIC parse speed | 解析热路径对首屏有影响 | LiteParse 先关闭 OCR 做等价替换 PoC,再单独评估 OCR | 2026-06-15 |

## Phase 3: Research

### 当前实现

项目当前依赖 `pdf-parse@^2.4.5`,lockfile 中解析到 `pdf-parse@2.4.5` 和 `pdfjs-dist@5.4.296`。

已发现 3 类 PDF 解析实现:

| 位置 | 当前方式 | 输出 | 备注 |
|---|---|---|---|
| `src/lib/document-parser.ts` | 动态导入 `PDFParse`, `new PDFParse({ data: buffer })`, `getText()`, finally `destroy()` | `ParseResult.document.content`, `metadata.pages`, `parseMethod: pdf-parse-v2` | 普通上传、Reasoning RAG、MAIC、MiroFish text processor 共用 |
| `src/lib/document-pipeline.ts` | 动态导入 `PDFParse`, `getText()`, `getInfo()`, `destroy()` | `LoadedDocument.content`, title/author/pageCount | Pipeline/Milvus 上传链路使用,失败路径没有 finally destroy |
| `src/app/api/mirofish/upload/route.ts` | route 内直接导入 `PDFParse`, `getText()`, `getInfo()`, `destroy()` | JSON: text/pages/filename/size | 已显式 `runtime = 'nodejs'`,但没有复用共享 parser |

当前 `next.config.ts` 已将 `pdf-parse`, `@napi-rs/canvas`, `pdfjs-dist`, `canvas` 放入 `serverExternalPackages`,说明 PDF 解析依赖已触发过 Next 服务端打包约束。

### LiteParse 能力核验

主要来源:

- GitHub: https://github.com/run-llama/liteparse
- Node README: https://github.com/run-llama/liteparse/blob/main/packages/node/README.md
- Node package manifest: https://raw.githubusercontent.com/run-llama/liteparse/main/packages/node/package.json
- Releases: https://github.com/run-llama/liteparse/releases

已核验事实:

- npm 包名是 `@llamaindex/liteparse`,不是旧的 `liteParse` 模板包。
- Node package `2.0.1` 要求 Node `>=18.0.0`,ESM-only,入口为 `dist/lib.js`。
- 包含 `lit`/`liteparse` CLI,也支持 Node library 方式。
- 支持 `Buffer`/`Uint8Array` 输入,能返回 `result.text` 和 `result.pages`。
- 默认配置包含 `ocrEnabled: true`,`ocrLanguage`,`maxPages`,`targetPages`,`dpi`,`password`,`numWorkers` 等。
- Node 包通过 napi-rs/native optional dependencies 分发,包括 win32/linux/darwin 平台包。
- 官方说明支持 PDF 原生解析,Office/Image 需要 LibreOffice/ImageMagick 转换；本项目已有 `mammoth`/`xlsx`,不建议本次顺手统一 Office 解析。

## Phase 4: Review

### 对比结论

| 维度 | 当前 `pdf-parse` | `@llamaindex/liteparse` | 对本项目判断 |
|---|---|---|---|
| 接入复杂度 | 已接入,但有重复实现 | API 简单,但 native optional deps 需要打包验证 | LiteParse 可接,但应先做 adapter PoC |
| 文本抽取 | 当前足够支撑 text-only RAG | 提供 layout-preserved text 和 pages | 对表格/多栏/版面文档有潜在收益 |
| OCR | 当前扫描件基本失败并提示 | 内置 OCR,可接 HTTP OCR server | 是主要增量价值,但必须显式开关 |
| 性能 | 纯文本 PDF 可用,MAIC 曾优化掉额外 `getInfo()` | v2 官方主张更快,但本仓库未 benchmark | 需要用本项目 PDF fixture 验证,不能只凭发布说明替换 |
| 元数据 | getInfo 可取 title/author/pageCount | pages/structured data 更丰富 | 可映射现有 metadata,但字段语义需确认 |
| 部署 | 已为 pdf-parse 外置包配置 | ESM + native optional deps + PDFium/Tesseract | Next serverExternalPackages 和 tracing 是风险点 |
| 输出稳定性 | 已被 chunk/cache 逻辑隐式依赖 | 输出格式和分页可能不同 | 需要回归 chunk 数、MAIC 分页、检索质量 |

### Findings

- P1: 不建议在每个 route 里各自把 `PDFParse` 替换成 `LiteParse`。当前至少有 5 条调用链,直接替换会继续放大重复实现和行为漂移。
- P1: LiteParse 的 OCR 默认开启可能改变用户感知: 扫描件会从失败变成功,但 CPU 时间、文本噪声、chunk 数都会变化。第一阶段应默认 `ocrEnabled: false` 做等价替换。
- P1: `document-pipeline.ts` 和 `mirofish/upload/route.ts` 当前 `destroy()` 不在 finally 中。即使暂不迁移 LiteParse,也值得在后续 parser adapter 中统一资源释放。
- P2: `document-parser.ts` 已把 PDF page count 从 `getText().total` 取回,但 `document-pipeline.ts` 和 MiroFish route 仍额外 `getInfo()`。如果只为页数,这里有可先行优化空间。
- P2: 缺少 PDF fixture 和解析回归测试。任何 parser 替换都应该先补 text-only、multi-page、empty/scanned-like failure 三类测试。

## Phase 5: Work Follow-up

用户确认“按照最稳的方案直接执行”后，已落地稳态迁移骨架：

- 新增 `src/lib/pdf-parser.ts` 作为唯一 PDF parser adapter。
- 默认 provider 仍为 `pdf-parse`,通过 `PDF_PARSE_PROVIDER=liteparse` 才切换 LiteParse。
- LiteParse OCR 默认关闭,通过 `PDF_PARSE_OCR_ENABLED=true` 显式启用。
- `document-parser`, `document-pipeline`, `mirofish/upload` 已统一调用 adapter。
- `next.config.ts` 已把 `@llamaindex/liteparse` 加入 server external packages。
- `@llamaindex/liteparse@2.0.1` 已锁入 dependencies。
- 新增 `src/lib/pdf-parser.test.mjs` 覆盖 provider 默认值、OCR opt-in 和错误上下文。

验证结果:

- `node --experimental-strip-types --test src/lib/pdf-parser.test.mjs` 通过。
- `node --experimental-strip-types --test src/lib/maic/upload-validation.test.mjs` 通过。
- `node --experimental-strip-types --test src/lib/maic/parsed-slides-cache.test.mjs` 通过。
- `pnpm exec eslint src/lib/pdf-parser.ts src/lib/document-parser.ts src/lib/document-pipeline.ts src/app/api/mirofish/upload/route.ts next.config.ts` 通过。
- `pnpm exec tsc --noEmit --pretty false` 通过。
- `node -e "import('@llamaindex/liteparse')..."` 初始化 LiteParse native provider 通过。

未完成项:

- 仓库内未发现 PDF fixture,所以尚未做真实 PDF 的文本质量、chunk 数和耗时 benchmark。
- 默认 provider 未切到 LiteParse；这保留了生产行为稳定性。

## Phase 6: Compound

### 建议决策

可以改成 LiteParse,但不建议“一步全量替换”。推荐两阶段:

1. 新建共享 PDF parser adapter,把现有 `pdf-parse` 三处实现先收敛成一个接口。
2. 在 adapter 内增加 LiteParse provider,用配置开关或环境变量选择,默认先 `ocrEnabled: false`;通过 fixture benchmark 后再决定是否默认切换。

建议接口:

```typescript
export interface PdfParseOutput {
  text: string;
  pages: number;
  title?: string;
  author?: string;
  parseMethod: 'pdf-parse-v2' | 'liteparse-v2';
  pageTexts?: string[];
}

export async function parsePdfBuffer(
  buffer: Buffer,
  filename: string,
  options?: {
    provider?: 'pdf-parse' | 'liteparse';
    ocrEnabled?: boolean;
    maxPages?: number;
  }
): Promise<PdfParseOutput>;
```

### 后续实施任务

- [ ] T1 新建 `src/lib/pdf-parser.ts`,封装现有 `pdf-parse` 行为并补 finally 资源释放。
- [ ] T2 改造 `document-parser.ts`, `document-pipeline.ts`, `mirofish/upload/route.ts` 调用共享 adapter。
- [ ] T3 添加 PDF fixture 和 parser 回归测试,至少覆盖 page count、空文本、chunk 数稳定性。
- [ ] T4 安装 `@llamaindex/liteparse` 并加入 provider,同步更新 `next.config.ts serverExternalPackages`。
- [ ] T5 用同一批 PDF 对比 `pdf-parse` 与 LiteParse 的文本长度、页数、chunk 数、解析耗时、错误类型。
- [ ] T6 决定默认 provider: 若 LiteParse 等价且部署通过,默认切换；否则保留为 opt-in/OCR 专用路径。

### 复利记录

- 架构规则: `.codex/rules/architecture.md` 追加“PDF Parser Changes Go Through A Shared Adapter”。
- 未新增业务代码。
- 建议下一步先做 adapter 收敛,再做 LiteParse PoC。
