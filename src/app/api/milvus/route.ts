import { NextRequest, NextResponse } from 'next/server';
import {
  type MilvusConfig,
  type MilvusIndexType,
  type MilvusMetricType,
  type MilvusSearchOptions,
  getMilvusInstance,
  resetMilvusInstance,
  getModelDimension,
} from '@/lib/milvus-client';
import { v4 as uuidv4 } from 'uuid';
import {
  getEmbeddingModel,
  generateQueryEmbedding,
  selectModelForCollection,
  vectorizeAndInsert,
  DocumentInput,
} from '@/lib/vectorization-utils';
import { 
  getMilvusConnectionConfig, 
  getMilvusConfigSummary,
  getMilvusProvider,
  isZillizCloud,
} from '@/lib/milvus-config';
import { getEmbeddingConfigSummary } from '@/lib/embedding-config';
import {
  REQUEST_LIMITS,
  RequestValidationError,
  publicErrorPayload,
  readJsonObjectWithLimit,
  validateEmbeddingModelSelection,
  validateQueryText,
} from '@/lib/security/request-validation';
import {
  RagSecurityError,
  resolveRagSecurityContext,
  type RagCapability,
} from '@/lib/security/request-context';
import {
  buildScopedMilvusSearchOptions,
  createRetrievalScope,
  stampDocumentScope,
} from '@/lib/security/retrieval-scope';
import { redactErrorForLog } from '@/lib/security/error-redaction';
import {
  toPublicMilvusConfig,
  toPublicServiceHealth,
} from '@/lib/security/public-config';

export const runtime = 'nodejs';

// 使用独立的 Embedding 配置系统
const embeddingConfig = getEmbeddingConfigSummary();
const EMBEDDING_MODEL = embeddingConfig.model;

const MILVUS_ACTION_CAPABILITIES = {
  connect: 'manage-runtime',
  recreate: 'manage-runtime',
  'check-schema': 'query',
  disconnect: 'manage-runtime',
  health: 'query',
  stats: 'query',
  insert: 'ingest',
  search: 'query',
  delete: 'delete-document',
  clear: 'manage-runtime',
  'import-files': 'ingest',
  'rebuild-index': 'reindex',
  'update-config': 'manage-runtime',
} as const satisfies Record<string, RagCapability>;

type MilvusAction = keyof typeof MILVUS_ACTION_CAPABILITIES;

const GLOBAL_MILVUS_ACTIONS = new Set<MilvusAction>([
  'connect',
  'recreate',
  'disconnect',
  'delete',
  'clear',
  'rebuild-index',
  'update-config',
]);

type RawMilvusDocument = {
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
};

type RawImportFile = {
  content: string;
  filename: string;
};

function isRawMilvusDocument(value: unknown): value is RawMilvusDocument {
  return Boolean(value && typeof value === 'object' && typeof (value as { content?: unknown }).content === 'string');
}

function isRawImportFile(value: unknown): value is RawImportFile {
  const record = value as { content?: unknown; filename?: unknown };
  return Boolean(value && typeof value === 'object' && typeof record.content === 'string' && typeof record.filename === 'string');
}

/**
 * 获取默认 Milvus 配置（从统一配置系统读取）
 */
function getDefaultMilvusConfig(): MilvusConfig {
  const connConfig = getMilvusConnectionConfig();
  return {
    address: connConfig.address,
    username: connConfig.username,
    password: connConfig.password,
    ssl: connConfig.ssl,
    database: connConfig.database,
    collectionName: connConfig.defaultCollection,
    embeddingDimension: connConfig.defaultDimension,
    indexType: connConfig.defaultIndexType,
    metricType: connConfig.defaultMetricType,
    token: connConfig.token,
    consistencyLevel: connConfig.defaultConsistencyLevel,
    ignoreGrowing: connConfig.ignoreGrowing,
    groupByField: connConfig.groupByField,
    groupSize: connConfig.groupSize,
    strictGroupSize: connConfig.strictGroupSize,
    flushOnInsert: connConfig.flushOnInsert,
    reloadAfterInsert: connConfig.reloadAfterInsert,
    searchParams: connConfig.searchParams,
    searchOutputFields: connConfig.searchOutputFields as MilvusConfig['searchOutputFields'],
    debugLogs: connConfig.debugLogs,
  };
}

function getPublicMilvusRuntimeConfig(config: MilvusConfig = getDefaultMilvusConfig()) {
  return toPublicMilvusConfig(
    config as unknown as Record<string, unknown>,
    {
      provider: getMilvusProvider(),
      isZillizCloud: isZillizCloud(),
    }
  );
}

// POST: 执行 Milvus 操作
export async function POST(request: NextRequest) {
  const requestId = resolvePublicRequestId(request);
  try {
    const body = await readJsonObjectWithLimit(request, REQUEST_LIMITS.milvusJsonBytes);
    const { action, ...params } = body;
    const milvusAction = parseMilvusAction(action);
    const securityContext = await resolveRagSecurityContext(request, {
      capability: MILVUS_ACTION_CAPABILITIES[milvusAction],
      requestedCorpusId: typeof params.corpusId === 'string' ? params.corpusId : undefined,
      requestIdFactory: () => requestId,
    });
    const retrievalScope = createRetrievalScope({
      tenantId: securityContext.tenantId,
      corpusId: securityContext.corpusId,
      enforceIsolation: securityContext.enforceIsolation,
    });

    if (securityContext.enforceIsolation && GLOBAL_MILVUS_ACTIONS.has(milvusAction)) {
      throw new RequestValidationError(
        'GLOBAL_MILVUS_ACTION_FORBIDDEN',
        'This global Milvus operation is unavailable in multi-tenant mode.',
        409
      );
    }
    if (securityContext.enforceIsolation && milvusAction === 'stats') {
      throw new RequestValidationError(
        'GLOBAL_STATS_FORBIDDEN',
        'Global collection statistics are unavailable in multi-tenant mode.',
        409
      );
    }

    switch (milvusAction) {
      // 连接到 Milvus
      case 'connect': {
        const defaultConfig = getDefaultMilvusConfig();
        // Runtime endpoints cannot redirect the server to a client-selected address.
        const config: MilvusConfig = securityContext.accessMode === 'local-dev'
          ? { ...defaultConfig, ...(isRecord(params.config) ? params.config : {}) }
          : defaultConfig;
        const autoRecreate = params.autoRecreate === true;
        
        const milvus = getMilvusInstance(config);
        await milvus.connect();
        await milvus.initializeCollection(autoRecreate);
        
        const stats = await milvus.getCollectionStats();
        
        return NextResponse.json({
          success: true,
          message: 'Connected to Milvus',
          stats,
        });
      }

      // 重建集合（删除并重新创建）
      case 'recreate': {
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.connect();
        await milvus.recreateCollection();
        
        const stats = await milvus.getCollectionStats();
        
        return NextResponse.json({
          success: true,
          message: 'Collection recreated successfully',
          stats,
        });
      }

      // 检查 Schema 兼容性
      case 'check-schema': {
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.connect();
        const compatibility = await milvus.checkSchemaCompatibility();
        
        return NextResponse.json({
          success: true,
          ...compatibility,
        });
      }

      // 断开连接
      case 'disconnect': {
        await resetMilvusInstance();
        return NextResponse.json({
          success: true,
          message: 'Disconnected from Milvus',
        });
      }

      // 检查健康状态
      case 'health': {
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        const health = await milvus.checkHealth();
        return NextResponse.json({
          success: true,
          ...toPublicServiceHealth(health),
        });
      }

      // 获取集合统计信息
      case 'stats': {
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        const stats = await milvus.getCollectionStats();
        return NextResponse.json({
          success: true,
          stats,
        });
      }

      // 插入文档
      case 'insert': {
        const { documents, embeddingModel } = params;
        
        console.log(`[Milvus Insert] ========== 开始导入 ==========`);
        console.log(`[Milvus Insert] Documents count: ${Array.isArray(documents) ? documents.length : 0}`);
        console.log(`[Milvus Insert] Requested embedding model: "${embeddingModel || 'default'}"`);
        
        if (!documents || !Array.isArray(documents) || documents.length === 0) {
          return NextResponse.json({
            success: false,
            error: '请提供有效的文档列表',
          }, { status: 400 });
        }

        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.connect();
        await milvus.initializeCollection();

        // 获取集合的向量维度
        const stats = await milvus.getCollectionStats();
        const collectionDimension = stats?.embeddingDimension || 768;
        console.log(`[Milvus Insert] Collection dimension: ${collectionDimension}D`);

        // 获取模型维度信息
        const actualModelName = validateEmbeddingModelSelection(embeddingModel);
        const modelDimension = getModelDimension(actualModelName);
        
        console.log(`[Milvus Insert] Using model: "${actualModelName}" (${modelDimension}D)`);
        
        // 检查维度是否匹配
        if (modelDimension !== collectionDimension) {
          console.warn(`[Milvus Insert] ⚠️ 维度不匹配警告: 模型 ${modelDimension}D vs 集合 ${collectionDimension}D`);
          console.warn(`[Milvus Insert] 这可能会导致插入失败！`);
        }
        
        const embeddings = getEmbeddingModel(actualModelName);
        
        // 为每个文档生成向量
        console.log(`[Milvus Insert] Generating embeddings for ${documents.length} documents...`);
        const normalizedDocuments = documents.filter(isRawMilvusDocument);
        if (normalizedDocuments.length !== documents.length) {
          return NextResponse.json({
            success: false,
            error: '文档格式无效：每个文档都必须包含 string 类型的 content',
          }, { status: 400 });
        }
        validateDocumentBatch(documents);

        const milvusDocs = await Promise.all(normalizedDocuments.map(async (doc) => {
          const embedding = await embeddings.embedQuery(doc.content);
          return {
            id: doc.id || uuidv4(),
            content: doc.content,
            embedding,
            metadata: stampDocumentScope(
              doc.metadata,
              retrievalScope,
              'external'
            ),
          };
        }));

        // 验证生成的向量维度
        const actualDimension = milvusDocs[0]?.embedding?.length || 0;
        console.log(`[Milvus Insert] Generated embedding dimension: ${actualDimension}D`);
        
        if (actualDimension !== collectionDimension) {
          console.error(`[Milvus Insert] ❌ 维度不匹配! 生成: ${actualDimension}D, 集合: ${collectionDimension}D`);
          return NextResponse.json({
            success: false,
            error: `向量维度不匹配！生成的向量: ${actualDimension}维, 集合要求: ${collectionDimension}维。`,
            generatedDimension: actualDimension,
            collectionDimension,
            usedModel: actualModelName,
          }, { status: 400 });
        }

        console.log(`[Milvus Insert] ✅ 维度匹配，开始插入...`);
        const ids = await milvus.insertDocuments(milvusDocs);
        console.log(`[Milvus Insert] ✅ 成功插入 ${ids.length} 个文档`);
        console.log(`[Milvus Insert] ========== 导入完成 ==========`);
        
        return NextResponse.json({
          success: true,
          message: `Inserted ${ids.length} documents`,
          ids,
          embeddingModel: actualModelName,
          dimension: actualDimension,
          collectionDimension,
        });
      }

      // 相似度搜索
      case 'search': {
        const requestStartedAt = Date.now();
        const {
          query,
          topK: rawTopK,
          threshold: rawThreshold,
          filter,
          filterParams,
          exprValues,
          consistencyLevel,
          ignoreGrowing,
          groupByField,
          groupSize,
          strictGroupSize,
          searchParams,
          hints,
          roundDecimal,
          embeddingModel,
        } = params;
        const topK = boundedInteger(rawTopK, 'topK', 1, 50, 5);
        const threshold = boundedNumber(rawThreshold, 'threshold', 0, 1, 0);

        const queryText = validateQueryText(query);

        const defaultConfig = getDefaultMilvusConfig();
        const debugLogs = defaultConfig.debugLogs === true;
        const debugSearch = (message: string, ...args: unknown[]) => {
          if (debugLogs) console.log(message, ...args);
        };

        debugSearch(`[Milvus Search] ========== 开始搜索 ==========`);
        debugSearch(`[Milvus Search] Query: "${queryText}"`);
        debugSearch(`[Milvus Search] Requested embedding model: "${embeddingModel || 'default'}"`);

        const milvus = getMilvusInstance(defaultConfig);
        const initStartedAt = Date.now();
        await milvus.connect();
        await milvus.initializeCollection();
        const initMs = Date.now() - initStartedAt;

        // initializeCollection 已做 schema 兼容检查；搜索热路径避免每次读取 stats/describeCollection。
        const collectionDimension = milvus.getConfig().embeddingDimension;
        debugSearch(`[Milvus Search] Collection dimension: ${collectionDimension}D`);

        // 自动选择与集合维度匹配的模型
        const requestedEmbeddingModel = validateEmbeddingModelSelection(embeddingModel);
        const actualModel = selectModelForCollection(collectionDimension, requestedEmbeddingModel);
        debugSearch(`[Milvus Search] Auto-selected model: "${actualModel}"`);

        const embeddingStartedAt = Date.now();
        const queryEmbedding = await generateQueryEmbedding(queryText, actualModel);
        const embeddingMs = Date.now() - embeddingStartedAt;
        const queryDimension = queryEmbedding.length;
        debugSearch(`[Milvus Search] Generated query embedding dimension: ${queryDimension}D`);
        
        // 检查维度是否匹配
        if (queryDimension !== collectionDimension) {
          console.error(`[Milvus Search] ❌ 维度不匹配! Collection: ${collectionDimension}D, Query: ${queryDimension}D`);
          return NextResponse.json({
            success: false,
            error: `向量维度不匹配！集合维度: ${collectionDimension}, 查询向量维度: ${queryDimension}。请使用与导入文档时相同维度的 Embedding 模型，或清空集合后使用新模型重新导入。`,
            collectionDimension,
            queryDimension,
            requestedModel: embeddingModel,
            actualModel,
            suggestion: collectionDimension === 768 
              ? '建议使用 nomic-embed-text 模型 (768维)' 
              : collectionDimension === 1024 
                ? '建议使用 bge-m3 或 mxbai-embed-large 模型 (1024维)'
                : `需要 ${collectionDimension} 维的模型`,
          }, { status: 400 });
        }
        
        debugSearch(`[Milvus Search] ✅ 维度匹配，开始搜索...`);
        const searchStartedAt = Date.now();
        const baseSearchOptions: MilvusSearchOptions = { threshold };
        if (!retrievalScope.enforceIsolation) {
          if (typeof consistencyLevel === 'string' || typeof consistencyLevel === 'number') {
            baseSearchOptions.consistencyLevel = validateConsistencyLevel(consistencyLevel);
          }
          if (typeof ignoreGrowing === 'boolean') baseSearchOptions.ignoreGrowing = ignoreGrowing;
          if (typeof groupByField === 'string') baseSearchOptions.groupByField = groupByField;
          if (typeof groupSize === 'number') {
            baseSearchOptions.groupSize = boundedInteger(groupSize, 'groupSize', 1, 100, 1);
          }
          if (typeof strictGroupSize === 'boolean') baseSearchOptions.strictGroupSize = strictGroupSize;
          if (isRecord(searchParams)) baseSearchOptions.searchParams = searchParams;
          if (typeof hints === 'string') baseSearchOptions.hints = hints;
          if (typeof roundDecimal === 'number') {
            baseSearchOptions.roundDecimal = boundedInteger(roundDecimal, 'roundDecimal', -1, 12, -1);
          }
        }
        const results = await milvus.search(
          queryEmbedding,
          topK,
          retrievalScope.enforceIsolation
            ? buildScopedMilvusSearchOptions(retrievalScope, baseSearchOptions)
            : {
                ...baseSearchOptions,
                filter: typeof filter === 'string' ? filter : undefined,
                exprValues: isRecord(exprValues)
                  ? exprValues
                  : isRecord(filterParams)
                    ? filterParams
                    : undefined,
              }
        );
        const searchMs = Date.now() - searchStartedAt;
        const totalMs = Date.now() - requestStartedAt;
        debugSearch(`[Milvus Search] ✅ 找到 ${results.length} 个结果`);
        debugSearch(`[Milvus Search] ========== 搜索完成 ==========`);
        
        return NextResponse.json({
          success: true,
          query: queryText,
          results,
          count: results.length,
          embeddingModel: actualModel,
          dimension: queryDimension,
          collectionDimension,
          timings: {
            initMs,
            embeddingMs,
            searchMs,
            totalMs,
          },
        });
      }

      // 删除文档
      case 'delete': {
        if (retrievalScope.enforceIsolation) {
          throw new RequestValidationError(
            'SCOPED_DELETE_UNAVAILABLE',
            'Scoped deletion must be performed through the corpus document API.',
            409
          );
        }
        const { ids: rawIds } = params;
        
        if (!rawIds || !Array.isArray(rawIds) || rawIds.length === 0) {
          return NextResponse.json({
            success: false,
            error: '请提供有效的文档 ID 列表',
          }, { status: 400 });
        }

        const ids = validateDocumentIds(rawIds);
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.deleteDocuments(ids);
        
        return NextResponse.json({
          success: true,
          message: `Deleted ${ids.length} documents`,
        });
      }

      // 清空集合
      case 'clear': {
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.clearCollection();
        
        return NextResponse.json({
          success: true,
          message: 'Collection cleared',
        });
      }

      // 从文件导入文档
      case 'import-files': {
        const {
          files,
          embeddingModel: fileEmbeddingModel,
          chunkSize: rawChunkSize,
          chunkOverlap: rawChunkOverlap,
        } = params;
        const chunkSize = boundedInteger(rawChunkSize, 'chunkSize', 100, 4_000, 500);
        const chunkOverlap = boundedInteger(rawChunkOverlap, 'chunkOverlap', 0, chunkSize - 1, 50);
        
        if (!files || !Array.isArray(files) || files.length === 0) {
          return NextResponse.json({
            success: false,
            error: '请提供有效的文件列表',
          }, { status: 400 });
        }

        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        
        // 转换为 DocumentInput 格式
        const normalizedFiles = files.filter(isRawImportFile);
        if (normalizedFiles.length !== files.length) {
          return NextResponse.json({
            success: false,
            error: '文件格式无效：每个文件都必须包含 content 和 filename',
          }, { status: 400 });
        }
        validateImportFiles(files);

        const documents: DocumentInput[] = normalizedFiles.map((file) => ({
          content: file.content,
          filename: file.filename,
          metadata: stampDocumentScope({}, retrievalScope, 'external'),
        }));
        
        // 使用公共向量化工具
        const result = await vectorizeAndInsert(milvus, documents, {
          embeddingModel: validateEmbeddingModelSelection(fileEmbeddingModel),
          chunkSize,
          chunkOverlap,
        });
        
        if (!result.success) {
          return NextResponse.json({
            success: false,
            error: 'Vectorization failed.',
            code: 'VECTORIZATION_FAILED',
          }, { status: 400 });
        }
        
        return NextResponse.json({
          success: true,
          message: `Imported ${files.length} files as ${result.chunksInserted} chunks`,
          files: normalizedFiles.map((file) => file.filename),
          chunkCount: result.chunksInserted,
          embeddingModel: result.embeddingModel,
          dimension: result.dimension,
        });
      }

      // 重建索引
      case 'rebuild-index': {
        const indexType = validateIndexType(params.indexType);
        const metricType = validateMetricType(params.metricType);
        
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.updateConfig({ indexType, metricType });
        await milvus.clearCollection();
        
        return NextResponse.json({
          success: true,
          message: `Index rebuilt with ${indexType} and ${metricType}`,
        });
      }

      // 更新配置
      case 'update-config': {
        const { config } = params;
        
        if (!isRecord(config)) {
          return NextResponse.json({
            success: false,
            error: '请提供配置参数',
          }, { status: 400 });
        }
        if (securityContext.accessMode !== 'local-dev') {
          throw new RequestValidationError(
            'RUNTIME_CONFIG_UPDATE_FORBIDDEN',
            'Client-selected runtime configuration is only available in local development.',
            409
          );
        }

        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.updateConfig(config as Partial<MilvusConfig>);
        
        return NextResponse.json({
          success: true,
          message: 'Configuration updated',
          config: getPublicMilvusRuntimeConfig(milvus.getConfig()),
        });
      }

      default:
        return NextResponse.json({
          success: false,
          error: 'Unknown action',
          code: 'UNKNOWN_ACTION',
        }, { status: 400 });
    }
  } catch (error) {
    console.error(`[Milvus API] requestId=${requestId}`, redactErrorForLog(error));
    const mapped = mapMilvusError(error, 'MILVUS_INTERNAL_ERROR', 'Milvus operation failed.', requestId);
    return NextResponse.json({
      success: false,
      error: mapped.body.error.message,
      code: mapped.body.error.code,
      requestId: mapped.body.requestId,
    }, { status: mapped.status });
  }
}

// GET: 获取 Milvus 状态和信息
export async function GET(request: NextRequest) {
  const requestId = resolvePublicRequestId(request);
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'status';

  try {
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: searchParams.get('corpusId') || undefined,
      requestIdFactory: () => requestId,
    });
    switch (action) {
      case 'status': {
        const defaultConfig = getDefaultMilvusConfig();
        const milvus = getMilvusInstance(defaultConfig);
        const health = await milvus.checkHealth();
        const stats = !securityContext.enforceIsolation && health.healthy
          ? await milvus.getCollectionStats()
          : null;
        
        return NextResponse.json({
          success: true,
          connected: health.healthy,
          health: toPublicServiceHealth(health),
          stats,
          config: getPublicMilvusRuntimeConfig(defaultConfig),
        });
      }

      case 'config': {
        const configSummary = getMilvusConfigSummary();
        return NextResponse.json({
          success: true,
          config: {
            provider: configSummary.provider,
            configured: Boolean(configSummary.endpoint),
            hasCredentials: configSummary.hasCredentials,
            ssl: configSummary.ssl,
            defaultCollection: configSummary.defaultCollection,
            defaultDimension: configSummary.defaultDimension,
            defaultConsistencyLevel: configSummary.defaultConsistencyLevel,
            ignoreGrowing: configSummary.ignoreGrowing,
            groupByField: configSummary.groupByField,
            groupSize: configSummary.groupSize,
            strictGroupSize: configSummary.strictGroupSize,
            flushOnInsert: configSummary.flushOnInsert,
            reloadAfterInsert: configSummary.reloadAfterInsert,
            debugLogs: configSummary.debugLogs,
            embeddingModel: EMBEDDING_MODEL,
            supportedIndexTypes: ['AUTOINDEX', 'FLAT', 'IVF_FLAT', 'IVF_SQ8', 'IVF_PQ', 'HNSW', 'ANNOY'],
            supportedMetricTypes: ['L2', 'IP', 'COSINE'],
            supportedConsistencyLevels: ['Strong', 'Bounded', 'Session', 'Eventually'],
          },
        });
      }

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error(`[Milvus API] status requestId=${requestId}`, redactErrorForLog(error));
    const mapped = mapMilvusError(error, 'MILVUS_STATUS_FAILED', 'Milvus status is unavailable.', requestId);
    return NextResponse.json({
      success: false,
      error: mapped.body.error.message,
      code: mapped.body.error.code,
      requestId: mapped.body.requestId,
    }, { status: mapped.status });
  }
}

function parseMilvusAction(value: unknown): MilvusAction {
  if (typeof value === 'string' && value in MILVUS_ACTION_CAPABILITIES) {
    return value as MilvusAction;
  }
  throw new RequestValidationError('UNKNOWN_ACTION', 'Unknown Milvus action.', 400);
}

function boundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RequestValidationError(
      'INVALID_INTEGER',
      `${field} must be an integer between ${min} and ${max}.`,
      400
    );
  }
  return value;
}

function boundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RequestValidationError(
      'INVALID_NUMBER',
      `${field} must be a finite number between ${min} and ${max}.`,
      400
    );
  }
  return value;
}

function validateIndexType(value: unknown): MilvusIndexType {
  const candidate = value === undefined ? 'IVF_FLAT' : value;
  const supported: MilvusIndexType[] = [
    'AUTOINDEX', 'IVF_FLAT', 'IVF_SQ8', 'IVF_PQ', 'HNSW', 'ANNOY', 'FLAT',
  ];
  if (typeof candidate !== 'string' || !supported.includes(candidate as MilvusIndexType)) {
    throw new RequestValidationError('INVALID_INDEX_TYPE', 'Unsupported Milvus index type.', 400);
  }
  return candidate as MilvusIndexType;
}

function validateMetricType(value: unknown): MilvusMetricType {
  const candidate = value === undefined ? 'COSINE' : value;
  const supported: MilvusMetricType[] = ['L2', 'IP', 'COSINE'];
  if (typeof candidate !== 'string' || !supported.includes(candidate as MilvusMetricType)) {
    throw new RequestValidationError('INVALID_METRIC_TYPE', 'Unsupported Milvus metric type.', 400);
  }
  return candidate as MilvusMetricType;
}

function validateConsistencyLevel(
  value: string | number
): NonNullable<MilvusSearchOptions['consistencyLevel']> {
  const supported = ['Strong', 'Bounded', 'Session', 'Eventually'];
  if (typeof value === 'string' && supported.includes(value)) {
    return value as NonNullable<MilvusSearchOptions['consistencyLevel']>;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4) {
    return value as NonNullable<MilvusSearchOptions['consistencyLevel']>;
  }
  throw new RequestValidationError(
    'INVALID_CONSISTENCY_LEVEL',
    'Unsupported Milvus consistency level.',
    400
  );
}

function validateDocumentBatch(documents: unknown[]): void {
  if (documents.length > 100) {
    throw new RequestValidationError(
      'DOCUMENT_BATCH_TOO_LARGE',
      'No more than 100 documents are allowed.',
      413
    );
  }
  let totalCharacters = 0;
  for (const document of documents) {
    if (!isRawMilvusDocument(document) || document.content.length > 200_000) {
      throw new RequestValidationError(
        'INVALID_DOCUMENT',
        'Each document must contain bounded text content.',
        400
      );
    }
    totalCharacters += document.content.length;
  }
  if (totalCharacters > 2_000_000) {
    throw new RequestValidationError(
      'DOCUMENT_BATCH_TOO_LARGE',
      'Document content is too large.',
      413
    );
  }
}

function validateImportFiles(files: unknown[]): void {
  if (files.length > 20) {
    throw new RequestValidationError(
      'FILE_BATCH_TOO_LARGE',
      'No more than 20 files are allowed.',
      413
    );
  }
  let totalCharacters = 0;
  for (const file of files) {
    if (!isRawImportFile(file) || file.content.length > 500_000 || file.filename.length > 512) {
      throw new RequestValidationError(
        'INVALID_IMPORT_FILE',
        'Each import file must contain bounded text and a filename.',
        400
      );
    }
    totalCharacters += file.content.length;
  }
  if (totalCharacters > 4_000_000) {
    throw new RequestValidationError(
      'FILE_BATCH_TOO_LARGE',
      'Import file content is too large.',
      413
    );
  }
}

function validateDocumentIds(values: unknown[]): string[] {
  if (values.length > 100) {
    throw new RequestValidationError(
      'TOO_MANY_DOCUMENT_IDS',
      'No more than 100 document IDs are allowed.',
      413
    );
  }
  return values.map((value) => {
    if (
      typeof value !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
    ) {
      throw new RequestValidationError('INVALID_DOCUMENT_ID', 'Invalid document ID.', 400);
    }
    return value;
  });
}

function mapMilvusError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  requestId: string
) {
  if (error instanceof RagSecurityError) {
    return {
      status: error.status,
      body: {
        error: { code: error.code, message: error.message },
        requestId: error.requestId,
      },
    };
  }
  return publicErrorPayload(error, fallbackCode, fallbackMessage, requestId);
}

function resolvePublicRequestId(request: NextRequest): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && supplied.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
