/**
 * MiroFish 模块入口
 *
 * 参考 MiroFish 项目: https://github.com/666ghj/MiroFish
 *
 * 功能：
 * 1. 本体生成 - 分析文本生成实体/关系类型定义
 * 2. 图谱构建 - 基于实体抽取构建知识图谱
 * 3. 人设生成 - 为实体生成模拟人设
 * 4. 项目管理 - 项目 CRUD
 * 5. 模拟引擎 - 多Agent社交模拟
 * 6. 报告生成 - 分析模拟数据生成报告
 * 7. 深度交互 - Agent采访、对话
 */

// 类型导出
export * from './types';

// 核心服务导出
export { OntologyGenerator } from './ontology-generator';
export { MiroFishGraphBuilder } from './graph-builder';
export { ProfileGenerator } from './profile-generator';
export { TextProcessor } from './text-processor';
export { TaskManager, getTaskManager } from './task-manager';

// 项目管理
export { getProjectStore } from './project-store';

// 模拟引擎
export { SimulationEngine } from './simulation-engine';
export { getSimulationRunner } from './simulation-runner';
export type { SimulationEvent } from './simulation-runner';

// 报告生成
export { ReportAgent, getReportAgent } from './report-agent';

// 深度交互
export { InteractionAgent, getInteractionAgent } from './interaction-agent';
