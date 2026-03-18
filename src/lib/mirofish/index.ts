/**
 * MiroFish 模块入口
 *
 * 参考 MiroFish 项目: https://github.com/666ghj/MiroFish
 *
 * 功能：
 * 1. 本体生成 - 分析文本生成实体/关系类型定义
 * 2. 图谱构建 - 基于实体抽取构建知识图谱
 * 3. 人设生成 - 为实体生成模拟人设
 */

// 类型导出
export * from './types';

// 服务导出
export { OntologyGenerator } from './ontology-generator';
export { MiroFishGraphBuilder } from './graph-builder';
export { ProfileGenerator } from './profile-generator';
export { TextProcessor } from './text-processor';
export { TaskManager, getTaskManager } from './task-manager';
