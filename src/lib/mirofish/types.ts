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

// ==================== 项目类型 ====================

/** 项目状态 */
export type ProjectStatus = 'created' | 'graph_built' | 'env_setup' | 'simulating' | 'report_generated' | 'completed';

/** 模型覆盖配置 — 运行时切换 LLM Provider */
export interface ModelOverride {
  provider: 'ollama' | 'openai' | 'custom';
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
}

/** 项目信息 */
export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  current_step: number; // 0-4 对应5个步骤
  simulation_requirement: string;
  texts: string[];
  ontology?: Ontology;
  graph_id?: string;
  simulation_id?: string;
  report_id?: string;
  model_config?: ModelOverride;
  created_at: string;
  updated_at: string;
}

/** 创建项目请求 */
export interface CreateProjectRequest {
  name: string;
  description?: string;
  simulation_requirement: string;
}

// ==================== 模拟类型 ====================

/** 平台类型 */
export type PlatformType = 'twitter' | 'reddit';

/** Agent动作类型 */
export type AgentActionType =
  | 'post'
  | 'comment'
  | 'like'
  | 'repost'
  | 'follow'
  | 'debate'
  | 'quote'
  | 'upvote'
  | 'downvote';

/** 模拟配置 */
export interface SimulationConfig {
  simulation_id: string;
  project_id: string;
  platforms: PlatformType[];
  round_count: number;
  posts_per_round: number;
  agents_per_round: number;
  temperature: number;
  seed_topics: string[];
  time_interval: number; // 秒
}

/** 模拟状态 */
export type SimulationStatus = 'created' | 'preparing' | 'running' | 'paused' | 'completed' | 'failed';

/** 模拟帖子 */
export interface SimulationPost {
  id: string;
  simulation_id: string;
  platform: PlatformType;
  round: number;
  author_id: string;
  author_name: string;
  author_type: string;
  action: AgentActionType;
  content: string;
  parent_id?: string; // 回复/评论的目标
  target_id?: string; // 转发/引用的目标
  likes: number;
  replies_count: number;
  reposts: number;
  sentiment: 'positive' | 'neutral' | 'negative';
  topics: string[];
  timestamp: string;
}

/** 模拟运行信息 */
export interface SimulationInfo {
  simulation_id: string;
  project_id: string;
  status: SimulationStatus;
  config: SimulationConfig;
  current_round: number;
  total_posts: number;
  total_comments: number;
  total_likes: number;
  participants: string[];
  agent_profiles: EntityProfile[];
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

/** Agent统计 */
export interface AgentStats {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  post_count: number;
  comment_count: number;
  like_count: number;
  repost_count: number;
  avg_sentiment: number;
  top_topics: string[];
}

/** 模拟时间线条目 */
export interface TimelineEntry {
  round: number;
  timestamp: string;
  posts: SimulationPost[];
  stats: {
    total_posts: number;
    sentiment_distribution: { positive: number; neutral: number; negative: number };
    hot_topics: string[];
    active_agents: number;
  };
}

// ==================== 报告类型 ====================

/** 报告状态 */
export type ReportStatus = 'generating' | 'completed' | 'failed';

/** 报告章节 */
export interface ReportSection {
  index: number;
  title: string;
  content: string;
  type: 'overview' | 'sentiment' | 'coalition' | 'timeline' | 'prediction' | 'conclusion';
}

/** 报告信息 */
export interface ReportInfo {
  report_id: string;
  simulation_id: string;
  project_id: string;
  status: ReportStatus;
  title: string;
  summary: string;
  sections: ReportSection[];
  key_findings: string[];
  sentiment_trend: Array<{ round: number; positive: number; neutral: number; negative: number }>;
  generated_at?: string;
  created_at: string;
  updated_at: string;
}

// ==================== 交互类型 ====================

/** 对话消息 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** 采访请求 */
export interface InterviewRequest {
  simulation_id: string;
  agent_id: string;
  question: string;
}

/** 采访响应 */
export interface InterviewResponse {
  agent_id: string;
  agent_name: string;
  question: string;
  answer: string;
  sentiment: string;
  confidence: number;
  timestamp: string;
}

// ==================== 进度回调类型 ====================

/** 抽取进度 */
export interface ExtractionProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
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
