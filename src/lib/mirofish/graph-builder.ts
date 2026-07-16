/**
 * 图谱构建服务
 *
 * 复用现有的 entity-extraction.ts 实体抽取功能
 * 包装为 MiroFish 风格的接口，支持本体约束
 */

import { randomUUID } from 'node:crypto';
import {
  EntityExtractor,
  EntityExtractionOutputBudgetError,
  type ExtractionConfig,
  type KnowledgeGraph,
} from '../entity-extraction';
import { createStableErrorLog } from '../security/error-redaction';
import { getTaskManager } from './task-manager';
import { createLLMFromOverride } from './model-override';
import {
  purgeMiroFishLegacyGraphCache,
} from './artifact-cache';
import { assertMiroFishGraphDataResourceLimits } from './graph-artifact-store';
import {
  MIROFISH_GRAPH_EXTRACTION_CALL_LIMIT,
  MIROFISH_GRAPH_EXTRACTION_RESOURCE_LIMITS,
  MIROFISH_GRAPH_PROVIDER_INPUT_CHARACTER_LIMIT,
} from './graph-extraction-budget';
import type {
  Ontology,
  GraphData,
  GraphNode,
  GraphEdge,
  GraphInfo,
  GraphBuildRequest,
  ExtractionProgress,
  ModelOverride,
} from './types';

const MIROFISH_GRAPH_DEFAULTS = {
  chunkSize: 5000,
  chunkOverlap: 300,
  batchSize: 1,
};

const MIROFISH_GRAPH_OLLAMA_OPTIONS = {
  format: 'json',
  num_ctx: 32768,
};

const GRAPH_PROGRESS_RANGES: Record<string, [number, number]> = {
  preprocessing: [0, 5],
  chunking: [5, 10],
  extracting: [10, 75],
  gleaning: [75, 80],
  resolving: [80, 88],
  community: [88, 93],
  summarizing: [93, 98],
  completed: [100, 100],
};

const MIROFISH_GRAPH_ONTOLOGY_LIMITS = {
  entityTypes: 10,
  edgeTypes: 10,
  attributes: 50,
  examples: 50,
  sourceTargets: 100,
  nameLength: 200,
  descriptionLength: 8_000,
  analysisSummaryLength: 20_000,
};

const MIROFISH_GRAPH_ARTIFACT_LIMIT_CODE =
  'MIROFISH_GRAPH_ARTIFACT_LIMIT_EXCEEDED';
const MIROFISH_GRAPH_OUTPUT_BUDGET_LIMIT_CODE =
  'MIROFISH_GRAPH_OUTPUT_BUDGET_EXCEEDED';

export class MiroFishGraphArtifactLimitError extends Error {
  readonly code = MIROFISH_GRAPH_ARTIFACT_LIMIT_CODE;

  constructor(cause?: unknown) {
    super('MiroFish graph output exceeds the retained artifact limits.', {
      cause,
    });
    this.name = 'MiroFishGraphArtifactLimitError';
  }
}

export function createMiroFishGraphDocumentId(): string {
  return `mirofish_${randomUUID()}`;
}

export class MiroFishGraphOntologyValidationError extends Error {
  readonly code = 'INVALID_GRAPH_ONTOLOGY';

  constructor(path: string) {
    super(`Invalid MiroFish graph ontology at ${path}.`);
    this.name = 'MiroFishGraphOntologyValidationError';
  }
}

/**
 * Runtime validation for the JSON boundary and direct library callers.
 * Missing analysis_summary remains compatible with the legacy route shape.
 */
export function normalizeMiroFishGraphOntology(value: unknown): Ontology {
  const ontology = requireOntologyRecord(value, 'ontology');
  const entityTypes = requireOntologyArray(
    ontology.entity_types,
    'ontology.entity_types',
    MIROFISH_GRAPH_ONTOLOGY_LIMITS.entityTypes
  ).map((entry, index) => {
    const path = `ontology.entity_types[${index}]`;
    const entity = requireOntologyRecord(entry, path);
    return {
      name: normalizeOntologyString(entity.name, `${path}.name`, {
        maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.nameLength,
      }),
      description: normalizeOntologyString(entity.description, `${path}.description`, {
        allowEmpty: true,
        maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.descriptionLength,
      }),
      attributes: normalizeOntologyAttributes(entity.attributes, `${path}.attributes`),
      examples: requireOntologyArray(
        entity.examples,
        `${path}.examples`,
        MIROFISH_GRAPH_ONTOLOGY_LIMITS.examples
      ).map((example, exampleIndex) => normalizeOntologyString(
        example,
        `${path}.examples[${exampleIndex}]`,
        {
          allowEmpty: true,
          maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.descriptionLength,
        }
      )),
    };
  });
  const edgeTypes = requireOntologyArray(
    ontology.edge_types,
    'ontology.edge_types',
    MIROFISH_GRAPH_ONTOLOGY_LIMITS.edgeTypes
  ).map((entry, index) => {
    const path = `ontology.edge_types[${index}]`;
    const edge = requireOntologyRecord(entry, path);
    return {
      name: normalizeOntologyString(edge.name, `${path}.name`, {
        maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.nameLength,
      }),
      description: normalizeOntologyString(edge.description, `${path}.description`, {
        allowEmpty: true,
        maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.descriptionLength,
      }),
      source_targets: requireOntologyArray(
        edge.source_targets,
        `${path}.source_targets`,
        MIROFISH_GRAPH_ONTOLOGY_LIMITS.sourceTargets
      ).map((entry, sourceTargetIndex) => {
        const sourceTargetPath = `${path}.source_targets[${sourceTargetIndex}]`;
        const sourceTarget = requireOntologyRecord(entry, sourceTargetPath);
        return {
          source: normalizeOntologyString(sourceTarget.source, `${sourceTargetPath}.source`, {
            maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.nameLength,
          }),
          target: normalizeOntologyString(sourceTarget.target, `${sourceTargetPath}.target`, {
            maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.nameLength,
          }),
        };
      }),
      attributes: normalizeOntologyAttributes(edge.attributes, `${path}.attributes`),
    };
  });

  assertUniqueOntologyNames(entityTypes, 'ontology.entity_types');
  assertUniqueOntologyNames(edgeTypes, 'ontology.edge_types');

  return {
    entity_types: entityTypes,
    edge_types: edgeTypes,
    analysis_summary: ontology.analysis_summary === undefined
      ? ''
      : normalizeOntologyString(
        ontology.analysis_summary,
        'ontology.analysis_summary',
        {
          allowEmpty: true,
          maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.analysisSummaryLength,
        }
      ),
  };
}

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
  private modelOverride?: ModelOverride;

  constructor(
    config?: {
      chunkSize?: number;
      chunkOverlap?: number;
      batchSize?: number;
    },
    modelOverride?: ModelOverride
  ) {
    this.config = {
      chunkSize: config?.chunkSize ?? MIROFISH_GRAPH_DEFAULTS.chunkSize,
      chunkOverlap: config?.chunkOverlap ?? MIROFISH_GRAPH_DEFAULTS.chunkOverlap,
      batchSize: config?.batchSize ?? MIROFISH_GRAPH_DEFAULTS.batchSize,
    };
    this.modelOverride = modelOverride;
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
    onProgress?: (progress: ExtractionProgress) => void,
    taskMetadata?: Record<string, unknown>,
    reservedTaskId?: string
  ): Promise<string> {
    const { text, ontology, graphName, chunkSize, chunkOverlap } = request;
    const normalizedOntology = normalizeMiroFishGraphOntology(ontology);

    // Validate and normalize before task allocation so malformed input cannot
    // consume a global/tenant task slot.
    this.setOntology(normalizedOntology);

    // 应用配置覆盖
    if (chunkSize !== undefined) this.config.chunkSize = chunkSize;
    if (chunkOverlap !== undefined) this.config.chunkOverlap = chunkOverlap;

    // Remove all unscoped legacy graph records before accepting new work.
    await purgeMiroFishLegacyGraphCache();

    // The HTTP route may reserve a task synchronously so admission and
    // allocation cannot race. Direct library callers retain the legacy path.
    const taskManager = getTaskManager();
    const metadata = {
      graphName: graphName || 'MiroFish Graph',
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      textLength: text.length,
      ...taskMetadata,
    };
    let taskId: string;
    if (reservedTaskId !== undefined) {
      const reservedTask = taskManager.getTask(reservedTaskId);
      if (
        reservedTask?.task_type !== 'graph_build'
        || reservedTask.status !== 'pending'
      ) {
        throw new Error('Reserved graph task is unavailable.');
      }
      taskId = reservedTaskId;
      taskManager.updateTask(taskId, { metadata });
    } else {
      taskId = taskManager.createTask('graph_build', metadata);
    }
    // 在后台执行构建
    this.buildGraphWorker(taskId, text, onProgress).catch(error => {
      console.error(
        `[MiroFishGraphBuilder] taskId=${taskId} build failed`,
        createStableErrorLog(error)
      );
      const tm = getTaskManager();
      const task = tm.getTask(taskId);
      if (task?.status === 'pending' || task?.status === 'processing') {
        tm.failTask(
          taskId,
          error instanceof EntityExtractionOutputBudgetError
            ? MIROFISH_GRAPH_OUTPUT_BUDGET_LIMIT_CODE
            : 'MIROFISH_GRAPH_BUILD_FAILED'
        );
      }
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
        progress: calculateGraphProgress(progress),
        message: progress.message,
      });
      onProgress?.(progress);
    };

    // 1. 文本预处理
    reportProgress({
      stage: 'preprocessing',
      current: 0,
      total: 1,
      message: '正在预处理文本...',
    });

    // Evidence offsets must remain relative to the exact accepted source. Any
    // destructive whitespace normalization would make passage offsets forged.
    const sourceText = text;

    // 2. 创建实体提取器（注入运行时模型覆盖）
    const llmInstance = createLLMFromOverride(this.modelOverride, {
      temperature: 0.1,
      ollamaOptions: MIROFISH_GRAPH_OLLAMA_OPTIONS,
    });
    const extractor = new EntityExtractor(
      createMiroFishGraphExtractionConfig(this.config),
      {
        llmInstance,
        providerKey: this.modelOverride
          ? [
              this.modelOverride.provider,
              this.modelOverride.modelName,
              this.modelOverride.baseUrl ?? 'server-default',
            ].join(':')
          : undefined,
      }
    );

    // 设置进度回调
    extractor.onProgress(reportProgress);

    reportProgress({
      stage: 'extracting',
      current: 0,
      total: 1,
      message: '开始实体抽取...',
    });

    // 3. 执行实体抽取
    const documentId = createMiroFishGraphDocumentId();
    const graph = await extractor.extract(sourceText, documentId);

    // 4. 转换为 GraphData 格式
    const graphData = convertKnowledgeGraphToGraphData(graph);

    // 5. 应用本体约束（过滤）
    const filteredData = this.applyOntologyFilter(graphData);

    // Complete only after the same hard resource budget used by durable graph
    // artifacts accepts the result. Oversized provider output is never retained
    // in TaskManager, even transiently.
    this.completeGraphTask(taskId, documentId, graphData, filteredData);

    reportProgress({
      stage: 'completed',
      current: 1,
      total: 1,
      message: '图谱构建完成',
    });
  }

  private completeGraphTask(
    taskId: string,
    documentId: string,
    graphData: GraphData,
    filteredData: GraphData
  ): void {
    const taskManager = getTaskManager();
    try {
      if (filteredData.graph_id !== documentId) {
        throw new Error('Graph output identity does not match its document id.');
      }
      assertMiroFishGraphDataResourceLimits(filteredData);
    } catch (error) {
      taskManager.failTask(taskId, MIROFISH_GRAPH_ARTIFACT_LIMIT_CODE);
      throw new MiroFishGraphArtifactLimitError(error);
    }

    taskManager.completeTask(taskId, {
      graphId: documentId,
      graphData: filteredData,
      originalEntityCount: graphData.node_count,
      filteredEntityCount: filteredData.node_count,
      cache_status: 'disabled',
    });
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
    const filteredEdgeIds = new Set(filteredEdges.map(edge => edge.uuid));
    const filteredCommunities = graphData.communities
      ?.map(community => ({
        ...community,
        entities: community.entities.filter(entityId => nodeIds.has(entityId)),
        relations: community.relations.filter(relationId => filteredEdgeIds.has(relationId)),
      }))
      .filter(community => community.entities.length > 0);

    return {
      ...graphData,
      nodes: filteredNodes,
      edges: filteredEdges,
      node_count: filteredNodes.length,
      edge_count: filteredEdges.length,
      communities: filteredCommunities,
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
    await purgeMiroFishLegacyGraphCache();

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

/**
 * 将完整抽取结果适配为可检索图 artifact。
 *
 * WHY: GraphRAG 的实体和社区只负责召回/排序，引用必须回落到原文 passage。
 */
export function convertKnowledgeGraphToGraphData(graph: KnowledgeGraph): GraphData {
  const createdAt = graph.metadata.createdAt.toISOString();
  const nodes: GraphNode[] = Array.from(graph.entities.values(), entity => ({
    uuid: entity.id,
    name: entity.name,
    labels: [entity.type],
    summary: entity.description,
    attributes: {
      ...entity.metadata,
      aliases: entity.aliases,
      mentions: entity.mentions,
      sourceChunks: [...entity.sourceChunks],
    },
    created_at: createdAt,
  }));
  const nodesById = new Map(nodes.map(node => [node.uuid, node]));
  const edges: GraphEdge[] = [];

  for (const relation of graph.relations.values()) {
    const sourceNode = nodesById.get(relation.source);
    const targetNode = nodesById.get(relation.target);
    if (!sourceNode || !targetNode) continue;
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
        ...relation.metadata,
        weight: relation.weight,
        sourceChunks: [...relation.sourceChunks],
      },
      created_at: createdAt,
      episodes: [],
    });
  }

  return {
    graph_id: graph.metadata.documentId,
    nodes,
    edges,
    node_count: nodes.length,
    edge_count: edges.length,
    artifact_version: 'mirofish-graph-v2',
    passages: Array.from(graph.chunks.values(), chunk => ({
      id: chunk.id,
      document_id: graph.metadata.documentId,
      content: chunk.content,
      index: chunk.index,
      start_offset: chunk.startChar,
      end_offset: chunk.endChar,
      source: readOptionalString(chunk.metadata, 'source'),
      page: readOptionalPositiveInteger(chunk.metadata, 'page'),
      section_path: readOptionalStringArray(chunk.metadata, 'sectionPath'),
      metadata: chunk.metadata ? { ...chunk.metadata } : undefined,
    })),
    communities: Array.from(graph.communities.values(), community => ({
      id: community.id,
      name: community.name,
      entities: [...community.entities],
      relations: [...community.relations],
      summary: community.summary,
      keywords: [...community.keywords],
      level: community.level,
      parent_id: community.parentId,
    })),
  };
}

function normalizeOntologyAttributes(value: unknown, path: string) {
  return requireOntologyArray(
    value,
    path,
    MIROFISH_GRAPH_ONTOLOGY_LIMITS.attributes
  ).map((entry, index) => {
    const attributePath = `${path}[${index}]`;
    const attribute = requireOntologyRecord(entry, attributePath);
    return {
      name: normalizeOntologyString(attribute.name, `${attributePath}.name`, {
        maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.nameLength,
      }),
      type: normalizeOntologyString(attribute.type, `${attributePath}.type`, {
        maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.nameLength,
      }),
      description: normalizeOntologyString(
        attribute.description,
        `${attributePath}.description`,
        {
          allowEmpty: true,
          maxLength: MIROFISH_GRAPH_ONTOLOGY_LIMITS.descriptionLength,
        }
      ),
    };
  });
}

function requireOntologyRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MiroFishGraphOntologyValidationError(path);
  }
  return value as Record<string, unknown>;
}

function requireOntologyArray(value: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new MiroFishGraphOntologyValidationError(path);
  }
  return value;
}

function normalizeOntologyString(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean; maxLength: number }
): string {
  if (typeof value !== 'string') {
    throw new MiroFishGraphOntologyValidationError(path);
  }
  const normalized = value.trim();
  if ((!options.allowEmpty && normalized.length === 0) || normalized.length > options.maxLength) {
    throw new MiroFishGraphOntologyValidationError(path);
  }
  return normalized;
}

function assertUniqueOntologyNames(
  definitions: Array<{ name: string }>,
  path: string
): void {
  const names = new Set<string>();
  for (const definition of definitions) {
    const normalizedName = definition.name.toLocaleLowerCase('en-US');
    if (names.has(normalizedName)) {
      throw new MiroFishGraphOntologyValidationError(path);
    }
    names.add(normalizedName);
  }
}

/**
 * Public graph APIs expose topology only. Source passages stay inside the
 * scoped artifact store and must never be serialized by legacy graph routes.
 */
export function createPublicGraphProjection(
  graph: GraphData
): Omit<GraphData, 'passages'> {
  const publicGraph = { ...graph };
  delete publicGraph.passages;
  return publicGraph;
}

function readOptionalString(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readOptionalPositiveInteger(
  metadata: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readOptionalStringArray(
  metadata: Record<string, unknown> | undefined,
  key: string
): string[] | undefined {
  const value = metadata?.[key];
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value.map(item => item.trim()).filter(Boolean)
    : undefined;
}

export function createMiroFishGraphExtractionConfig(config: {
  chunkSize: number;
  chunkOverlap: number;
}): Partial<ExtractionConfig> {
  return {
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    enableGleaning: false,
    maxChunkTimeout: 45 * 1000,
    maxProviderCalls: MIROFISH_GRAPH_EXTRACTION_CALL_LIMIT,
    maxProviderInputCharacters: MIROFISH_GRAPH_PROVIDER_INPUT_CHARACTER_LIMIT,
    ...MIROFISH_GRAPH_EXTRACTION_RESOURCE_LIMITS,
  };
}

function calculateGraphProgress(progress: ExtractionProgress): number {
  const [start, end] = GRAPH_PROGRESS_RANGES[progress.stage] ?? [0, 100];
  if (start === end) return start;
  const total = Math.max(1, progress.total);
  const ratio = Math.min(1, Math.max(0, progress.current / total));
  return start + (end - start) * ratio;
}
