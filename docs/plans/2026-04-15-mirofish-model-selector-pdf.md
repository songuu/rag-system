---
title: MiroFish 模型选择器 + PDF 种子文件上传
date: 2026-04-15
status: in-progress
updated: 2026-04-15
---

# MiroFish 模型选择器 + PDF 种子文件上传

## 需求分析

### 背景
对标 MiroFish 演示页 (`https://mirofish-demo.pages.dev/console`) 的交互形态，在当前 `/mirofish/console/[projectId]` 工作流中补齐两项能力：
1. **运行时模型选择** — 支持 Ollama 本地、OpenAI、Custom 兼容 API
2. **PDF 种子文件上传** — Step1 图谱构建的"现实种子"入口

### 目标用户场景
用户进入项目 console，顶部可切换所用的 LLM（如将本地 Ollama 切换成自己的 OpenAI key），在 Step1 直接拖放一份 PDF 报告作为种子文本，后续 5 步工作流全部使用所选模型。

### In Scope
- PDF 上传（dropzone + pdf-parse 文本抽取，仅 application/pdf，≤10MB）
- ModelSelector UI 组件（ollama/openai/custom 三个 provider）
- `ModelOverride` 数据流：project 持久化 → API body → service 构造函数 → `createLLMFromOverride()`
- PUT project 白名单扩展 `model_config` 字段 + 结构校验
- 所有涉及 LLM 的 6 个 API route 透传 override

### Out of Scope
- Azure 不暴露在 UI（env 仍可用）
- Embedding provider 切换（独立 `EMBEDDING_PROVIDER`）
- 多文件上传、OCR、扫描件识别
- API Key 加密存储（内存存储，session 级别可接受）
- 模型预设管理界面

### 关键约束
- **安全**：`apiKey` 前端 mask，不打印到 console
- **向后兼容**：`.env` 用户未修改仍可正常工作（`model_config` 为空走默认）
- **Node runtime**：PDF 上传路由必须 `export const runtime = 'nodejs'`
- **不碰全局 ModelFactory**：通过参数覆盖而非修改单例 state

### 验收标准
- [ ] 用户能在 console 顶部切换 Ollama/OpenAI/Custom，参数持久化到项目
- [ ] 用户能在 Step1 上传 PDF，系统自动抽取文本填充到 `texts`
- [ ] 上传非 PDF 文件被拒绝并提示
- [ ] 后续 ontology/graph/simulation 等调用使用所选模型
- [ ] `.env` 未做任何修改的用户仍可正常工作

## 技术方案

### 数据结构

```typescript
// src/lib/mirofish/types.ts 新增
export interface ModelOverride {
  provider: 'ollama' | 'openai' | 'custom';
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
}

// Project 扩展
export interface Project {
  // ... 现有字段
  model_config?: ModelOverride;
}
```

### 核心辅助函数

`src/lib/mirofish/model-override.ts`（新）:

```typescript
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLLM } from '../model-config';
import type { ModelOverride } from './types';

export function createLLMFromOverride(
  override?: ModelOverride,
  defaults: { temperature?: number } = {}
): BaseChatModel {
  const temperature = override?.temperature ?? defaults.temperature ?? 0.7;

  if (!override) {
    return createLLM(undefined, { temperature });
  }

  switch (override.provider) {
    case 'ollama':
      return new ChatOllama({
        baseUrl: override.baseUrl || 'http://localhost:11434',
        model: override.modelName,
        temperature,
      });
    case 'openai':
      if (!override.apiKey) throw new Error('OpenAI 需要 API Key');
      return new ChatOpenAI({
        openAIApiKey: override.apiKey,
        modelName: override.modelName,
        temperature,
        configuration: override.baseUrl ? { baseURL: override.baseUrl } : undefined,
      });
    case 'custom':
      if (!override.apiKey || !override.baseUrl) {
        throw new Error('Custom 需要 API Key 和 Base URL');
      }
      return new ChatOpenAI({
        apiKey: override.apiKey,
        model: override.modelName,
        temperature,
        configuration: { baseURL: override.baseUrl },
      });
    default:
      throw new Error(`不支持的 provider: ${(override as ModelOverride).provider}`);
  }
}

export function validateModelOverride(input: unknown): ModelOverride | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const provider = obj.provider;
  if (provider !== 'ollama' && provider !== 'openai' && provider !== 'custom') return null;
  if (typeof obj.modelName !== 'string' || !obj.modelName.trim()) return null;

  const result: ModelOverride = {
    provider,
    modelName: obj.modelName.trim(),
  };
  if (typeof obj.baseUrl === 'string') result.baseUrl = obj.baseUrl;
  if (typeof obj.apiKey === 'string') result.apiKey = obj.apiKey;
  if (typeof obj.temperature === 'number') result.temperature = obj.temperature;
  return result;
}
```

### 服务改造清单

| 文件 | 改动摘要 |
|---|---|
| `ontology-generator.ts` | `constructor(modelOverride?: ModelOverride)` → `createLLMFromOverride(modelOverride, { temperature: 0.3 })` |
| `profile-generator.ts` | 同上 |
| `simulation-engine.ts` | `constructor(temperature, modelOverride?)` |
| `simulation-runner.ts` | `start()` 从 simulation config 取 override 传入 SimulationEngine |
| `report-agent.ts` | 去 singleton，`new ReportAgent(modelOverride)` |
| `interaction-agent.ts` | 去 singleton，`new InteractionAgent(modelOverride)` |
| `graph-builder.ts` / `task-manager.ts` | task payload 存 override，执行时透传 |

### API 路由改造

| Route | 改动 |
|---|---|
| `POST /api/mirofish/ontology` | body 接受 `modelOverride` |
| `POST /api/mirofish/graph` | 同上 |
| `POST /api/mirofish/profile` | 同上 |
| `POST /api/mirofish/simulation` | body 的 `config.model_config` 存入 simulation |
| `POST /api/mirofish/report` | 同上 |
| `POST /api/mirofish/interaction/chat` | body 接受 `modelOverride` |
| `PUT /api/mirofish/project/[id]` | 白名单加 `model_config` + 用 `validateModelOverride` 校验 |
| `POST /api/mirofish/upload` (新) | formData + pdf-parse |

### PDF 上传路由

```typescript
// src/app/api/mirofish/upload/route.ts
export const runtime = 'nodejs';
const MAX_PDF_SIZE = 10 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) return NextResponse.json({ success: false, error: '未提供文件' }, { status: 400 });
  if (file.type !== 'application/pdf') {
    return NextResponse.json({ success: false, error: '仅支持 PDF 文件' }, { status: 400 });
  }
  if (file.size > MAX_PDF_SIZE) {
    return NextResponse.json({ success: false, error: '文件大小不能超过 10MB' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buffer);

  const safeName = file.name.replace(/[^\w\s\u4e00-\u9fff.-]/g, '').substring(0, 100);

  return NextResponse.json({
    success: true,
    text: data.text,
    pages: data.numpages,
    filename: safeName,
  });
}
```

### UI 组件

**新组件** `ModelSelector.tsx`:
- Provider 下拉 + 动态字段
- API Key `type="password"`，回显时 mask
- 保存按钮调用 PUT project 持久化

**Step1GraphBuild 改造**:
- textarea 上方新增 PDF dropzone
- 上传成功后 `setTexts(text)` + 显示徽章 `📄 xxx.pdf (3 pages)`
- 所有 fetch 调用传递 `modelOverride`

**console/[projectId]/page.tsx**:
- 新增 `modelOverride` state 从 `project.model_config` 初始化
- `<ModelSelector>` 放在 StepNav 之上
- 下传到所有 Step 组件

## 任务拆解

- [x] **T1** 在 `types.ts` 新增 `ModelOverride` 和 `Project.model_config` 字段
- [x] **T2** 新建 `src/lib/mirofish/model-override.ts` 提供 `createLLMFromOverride()` 和 `validateModelOverride()`
- [x] **T3** 改造 `ontology-generator.ts` 构造函数
- [x] **T4** 改造 `profile-generator.ts` 构造函数
- [x] **T5** 改造 `simulation-engine.ts` 构造函数
- [x] **T6** 改造 `simulation-runner.ts` 从 config 提取 override
- [x] **T7** 改造 `report-agent.ts` 去 singleton
- [x] **T8** 改造 `interaction-agent.ts` 去 singleton
- [x] **T9** 改造 `graph-builder.ts` 接受 override
- [x] **T10** 改造 6 个 API route 透传 modelOverride
- [x] **T11** 改造 `project/[id]/route.ts` PUT 白名单 + 结构校验
- [x] **T12** 新建 `POST /api/mirofish/upload` PDF 抽取路由
- [x] **T13** 新建 `ModelSelector.tsx` 组件
- [x] **T14** 改造 `Step1GraphBuild.tsx` 加 PDF 上传 + 透传 override
- [x] **T15** 改造 Step2/3/4/5 透传 override
- [x] **T16** 改造 `console/[projectId]/page.tsx` 集成 ModelSelector
- [x] **T17** 类型检查通过
- [x] **T18** 审查 + 修复

## 变更日志

### 新建文件
- `src/lib/mirofish/model-override.ts` — `createLLMFromOverride` / `validateModelOverride` / `maskModelOverride`
- `src/app/api/mirofish/upload/route.ts` — PDF 上传 + pdf-parse 抽取（Node runtime、10MB、MIME 校验、filename 消毒）
- `src/components/mirofish/ModelSelector.tsx` — 顶部 bar 模型选择器，支持 ollama/openai/custom

### 修改文件（后端）
- `src/lib/mirofish/types.ts` — `ModelOverride` 接口 + `Project.model_config`
- `src/lib/mirofish/ontology-generator.ts` — 构造函数改 `modelOverride`
- `src/lib/mirofish/profile-generator.ts` — 同上
- `src/lib/mirofish/simulation-engine.ts` — 构造函数新增第二参数 `modelOverride`
- `src/lib/mirofish/simulation-runner.ts` — `create()` 新增 `modelOverride` 参数
- `src/lib/mirofish/report-agent.ts` — 去 singleton，`getReportAgent(override)` 每次新建
- `src/lib/mirofish/interaction-agent.ts` — 同上
- `src/lib/mirofish/graph-builder.ts` — 构造函数接受 override，注入给 EntityExtractor
- `src/lib/entity-extraction.ts` — 构造函数新增 `options.llmInstance` 注入点
- `src/app/api/mirofish/ontology/route.ts` — 透传 modelOverride
- `src/app/api/mirofish/profile/route.ts` — 同上
- `src/app/api/mirofish/graph/route.ts` — 同上
- `src/app/api/mirofish/simulation/route.ts` — 同上
- `src/app/api/mirofish/report/route.ts` — 同上
- `src/app/api/mirofish/interaction/chat/route.ts` — 同上
- `src/app/api/mirofish/interaction/interview/route.ts` — 同上
- `src/app/api/mirofish/project/[id]/route.ts` — PUT 白名单加 `model_config` + 结构校验

### 修改文件（前端）
- `src/components/mirofish/Step1GraphBuild.tsx` — PDF dropzone（拖放+点击，10MB，MIME 校验），`modelOverride` prop
- `src/components/mirofish/Step2EnvSetup.tsx` — `modelOverride` prop，profile/simulation fetch 透传
- `src/components/mirofish/Step4Report.tsx` — 同上，report fetch 透传
- `src/components/mirofish/Step5Interaction.tsx` — 同上，chat/interview 透传
- `src/app/mirofish/console/[projectId]/page.tsx` — 集成 ModelSelector + 状态持久化 + 向所有 Step 下发 modelOverride

## 审查结果

### 安全自审
- ✅ **PDF 上传**：前后端双 MIME 校验（`application/pdf`）、10MB 限制、空文件检查、filename 正则消毒
- ✅ **API Key**：前端 `type="password"`，保存走 PUT 白名单校验
- ✅ **PUT 白名单**：`model_config` 字段必须通过 `validateModelOverride` 结构校验
- ✅ **向后兼容**：`model_config` 为空或无效时 `createLLMFromOverride` 回退到默认 `createLLM`

### 已知限制
- pdf-parse v2 依赖 Node runtime（已 `export const runtime = 'nodejs'`）
- 扫描件 PDF 抽取失败返回 422，前端提示"可能是扫描件"
- Step3 不接收 modelOverride，因为 SSE 流只是消费已启动模拟的事件，模型在 `runner.create` 时已固化

### 类型检查
- `npx tsc --noEmit` 针对本次修改的全部文件 0 error
- 其他 pre-existing 错误（entity-extraction d3 / ontology-generator fallback cast / process/page.tsx d3）不在本次 sprint 范围内

## 复利记录

### 新模式
- **Provider 运行时覆盖模式**：通过单独的 `createLLMFromOverride()` 绕开 `ModelFactory` 单例，避免修改全局 env 状态。适合"按请求/按项目"切换 LLM 的场景。
- **SingletonlessAgent 模式**：当 agent 需要每次使用不同 LLM 时，`getXxx(override)` 改为工厂函数而非共享实例，实现零副作用切换。
- **entity-extraction 扩展点**：通过可选 `llmInstance` 注入，以最小侵入方式让共享模块支持运行时模型覆盖。

### 可复用经验
- Next.js 16 + pdf-parse v2：必须 `runtime = 'nodejs'` + 动态 `import('pdf-parse')`（ESM 兼容性）
- formData 接收 File：`file instanceof File` 守卫，防止 `formData.get` 返回 string
- PUT 白名单校验时，复杂字段用专用 validator 函数返回归一化值而非布尔
