/**
 * MiroFish 模块类型定义
 *
 * 参考 MiroFish 项目: https://github.com/666ghj/MiroFish
 */

// ==================== 本体类型 ====================

/** 本体属性定义 */
export interface OntologyAttribute {
  name: string;
  type: string;
  description: string;
}

/** 实体类型定义 */
export interface EntityTypeDefinition {
  name: string;
  description: string;
  attributes: OntologyAttribute[];
  examples: string[];
}

/** 关系源目标定义 */
export interface EdgeSourceTarget {
  source: string;
  target: string;
}

/** 边类型定义 */
export interface EdgeTypeDefinition {
  name: string;
  description: string;
  source_targets: EdgeSourceTarget[];
  attributes: OntologyAttribute[];
}

/** 本体定义 */
export interface Ontology {
  entity_types: EntityTypeDefinition[];
  edge_types: EdgeTypeDefinition[];
  analysis_summary: string;
}

// ==================== 图谱数据类型 ====================

/** 图谱节点 */
export interface GraphNode {
  uuid: string;
  name: string;
  labels: string[];
  summary: string;
  attributes: Record<string, unknown>;
  created_at?: string;
}

/** 图谱边 */
export interface GraphEdge {
  uuid: string;
  name: string;
  fact: string;
  fact_type: string;
  source_node_uuid: string;
  target_node_uuid: string;
  source_node_name: string;
  target_node_name: string;
  attributes: Record<string, unknown>;
  created_at?: string;
  valid_at?: string;
  invalid_at?: string;
  expired_at?: string;
  episodes: string[];
}

/** 图谱数据 */
export interface GraphData {
  graph_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  node_count: number;
  edge_count: number;
}

/** 图谱信息 */
export interface GraphInfo {
  graph_id: string;
  node_count: number;
  edge_count: number;
  entity_types: string[];
}

// ==================== 人设数据类型 ====================

/** 实体人设 */
export interface EntityProfile {
  entity_id: string;
  entity_name: string;
  entity_type: string;

  // 基本信息
  full_name: string;
  age?: number;
  gender?: string;
  occupation?: string;
  position?: string;

  // 性格特点
  personality_traits: string[];
  speaking_style: string;

  // 社交媒体
  social_media_style: string;
  typical_posts: string[];

  // 观点倾向
  viewpoints: Record<string, string>;

  // 背景信息
  background: string;
  expertise?: string[];

  // 生成元数据
  generated_at: string;
  model?: string;
}

/** 人设生成选项 */
export interface ProfileGenerationOptions {
  includePersonality?: boolean;
  includeViewpoints?: boolean;
  includePosts?: boolean;
  language?: 'zh' | 'en';
}

// ==================== 任务类型 ====================

/** 任务状态 */
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** 任务信息 */
export interface TaskInfo {
  task_id: string;
  task_type: string;
  status: TaskStatus;
  progress: number;
  message: string;
  metadata?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  created_at: number;
  updated_at: number;
}

// ==================== API 请求/响应类型 ====================

/** 本体生成请求 */
export interface OntologyGenerateRequest {
  texts: string[];
  simulationRequirement: string;
  additionalContext?: string;
}

/** 本体生成响应 */
export interface OntologyGenerateResponse {
  success: boolean;
  ontology?: Ontology;
  error?: string;
}

/** 图谱构建请求 */
export interface GraphBuildRequest {
  text: string;
  ontology: Ontology;
  graphName?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  batchSize?: number;
}

/** 图谱构建响应 */
export interface GraphBuildResponse {
  success: boolean;
  taskId?: string;
  graphId?: string;
  error?: string;
}

/** 图谱状态响应 */
export interface GraphStatusResponse {
  success: boolean;
  status: TaskStatus;
  progress?: number;
  message?: string;
  graphId?: string;
  error?: string;
}

/** 人设生成请求 */
export interface ProfileGenerateRequest {
  entity: {
    name: string;
    type: string;
    description: string;
    attributes?: Record<string, unknown>;
  };
  simulationContext: string;
  options?: ProfileGenerationOptions;
}

/** 人设生成响应 */
export interface ProfileGenerateResponse {
  success: boolean;
  profile?: EntityProfile;
  error?: string;
}

/** 批量人设生成请求 */
export interface ProfileBatchGenerateRequest {
  entities: Array<{
    id: string;
    name: string;
    type: string;
    description: string;
    attributes?: Record<string, unknown>;
  }>;
  simulationContext: string;
  options?: ProfileGenerationOptions;
}

/** 批量人设生成响应 */
export interface ProfileBatchGenerateResponse {
  success: boolean;
  profiles?: EntityProfile[];
  error?: string;
}

// ==================== 常量 ====================

/** 本体生成常量 */
export const ONTOLOGY_CONSTANTS = {
  MAX_ENTITY_TYPES: 10,
  MAX_EDGE_TYPES: 10,
  MAX_TEXT_LENGTH: 50000,

  // 兜底类型
  FALLBACK_ENTITY_TYPES: {
    Person: {
      name: 'Person',
      description: 'Any individual person not fitting other specific person types.',
      attributes: [
        { name: 'full_name', type: 'text', description: 'Full name of the person' },
        { name: 'role', type: 'text', description: 'Role or occupation' },
      ],
      examples: ['ordinary citizen', 'anonymous netizen'],
    },
    Organization: {
      name: 'Organization',
      description: 'Any organization not fitting other specific organization types.',
      attributes: [
        { name: 'org_name', type: 'text', description: 'Name of the organization' },
        { name: 'org_type', type: 'text', description: 'Type of organization' },
      ],
      examples: ['small business', 'community group'],
    },
  },

  // 保留属性名（不能使用）
  RESERVED_ATTRIBUTES: ['name', 'uuid', 'group_id', 'name_embedding', 'summary', 'created_at'],
} as const;
