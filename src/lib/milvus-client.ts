/**
 * Milvus 向量数据库客户端管理器
 * 提供连接管理、集合操作、向量存储等功能
 * 
 * 已更新为使用统一配置系统 (milvus-config.ts)
 * 支持本地 Milvus 和 Zilliz Cloud 两种模式
 */

import { MilvusClient, DataType, MetricType, InsertReq, SearchReq } from '@zilliz/milvus2-sdk-node';
import {
  getMilvusConnectionConfig,
  createMilvusClient as createConfiguredClient,
  isZillizCloud,
  getMilvusProvider,
  type MilvusConnectionConfig
} from './milvus-config';

// Milvus 配置接口（保持向后兼容）
export interface MilvusConfig {
  address?: string;          // Milvus 服务地址 (如: localhost:19530)
  username?: string;         // 用户名（可选）
  password?: string;         // 密码（可选）
  ssl?: boolean;             // 是否使用 SSL
  database?: string;         // 数据库名（默认: default）
  collectionName?: string;   // 集合名称（默认: rag_documents）
  embeddingDimension?: number; // 向量维度（默认: 768）
  indexType?: 'IVF_FLAT' | 'IVF_SQ8' | 'IVF_PQ' | 'HNSW' | 'ANNOY' | 'FLAT'; // 索引类型
  metricType?: 'L2' | 'IP' | 'COSINE'; // 距离度量类型
  token?: string;            // Zilliz Cloud API Token（新增）
}

// 文档接口
export interface MilvusDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
}

// 搜索结果接口
export interface MilvusSearchResult {
  id: string;
  content: string;
  metadata: Record<string, any>;
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
  async checkSchemaCompatibility(): Promise<{ compatible: boolean; reason?: string; existingSchema?: any }> {
    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    try {
      const hasCollection = await client.hasCollection({ collection_name: collectionName });
      if (!hasCollection.value) {
        return { compatible: true }; // 集合不存在，可以创建
      }

      // 获取集合信息
      const collectionInfo = await client.describeCollection({ collection_name: collectionName });
      const fields = collectionInfo.schema?.fields || [];

      // 检查必需字段
      const requiredFields = ['id', 'content', 'embedding', 'source', 'metadata_json', 'created_at'];
      const existingFieldNames = fields.map((f: any) => f.name);

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
      const idField = fields.find((f: any) => f.name === 'id');
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
      const embeddingField = fields.find((f: any) => f.name === 'embedding');
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

      return { compatible: true };
    } catch (error) {
      console.warn('[Milvus] Schema compatibility check failed:', error);
      return { compatible: true }; // 无法检查时默认兼容
    }
  }

  /**
   * 强制重建集合（删除现有集合并创建新的）
   */
  async recreateCollection(): Promise<void> {
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

    // 创建新集合
    await this.initializeCollection();
    console.log(`[Milvus] Collection '${collectionName}' recreated successfully`);
  }

  /**
   * 初始化集合（创建 Schema 和索引）
   * @param autoRecreate 是否在维度不匹配时自动重建集合
   */
  async initializeCollection(autoRecreate: boolean = false): Promise<void> {
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
          }
        ],
      });

      console.log(`[Milvus] Collection '${collectionName}' created`);

      // 创建向量索引
      await this.createIndex();

      // 加载集合
      await this.loadCollection();

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
    let indexParams: any = {};
    switch (this.config.indexType) {
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
    const data = documents.map((doc) => ({
      id: doc.id,
      content: doc.content.substring(0, 65000), // 限制长度
      embedding: doc.embedding,
      source: doc.metadata?.source || 'unknown',
      metadata_json: JSON.stringify(doc.metadata || {}).substring(0, 65000),
      created_at: Date.now(),
    }));

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

    // 刷新数据确保持久化
    console.log(`[Milvus] Flushing data...`);
    await client.flushSync({ collection_names: [collectionName] });

    // 重新加载集合以确保新数据可被搜索
    console.log(`[Milvus] Reloading collection to make new data searchable...`);
    try {
      await client.releaseCollection({ collection_name: collectionName });
      await client.loadCollection({ collection_name: collectionName });
      console.log(`[Milvus] Collection reloaded successfully`);
    } catch (reloadError) {
      console.warn(`[Milvus] Reload warning (may be OK):`, reloadError);
    }

    // 返回所有文档的 ID
    return data.map(d => d.id);
  }

  /**
   * 相似度搜索
   */
  async search(
    queryEmbedding: number[],
    topK: number = 5,
    threshold: number = 0.0,
    filter?: string
  ): Promise<MilvusSearchResult[]> {
    if (!this.isInitialized) {
      await this.initializeCollection();
    }

    const client = await this.ensureConnected();
    const collectionName = this.config.collectionName;

    // 根据索引类型设置搜索参数
    let searchParams: any = {};
    switch (this.config.indexType) {
      case 'IVF_FLAT':
      case 'IVF_SQ8':
      case 'IVF_PQ':
        searchParams = { nprobe: 16 };
        break;
      case 'HNSW':
        searchParams = { ef: 64 };
        break;
      case 'ANNOY':
        searchParams = { search_k: -1 };
        break;
      default:
        searchParams = {};
    }

    const searchReq = {
      collection_name: collectionName,
      data: [queryEmbedding],
      anns_field: 'embedding',
      limit: topK,
      output_fields: ['id', 'content', 'source', 'metadata_json', 'created_at'],
      params: searchParams,
      filter: filter,
    } as any; // 使用 any 绕过类型检查，因为 SDK 类型定义可能不完整

    const results = await client.search(searchReq);

    console.log('[Milvus] Search response status:', results.status);
    console.log('[Milvus] Search results type:', typeof results.results, Array.isArray(results.results));
    console.log('[Milvus] Search results length:', results.results?.length);

    if (results.status.error_code !== 'Success') {
      throw new Error(`Search failed: ${results.status.reason}`);
    }

    // 转换结果
    const searchResults: MilvusSearchResult[] = [];

    // Milvus SDK 2.x 返回的 results.results 直接是数组
    // 但如果是多向量查询，可能是嵌套数组
    let hits: any[] = [];

    if (Array.isArray(results.results)) {
      if (results.results.length > 0) {
        // 检查是否是嵌套数组（多向量查询）
        if (Array.isArray(results.results[0])) {
          hits = results.results[0];
        } else {
          // 单向量查询，直接使用
          hits = results.results;
        }
      }
    }

    console.log('[Milvus] Parsed hits count:', hits.length);
    if (hits.length > 0) {
      console.log('[Milvus] First hit sample:', JSON.stringify(hits[0]).substring(0, 200));
    }

    if (hits.length === 0) {
      console.warn('[Milvus] No search results returned');
      return [];
    }

    let filteredCount = 0;
    for (const hit of hits) {
      // 计算相似度 (根据度量类型转换)
      let similarity: number;
      const rawScore = (hit as any).score;
      const rawDistance = (hit as any).distance;
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
      if (similarity < threshold) {
        filteredCount++;
        continue;
      }

      const hitData = hit as any;
      let metadata = {};
      try {
        metadata = JSON.parse(hitData.metadata_json || '{}');
      } catch {
        metadata = { source: hitData.source };
      }

      searchResults.push({
        id: hitData.id || '',
        content: hitData.content || '',
        metadata: { ...metadata, source: hitData.source },
        score: similarity,
        distance: distance,
      });
    }

    if (filteredCount > 0) {
      console.log(`[Milvus] 阈值过滤: ${filteredCount} 个结果低于阈值 ${threshold}`);
    }
    console.log(`[Milvus] 返回 ${searchResults.length} 个结果 (threshold=${threshold})`);

    return searchResults;
  }

  /**
   * 删除文档
   */
  async deleteDocuments(ids: string[]): Promise<void> {
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
  private parseDimensionFromTypeParams(typeParams: any): number | null {
    if (!typeParams) return null;

    // 格式 1: 对象格式 { dim: "1024" } (Milvus SDK v2.6+)
    if (typeParams.dim !== undefined) {
      const dim = parseInt(String(typeParams.dim), 10);
      if (!isNaN(dim) && dim > 0) {
        return dim;
      }
    }

    // 格式 2: 数组格式 [{ key: 'dim', value: '1024' }] (旧版)
    if (Array.isArray(typeParams)) {
      const dimParam = typeParams.find((p: any) => p.key === 'dim');
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
          JSON.stringify(collectionInfo.schema?.fields?.map((f: any) => ({
            name: f.name,
            type_params: f.type_params
          })), null, 2)
        );
        
        const embeddingField = collectionInfo.schema?.fields?.find(
          (f: any) => f.name === 'embedding'
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
