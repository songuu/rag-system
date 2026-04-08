---
title: "React 闭包过期导致状态丢失"
date: 2026-04-08
tags: [react, closure, state, callback]
related_instincts: [closure-stale-state]
---

# React 闭包过期导致状态丢失

## 问题
`Step2EnvSetup` 组件中 `onSimulationCreated` 设置 simulationId 后立即调用 `onComplete`，但父组件 `handleStep2Complete` 闭包中的 `simulationId` 仍是旧值 null，导致项目状态永远不会保存 simulation_id。

## 根因
React `useState` 的 setter 是异步的。`setSimulationId(simId)` 后立即读取 `simulationId` 得到的是旧值。当 `handleStep2Complete` 在同一个事件循环中被调用时，它捕获的是渲染时的 `simulationId` 值（null）。

## 解决方案
在回调中直接传递值，绕过闭包：

```typescript
// 父组件
const handleStep2Complete = (simIdOverride?: string) => {
  const effectiveSimId = simIdOverride || simulationId;
  updateProject({ simulation_id: effectiveSimId });
};

// JSX
onSimulationCreated={(simId) => {
  setSimulationId(simId);
  handleStep2Complete(simId); // 直接传值，不依赖 state
}}
```

## 预防
**规则**：当 setter 和依赖该 state 的回调在同一事件中执行时，必须直接传参而非读取 state。
