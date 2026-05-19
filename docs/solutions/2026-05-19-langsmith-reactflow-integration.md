# LangSmith ReactFlow 接入方案

## 背景

上一轮已经把 LangSmith root run、child run、`thread_id`、metadata/tags 和 feedback 链路接入项目。本轮补齐前端图形化层：让 LangSmith viewer 不再只显示静态时间线或列表，而是直接使用 React Flow 12 展示可交互 run tree / decision path。

## 已落地

- 安装 `@xyflow/react@12.10.2`。
- 在 `src/app/layout.tsx` 引入 `@xyflow/react/dist/style.css`。
- 新增 `src/components/LangSmithReactFlowGraph.tsx`，统一封装节点、边、Controls、MiniMap、Background、fitView。
- `src/components/LangSmithTraceViewer.tsx` 的图形 tab 改为 ReactFlow 画布。
- `src/components/SCRAGLangSmithViewer.tsx` 的决策路径 tab 改为 ReactFlow 画布。

## 设计原则

1. **只接 UI，不改 trace 合同。** ReactFlow 消费已有 workflow steps / decision path，不改 API response。
2. **保留旧详情视图。** timeline、metrics、debug、grader、rewrite 仍保留，用于查看输入输出和评分细节。
3. **统一图组件。** 普通 RAG 和 Self-Corrective RAG 都使用同一套节点状态、边样式和 viewport 控制。
4. **轻量布局。** 当前 workflow 是线性或少分支路径，先用稳定分层坐标，不引入 dagre/elkjs。

## 后续可演进

- 从 `/api/traces/[traceId]` 读取真实 `ObservabilityEngine` observations，生成更完整的父子 run tree。
- 增加节点点击详情抽屉，把 input/output/metadata 从时间线迁移到 graph 节点详情。
- 当 agent 分支明显增多时，再引入自动布局算法。
