/**
 * 图谱构建服务
 *
 * 复用现有的 entity-extraction.ts 实体抽取功能
 * 包装为 MiroFish 风格的接口，支持本体约束
 */

import { EntityExtractor } from '../entity-extraction';
import { TextProcessor } from './text-processor';
import { getTaskManager } from './task-manager';
import type {
  Ontology,
  GraphData,
  GraphNode,
  GraphEdge,
  GraphInfo,
  GraphBuildRequest,
  ExtractionProgress,
} from './types';

/**
 * MiroFish 图谱构建器
 *
 * 基于实体抽取系统构建知识图谱，支持本体约束
 */
export class MiroFishGraphBuilder {
  private config: {
    chunkSize: number;
    chunkOverlap: number;
    batchSize: number;
  };
  private ontology?: Ontology;

  constructor(config?: {
    chunkSize?: number;
    chunkOverlap?: number;
    batchSize?: number;
  }) {
    this.config = {
      chunkSize: config?.chunkSize || 500,
      chunkOverlap: config?.chunkOverlap || 100,
      batchSize: config?.batchSize || 3,
    };
  }

  /**
   * 设置本体定义
   */
  setOntology(ontology: Ontology): void {
    this.ontology = ontology;
  }

  /**
   * 异步构建图谱
   */
  async buildGraphAsync(
    request: GraphBuildRequest,
    onProgress?: (progress: ExtractionProgress) => void
  ): Promise<string> {
    const { text, ontology, graphName, chunkSize, chunkOverlap } = request;

    // 设置本体
    if (ontology) {
      this.setOntology(ontology);
    }

    // 应用配置覆盖
    if (chunkSize) this.config.chunkSize = chunkSize;
    if (chunkOverlap) this.config.chunkOverlap = chunkOverlap;

    // 创建任务
    const taskManager = getTaskManager();
    const taskId = taskManager.createTask('graph_build', {
      graphName: graphName || 'MiroFish Graph',
      chunkSize: this.config.chunkSize,
      textLength: text.length,
    });

    // 在后台执行构建
    this.buildGraphWorker(taskId, text, onProgress).catch(error => {
      const tm = getTaskManager();
      tm.failTask(taskId, error instanceof Error ? error.message : String(error));
    });

    return taskId;
  }

  /**
   * 构建图谱工作线程
   */
  private async buildGraphWorker(
    taskId: string,
    text: string,
    onProgress?: (progress: ExtractionProgress) => void
  ): Promise<void> {
    const taskManager = getTaskManager();
    const reportProgress = (progress: ExtractionProgress) => {
      taskManager.updateTask(taskId, {
        progress: progress.current / progress.total * 100,
        message: progress.message,
      });
      onProgress?.(progress);
    };

    try {
      // 1. 文本预处理
      reportProgress({
        stage: 'preprocessing',
        current: 0,
        total: 1,
        message: '正在预处理文本...',
      });

      const processedText = TextProcessor.preprocessText(text);

      // 2. 创建实体提取器
      const extractor = new EntityExtractor({
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
      });

      // 设置进度回调
      if (onProgress) {
        extractor.onProgress(onProgress);
      }

      reportProgress({
        stage: 'extracting',
        current: 0,
        total: 1,
        message: '开始实体抽取...',
      });

      // 3. 执行实体抽取
      const documentId = `mirofish_${Date.now()}`;
      const graph = await extractor.extract(processedText, documentId);

      // 4. 转换为 GraphData 格式
      const graphData = this.convertToGraphData(graph);

      // 5. 应用本体约束（过滤）
      const filteredData = this.applyOntologyFilter(graphData);

      // 完成任务
      taskManager.completeTask(taskId, {
        graphId: documentId,
        graphData: filteredData,
        originalEntityCount: graphData.node_count,
        filteredEntityCount: filteredData.node_count,
      });

      reportProgress({
        stage: 'completed',
        current: 1,
        total: 1,
        message: '图谱构建完成',
      });

    } catch (error) {
      console.error('[MiroFishGraphBuilder] 构建失败:', error);
      throw error;
    }
  }

  /**
   * 将实体抽取结果转换为图谱数据格式
   */
  private convertToGraphData(
    graph: Awaited<ReturnType<EntityExtractor['extract']>>
  ): GraphData {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // 转换实体为节点
    for (const entity of graph.entities.values()) {
      nodes.push({
        uuid: entity.id,
        name: entity.name,
        labels: [entity.type],
        summary: entity.description,
        attributes: {
          aliases: entity.aliases,
          mentions: entity.mentions,
          sourceChunks: entity.sourceChunks,
          ...entity.metadata,
        },
        created_at: new Date().toISOString(),
      });
    }

    // 转换关系为边
    for (const relation of graph.relations.values()) {
      const sourceNode = nodes.find(n => n.uuid === relation.source);
      const targetNode = nodes.find(n => n.uuid === relation.target);

      if (sourceNode && targetNode) {
        edges.push({
          uuid: relation.id,
          name: relation.type,
          fact: relation.description,
          fact_type: relation.type,
          source_node_uuid: relation.source,
          target_node_uuid: relation.target,
          source_node_name: sourceNode.name,
          target_node_name: targetNode.name,
          attributes: {
            weight: relation.weight,
            sourceChunks: relation.sourceChunks,
            ...relation.metadata,
          },
          created_at: new Date().toISOString(),
          episodes: [],
        });
      }
    }

    return {
      graph_id: graph.metadata.documentId,
      nodes,
      edges,
      node_count: nodes.length,
      edge_count: edges.length,
    };
  }

  /**
   * 应用本体约束过滤
   *
   * 根据 ontology 过滤实体类型，只保留允许的类型
   */
  private applyOntologyFilter(graphData: GraphData): GraphData {
    if (!this.ontology) {
      return graphData;
    }

    // 获取允许的实体类型
    const allowedTypes = new Set(
      this.ontology.entity_types.map(e => e.name.toUpperCase())
    );

    // 过滤节点
    const filteredNodes = graphData.nodes.filter(node => {
      // 检查节点标签是否在允许列表中
      const nodeTypes = node.labels.map(l => l.toUpperCase());
      return nodeTypes.some(t => allowedTypes.has(t));
    });

    // 获取过滤后的节点 ID 集合
    const nodeIds = new Set(filteredNodes.map(n => n.uuid));

    // 过滤边（只保留两端都在过滤后节点中的边）
    const filteredEdges = graphData.edges.filter(
      edge =>
        nodeIds.has(edge.source_node_uuid) && nodeIds.has(edge.target_node_uuid)
    );

    return {
      ...graphData,
      nodes: filteredNodes,
      edges: filteredEdges,
      node_count: filteredNodes.length,
      edge_count: filteredEdges.length,
    };
  }

  /**
   * 获取图谱数据
   */
  async getGraphData(graphId: string): Promise<GraphData | null> {
    // 从任务结果中获取
    const taskManager = getTaskManager();
    const tasks = taskManager.getAllTasks();

    for (const task of tasks) {
      if (task.result?.graphId === graphId) {
        return task.result.graphData as GraphData;
      }
    }

    return null;
  }

  /**
   * 获取图谱信息
   */
  async getGraphInfo(graphId: string): Promise<GraphInfo | null> {
    const graphData = await this.getGraphData(graphId);

    if (!graphData) {
      return null;
    }

    // 统计实体类型
    const entityTypes = new Set<string>();
    for (const node of graphData.nodes) {
      for (const label of node.labels) {
        if (label !== 'Entity' && label !== 'Node') {
          entityTypes.add(label);
        }
      }
    }

    return {
      graph_id: graphId,
      node_count: graphData.node_count,
      edge_count: graphData.edge_count,
      entity_types: Array.from(entityTypes),
    };
  }

  /**
   * 删除图谱
   */
  async deleteGraph(graphId: string): Promise<boolean> {
    // 清理相关任务
    const taskManager = getTaskManager();
    const tasks = taskManager.getAllTasks();

    for (const task of tasks) {
      if (task.result?.graphId === graphId) {
        taskManager.deleteTask(task.task_id);
      }
    }

    return true;
  }

  /**
   * 获取允许的实体类型列表
   */
  getAllowedEntityTypes(): string[] {
    if (!this.ontology) {
      return [];
    }
    return this.ontology.entity_types.map(e => e.name);
  }

  /**
   * 获取允许的关系类型列表
   */
  getAllowedEdgeTypes(): string[] {
    if (!this.ontology) {
      return [];
    }
    return this.ontology.edge_types.map(e => e.name);
  }
}
