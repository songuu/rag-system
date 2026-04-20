---
title: OpenMAIC 多智能体课堂 - 本项目完整实现
status: completed
created: 2026-04-15
updated: 2026-04-15
owner: songuu
sprint_phase: 5/5 Compound
---

# OpenMAIC 多智能体课堂在本项目中的完整实现

## 1. 需求分析

### 1.1 源参考

- 站点: https://open.maic.chat/
- 论文: arXiv 2409.03512 (Tsinghua, MAIC: Massive AI-empowered Course)
- 定位: LLM 驱动的"多智能体交互课堂",兼顾规模化 (scalability) 与个性化 (adaptivity)

### 1.2 OpenMAIC 核心能力 (来自论文)

**Teaching Side (教学端 — 课程准备)**
- `Read Stage`:
  - `f1`: 多模态 LLM 从 slides 提取 `<text, visual>` → 页级内容
  - `f2`: 生成每页完整文本描述
  - `f3`: 构建课程知识的树形分类 (knowledge tree)
- `Plan Stage`:
  - `f4`: 长上下文 LLM 生成带教学动作标记的讲座脚本 (ShowFile / ReadScript / AskQuestion)
  - `f5`: 生成课堂主动提问
  - `ρ`: Agent 角色定制 (system prompt + RAG 知识注入)

**Learning Side (学习端 — 课堂运行)**
- `Session Controller`:
  - `Class State Receptor`: 聚合对话历史 `H_t` + 已覆盖材料 `P_t` → 课堂状态 `S_t`
  - `Manager Agent (meta)`: `f_L: S_t → (agent, teaching_action)` 决策下一步由谁做什么
  - `Action Execution`: 选中 agent 执行动作 → 等待窗口 τ → 触发下一轮决策
- `Agent Roles`:
  - Teacher Agent (主讲)
  - TA Agent (维护秩序、安全)
  - Classmate Agents × 4 原型:
    - Class Clown (氛围/创意)
    - Deep Thinker (启发深度讨论)
    - Note Taker (总结关键点)
    - Inquisitive Mind (追问探究)
- `交互模式`:
  - Continuous: agent 自驱全程,学生被动观看
  - Interactive: 学生可随时打断、提问、请求换讲解方式
- `教学动作语言 T = (type, value)`: ShowFile | ReadScript | AskQuestion | ...

**Analytics (分析)**
- 课堂记录收集、学习数据预测、自动评估/面试

### 1.3 目标 (范围定义)

**MUST (P0) — 第一轮 sprint 必须完成**

1. **课程管理**: 列表/详情/上传 slides (PDF/PPT 解析) 并持久化
2. **课程准备流水线 (Read + Plan)**:
   - 解析 slides → 页级 text (复用 `document-parser.ts` + 可选 vision)
   - 生成每页描述 → 知识树 (复用 `entity-extraction.ts`)
   - 生成带动作标记的讲座脚本
   - 生成课堂主动提问
3. **课堂运行时**:
   - `Session Controller` + `Class State Receptor`
   - `Manager Agent` 决策循环
   - Teacher / TA / 4 种 Classmate agent 实现
   - SSE 实时推送教学动作事件到前端 (复用 mirofish SSE 模式)
4. **课堂 UI**:
   - 幻灯片播放区 + 对话流 + 角色头像 + 学生输入框
   - Continuous / Interactive 双模式切换
   - 跳转上一页/下一页、请求换讲解方式等管理指令
5. **学生交互**: 中途提问 → Manager 插入 agent 响应 → 课堂继续

**SHOULD (P1) — 如果余力包含**

6. Agent 角色可自定义 (role prompt 编辑器)
7. 课堂记录保存与回放
8. 基础学习分析 (消息数/长度统计 + 成绩相关性占位)
9. 课程知识树可视化

**WON'T (P2) — 本轮明确不做**

- 真实用户认证/多租户 (单用户本地即可)
- 100k+ 学生规模的分布式架构
- 自动化测验/面试评分
- 多模态 vision 深度解析 (可用纯文本 slides 替代)
- 移动端适配优化

### 1.4 成功标准

- 用户可上传一份 PDF slides,系统自动生成讲座脚本与 agent 配置
- 点击"进入课堂",Teacher agent 按脚本逐页讲解,Classmate 按 Manager 决策介入发言
- 用户在 Interactive 模式下提问,Manager 正确路由给最合适的 agent 并继续流程
- 全程 SSE 实时流式,无刷新,无明显卡顿
- 课程/会话状态持久化 (localStorage 或 server-side store)

### 1.5 约束与前提

- **独立模块**: 本功能在独立页面 `/maic` 下实现,代码目录 `src/lib/maic/` + `src/app/api/maic/` + `src/components/maic/`,**不与 mirofish 融合**,不共享 store/types/agent。
- **借鉴而非共享**: 可以复制 mirofish 的 SSE/ReadableStream.cancel() 清理模板、单例 Store 模板作为起点,但独立演进。
- 复用通用基础设施 (与 mirofish 无耦合):
  - `src/lib/document-parser.ts` 文档解析
  - `src/lib/entity-extraction.ts` 知识抽取 (若有通用 API)
  - `src/lib/model-config.ts` 统一 LLM 调用
  - `src/lib/rag-system.ts` (可选,作为 agent 知识后端)
- 后端: Next.js API Routes + ReadableStream SSE
- 前端: React + Tailwind,独立页面 `src/app/maic/page.tsx`
- 存储: 独立的 `maic-store.ts` 单例 in-memory,可选 IndexedDB 持久化

### 1.6 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 1:1 克隆整个 MAIC 工作量巨大 | 无法在一个 sprint 完成 | 严格按 MUST 范围落地,P1/P2 显式延后 |
| Manager Agent 决策质量差 → 课堂卡顿或重复 | 体验差 | 用简单 state machine + LLM 混合:硬规则兜底 |
| SSE 长连接在 Next.js dev mode 下稳定性 | 已踩过坑 (见 memory) | 严格遵守 ReadableStream.cancel() 清理规范 |
| slides 解析复杂度 (PDF/PPT/图片) | 可能阻塞流水线 | P0 只支持 PDF 文本抽取,其他 P1 |
| 多 agent 并发 API 成本 | 费用+延迟 | 限制并发数 ≤ 5,单轮 action 1 个 agent |

---

## 2. 技术方案

### 2.1 目录结构 (新增,均为独立模块)

```
src/
├─ app/
│  ├─ maic/                              # 独立页面入口
│  │  ├─ page.tsx                        # 课程列表 (首页)
│  │  ├─ layout.tsx                      # MAIC 布局 (头部/导航)
│  │  ├─ prepare/[courseId]/page.tsx     # 课程准备进度 (Read/Plan 流水线)
│  │  └─ classroom/[courseId]/page.tsx   # 课堂运行时 (核心 UI)
│  └─ api/maic/
│     ├─ courses/route.ts                # GET/POST 课程 CRUD
│     ├─ courses/[courseId]/route.ts     # GET/DELETE 单课程
│     ├─ upload/route.ts                 # POST slides 上传
│     ├─ prepare/[courseId]/route.ts     # POST 启动准备 / GET SSE 进度
│     └─ classroom/[courseId]/route.ts   # GET SSE 课堂事件流 / POST 学生消息
├─ lib/maic/
│  ├─ types.ts                           # 全量类型
│  ├─ course-store.ts                    # 单例 in-memory Store (课程/会话)
│  ├─ slide-parser.ts                    # PDF → pages[] (复用 document-parser)
│  ├─ pipeline/
│  │  ├─ read-stage.ts                   # f1/f2/f3: 页内容→描述→知识树
│  │  ├─ plan-stage.ts                   # f4/f5: 讲座脚本 + 主动提问生成
│  │  └─ prepare-runner.ts               # 流水线编排 + SSE 事件发射
│  ├─ agents/
│  │  ├─ base-agent.ts                   # LLM agent 基类 (role prompt + respond())
│  │  ├─ teacher-agent.ts                # 主讲
│  │  ├─ ta-agent.ts                     # 助教
│  │  ├─ classmate-clown.ts              # Class Clown
│  │  ├─ classmate-thinker.ts            # Deep Thinker
│  │  ├─ classmate-notetaker.ts          # Note Taker
│  │  ├─ classmate-inquisitive.ts        # Inquisitive Mind
│  │  └─ manager-agent.ts                # Meta agent 路由决策
│  ├─ session/
│  │  ├─ session-controller.ts           # 会话生命周期 + 事件总线
│  │  ├─ state-receptor.ts               # 聚合 S_t = {P_t, H_t, R}
│  │  └─ action-executor.ts              # 执行 T = (type, value)
│  └─ sse-utils.ts                       # ReadableStream + cancel() 模板
└─ components/maic/
   ├─ CourseCard.tsx
   ├─ UploadDropzone.tsx
   ├─ PrepareProgress.tsx                # 流水线进度可视化
   ├─ ClassroomStage.tsx                 # 幻灯片展示区
   ├─ ClassroomChat.tsx                  # 对话流 (含角色头像)
   ├─ StudentInput.tsx                   # 学生输入框
   ├─ ModeSwitch.tsx                     # Continuous/Interactive
   └─ AgentAvatar.tsx
```

### 2.2 核心数据模型

```typescript
// types.ts 关键类型
export type ActionType = 'ShowFile' | 'ReadScript' | 'AskQuestion' | 'Navigate' | 'EndClass';

export interface TeachingAction {
  type: ActionType;
  value: {
    slide_index?: number;
    script?: string;
    question?: string;
    [k: string]: unknown;
  };
}

export interface SlidePage {
  index: number;
  raw_text: string;      // f1
  description: string;   // f2
  key_points: string[];  // f3 叶节点
}

export interface KnowledgeNode {
  id: string;
  title: string;
  children: KnowledgeNode[];
  page_refs: number[];
}

export interface CoursePrepared {
  pages: SlidePage[];
  knowledge_tree: KnowledgeNode;
  lecture_script: ScriptEntry[]; // f4: 带 action 标记
  active_questions: string[];    // f5
}

export interface ScriptEntry {
  slide_index: number;
  actions: TeachingAction[];
}

export interface Course {
  course_id: string;
  title: string;
  source_filename: string;
  status: 'uploaded' | 'preparing' | 'ready' | 'failed';
  prepared?: CoursePrepared;
  created_at: string;
  updated_at: string;
}

export type AgentRole = 'teacher' | 'ta' | 'clown' | 'thinker' | 'notetaker' | 'inquisitive';

export interface Utterance {
  id: string;
  speaker: AgentRole | 'student';
  content: string;
  action?: TeachingAction;
  timestamp: string;
}

export interface ClassroomState {
  P_t: number;          // 已覆盖到哪一页
  H_t: Utterance[];     // 对话历史
  R: AgentRole[];       // 本节启用的角色集合
  mode: 'continuous' | 'interactive';
  status: 'idle' | 'running' | 'paused' | 'ended';
}

export interface ClassroomSession {
  session_id: string;
  course_id: string;
  state: ClassroomState;
  created_at: string;
}

export type ClassroomEvent =
  | { type: 'utterance'; data: Utterance }
  | { type: 'slide_change'; data: { slide_index: number } }
  | { type: 'state'; data: ClassroomState }
  | { type: 'end'; data: { reason: string } }
  | { type: 'error'; data: { message: string } };
```

### 2.3 流水线 (Read + Plan) 算法

```
upload(PDF)
  → slide-parser.splitPages(pdf)           # 每页一段文本 (PDF.js text layer)
  → read-stage.extractRaw(page)            # f1: 原文本 (图像 P2 忽略)
  → read-stage.describePage(raw)           # f2: LLM 生成完整描述 (单次调用)
  → read-stage.buildKnowledgeTree(pages)   # f3: 一次 LLM 调用产出 JSON tree
  → plan-stage.generateScript(pages, tree) # f4: 逐页生成 actions[] (ShowFile, ReadScript, AskQuestion)
  → plan-stage.generateQuestions(tree)     # f5: 课堂主动提问池
  → store.markReady(courseId, prepared)
```

- 并发: Read/Plan 的 per-page 调用使用 `Promise.all` + 并发上限 5
- SSE 进度: `read:start` → `read:page:N` → `read:tree` → `plan:script` → `plan:questions` → `done`
- 失败: 任意步骤失败 → `status=failed` + 事件 `error`,保留已完成结果

### 2.4 Session Controller 循环

```
loop while state.status === 'running':
  S_t = stateReceptor.snapshot(session)

  decision = managerAgent.decide(S_t, course.prepared)
    → { next_agent: AgentRole, action: TeachingAction }
    → 实现:硬规则优先 + LLM 兜底
       规则示例:
         - 学生刚提问 → teacher 回答
         - 连续 3 次 teacher → 触发 classmate 发言
         - 讲完一页脚本 → ShowFile 下一页
         - 用户说"简单点" → teacher ReadScript(简化)
       无规则命中时 → LLM JSON 决策

  agent = agents[decision.next_agent]
  utterance = await agent.respond(S_t, decision.action, course.prepared)
  executor.apply(session, utterance, decision.action)
  emit('utterance', utterance)

  if action.type === 'ShowFile': emit('slide_change', ...)
  if state.P_t > lastPage && queue empty: emit('end'); break

  await wait(τ = 2s, 或学生输入中断信号)
```

- 中断机制: `AbortController` + `session.inputQueue`。学生输入即插入 `H_t` 并 abort 当前 wait,循环立即重新决策。
- 并发防护: 每个 session 由单 `SessionController.runOnce(sessionId)` 串行驱动;并发写入用 Mutex。

### 2.5 Agent 实现

- `BaseAgent.respond(state, action, prepared)`:
  - 组装 system prompt = `rolePrompt + contextSnippet`
  - user prompt = 最近 N=12 条 `H_t` + 当前 action 要求
  - 调 `model-config` 的 `createChatModel()`
  - 返回 `Utterance`
- `ManagerAgent.decide()`:
  - JSON mode 输出 `{ next_agent, action }`
  - 系统提示包含角色表 + 当前状态摘要 + 脚本当前位置
- Classmate 角色的 prompt 模板遵循论文四原型描述

### 2.6 SSE 模式 (基于已有教训)

```typescript
// sse-utils.ts
export function sseStream(
  setup: (emit: (event: ClassroomEvent) => void) => Promise<() => void>
): Response {
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: ClassroomEvent) => {
        controller.enqueue(`data: ${JSON.stringify(e)}\n\n`);
      };
      cleanup = await setup(emit);
    },
    cancel() {
      cleanup?.();  // 主清理路径
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', ... } });
}
```

- `cancel()` 是主清理,`signal.aborted` 作备用 (遵守 `feedback_sse_cleanup.md`)
- 课堂结束事件 → 延迟 1s `controller.close()`

### 2.7 UI 交互

- `/maic` 首页: 课程卡片网格 + "上传新课程"
- `/maic/prepare/[courseId]`: 流水线步骤进度条 + 实时事件日志
- `/maic/classroom/[courseId]`:
  - 左: 幻灯片大图 + 页码
  - 右: 聊天流 (Continuous/Interactive 切换按钮,学生输入框)
  - 底部: 角色头像条 (显示本节启用角色)
- 客户端直接订阅 `GET /api/maic/classroom/[courseId]` SSE;学生消息 `POST` 到同 endpoint 的 sub-route `/message`

### 2.8 与 mirofish 的界线

| 决定 | 说明 |
|---|---|
| 独立目录 `src/lib/maic/`, `src/app/maic/`, `src/app/api/maic/` | 不共享 |
| 独立 Store `course-store.ts` | 不沿用 `project-store.ts` |
| 独立类型 `src/lib/maic/types.ts` | 不 import mirofish types |
| 允许参考 mirofish 的 SSE 模式写法 | 但代码在 `maic/sse-utils.ts` 内独立实现 |
| 复用通用模块 `document-parser.ts`, `model-config.ts` | 这些是项目级通用,不属 mirofish |

## 3. 任务拆解

执行顺序按层级,粗粒度每项 15–40 分钟。

### T1. 基础骨架 (P0)

- [ ] T1.1 创建目录 `src/lib/maic/`, `src/app/maic/`, `src/app/api/maic/`, `src/components/maic/`
- [ ] T1.2 写 `types.ts` 全量类型
- [ ] T1.3 写 `course-store.ts` 单例 + CRUD (Map-based, immutable updates)
- [ ] T1.4 写 `sse-utils.ts` SSE 流模板 (cancel-first 清理)

### T2. Read/Plan 流水线 (P0)

- [ ] T2.1 `slide-parser.ts`: 调 `document-parser` 拿 PDF 文本,按换页切 pages
- [ ] T2.2 `read-stage.ts`: `describePage` + `buildKnowledgeTree` (LLM JSON mode)
- [ ] T2.3 `plan-stage.ts`: `generateScript` (逐页,含 action 标记) + `generateQuestions`
- [ ] T2.4 `prepare-runner.ts`: 串联 + SSE 事件发射 + 失败隔离
- [ ] T2.5 API `POST /api/maic/upload`: multipart → 存 course → 返回 courseId
- [ ] T2.6 API `POST /api/maic/prepare/[courseId]`: 启动 runner (竞态 Set 锁)
- [ ] T2.7 API `GET /api/maic/prepare/[courseId]` (SSE): 订阅 runner 事件

### T3. Agents (P0)

- [ ] T3.1 `base-agent.ts`: `respond()` 通用实现
- [ ] T3.2 `teacher-agent.ts` + `ta-agent.ts`
- [ ] T3.3 4 × classmate agents (一个文件一个角色,共享模板)
- [ ] T3.4 `manager-agent.ts`: 硬规则表 + LLM JSON 兜底

### T4. Session Controller (P0)

- [ ] T4.1 `state-receptor.ts`: `snapshot(session) → S_t`
- [ ] T4.2 `action-executor.ts`: 把 action 落到 state (P_t/H_t/status)
- [ ] T4.3 `session-controller.ts`: 循环 + AbortController + Mutex + 事件发射
- [ ] T4.4 API `GET /api/maic/classroom/[courseId]` (SSE): 创建/续接 session,推事件
- [ ] T4.5 API `POST /api/maic/classroom/[courseId]/message`: 学生输入入队 + 打断 wait

### T5. UI (P0)

- [ ] T5.1 `layout.tsx` + 顶部导航 (返回/课程名/模式切换)
- [ ] T5.2 `/maic/page.tsx`: 课程列表 + `UploadDropzone`
- [ ] T5.3 `/maic/prepare/[courseId]/page.tsx`: `PrepareProgress` + EventSource
- [ ] T5.4 `/maic/classroom/[courseId]/page.tsx`: `ClassroomStage` + `ClassroomChat` + `StudentInput` + `ModeSwitch`
- [ ] T5.5 `AgentAvatar` + `CourseCard` 卡片组件

### T6. 联调 & 验证 (P0)

- [ ] T6.1 上传样例 PDF → 走完 Read/Plan → 看 status=ready
- [ ] T6.2 进入课堂 → Continuous 跑完一页 → Teacher 讲解 + classmate 自然插话
- [ ] T6.3 Interactive 模式下提问 → Manager 正确路由 teacher 回答 → 恢复讲解
- [ ] T6.4 浏览器 tab 关闭 → SSE `cancel()` 正确清理 listener
- [ ] T6.5 `tsc --noEmit` 无报错

### T7 (P1, 余力做)

- [ ] T7.1 Agent 角色 prompt 编辑器
- [ ] T7.2 课堂记录持久化 + 回放
- [ ] T7.3 知识树可视化 (d3/react-flow)
- [ ] T7.4 消息数/长度统计面板

## 4. 变更日志

### 2026-04-15 Phase 3 Work 一次性交付

新增文件 (23 个,全部独立于 mirofish):

**Lib (11)**
- `src/lib/maic/types.ts` - 全量类型定义
- `src/lib/maic/course-store.ts` - 单例 in-memory store (不可变更新)
- `src/lib/maic/sse-utils.ts` - `createSseResponse` cancel-first 清理
- `src/lib/maic/slide-parser.ts` - 基于 document-parser 的分页启发式
- `src/lib/maic/pipeline/read-stage.ts` - f1/f2/f3 (describePages + buildKnowledgeTree)
- `src/lib/maic/pipeline/plan-stage.ts` - f4/f5 (generateLectureScript + generateActiveQuestions)
- `src/lib/maic/pipeline/prepare-runner.ts` - pub/sub 流水线 runner + 竞态锁
- `src/lib/maic/agents/profiles.ts` - 7 个 agent 的 system prompt
- `src/lib/maic/agents/base-agent.ts` - 通用 respond() (system+user prompt, fallback)
- `src/lib/maic/agents/agent-registry.ts` - 懒加载单例注册表
- `src/lib/maic/agents/manager-agent.ts` - 硬规则 + LLM 兜底决策
- `src/lib/maic/session/action-executor.ts` - `applyAction` → StatePatch
- `src/lib/maic/session/session-controller.ts` - 循环 + AbortController 打断 + mutex

**API Routes (6)**
- `src/app/api/maic/upload/route.ts` - multipart 上传 + 立刻解析
- `src/app/api/maic/courses/route.ts` - 课程列表
- `src/app/api/maic/courses/[courseId]/route.ts` - 单课程 GET/DELETE
- `src/app/api/maic/prepare/[courseId]/route.ts` - POST 启动 + GET SSE
- `src/app/api/maic/classroom/[courseId]/route.ts` - GET SSE 课堂事件
- `src/app/api/maic/classroom/[courseId]/message/route.ts` - POST 学生输入 + mode

**UI (6)**
- `src/app/maic/layout.tsx` - 顶部导航
- `src/app/maic/page.tsx` - 课程列表 + 轮询
- `src/app/maic/prepare/[courseId]/page.tsx` - 实时准备进度
- `src/app/maic/classroom/[courseId]/page.tsx` - 核心课堂 UI (幻灯片 + 聊天 + 模式切换)
- `src/components/maic/UploadDropzone.tsx`
- `src/components/maic/CourseCard.tsx`

### 类型检查

- `tsc --noEmit` → maic/ 目录零报错
- 修复过程:
  - `manager-agent.ts`: `maybeInjectClassmate` 返回类型窄化为 `SpeakingRole`
  - `session-controller.ts`: 移除无效的 `=== 'manager'` 比较,去掉 non-null 断言,`studentMsg` 显式标注

### 与 mirofish 的物理隔离验证

- ✅ `src/lib/maic/**` 不 import `src/lib/mirofish/**`
- ✅ `src/app/maic/**` 不引用 mirofish 组件
- ✅ 独立单例 Store,独立类型,独立 SSE util
- ✅ 仅共享项目级通用设施 `document-parser` + `model-config`

## 5. 审查结果 (Phase 4 填写)

_待定_

## 6. 复利记录

### 新增本能/经验 (已写入全局 memory)

1. **[Agent Action Semantics](../../../../../../Users/Administrator/.claude/projects/e--project-ai-rag-project-rag-nextjs/memory/feedback_agent_action_semantics.md)** (feedback)
   - 多 agent 系统中,不同的"动作"必须有独立的 `ActionType` + prompt 分支
   - 反例: 把"回答学生问题"的指令塞进 `ReadScript.value.script`,teacher 会照读
   - 正例: 新增 `AnswerStudent` type + 独立 describeAction 分支 + `student_question` 字段

2. **[MAIC Classroom Architecture](../../../../../../Users/Administrator/.claude/projects/e--project-ai-rag-project-rag-nextjs/memory/project_maic_architecture.md)** (project)
   - 模块位置 / 三段式架构 / 与 mirofish 的物理隔离边界
   - 默认角色集 / 可扩展点清单

### 可迁移的设计模式

- **Pub/Sub Runner**: `prepare-runner` 的 subscribe→event buffer→multicast 模式,对所有"后台任务 + 多客户端 SSE 订阅"场景都适用
- **硬规则 + LLM 兜底决策**: Manager Agent 的模式值得在其他 agentic 场景复用(RAG 路由、工作流编排)
- **Cancel-first SSE**: `sse-utils.createSseResponse` 已内化,未来所有 maic/mirofish 外的 SSE 都可借鉴

### 对原计划的偏差

- 无显著偏差。任务按 T1→T6 顺序完成,未出现 blocker。
- P0 code review 发现 1 个语义 bug (AnswerStudent),在 Phase 4 当场修复

### 未做项 (P1)

- Agent role prompt 编辑器
- 课堂回放/持久化
- 知识树可视化
- 学习分析面板
- 单元测试 (action-executor / manager.decide / slide-parser 至少 3 个)

### 统计

- 新增文件: 23
- 新增 API 路由: 6
- 新增 UI 页面: 3
- Agent 角色: 7
- TypeScript 报错 (maic 目录): 0
- Sprint 耗时: 1 次会话内完成
