/**
 * Milvus 向量数据库客户端管理器
 * 提供连接管理、集合操作、向量存储等功能
 * 
 * 已更新为使用统一配置系统 (milvus-config.ts)
 * 支持本地 Milvus 和 Zilliz Cloud 两种模式
 */

import {
  MilvusClient,
  DataType,
  FunctionType,
  MetricType,
  RANKER_TYPE,
  ConsistencyLevelEnum,
  type HybridSearchReq,
  type InsertReq,
  type QueryReq,
  type SearchSimpleReq,
} from '@zilliz/milvus2-sdk-node';
import {
  getMilvusConnectionConfig,
  isZillizCloud,
  getMilvusProvider,
} from './milvus-config';
import {
  buildScopedMilvusFilter,
  getDocumentSecurityFields,
  isServerDerivedScope,
  isTenantIsolationRequired,
  type RagRetrievalScope,
} from './security/retrieval-scope';
import type {
  MilvusHybridCapability,
  MilvusHybridHit,
  MilvusHybridSearchPort,
  MilvusHybridSearchRequest,
} from './rag/retrieval/hybrid-policy';


export type MilvusIndexType = 'AUTOINDEX' | 'IVF_FLAT' | 'IVF_SQ8' | 'IVF_PQ' | 'HNSW' | 'ANNOY' | 'FLAT';
export type MilvusMetricType = 'L2' | 'IP' | 'COSINE';
export type MilvusConsistencyLevel = keyof typeof ConsistencyLevelEnum | ConsistencyLevelEnum;
export type MilvusSearchOutputField =
  | 'id'
  | 'content'
  | 'source'
  | 'metadata_json'
  | 'created_at'
  | 'tenant_id'
  | 'corpus_id'
  | 'document_id'
  | 'trust_level'
  | 'document_version'
  | 'chunk_index'
  | 'total_chunks';

export interface MilvusSearchOptions {
  threshold?: number;
  filter?: string;
  exprValues?: Record<string, unknown>;
  searchParams?: Record<string, unknown>;
  consistencyLevel?: MilvusConsistencyLevel;
  ignoreGrowing?: boolean;
  groupByField?: string;
  groupSize?: number;
  strictGroupSize?: boolean;
  hints?: string;
  roundDecimal?: number;
  outputFields?: MilvusSearchOutputField[];
}

interface NormalizedMilvusSearchOptions {
  threshold: number;
  filter?: string;
  exprValues?: Record<string, unknown>;
  searchParams: Record<string, unknown>;
  consistencyLevel?: ConsistencyLevelEnum;
  ignoreGrowing?: boolean;
  groupByField?: string;
  groupSize?: number;
  strictGroupSize?: boolean;
  hints?: string;
  roundDecimal?: number;
  outputFields: MilvusSearchOutputField[];
}

type MilvusMetadata = Record<string, unknown>;
type MilvusField = {
  name?: string;
  data_type?: unknown;
  type_params?: unknown;
};
type MilvusTypeParam = {
  key?: unknown;
  value?: unknown;
};
type MilvusHit = {
  score?: number;
  distance?: number;
  id?: string;
  content?: string;
  source?: string;
  metadata_json?: string;
  tenant_id?: string;
  corpus_id?: string;
  document_id?: string;
  trust_level?: string;
};

export type MilvusQueryRow = Record<string, unknown> & {
  id?: string;
  content?: string;
  source?: string;
  metadata_json?: string;
  tenant_id?: string;
  corpus_id?: string;
  document_id?: string;
  trust_level?: string;
  document_version?: string;
  chunk_index?: number;
  total_chunks?: number;
};

// Milvus 配置接口（保持向后兼容）
export interface MilvusConfig {
  address?: string;          // Milvus 服务地址 (如: localhost:19530)
  username?: string;         // 用户名（可选）
  password?: string;         // 密码（可选）
  ssl?: boolean;             // 是否使用 SSL
  database?: string;         // 数据库名（默认: default）
  collectionName?: string;   // 集合名称（默认: rag_documents）
  embeddingDimension?: number; // 向量维度（默认: 768）
  indexType?: MilvusIndexType; // 索引类型
  metricType?: MilvusMetricType; // 距离度量类型
  token?: string;            // Zilliz Cloud API Token（新增）
  consistencyLevel?: MilvusConsistencyLevel; // 搜索一致性级别
  ignoreGrowing?: boolean;   // 是否跳过 growing segments
  groupByField?: string;     // 搜索结果按字段分组，提升来源多样性
  groupSize?: number;        // 每组返回结果数
  strictGroupSize?: boolean; // 是否严格填满每组
  flushOnInsert?: boolean;   // 插入后是否立即 flush
  reloadAfterInsert?: boolean; // 插入后是否 release/load 使结果立即可见
  searchParams?: Record<string, unknown>; // 全局搜索参数覆盖，如 nprobe/ef/radius
  searchOutputFields?: MilvusSearchOutputField[]; // 搜索返回字段，减少不必要字段传输可降低延迟
  debugLogs?: boolean;       // 是否输出 Milvus 热路径调试日志
}

const DEFAULT_SEARCH_OUTPUT_FIELDS: MilvusSearchOutputField[] = ['id', 'content', 'source', 'metadata_json'];

/**
 * T6: 瘦身 output_fields helper
 *
 * 用于不需要 metadata_json 的快速 retrieval 场景（如 lane-handlers、agentic-rag 的初筛阶段）。
 * 返回 ['id', 'content', 'source']，减少网络传输和反序列化开销。
 *
 * 不修改 DEFAULT_SEARCH_OUTPUT_FIELDS（visualize route 仍依赖 metadata_json）；
 * 调用方需要时显式传入：
 *   await milvus.search(embedding, topK, threshold, filter, { outputFields: getSlimSearchFields() });
 */
export function getSlimSearchFields(): MilvusSearchOutputField[] {
  return ['id', 'content', 'source'];
}

export function getScopedSearchFields(
  outputFields: readonly MilvusSearchOutputField[]
): MilvusSearchOutputField[] {
  return [
    ...new Set([
      ...outputFields,
      'tenant_id',
      'corpus_id',
      'document_id',
      'trust_level',
    ] as MilvusSearchOutputField[]),
  ];
}

export function getOrderedDocumentFields(
  metadata: Record<string, unknown> | undefined
): {
  document_version: string;
  chunk_index: number;
  total_chunks: number;
} {
  const versionCandidate = [
    metadata?.documentVersion,
    metadata?.document_version,
    metadata?.sourceHash,
    metadata?.source_hash,
  ].find(value => typeof value === 'string' && value.trim()) as string | undefined;
  const documentVersion = versionCandidate?.trim() || 'unversioned';
  if (documentVersion.length > 256 || /[\u0000-\u001f]/u.test(documentVersion)) {
    throw new Error('Milvus documentVersion is outside the safe scalar bounds.');
  }

  const chunkCandidate = metadata?.chunkIndex ?? metadata?.chunk_index ?? 0;
  const totalCandidate = metadata?.totalChunks ?? metadata?.total_chunks ?? 1;
  if (
    typeof chunkCandidate !== 'number'
    || !Number.isSafeInteger(chunkCandidate)
    || chunkCandidate < 0
  ) {
    throw new Error('Milvus chunkIndex must be a non-negative safe integer.');
  }
  if (
    typeof totalCandidate !== 'number'
    || !Number.isSafeInteger(totalCandidate)
    || totalCandidate < 1
    || chunkCandidate >= totalCandidate
  ) {
    throw new Error('Milvus totalChunks must contain the current chunk index.');
  }
  return {
    document_version: documentVersion,
    chunk_index: chunkCandidate,
    total_chunks: totalCandidate,
  };
}

// 文档接口
export interface MilvusDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: MilvusMetadata;
}

export const MILVUS_HYBRID_SCHEMA_VERSION = 'milvus-native-hybrid-schema/v1' as const;

export interface MilvusHybridRuntimeManifest {
  version: typeof MILVUS_HYBRID_SCHEMA_VERSION;
  collectionName: string;
  sourceCollectionName: string;
  corpusVersion: string;
  embeddingModel: string;
  embeddingDimension: number;
  rawTextField: 'content';
  denseVectorField: 'embedding';
  bm25OutputField: 'bm25_sparse';
  fusion: 'rrf' | 'weighted';
}

export class MilvusHybridProviderUnavailableError extends Error {
  readonly code = 'MILVUS_HYBRID_PROVIDER_UNAVAILABLE';

  constructor() {
    super('Milvus hybrid provider is unavailable.');
    this.name = 'MilvusHybridProviderUnavailableError';
  }
}

export class MilvusHybridEvidenceIntegrityError extends Error {
  readonly code = 'MILVUS_HYBRID_EVIDENCE_INTEGRITY';

  constructor(message: string) {
    super(message);
    this.name = 'MilvusHybridEvidenceIntegrityError';
  }
}

const MILVUS_HYBRID_CAPABILITY_CACHE_TTL_MS = 30_000;

export function createMilvusHybridRuntimeManifest(input: {
  sourceCollectionName: string;
  embeddingModel: string;
  embeddingDimension: number;
  env?: Record<string, string | undefined>;
}): MilvusHybridRuntimeManifest {
  const env = input.env ?? process.env;
  const sourceCollectionName = safeMilvusIdentifier(
    input.sourceCollectionName,
    'sourceCollectionName'
  );
  const requestedCollection = env.MILVUS_HYBRID_COLLECTION_NAME?.trim()
    || sourceCollectionName + '_hybrid_v1';
  if (!Number.isInteger(input.embeddingDimension) || input.embeddingDimension < 1) {
    throw new Error('Milvus hybrid embeddingDimension must be a positive integer.');
  }
  const fusion = env.MILVUS_HYBRID_FUSION?.trim().toLowerCase() || 'rrf';
  if (fusion !== 'rrf' && fusion !== 'weighted') {
    throw new Error('MILVUS_HYBRID_FUSION must be rrf or weighted.');
  }
  return {
    version: MILVUS_HYBRID_SCHEMA_VERSION,
    collectionName: safeMilvusIdentifier(requestedCollection, 'collectionName'),
    sourceCollectionName,
    corpusVersion: env.RAG_CORPUS_VERSION?.trim() || 'live-corpus-v1',
    embeddingModel: requiredMilvusHybridValue(input.embeddingModel, 'embeddingModel'),
    embeddingDimension: input.embeddingDimension,
    rawTextField: 'content',
    denseVectorField: 'embedding',
    bm25OutputField: 'bm25_sparse',
    fusion,
  };
}

// 搜索结果接口
export interface MilvusSearchResult {
  id: string;
  content: string;
  metadata: MilvusMetadata;
  score: number;
  distance: number;
}

// 集合统计信息
export interface CollectionStats {
  name: string;
  rowCount: number;
  embeddingDimension: number | null;  // null 表示集合为空，可以使用任何维度的模型
  indexType: string;
  metricType: string;
  loaded: boolean;
}

export function normalizeMilvusConsistencyLevel(
  level?: MilvusConsistencyLevel
): ConsistencyLevelEnum | undefined {
  if (level === undefined || level === null) return undefined;
  if (typeof level === 'number' && Object.values(ConsistencyLevelEnum).includes(level)) {
    return level;
  }
  if (typeof level === 'string') {
    const normalized = level.trim().toLowerCase();
    const match = Object.entries(ConsistencyLevelEnum).find(([key]) => key.toLowerCase() === normalized);
    if (match && typeof match[1] === 'number') return match[1] as ConsistencyLevelEnum;
  }
  throw new Error(`Unsupported Milvus consistency level: ${String(level)}`);
}

export function buildMilvusSearchParams(
  indexType: MilvusIndexType,
  ...overrides: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  let baseParams: Record<string, unknown> = {};
  switch (indexType) {
    case 'IVF_FLAT':
    case 'IVF_SQ8':
    case 'IVF_PQ':
      baseParams = { nprobe: 16 };
      break;
    case 'HNSW':
      baseParams = { ef: 64 };
      break;
    case 'ANNOY':
      baseParams = { search_k: -1 };
      break;
    case 'AUTOINDEX':
    case 'FLAT':
    default:
      baseParams = {};
  }

  return Object.fromEntries(
    Object.entries(Object.assign({}, baseParams, ...overrides))
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

export function resolveMilvusSearchOptions(
  config: Required<MilvusConfig>,
  thresholdOrOptions: number | MilvusSearchOptions = 0.0,
  legacyFilter?: string
): NormalizedMilvusSearchOptions {
  const requestedOptions: MilvusSearchOptions =
    typeof thresholdOrOptions === 'number'
      ? { threshold: thresholdOrOptions, filter: legacyFilter }
      : thresholdOrOptions;

  const searchParams = buildMilvusSearchParams(
    config.indexType,
    config.searchParams,
    requestedOptions.searchParams
  );

  return {
    threshold: requestedOptions.threshold ?? 0.0,
    filter: requestedOptions.filter ?? legacyFilter,
    exprValues: requestedOptions.exprValues,
    searchParams,
    consistencyLevel: normalizeMilvusConsistencyLevel(
      requestedOptions.consistencyLevel ?? config.consistencyLevel
    ),
    ignoreGrowing: requestedOptions.ignoreGrowing ?? config.ignoreGrowing,
    groupByField: (requestedOptions.groupByField ?? config.groupByField) || undefined,
    groupSize: (requestedOptions.groupSize ?? config.groupSize) || undefined,
    strictGroupSize: requestedOptions.strictGroupSize ?? config.strictGroupSize,
    hints: requestedOptions.hints,
    roundDecimal: requestedOptions.roundDecimal,
    outputFields: requestedOptions.outputFields ?? config.searchOutputFields,
  };
}

/**
 * 获取默认配置（从统一配置系统读取）
 */
function getDefaultConfig(): Required<MilvusConfig> {
  try {
    const connConfig = getMilvusConnectionConfig();
    return {
      address: connConfig.address,
      username: connConfig.username || '',
      password: connConfig.password || '',
      ssl: connConfig.ssl,
      database: connConfig.database || 'default',
      collectionName: connConfig.defaultCollection,
      embeddingDimension: connConfig.defaultDimension,
      indexType: connConfig.defaultIndexType,
      metricType: connConfig.defaultMetricType,
      token: connConfig.token || '',
      consistencyLevel: connConfig.defaultConsistencyLevel,
      ignoreGrowing: connConfig.ignoreGrowing,
      groupByField: connConfig.groupByField || '',
      groupSize: connConfig.groupSize || 0,
      strictGroupSize: connConfig.strictGroupSize,
      flushOnInsert: connConfig.flushOnInsert,
      reloadAfterInsert: connConfig.reloadAfterInsert,
      searchParams: connConfig.searchParams,
      searchOutputFields: connConfig.searchOutputFields as MilvusSearchOutputField[],
      debugLogs: connConfig.debugLogs,
    };
  } catch {
    // 如果配置系统不可用，使用硬编码默认值
    return {
      address: 'localhost:19530',
      username: '',
      password: '',
      ssl: false,
      database: 'default',
      collectionName: 'rag_documents',
      embeddingDimension: 768,
      indexType: 'IVF_FLAT',
      metricType: 'COSINE',
      token: '',
      consistencyLevel: 'Bounded',
      ignoreGrowing: false,
      groupByField: '',
      groupSize: 0,
      strictGroupSize: false,
      flushOnInsert: true,
      reloadAfterInsert: true,
      searchParams: {},
      searchOutputFields: DEFAULT_SEARCH_OUTPUT_FIELDS,
      debugLogs: false,
    };
  }
}

/**
 * Milvus 向量存储类
 * 支持本地 Milvus 和 Zilliz Cloud 两种模式
 */
export class MilvusVectorStore {
  private client: MilvusClient | null = null;
  private config: Required<MilvusConfig>;
  private isConnected: boolean = false;
  private isInitialized: boolean = false;
  private supportsTenantIsolation: boolean = false;
  private supportsOrderedContext: boolean = false;
  private readonly hybridCapabilityCache = new Map<
    string,
    { expiresAt: number; capability: MilvusHybridCapability }
  >();
  private readonly hybridCapabilityProbes = new Map<
    string, Promise<MilvusHybridCapability>
  >();

  constructor(config: MilvusConfig = {}) {
    const defaultConfig = getDefaultConfig();
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): Required<MilvusConfig> {
    return { ...this.config };
  }

  /** Whether the active collection has scalar tenant/corpus/trust fields. */
  hasTenantIsolationSchema(): boolean {
    return this.supportsTenantIsolation;
  }

  /** Whether the active collection can prove a complete deterministic chunk order. */
  hasOrderedContextSchema(): boolean {
    return this.supportsOrderedContext;
  }

  private debugLog(message: string, ...args: unknown[]): void {
    if (this.config.debugLogs) {
      console.log(message, ...args);
    }
  }

  /**
   * 连接到 Milvus 服务
   * 自动处理本地 Milvus 和 Zilliz Cloud 的连接差异
   */
  async connect(): Promise<void> {
    if (this.isConnected && this.client) {
      console.log('[Milvus] Already connected');
      return;
    }

    try {
      const provider = getMilvusProvider();
      const isCloud = isZillizCloud();

      console.log(`[Milvus] Connecting to ${this.config.address} (${provider})...`);

      if (isCloud && this.config.token) {
        // Zilliz Cloud 连接 - 使用 Token 认证
        console.log('[Milvus] Using Zilliz Cloud authentication');
        this.client = new MilvusClient({
          address: this.config.address,
          token: this.config.token,
          ssl: true, // Zilliz Cloud 必须使用 SSL
        });
      } else {
        // 本地 Milvus 连接 - 使用用户名密码认证（可选）
        console.log('[Milvus] Using local Milvus authentication');
        this.client = new MilvusClient({
          address: this.config.address,
          username: this.config.username || undefined,
          password: this.config.password || undefined,
          ssl: this.config.ssl,
        });
      }

      // 检查连接
      const health = await this.client.checkHealth();
      if (!health.isHealthy) {
        throw new Error('Milvus service is not healthy');
      }

      this.isConnected = true;
      console.log(`[Milvus] Connected successfully to ${provider}`);

      // 使用指定数据库
      if (this.config.database !== 'default') {
        try {
          await this.client.useDatabase({ db_name: this.config.database });
          console.log(`[Milvus] Using database: ${this.config.database}`);
        } catch (dbError) {
          console.warn(`[Milvus] Could not switch database: ${dbError}`);
        }
      }
    } catch (error) {
      this.isConnected = false;
      this.client = null;
      throw new Error(`Failed to connect to Milvus: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.closeConnection();
      this.client = null;
      this.isConnected = false;
      this.isInitialized = false;
      console.log('[Milvus] Disconnected');
    }
  }

  /**
   * 确保连接已建立
   */
  private async ensureConnected(): Promise<MilvusClient> {
    if (!this.isConnected || !this.client) {
      await this.connect();
    }
    return this.client!;
  }

  /**
   * 检查现有集合的 Schema 是否与我们的期望兼容
   */
  async checkSchemaCompatibility(): Promise<{
    compatible: boolean;
    supportsTenantIsolation?: boolean;
    supportsOrderedContext?: boolean;
    reason?: string;
    existingSchema?: unknown;
  }> {
    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    try {
      const hasCollection = await client.hasCollection({ collection_name: collectionName });
      if (!hasCollection.value) {
        this.supportsTenantIsolation = true;
        this.supportsOrderedContext = true;
        return { compatible: true, supportsTenantIsolation: true, supportsOrderedContext: true };
      }

      // 获取集合信息
      const collectionInfo = await client.describeCollection({ collection_name: collectionName });
      const fields = (collectionInfo.schema?.fields || []) as MilvusField[];

      // 检查必需字段
      const requiredFields = ['id', 'content', 'embedding', 'source', 'metadata_json', 'created_at'];
      const isolationFields = ['tenant_id', 'corpus_id', 'document_id', 'trust_level'];
      const orderedFields = ['document_version', 'chunk_index', 'total_chunks'];
      const existingFieldNames = fields.map((field) => field.name);
      const supportsTenantIsolation = isolationFields.every((field) => existingFieldNames.includes(field));
      const supportsOrderedContext = orderedFields.every((field) => existingFieldNames.includes(field));
      this.supportsOrderedContext = supportsOrderedContext;
      this.supportsTenantIsolation = supportsTenantIsolation;

      if (isTenantIsolationRequired() && !supportsTenantIsolation) {
        return {
          compatible: false,
          supportsTenantIsolation: false,
          reason: `缺少租户隔离字段: ${isolationFields.filter((field) => !existingFieldNames.includes(field)).join(', ')}`,
          existingSchema: fields,
        };
      }

      // 检查字段是否存在
      for (const required of requiredFields) {
        if (!existingFieldNames.includes(required)) {
          return {
            compatible: false,
            reason: `缺少必需字段: ${required}`,
            existingSchema: fields,
          };
        }
      }

      // 检查主键字段类型 (我们使用 VarChar，如果是 Int64 则不兼容)
      const idField = fields.find((field) => field.name === 'id');
      if (idField) {
        // data_type 可能是数字、字符串或枚举值
        // DataType.VarChar = 21, DataType.Int64 = 5
        const dataType = idField.data_type;
        const dataTypeStr = String(dataType).toLowerCase();
        const dataTypeNum = Number(dataType);
        
        // 检查是否为 VarChar 类型（支持多种表示方式）
        const isVarChar = 
          dataTypeStr === 'varchar' ||
          dataTypeStr === '21' ||
          dataTypeNum === 21 ||
          dataTypeNum === Number(DataType.VarChar);
        
        if (!isVarChar) {
          return {
            compatible: false,
            reason: `主键字段类型不兼容: 期望 VarChar，实际为 ${dataType} (${dataTypeStr})`,
            existingSchema: fields,
          };
        }
        console.log(`[Milvus] 主键字段类型检查通过: ${dataType} (${dataTypeStr})`);
      }

      // 检查向量维度
      const embeddingField = fields.find((field) => field.name === 'embedding');
      if (embeddingField?.type_params) {
        const existingDim = this.parseDimensionFromTypeParams(embeddingField.type_params);
        if (existingDim !== null && existingDim !== this.config.embeddingDimension) {
          return {
            compatible: false,
            reason: `向量维度不匹配: 集合为 ${existingDim}D，配置为 ${this.config.embeddingDimension}D`,
            existingSchema: fields,
          };
        }
      }

      return { compatible: true, supportsTenantIsolation, supportsOrderedContext };
    } catch (error) {
      console.warn('[Milvus] Schema compatibility check failed:', error);
      this.supportsTenantIsolation = false;
      if (isTenantIsolationRequired()) {
      this.supportsOrderedContext = false;
        return {
          compatible: false,
          supportsTenantIsolation: false,
          reason: '无法验证集合的租户隔离 Schema，已按 fail-closed 策略拒绝访问',
        };
      }
      return { compatible: true, supportsTenantIsolation: false, supportsOrderedContext: false };
    }
  }

  /**
   * 强制重建集合（删除现有集合并创建新的）
   */
  async recreateCollection(): Promise<void> {
    if (isTenantIsolationRequired()) {
      throw new Error('Global collection recreation is disabled while tenant isolation is required.');
    }
    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    console.log(`[Milvus] Recreating collection '${collectionName}'...`);

    // 删除现有集合
    const hasCollection = await client.hasCollection({ collection_name: collectionName });
    if (hasCollection.value) {
      console.log(`[Milvus] Dropping existing collection '${collectionName}'...`);
      await client.dropCollection({ collection_name: collectionName });
    }

    // 重置状态
    this.isInitialized = false;
    this.supportsTenantIsolation = false;

    // 创建新集合
    this.supportsOrderedContext = false;
    await this.initializeCollection();
    console.log(`[Milvus] Collection '${collectionName}' recreated successfully`);
  }

  /**
   * 初始化集合（创建 Schema 和索引）
   * @param autoRecreate 是否在维度不匹配时自动重建集合
   */
  async initializeCollection(autoRecreate: boolean = false): Promise<void> {
    if (autoRecreate && isTenantIsolationRequired()) {
      throw new Error('Automatic collection recreation is disabled while tenant isolation is required.');
    }
    if (this.isInitialized && !autoRecreate) {
      this.debugLog(`[Milvus] Collection '${this.config.collectionName}' already initialized`);
      return;
    }

    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    try {
      // 检查集合是否存在
      const hasCollection = await client.hasCollection({ collection_name: collectionName });

      if (hasCollection.value) {
        console.log(`[Milvus] Collection '${collectionName}' already exists`);

        // 检查 Schema 兼容性（主要是维度）
        const compatibility = await this.checkSchemaCompatibility();
        
        if (compatibility.compatible) {
          // 维度匹配，直接加载使用
          console.log(`[Milvus] Schema compatible, loading collection...`);
          await this.loadCollection();
          this.isInitialized = true;
          return;
        }
        
        // 维度不匹配
        console.warn(`[Milvus] ⚠️ Schema 不兼容: ${compatibility.reason}`);

        if (autoRecreate) {
          console.log(`[Milvus] 维度不匹配，自动重建集合...`);
          console.log(`[Milvus] Dropping existing collection '${collectionName}'...`);
          await client.dropCollection({ collection_name: collectionName });
          // 继续创建新集合
        } else {
          throw new Error(
            `集合 Schema 不兼容: ${compatibility.reason}。` +
            `请调用 recreateCollection() 方法重建集合，或在 Zilliz Cloud 控制台手动删除集合 '${collectionName}'。`
          );
        }
      }

      console.log(`[Milvus] Creating collection '${collectionName}'...`);

      console.log("this.config.embeddingDimension", this.config.embeddingDimension);

      // 创建集合
      await client.createCollection({
        collection_name: collectionName,
        fields: [
          {
            name: 'id',
            description: 'Primary key',
            data_type: DataType.VarChar,
            is_primary_key: true,
            max_length: 256,
          },
          {
            name: 'content',
            description: 'Document content',
            data_type: DataType.VarChar,
            max_length: 65535,
          },
          {
            name: 'embedding',
            description: 'Vector embedding',
            data_type: DataType.FloatVector,
            dim: this.config.embeddingDimension,
          },
          {
            name: 'source',
            description: 'Document source',
            data_type: DataType.VarChar,
            max_length: 1024,
          },
          {
            name: 'metadata_json',
            description: 'Metadata as JSON string',
            data_type: DataType.VarChar,
            max_length: 65535,
          },
          {
            name: 'created_at',
            description: 'Creation timestamp',
            data_type: DataType.Int64,
          },
          {
            name: 'tenant_id',
            description: 'Server-derived tenant isolation key',
            data_type: DataType.VarChar,
            max_length: 128,
          },
          {
            name: 'corpus_id',
            description: 'Server-derived corpus isolation key',
            data_type: DataType.VarChar,
            max_length: 128,
          },
          {
            name: 'document_id',
            description: 'Stable source document identifier',
            data_type: DataType.VarChar,
            max_length: 256,
          },
          {
            name: 'trust_level',
            description: 'Content trust boundary',
            data_type: DataType.VarChar,
            max_length: 32,
          },
          {
            name: 'document_version',
            description: 'Stable source document version',
            data_type: DataType.VarChar,
            max_length: 256,
          },
          {
            name: 'chunk_index',
            description: 'Zero-based chunk order within a document',
            data_type: DataType.Int64,
          },
          {
            name: 'total_chunks',
            description: 'Expected chunk count for the document version',
            data_type: DataType.Int64,
          }
        ],
      });

      console.log(`[Milvus] Collection '${collectionName}' created`);

      // 创建向量索引
      await this.createIndex();

      // 加载集合
      await this.loadCollection();

      this.supportsTenantIsolation = true;
      this.supportsOrderedContext = true;
      this.isInitialized = true;
      console.log(`[Milvus] Collection '${collectionName}' initialized successfully`);
    } catch (error) {
      throw new Error(`Failed to initialize collection: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 创建向量索引
   */
  private async createIndex(): Promise<void> {
    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    console.log(`[Milvus] Creating index for collection '${collectionName}'...`);

    // 根据索引类型设置参数
    let indexParams: Record<string, unknown> = {};
    switch (this.config.indexType) {
      case 'AUTOINDEX':
        indexParams = {};
        break;
      case 'IVF_FLAT':
        indexParams = { nlist: 128 };
        break;
      case 'IVF_SQ8':
        indexParams = { nlist: 128 };
        break;
      case 'IVF_PQ':
        indexParams = { nlist: 128, m: 8, nbits: 8 };
        break;
      case 'HNSW':
        indexParams = { M: 16, efConstruction: 256 };
        break;
      case 'ANNOY':
        indexParams = { n_trees: 8 };
        break;
      case 'FLAT':
      default:
        indexParams = {};
    }

    await client.createIndex({
      collection_name: collectionName,
      field_name: 'embedding',
      index_type: this.config.indexType,
      metric_type: this.config.metricType as MetricType,
      params: indexParams,
    });

    console.log(`[Milvus] Index created: ${this.config.indexType} with ${this.config.metricType}`);
  }

  /**
   * 加载集合到内存
   */
  async loadCollection(): Promise<void> {
    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    try {
      const loadState = await client.getLoadState({ collection_name: collectionName });

      if (loadState.state !== 'LoadStateLoaded') {
        console.log(`[Milvus] Loading collection '${collectionName}'...`);
        await client.loadCollection({ collection_name: collectionName });
        console.log(`[Milvus] Collection '${collectionName}' loaded`);
      }
    } catch (error) {
      console.warn(`[Milvus] Warning loading collection: ${error}`);
    }
  }

  /**
   * 释放集合
   */
  async releaseCollection(): Promise<void> {
    const client = await this.ensureConnected();
    await client.releaseCollection({ collection_name: this.config.collectionName });
    console.log(`[Milvus] Collection '${this.config.collectionName}' released`);
  }

  /**
   * 插入文档
   */
  async insertDocuments(documents: MilvusDocument[]): Promise<string[]> {
    if (
      isTenantIsolationRequired()
      && documents.some(document => !isServerDerivedScope(document.metadata))
    ) {
      throw new Error('Milvus insertion requires authenticated server-derived document scope.');
    }
    if (!this.isInitialized) {
      await this.initializeCollection();
    }

    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    console.log(`[Milvus] Preparing to insert ${documents.length} documents...`);

    // 验证所有文档的 embedding 维度一致
    const firstDimension = documents[0]?.embedding?.length;
    if (!firstDimension) {
      throw new Error('First document has no embedding or invalid embedding');
    }

    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      if (!doc.embedding || !Array.isArray(doc.embedding)) {
        console.error(`[Milvus] Document ${i} (id: ${doc.id}) has invalid embedding:`, doc.embedding);
        throw new Error(`Document ${i} (id: ${doc.id}) has invalid embedding`);
      }
      if (doc.embedding.length !== firstDimension) {
        console.error(`[Milvus] Dimension mismatch at document ${i}:`, {
          docId: doc.id,
          expected: firstDimension,
          actual: doc.embedding.length
        });
        throw new Error(`Document ${i} (id: ${doc.id}) has mismatched embedding dimension: expected ${firstDimension}D, got ${doc.embedding.length}D`);
      }
    }

    console.log(`[Milvus] ✅ All ${documents.length} documents have consistent embedding dimension: ${firstDimension}D`);

    // 使用简单的对象数组格式 (推荐格式)
    if (isTenantIsolationRequired() && !this.supportsTenantIsolation) {
      throw new Error('Active Milvus collection does not support required tenant isolation fields.');
    }

    const data = documents.map((doc) => {
      const base = {
        id: doc.id,
        content: doc.content.substring(0, 65000), // 限制长度
        embedding: doc.embedding,
        source: String(doc.metadata?.source || 'unknown').substring(0, 1024),
        metadata_json: JSON.stringify(doc.metadata || {}).substring(0, 65000),
        created_at: Date.now(),
      };
      const orderedFields = this.supportsOrderedContext
        ? getOrderedDocumentFields(doc.metadata)
        : {};
      if (!this.supportsTenantIsolation) return { ...base, ...orderedFields };

      return {
        ...base,
        ...orderedFields,
        ...getDocumentSecurityFields(doc.metadata, {
          tenantId: process.env.SUPABASE_DEFAULT_TENANT_ID || 'local',
          corpusId: process.env.SUPABASE_DEFAULT_CORPUS_ID || 'default',
          trustLevel: 'external',
        }),
      };
    });

    console.log(`[Milvus] Inserting ${documents.length} documents...`);
    console.log(`[Milvus] Sample document structure:`, {
      id: data[0].id,
      contentLength: data[0].content.length,
      embeddingDimension: data[0].embedding.length,
      source: data[0].source
    });

    const insertReq: InsertReq = {
      collection_name: collectionName,
      data: data,
    };

    const result = await client.insert(insertReq);

    if (result.status.error_code !== 'Success') {
      throw new Error(`Insert failed: ${result.status.reason}`);
    }

    console.log(`[Milvus] Inserted ${result.insert_cnt} documents`);

    if (this.config.flushOnInsert) {
      console.log(`[Milvus] Flushing data...`);
      await client.flushSync({ collection_names: [collectionName] });
    }

    if (this.config.reloadAfterInsert) {
      console.log(`[Milvus] Reloading collection to make new data searchable...`);
      try {
        await client.releaseCollection({ collection_name: collectionName });
        await client.loadCollection({ collection_name: collectionName });
        console.log(`[Milvus] Collection reloaded successfully`);
      } catch (reloadError) {
        console.warn(`[Milvus] Reload warning (may be OK):`, reloadError);
      }
    }

    // 返回所有文档的 ID
    return data.map(d => d.id);
  }
  async probeHybridCollection(input: {
    collectionName: string;
    signal?: AbortSignal;
  }): Promise<MilvusHybridCapability> {
    assertMilvusHybridNotAborted(input.signal);
    const collectionName = safeMilvusIdentifier(input.collectionName, 'collectionName');
    const cached = this.hybridCapabilityCache.get(collectionName);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.capability };
    }
    if (cached) this.hybridCapabilityCache.delete(collectionName);
    let probe = this.hybridCapabilityProbes.get(collectionName);
    if (!probe) {
      probe = this.performHybridCollectionProbe(collectionName);
      this.hybridCapabilityProbes.set(collectionName, probe);
      void probe.then(
        () => this.hybridCapabilityProbes.delete(collectionName),
        () => this.hybridCapabilityProbes.delete(collectionName)
      );
    }
    const capability = await probe;
    assertMilvusHybridNotAborted(input.signal);
    this.hybridCapabilityCache.set(collectionName, {
      expiresAt: Date.now() + MILVUS_HYBRID_CAPABILITY_CACHE_TTL_MS,
      capability: { ...capability },
    });
    return { ...capability };
  }

  private async performHybridCollectionProbe(
    collectionName: string
  ): Promise<MilvusHybridCapability> {
    try {
      const client = await this.ensureConnected();
      const exists = await client.hasCollection({ collection_name: collectionName });
      if (!exists.value) {
        return {
          nativeHybridSearch: typeof client.hybridSearch === 'function',
          bm25Function: false,
          schemaCompatible: false,
          provider: getMilvusProvider(),
          reason: 'collection_missing',
        };
      }
      const description = await client.describeCollection({ collection_name: collectionName });
      const fields = (description.schema?.fields ?? []) as Array<MilvusField & Record<string, unknown>>;
      const fieldNames = new Set(fields.map(field => field.name));
      const requiredScalars = [
        'id',
        'content',
        'source',
        'metadata_json',
        'tenant_id',
        'corpus_id',
        'document_id',
        'document_version',
        'trust_level',
        'chunk_index',
        'total_chunks',
      ];
      const rawText = fields.find(field => field.name === 'content');
      const dense = fields.find(field => field.name === 'embedding');
      const sparse = fields.find(field => field.name === 'bm25_sparse');
      const functions = [
        ...(description.schema?.functions ?? []),
        ...(description.functions ?? []),
      ];
      const bm25Function = functions.some(fn =>
        isBm25Function(fn, 'content', 'bm25_sparse')
      );
      const schemaCompatible =
        requiredScalars.every(field => fieldNames.has(field))
        && isMilvusFieldType(rawText, DataType.VarChar, 'VarChar')
        && isAnalyzerEnabled(rawText)
        && isMilvusFieldType(dense, DataType.FloatVector, 'FloatVector')
        && readMilvusFieldDimension(dense) === this.config.embeddingDimension
        && isMilvusFieldType(sparse, DataType.SparseFloatVector, 'SparseFloatVector')
        && Boolean(sparse?.is_function_output);
      let serverVersion: string | undefined;
      try {
        serverVersion = (await client.getVersion()).version;
      } catch {
        serverVersion = undefined;
      }
      return {
        nativeHybridSearch: typeof client.hybridSearch === 'function',
        bm25Function,
        schemaCompatible,
        provider: getMilvusProvider(),
        ...(serverVersion ? { serverVersion } : {}),
        ...(!schemaCompatible
          ? { reason: 'shadow_schema_incompatible' }
          : !bm25Function
            ? { reason: 'bm25_function_missing' }
            : {}),
      };
    } catch {
      return {
        nativeHybridSearch: false,
        bm25Function: false,
        schemaCompatible: false,
        provider: getMilvusProvider(),
        reason: 'capability_probe_failed',
      };
    }
  }

  private invalidateHybridCapabilityCache(collectionName: string): void {
    this.hybridCapabilityCache.delete(collectionName);
    this.hybridCapabilityProbes.delete(collectionName);
  }

  async initializeHybridCollection(manifest: MilvusHybridRuntimeManifest): Promise<void> {
    assertHybridManifestMatchesStore(manifest, this.config);
    this.invalidateHybridCapabilityCache(manifest.collectionName);
    const client = await this.ensureConnected();
    const exists = await client.hasCollection({ collection_name: manifest.collectionName });
    if (exists.value) {
      const capability = await this.probeHybridCollection({
        collectionName: manifest.collectionName,
      });
      if (
        !capability.nativeHybridSearch
        || !capability.bm25Function
        || !capability.schemaCompatible
      ) {
        throw new Error('Existing Milvus hybrid shadow collection is incompatible.');
      }
      return;
    }

    await client.createCollection({
      collection_name: manifest.collectionName,
      description: manifest.version,
      properties: {
        rag_schema_version: manifest.version,
        rag_source_collection: manifest.sourceCollectionName,
        rag_corpus_version: manifest.corpusVersion,
        rag_embedding_model: manifest.embeddingModel,
      },
      fields: [
        {
          name: 'id',
          description: 'Primary key',
          data_type: DataType.VarChar,
          is_primary_key: true,
          max_length: 256,
        },
        {
          name: 'content',
          description: 'Raw source passage used by BM25 and generation',
          data_type: DataType.VarChar,
          max_length: 65535,
          enable_analyzer: true,
          enable_match: true,
        },
        {
          name: 'embedding',
          description: 'Dense embedding; contextual text is never persisted here',
          data_type: DataType.FloatVector,
          dim: manifest.embeddingDimension,
        },
        {
          name: 'bm25_sparse',
          description: 'Server-generated BM25 sparse vector',
          data_type: DataType.SparseFloatVector,
          is_function_output: true,
        },
        { name: 'source', data_type: DataType.VarChar, max_length: 1024 },
        { name: 'metadata_json', data_type: DataType.VarChar, max_length: 65535 },
        { name: 'created_at', data_type: DataType.Int64 },
        { name: 'tenant_id', data_type: DataType.VarChar, max_length: 128 },
        { name: 'corpus_id', data_type: DataType.VarChar, max_length: 128 },
        { name: 'document_id', data_type: DataType.VarChar, max_length: 256 },
        { name: 'document_version', data_type: DataType.VarChar, max_length: 256 },
        { name: 'trust_level', data_type: DataType.VarChar, max_length: 32 },
        { name: 'chunk_index', data_type: DataType.Int64 },
        { name: 'total_chunks', data_type: DataType.Int64 },
        { name: 'start_offset', data_type: DataType.Int64, nullable: true },
        { name: 'end_offset', data_type: DataType.Int64, nullable: true },
      ],
      functions: [{
        name: 'bm25_fn',
        description: 'Generate BM25 sparse vectors from raw source passages',
        type: FunctionType.BM25,
        input_field_names: ['content'],
        output_field_names: ['bm25_sparse'],
        params: {},
      }],
    });
    await client.createIndex({
      collection_name: manifest.collectionName,
      field_name: 'embedding',
      index_type: 'AUTOINDEX',
      metric_type: 'COSINE',
      params: {},
    });
    await client.createIndex({
      collection_name: manifest.collectionName,
      field_name: 'bm25_sparse',
      index_type: 'SPARSE_INVERTED_INDEX',
      metric_type: 'BM25',
      params: {},
    });
    await client.loadCollection({ collection_name: manifest.collectionName });
    this.invalidateHybridCapabilityCache(manifest.collectionName);
  }

  async insertHybridDocuments(
    manifest: MilvusHybridRuntimeManifest,
    documents: MilvusDocument[]
  ): Promise<string[]> {
    assertHybridManifestMatchesStore(manifest, this.config);
    if (
      isTenantIsolationRequired()
      && documents.some(document => !isServerDerivedScope(document.metadata))
    ) {
      throw new Error('Milvus hybrid insertion requires authenticated server-derived scope.');
    }
    await this.initializeHybridCollection(manifest);
    const client = await this.ensureConnected();
    const data = documents.map((document, index) => {
      if (
        !Array.isArray(document.embedding)
        || document.embedding.length !== manifest.embeddingDimension
        || document.embedding.some(value => !Number.isFinite(value))
      ) {
        throw new Error('Hybrid document embedding is invalid at index ' + index + '.');
      }
      const security = getDocumentSecurityFields(document.metadata, {
        tenantId: process.env.SUPABASE_DEFAULT_TENANT_ID || 'local',
        corpusId: process.env.SUPABASE_DEFAULT_CORPUS_ID || 'default',
        trustLevel: 'external',
      });
      const ordered = getOrderedDocumentFields(document.metadata);
      const startOffset = optionalMilvusHybridInteger(
        document.metadata.startOffset ?? document.metadata.start_offset,
        'startOffset'
      );
      const endOffset = optionalMilvusHybridInteger(
        document.metadata.endOffset ?? document.metadata.end_offset,
        'endOffset'
      );
      return {
        id: document.id,
        content: document.content.substring(0, 65000),
        embedding: document.embedding,
        source: String(document.metadata.source || 'unknown').substring(0, 1024),
        metadata_json: JSON.stringify(document.metadata || {}).substring(0, 65000),
        created_at: Date.now(),
        ...security,
        ...ordered,
        ...(startOffset === undefined ? {} : { start_offset: startOffset }),
        ...(endOffset === undefined ? {} : { end_offset: endOffset }),
      };
    });
    const result = await client.insert({
      collection_name: manifest.collectionName,
      data,
    });
    if (result.status.error_code !== 'Success') {
      throw new Error('Hybrid shadow insert failed: ' + result.status.reason);
    }
    if (this.config.flushOnInsert) {
      await client.flushSync({ collection_names: [manifest.collectionName] });
    }
    return data.map(row => row.id);
  }

  /**
   * Delete an exact set of dense rows inside an authenticated tenant/corpus/trust scope.
   * This is intentionally separate from the legacy global delete port so compensation
   * can never widen into a cross-tenant mutation.
   */
  async deleteScopedDocuments(
    ids: string[],
    scope: RagRetrievalScope
  ): Promise<void> {
    if (!this.supportsTenantIsolation) {
      throw new Error('Active Milvus collection does not support scoped document deletion.');
    }
    await this.deleteScopedCollectionDocuments(this.config.collectionName, ids, scope);
  }

  /**
   * Best-effort counterpart for a hybrid write whose RPC may have committed before
   * reporting failure (for example, a later flush failure). A missing collection is
   * already equivalent to a successful compensation.
   */
  async deleteScopedHybridDocuments(
    manifest: MilvusHybridRuntimeManifest,
    ids: string[],
    scope: RagRetrievalScope
  ): Promise<void> {
    assertHybridManifestMatchesStore(manifest, this.config);
    const client = await this.ensureConnected();
    const exists = await client.hasCollection({ collection_name: manifest.collectionName });
    if (!exists.value) return;
    await this.deleteScopedCollectionDocuments(manifest.collectionName, ids, scope, client);
  }

  private async deleteScopedCollectionDocuments(
    collectionName: string,
    ids: string[],
    scope: RagRetrievalScope,
    connectedClient?: MilvusClient
  ): Promise<void> {
    if (scope.enforceIsolation !== true) {
      throw new Error('Scoped Milvus deletion requires enforced tenant isolation.');
    }
    const normalizedIds = normalizeScopedMilvusDeleteIds(ids);
    const scoped = buildScopedMilvusFilter(scope);
    if (!scoped.filter || !scoped.exprValues || !isServerDerivedScope(scoped)) {
      throw new Error('Scoped Milvus deletion requires a server-derived exact scope.');
    }
    const client = connectedClient ?? await this.ensureConnected();
    const result = await client.delete({
      collection_name: safeMilvusIdentifier(collectionName, 'collectionName'),
      filter: scoped.filter + ' && id in {documentIds}',
      exprValues: {
        ...scoped.exprValues,
        documentIds: normalizedIds,
      },
    });
    if (result.status.error_code !== 'Success') {
      throw new Error('Scoped Milvus compensation delete failed.');
    }
    if (this.config.flushOnInsert) {
      await client.flushSync({ collection_names: [collectionName] });
    }
  }

  createHybridSearchPort(
    manifest: MilvusHybridRuntimeManifest
  ): MilvusHybridSearchPort {
    assertHybridManifestMatchesStore(manifest, this.config);
    return {
      probe: input => {
        assertRequestedHybridCollection(input.collectionName, manifest.collectionName);
        return this.probeHybridCollection(input);
      },
      search: request => {
        assertRequestedHybridCollection(request.collectionName, manifest.collectionName);
        return this.searchHybridCollection(request, manifest);
      },
    };
  }

  async searchHybridCollection(
    request: MilvusHybridSearchRequest,
    manifest: MilvusHybridRuntimeManifest
  ): Promise<MilvusHybridHit[]> {
    assertHybridManifestMatchesStore(manifest, this.config);
    assertRequestedHybridCollection(request.collectionName, manifest.collectionName);
    assertMilvusHybridNotAborted(request.signal);
    const scoped = buildScopedMilvusFilter(request.scope);
    const client = await this.ensureConnected();
    const rerank = request.fusion === 'weighted'
      ? { strategy: RANKER_TYPE.WEIGHTED, params: { weights: [0.5, 0.5] } }
      : { strategy: RANKER_TYPE.RRF, params: { k: 60 } };
    try {
      const result = await client.hybridSearch({
        collection_name: manifest.collectionName,
        data: [
          {
            anns_field: manifest.denseVectorField,
            data: request.denseEmbedding,
            expr: scoped.filter,
            exprValues: scoped.exprValues,
            params: buildMilvusSearchParams(this.config.indexType),
          },
          {
            anns_field: manifest.bm25OutputField,
            data: request.query,
            expr: scoped.filter,
            exprValues: scoped.exprValues,
            params: {},
          },
        ],
        output_fields: [
          'id',
          'content',
          'source',
          'metadata_json',
          'tenant_id',
          'corpus_id',
          'document_id',
          'document_version',
          'trust_level',
          'chunk_index',
          'total_chunks',
          'start_offset',
          'end_offset',
        ],
        limit: request.topK,
        rerank,
        consistency_level: normalizeMilvusConsistencyLevel(this.config.consistencyLevel),
      } as HybridSearchReq);
      assertMilvusHybridNotAborted(request.signal);
      if (result.status.error_code !== 'Success') {
        throw new MilvusHybridProviderUnavailableError();
      }

      // Native fused output does not prove lexical membership. Query BM25 alone
      // and retain only fused candidates that have a bounded lexical match.
      const lexical = await client.search({
        collection_name: manifest.collectionName,
        data: [request.query],
        anns_field: manifest.bm25OutputField,
        limit: Math.min(100, Math.max(request.topK, request.topK * 2)),
        output_fields: ['id'],
        filter: scoped.filter,
        exprValues: scoped.exprValues,
        params: {},
        consistency_level: normalizeMilvusConsistencyLevel(this.config.consistencyLevel),
      } as SearchSimpleReq);
      assertMilvusHybridNotAborted(request.signal);
      if (lexical.status.error_code !== 'Success') {
        throw new MilvusHybridProviderUnavailableError();
      }
      const lexicalIds = new Set(
        flattenMilvusHits(lexical.results).map(hit => String(hit.id ?? ''))
      );
      return flattenMilvusHits(result.results)
        .filter(hit => lexicalIds.has(String(hit.id ?? '')))
        .map(hit => adaptNativeHybridHit(hit, request.scope));
    } catch (error) {
      if (request.signal?.aborted) throw createMilvusHybridAbortError();
      if (error instanceof MilvusHybridEvidenceIntegrityError) throw error;
      if (error instanceof MilvusHybridProviderUnavailableError) throw error;
      throw new MilvusHybridProviderUnavailableError();
    }
  }


  /** Read a single bounded snapshot using the server-owned retrieval scope. */
  async queryOrderedCorpusRows(
    scope: RagRetrievalScope,
    maxChunks: number = 256
  ): Promise<MilvusQueryRow[]> {
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 512) {
      throw new Error('Milvus ordered corpus maxChunks must be between 1 and 512.');
    }
    if (!this.isInitialized) {
      await this.initializeCollection();
    }
    if (!this.supportsOrderedContext) {
      throw new Error('Milvus ordered context scalar schema is unavailable.');
    }

    const scopedFilter = buildScopedMilvusFilter(scope);
    if (isTenantIsolationRequired() && !isServerDerivedScope(scopedFilter)) {
      throw new Error('Milvus ordered corpus query requires a server-derived scope.');
    }
    const client = await this.ensureConnected();
    const result = await client.query({
      collection_name: this.config.collectionName,
      output_fields: [
        'id',
        'content',
        'source',
        'metadata_json',
        'tenant_id',
        'corpus_id',
        'document_id',
        'trust_level',
        'document_version',
        'chunk_index',
        'total_chunks',
      ],
      limit: maxChunks + 1,
      filter: scopedFilter.filter,
      exprValues: scopedFilter.exprValues,
      consistency_level: normalizeMilvusConsistencyLevel(this.config.consistencyLevel),
      order_by_fields: [
        { field: 'document_id', order: 'asc' },
        { field: 'document_version', order: 'asc' },
        { field: 'chunk_index', order: 'asc' },
      ],
    } as QueryReq);
    if (result.status.error_code !== 'Success') {
      throw new Error('Ordered corpus query failed: ' + result.status.reason);
    }
    return Array.isArray(result.data) ? result.data as MilvusQueryRow[] : [];
  }

  /**
   * 相似度搜索
   */
  async search(
    queryEmbedding: number[],
    topK: number = 5,
    threshold: number | MilvusSearchOptions = 0.0,
    filter?: string
  ): Promise<MilvusSearchResult[]> {
    if (
      isTenantIsolationRequired()
      && (
        typeof threshold !== 'object'
        || threshold === null
        || !isServerDerivedScope(threshold)
      )
    ) {
      throw new Error('Milvus search requires an authenticated server-derived scope.');
    }
    if (!this.isInitialized) {
      await this.initializeCollection();
    }

    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;
    const searchOptions = resolveMilvusSearchOptions(this.config, threshold, filter);
    if (isTenantIsolationRequired()) {
      searchOptions.outputFields = getScopedSearchFields(searchOptions.outputFields);
    }

    const searchReq = {
      collection_name: collectionName,
      data: [queryEmbedding],
      anns_field: 'embedding',
      limit: topK,
      output_fields: searchOptions.outputFields,
      params: searchOptions.searchParams,
      filter: searchOptions.filter,
      exprValues: searchOptions.exprValues,
      consistency_level: searchOptions.consistencyLevel,
      ignore_growing: searchOptions.ignoreGrowing,
      group_by_field: searchOptions.groupByField,
      group_size: searchOptions.groupSize,
      strict_group_size: searchOptions.strictGroupSize,
      hints: searchOptions.hints,
      round_decimal: searchOptions.roundDecimal,
    } as SearchSimpleReq;

    const results = await client.search(searchReq);

    this.debugLog('[Milvus] Search response status:', results.status);
    this.debugLog('[Milvus] Search results type:', typeof results.results, Array.isArray(results.results));
    this.debugLog('[Milvus] Search results length:', results.results?.length);

    if (results.status.error_code !== 'Success') {
      throw new Error(`Search failed: ${results.status.reason}`);
    }

    // 转换结果
    const searchResults: MilvusSearchResult[] = [];

    // Milvus SDK 2.x 返回的 results.results 直接是数组
    // 但如果是多向量查询，可能是嵌套数组
    let hits: unknown[] = [];

    const rawResults = results.results as unknown;
    if (Array.isArray(rawResults)) {
      if (rawResults.length > 0) {
        // 检查是否是嵌套数组（多向量查询）
        if (Array.isArray(rawResults[0])) {
          hits = rawResults[0];
        } else {
          // 单向量查询，直接使用
          hits = rawResults;
        }
      }
    }

    this.debugLog('[Milvus] Parsed hits count:', hits.length);
    if (hits.length > 0) {
      this.debugLog('[Milvus] First hit sample:', JSON.stringify(hits[0]).substring(0, 200));
    }

    if (hits.length === 0) {
      console.warn('[Milvus] No search results returned');
      return [];
    }

    let filteredCount = 0;
    for (const hit of hits) {
      // 计算相似度 (根据度量类型转换)
      let similarity: number;
      const hitData = hit as MilvusHit;
      const rawScore = hitData.score;
      const rawDistance = hitData.distance;
      const distance = rawScore ?? rawDistance ?? 0;

      switch (this.config.metricType) {
        case 'COSINE':
          // Milvus COSINE 度量：
          // - SDK 2.x 返回的 score 是相似度（0-1，越大越相似）
          // - 如果返回的是 distance，则是 1 - cosine_similarity
          // 判断：如果值在合理的相似度范围（0-1）且更可能是相似度，则直接使用
          if (rawScore !== undefined && rawScore >= 0 && rawScore <= 1) {
            // score 字段存在且在 [0,1] 范围内，视为相似度
            similarity = rawScore;
          } else {
            // 否则视为距离，进行转换
            similarity = 1 - distance;
          }
          break;
        case 'IP':
          // Inner Product，越大越相似
          similarity = distance;
          break;
        case 'L2':
          // L2 距离，越小越相似，转换为相似度
          similarity = 1 / (1 + distance);
          break;
        default:
          similarity = distance;
      }

      // 应用阈值过滤
      if (similarity < searchOptions.threshold) {
        filteredCount++;
        continue;
      }

      let metadata: MilvusMetadata = {};
      try {
        metadata = JSON.parse(hitData.metadata_json || '{}');
      } catch {
        metadata = { source: hitData.source };
      }

      searchResults.push({
        id: hitData.id || '',
        content: hitData.content || '',
        metadata: {
          ...metadata,
          source: hitData.source,
          ...(hitData.tenant_id
            ? { tenant_id: hitData.tenant_id, tenantId: hitData.tenant_id }
            : {}),
          ...(hitData.corpus_id
            ? { corpus_id: hitData.corpus_id, corpusId: hitData.corpus_id }
            : {}),
          ...(hitData.document_id
            ? { document_id: hitData.document_id, documentId: hitData.document_id }
            : {}),
          ...(hitData.trust_level
            ? { trust_level: hitData.trust_level, trustLevel: hitData.trust_level }
            : {}),
        },
        score: similarity,
        distance: distance,
      });
    }

    if (filteredCount > 0) {
      console.log(`[Milvus] 阈值过滤: ${filteredCount} 个结果低于阈值 ${searchOptions.threshold}`);
    }
    console.log(`[Milvus] 返回 ${searchResults.length} 个结果 (threshold=${searchOptions.threshold})`);

    return searchResults;
  }

  /**
   * 删除文档
   */
  async deleteDocuments(ids: string[]): Promise<void> {
    if (isTenantIsolationRequired()) {
      throw new Error('Global document deletion is disabled while tenant isolation is required.');
    }
    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    const expr = `id in [${ids.map(id => `"${id}"`).join(',')}]`;

    await client.delete({
      collection_name: collectionName,
      filter: expr,
    });

    console.log(`[Milvus] Deleted ${ids.length} documents`);
  }

  /**
   * 清空集合
   */
  async clearCollection(): Promise<void> {
    if (isTenantIsolationRequired()) {
      throw new Error('Global collection clearing is disabled while tenant isolation is required.');
    }
    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    // 删除并重建集合
    const hasCollection = await client.hasCollection({ collection_name: collectionName });

    if (hasCollection.value) {
      await client.dropCollection({ collection_name: collectionName });
      console.log(`[Milvus] Collection '${collectionName}' dropped`);
    }

    this.isInitialized = false;
    await this.initializeCollection();
  }

  /**
   * 从 type_params 解析维度
   * 支持两种格式：
   * - 对象格式 (Milvus SDK v2.6+): { dim: "1024" } 或 { dim: 1024 }
   * - 数组格式 (旧版): [{ key: 'dim', value: '1024' }]
   */
  private parseDimensionFromTypeParams(typeParams: unknown): number | null {
    if (!typeParams) return null;

    // 格式 1: 对象格式 { dim: "1024" } (Milvus SDK v2.6+)
    if (typeof typeParams === 'object' && !Array.isArray(typeParams) && 'dim' in typeParams) {
      const dim = parseInt(String((typeParams as { dim?: unknown }).dim), 10);
      if (!isNaN(dim) && dim > 0) {
        return dim;
      }
    }

    // 格式 2: 数组格式 [{ key: 'dim', value: '1024' }] (旧版)
    if (Array.isArray(typeParams)) {
      const dimParam = (typeParams as MilvusTypeParam[]).find((param) => param.key === 'dim');
      if (dimParam?.value !== undefined) {
        const dim = parseInt(String(dimParam.value), 10);
        if (!isNaN(dim) && dim > 0) {
          return dim;
        }
      }
    }

    return null;
  }

  /**
   * 获取集合统计信息
   */
  async getCollectionStats(): Promise<CollectionStats | null> {
    try {
      const client = await this.ensureConnected();
      const collectionName = this.config.collectionName;

      const hasCollection = await client.hasCollection({ collection_name: collectionName });
      if (!hasCollection.value) {
        return null;
      }

      const stats = await client.getCollectionStatistics({ collection_name: collectionName });
      const loadState = await client.getLoadState({ collection_name: collectionName });

      const rowCount = parseInt(stats.data.row_count || '0');

      // 始终从集合 schema 获取实际的向量维度
      // 维度在集合创建时就已确定，与是否有数据无关
      let actualDimension: number | null = null;

      try {
        const collectionInfo = await client.describeCollection({ collection_name: collectionName });
        console.log(`[Milvus] describeCollection response fields:`, 
          JSON.stringify((collectionInfo.schema?.fields as MilvusField[] | undefined)?.map((field) => ({
            name: field.name,
            type_params: field.type_params
          })), null, 2)
        );
        
        const embeddingField = (collectionInfo.schema?.fields as MilvusField[] | undefined)?.find(
          (field) => field.name === 'embedding'
        );
        
        if (embeddingField) {
          actualDimension = this.parseDimensionFromTypeParams(embeddingField.type_params);
          if (actualDimension) {
            console.log(`[Milvus] Collection dimension from schema: ${actualDimension}D (${rowCount} rows)`);
          }
        }
      } catch (schemaError) {
        console.warn('[Milvus] Could not get schema dimension:', schemaError);
      }

      // 如果无法从 schema 获取维度，使用配置值作为 fallback
      if (!actualDimension) {
        actualDimension = this.config.embeddingDimension;
        console.log(`[Milvus] Using config dimension as fallback: ${actualDimension}D`);
      }

      return {
        name: collectionName,
        rowCount,
        embeddingDimension: actualDimension,
        indexType: this.config.indexType,
        metricType: this.config.metricType,
        loaded: loadState.state === 'LoadStateLoaded',
      };
    } catch (error) {
      console.error('[Milvus] Error getting stats:', error);
      return null;
    }
  }

  /**
   * 检查健康状态
   */
  async checkHealth(): Promise<{ healthy: boolean; message: string }> {
    try {
      const client = await this.ensureConnected();
      const health = await client.checkHealth();

      return {
        healthy: health.isHealthy,
        message: health.isHealthy ? 'Milvus is healthy' : 'Milvus is not healthy',
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 获取文档数量
   */
  async getDocumentCount(): Promise<number> {
    const stats = await this.getCollectionStats();
    return stats?.rowCount || 0;
  }

  /**
   * 更新配置（需要重新连接）
   */
  async updateConfig(newConfig: Partial<MilvusConfig>): Promise<void> {
    await this.disconnect();
    this.config = { ...this.config, ...newConfig };
    await this.connect();
  }

  /**
   * 获取连接状态
   */
  isReady(): boolean {
    return this.isConnected && this.isInitialized;
  }
}

function safeMilvusIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(normalized)) {
    throw new Error('Milvus hybrid ' + field + ' must be a safe identifier.');
  }
  return normalized;
}

function normalizeScopedMilvusDeleteIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 4_096) {
    throw new Error('Scoped Milvus deletion requires between 1 and 4096 document IDs.');
  }
  const normalized = ids.map((id, index) => {
    if (
      typeof id !== 'string'
      || !id.trim()
      || id.length > 256
      || /[\u0000-\u001f]/.test(id)
    ) {
      throw new Error('Scoped Milvus deletion received an invalid document ID at index ' + index + '.');
    }
    return id.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Scoped Milvus deletion requires unique document IDs.');
  }
  return normalized;
}

function requiredMilvusHybridValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Milvus hybrid ' + field + ' is required.');
  return normalized;
}

function assertHybridManifestMatchesStore(
  manifest: MilvusHybridRuntimeManifest,
  config: Required<MilvusConfig>
): void {
  safeMilvusIdentifier(manifest.collectionName, 'collectionName');
  if (manifest.sourceCollectionName !== config.collectionName) {
    throw new Error('Milvus hybrid manifest source collection does not match the active store.');
  }
  if (manifest.embeddingDimension !== config.embeddingDimension) {
    throw new Error('Milvus hybrid manifest embedding dimension does not match the active store.');
  }
}

function assertRequestedHybridCollection(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error('Milvus hybrid request collection does not match the server manifest.');
  }
}

function isMilvusFieldType(
  field: (MilvusField & Record<string, unknown>) | undefined,
  expected: DataType,
  name: string
): boolean {
  if (!field) return false;
  const candidates = [field.data_type, field.dataType].map(value => String(value).toLowerCase());
  return candidates.includes(String(expected).toLowerCase())
    || candidates.includes(name.toLowerCase());
}

function readMilvusFieldDimension(
  field: (MilvusField & Record<string, unknown>) | undefined
): number | null {
  if (!field) return null;
  const direct = Number(field.dim);
  if (Number.isSafeInteger(direct) && direct > 0) return direct;
  if (!Array.isArray(field.type_params)) return null;
  for (const item of field.type_params) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { key?: unknown; value?: unknown };
    if (String(entry.key).toLowerCase() !== 'dim') continue;
    const value = Number(entry.value);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function isAnalyzerEnabled(
  field: (MilvusField & Record<string, unknown>) | undefined
): boolean {
  if (!field) return false;
  if (field.enable_analyzer === true || field.enable_analyzer === 'true') return true;
  if (!Array.isArray(field.type_params)) return false;
  return field.type_params.some(item => {
    if (!item || typeof item !== 'object') return false;
    const entry = item as { key?: unknown; value?: unknown };
    return String(entry.key).toLowerCase() === 'enable_analyzer'
      && String(entry.value).toLowerCase() === 'true';
  });
}

function isBm25Function(
  fn: { type?: unknown; input_field_names?: string[]; output_field_names?: string[] },
  inputField: string,
  outputField: string
): boolean {
  const type = String(fn.type).toLowerCase();
  const bm25 = Number(fn.type) === Number(FunctionType.BM25) || type === 'bm25';
  return bm25
    && fn.input_field_names?.length === 1
    && fn.input_field_names[0] === inputField
    && fn.output_field_names?.length === 1
    && fn.output_field_names[0] === outputField;
}

function optionalMilvusHybridInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Milvus hybrid ' + field + ' must be a non-negative integer.');
  }
  return value as number;
}

function assertMilvusHybridNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createMilvusHybridAbortError();
}

function createMilvusHybridAbortError(): Error {
  const error = new Error('Milvus hybrid request was aborted.');
  error.name = 'AbortError';
  return error;
}

function flattenMilvusHits(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  if (value.length > 0 && Array.isArray(value[0])) {
    return (value[0] as unknown[]).filter(isRecord);
  }
  return value.filter(isRecord);
}

function adaptNativeHybridHit(
  hit: Record<string, unknown>,
  scope: RagRetrievalScope
): MilvusHybridHit {
  const id = requiredNativeHybridString(hit.id, 'id');
  const content = requiredNativeHybridString(hit.content, 'content');
  const tenantId = requiredNativeHybridString(hit.tenant_id, 'tenant_id');
  const corpusId = requiredNativeHybridString(hit.corpus_id, 'corpus_id');
  const documentId = requiredNativeHybridString(hit.document_id, 'document_id');
  const documentVersion = requiredNativeHybridString(hit.document_version, 'document_version');
  const trustLevel = requiredNativeHybridString(hit.trust_level, 'trust_level');
  if (tenantId !== scope.tenantId || corpusId !== scope.corpusId) {
    throw new MilvusHybridEvidenceIntegrityError(
      'Milvus hybrid hit scope does not match the authenticated scope.'
    );
  }
  const metadata = parseNativeHybridMetadata(hit.metadata_json);
  assertNativeHybridAlias(metadata, ['tenantId', 'tenant_id'], tenantId);
  assertNativeHybridAlias(metadata, ['corpusId', 'corpus_id'], corpusId);
  assertNativeHybridAlias(metadata, ['documentId', 'document_id'], documentId);
  assertNativeHybridAlias(metadata, ['documentVersion', 'document_version'], documentVersion);
  assertNativeHybridAlias(metadata, ['trustLevel', 'trust_level'], trustLevel);
  const score = Number(hit.score ?? hit.distance);
  if (!Number.isFinite(score)) {
    throw new MilvusHybridEvidenceIntegrityError('Milvus hybrid hit score is invalid.');
  }
  const chunkIndex = optionalMilvusHybridInteger(hit.chunk_index, 'chunk_index');
  const totalChunks = optionalMilvusHybridInteger(hit.total_chunks, 'total_chunks');
  const startOffset = optionalMilvusHybridInteger(hit.start_offset, 'start_offset');
  const endOffset = optionalMilvusHybridInteger(hit.end_offset, 'end_offset');
  if ((startOffset === undefined) !== (endOffset === undefined)) {
    throw new MilvusHybridEvidenceIntegrityError('Milvus hybrid hit span is incomplete.');
  }
  if (startOffset !== undefined && endOffset !== undefined && endOffset <= startOffset) {
    throw new MilvusHybridEvidenceIntegrityError('Milvus hybrid hit span is invalid.');
  }
  return {
    id,
    score,
    content,
    source: typeof hit.source === 'string' ? hit.source : undefined,
    metadata: {
      ...metadata,
      tenantId,
      tenant_id: tenantId,
      corpusId,
      corpus_id: corpusId,
      documentId,
      document_id: documentId,
      documentVersion,
      document_version: documentVersion,
      trustLevel,
      trust_level: trustLevel,
      lexicalMatch: true,
      ...(chunkIndex === undefined ? {} : { chunkIndex, chunk_index: chunkIndex }),
      ...(totalChunks === undefined ? {} : { totalChunks, total_chunks: totalChunks }),
      ...(startOffset === undefined
        ? {}
        : {
            startOffset,
            start_offset: startOffset,
            endOffset,
            end_offset: endOffset,
          }),
    },
  };
}

function parseNativeHybridMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || value.length > 65_000) {
    throw new MilvusHybridEvidenceIntegrityError('Milvus hybrid metadata is invalid.');
  }
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error('metadata must be an object');
    }
    return parsed;
  } catch {
    throw new MilvusHybridEvidenceIntegrityError('Milvus hybrid metadata is malformed.');
  }
}

function assertNativeHybridAlias(
  metadata: Record<string, unknown>,
  aliases: readonly string[],
  authoritative: string
): void {
  for (const alias of aliases) {
    if (metadata[alias] !== undefined && metadata[alias] !== authoritative) {
      throw new MilvusHybridEvidenceIntegrityError(
        'Milvus hybrid metadata contains conflicting ' + alias + '.'
      );
    }
  }
}

function requiredNativeHybridString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MilvusHybridEvidenceIntegrityError(
      'Milvus hybrid hit ' + field + ' is required.'
    );
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 全局实例缓存 - 按集合名称缓存不同的实例
const milvusInstances: Map<string, MilvusVectorStore> = new Map();

/**
 * 获取 Milvus 实例（按集合名称缓存，支持多集合并存）
 */
export function getMilvusInstance(config?: MilvusConfig): MilvusVectorStore {
  const collectionName = config?.collectionName || 'rag_documents';

  let instance = milvusInstances.get(collectionName);

  if (!instance) {
    // 创建新实例
    instance = new MilvusVectorStore(config);
    milvusInstances.set(collectionName, instance);
    console.log(`[Milvus] Created new instance for collection: ${collectionName}`);
  } else if (config) {
    // 检查维度配置是否变化
    const currentConfig = instance.getConfig();
    if (config.embeddingDimension && currentConfig.embeddingDimension !== config.embeddingDimension) {
      console.log(`[Milvus] Dimension changed for ${collectionName}, recreating instance...`);
      console.log(`[Milvus] Old: ${currentConfig.embeddingDimension}D, New: ${config.embeddingDimension}D`);
      // 断开旧连接并创建新实例
      instance.disconnect().catch(() => { });
      instance = new MilvusVectorStore(config);
      milvusInstances.set(collectionName, instance);
    }
  }

  console.log(`[Milvus] Using instance for collection: ${collectionName}`);
  return instance;
}

/**
 * 重置指定集合的 Milvus 实例
 */
export async function resetMilvusInstance(collectionName?: string): Promise<void> {
  if (collectionName) {
    const instance = milvusInstances.get(collectionName);
    if (instance) {
      await instance.disconnect();
      milvusInstances.delete(collectionName);
      console.log(`[Milvus] Reset instance for collection: ${collectionName}`);
    }
  } else {
    // 重置所有实例
    for (const [name, instance] of milvusInstances) {
      await instance.disconnect();
      console.log(`[Milvus] Disconnected from collection: ${name}`);
    }
    milvusInstances.clear();
    console.log('[Milvus] All instances reset');
  }
}

// Embedding 模型维度映射（包含 Ollama、SiliconFlow、OpenAI）
const MODEL_DIMENSIONS: Record<string, number> = {
  // Ollama 本地模型
  'nomic-embed-text': 768,
  'nomic-embed-text-v2-moe': 768,
  'mxbai-embed-large': 1024,
  'bge-large': 1024,
  'bge-m3': 1024,
  'snowflake-arctic-embed': 1024,
  'e5-large': 1024,
  'gte-large': 1024,
  'all-minilm': 384,
  'paraphrase-multilingual': 768,
  'qwen3-embedding': 1024,
  // SiliconFlow 云端模型
  'BAAI/bge-m3': 1024,
  'BAAI/bge-large-zh-v1.5': 1024,
  'BAAI/bge-large-en-v1.5': 1024,
  'Pro/BAAI/bge-m3': 1024,
  'Qwen/Qwen3-Embedding-8B': 4096,
  'Qwen/Qwen3-Embedding-4B': 2560,
  'Qwen/Qwen3-Embedding-0.6B': 1024,
  'netease-youdao/bce-embedding-base_v1': 768,
  // OpenAI 模型
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

/**
 * 获取模型的向量维度（支持 Ollama、SiliconFlow、OpenAI 模型）
 */
export function getModelDimension(modelName: string): number {
  // 首先精确匹配（支持 SiliconFlow 的 BAAI/bge-m3 格式）
  if (MODEL_DIMENSIONS[modelName]) {
    return MODEL_DIMENSIONS[modelName];
  }
  
  // 移除 :latest 后缀后匹配
  const baseName = modelName.split(':')[0];
  if (MODEL_DIMENSIONS[baseName]) {
    return MODEL_DIMENSIONS[baseName];
  }

  // 小写后匹配
  const lowerName = baseName.toLowerCase();
  for (const [key, dim] of Object.entries(MODEL_DIMENSIONS)) {
    if (key.toLowerCase() === lowerName) {
      return dim;
    }
  }

  // 部分匹配
  for (const [key, dim] of Object.entries(MODEL_DIMENSIONS)) {
    if (lowerName.includes(key.toLowerCase()) || key.toLowerCase().includes(lowerName)) {
      return dim;
    }
  }

  // 默认维度
  console.warn(`[getModelDimension] No match for "${modelName}", using default: 768D`);
  return 768;
}

/**
 * 根据维度选择合适的 embedding 模型
 */
export function selectModelByDimension(dimension: number): string {
  console.log(`[selectModelByDimension] Looking for model with dimension: ${dimension}D`);

  // 按维度分组的模型列表（优先使用的模型在前）
  const modelsByDimension: Record<number, string[]> = {
    384: ['all-minilm'],
    768: ['nomic-embed-text', 'nomic-embed-text-v2-moe', 'paraphrase-multilingual', 'netease-youdao/bce-embedding-base_v1'],
    1024: ['bge-m3', 'BAAI/bge-m3', 'bge-large', 'mxbai-embed-large', 'snowflake-arctic-embed', 'e5-large', 'gte-large', 'qwen3-embedding', 'Qwen/Qwen3-Embedding-0.6B'],
    1536: ['text-embedding-3-small', 'text-embedding-ada-002'],
    2560: ['Qwen/Qwen3-Embedding-4B'],
    3072: ['text-embedding-3-large'],
    4096: ['Qwen/Qwen3-Embedding-8B'],
  };

  const candidates = modelsByDimension[dimension];

  if (candidates && candidates.length > 0) {
    const selected = candidates[0];
    console.log(`[selectModelByDimension] Selected: ${selected} (${dimension}D)`);
    return selected;
  }

  // 如果没有精确匹配，选择最接近的
  const availableDimensions = Object.keys(modelsByDimension).map(Number);
  const closest = availableDimensions.reduce((prev, curr) =>
    Math.abs(curr - dimension) < Math.abs(prev - dimension) ? curr : prev
  );

  const fallback = modelsByDimension[closest][0];
  console.log(`[selectModelByDimension] No exact match, using closest: ${fallback} (${closest}D)`);
  return fallback;
}

export default MilvusVectorStore;
