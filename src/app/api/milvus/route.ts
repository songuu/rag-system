import { NextRequest, NextResponse } from 'next/server';
import { MilvusVectorStore, MilvusConfig, getMilvusInstance, resetMilvusInstance, getModelDimension } from '@/lib/milvus-client';
import { v4 as uuidv4 } from 'uuid';
import {
  getEmbeddingModel,
  selectModelForCollection,
  vectorizeAndInsert,
  DEFAULT_EMBEDDING_MODEL,
  DocumentInput,
} from '@/lib/vectorization-utils';
import { 
  getMilvusConnectionConfig, 
  getMilvusConfigSummary,
  getMilvusProvider,
  isZillizCloud,
} from '@/lib/milvus-config';
import { getEmbeddingConfigSummary } from '@/lib/embedding-config';

// 使用独立的 Embedding 配置系统
const embeddingConfig = getEmbeddingConfigSummary();
const EMBEDDING_MODEL = embeddingConfig.model;

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
  };
}

// POST: 执行 Milvus 操作
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ...params } = body;

    switch (action) {
      // 连接到 Milvus
      case 'connect': {
        const defaultConfig = getDefaultMilvusConfig();
        const config: MilvusConfig = {
          ...defaultConfig,
          ...params.config,
        };
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
          ...health,
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
        console.log(`[Milvus Insert] Documents count: ${documents?.length || 0}`);
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
        const actualModelName = embeddingModel || EMBEDDING_MODEL;
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
        const milvusDocs = await Promise.all(documents.map(async (doc: any) => {
          const embedding = await embeddings.embedQuery(doc.content);
          return {
            id: doc.id || uuidv4(),
            content: doc.content,
            embedding,
            metadata: doc.metadata || {},
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
        const { query, topK = 5, threshold = 0.0, filter, embeddingModel } = params;
        
        console.log(`[Milvus Search] ========== 开始搜索 ==========`);
        console.log(`[Milvus Search] Query: "${query}"`);
        console.log(`[Milvus Search] Requested embedding model: "${embeddingModel || 'default'}"`);
        
        if (!query || typeof query !== 'string') {
          return NextResponse.json({
            success: false,
            error: '请提供有效的查询文本',
          }, { status: 400 });
        }

        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.connect();
        await milvus.initializeCollection();

        // 获取集合的向量维度
        const stats = await milvus.getCollectionStats();
        const collectionDimension = stats?.embeddingDimension || 768;
        console.log(`[Milvus Search] Collection dimension: ${collectionDimension}D`);

        // 自动选择与集合维度匹配的模型
        const actualModel = selectModelForCollection(collectionDimension, embeddingModel);
        console.log(`[Milvus Search] Auto-selected model: "${actualModel}"`);
        
        const embeddings = getEmbeddingModel(actualModel);
        
        const queryEmbedding = await embeddings.embedQuery(query);
        const queryDimension = queryEmbedding.length;
        console.log(`[Milvus Search] Generated query embedding dimension: ${queryDimension}D`);
        
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
        
        console.log(`[Milvus Search] ✅ 维度匹配，开始搜索...`);
        const results = await milvus.search(queryEmbedding, topK, threshold, filter);
        console.log(`[Milvus Search] ✅ 找到 ${results.length} 个结果`);
        console.log(`[Milvus Search] ========== 搜索完成 ==========`);
        
        return NextResponse.json({
          success: true,
          query,
          results,
          count: results.length,
          embeddingModel: actualModel,
          dimension: queryDimension,
          collectionDimension,
        });
      }

      // 删除文档
      case 'delete': {
        const { ids } = params;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return NextResponse.json({
            success: false,
            error: '请提供有效的文档 ID 列表',
          }, { status: 400 });
        }

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
        const { files, embeddingModel: fileEmbeddingModel, chunkSize = 500, chunkOverlap = 50 } = params;
        
        if (!files || !Array.isArray(files) || files.length === 0) {
          return NextResponse.json({
            success: false,
            error: '请提供有效的文件列表',
          }, { status: 400 });
        }

        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        
        // 转换为 DocumentInput 格式
        const documents: DocumentInput[] = files.map((f: any) => ({
          content: f.content,
          filename: f.filename,
        }));
        
        // 使用公共向量化工具
        const result = await vectorizeAndInsert(milvus, documents, {
          embeddingModel: fileEmbeddingModel || EMBEDDING_MODEL,
          chunkSize,
          chunkOverlap,
        });
        
        if (!result.success) {
          return NextResponse.json({
            success: false,
            error: result.error,
          }, { status: 400 });
        }
        
        return NextResponse.json({
          success: true,
          message: `Imported ${files.length} files as ${result.chunksInserted} chunks`,
          files: files.map((f: any) => f.filename),
          chunkCount: result.chunksInserted,
          embeddingModel: result.embeddingModel,
          dimension: result.dimension,
        });
      }

      // 重建索引
      case 'rebuild-index': {
        const { indexType = 'IVF_FLAT', metricType = 'COSINE' } = params;
        
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
        
        if (!config) {
          return NextResponse.json({
            success: false,
            error: '请提供配置参数',
          }, { status: 400 });
        }

        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.updateConfig(config);
        
        return NextResponse.json({
          success: true,
          message: 'Configuration updated',
          config: milvus.getConfig(),
        });
      }

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Milvus API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

// GET: 获取 Milvus 状态和信息
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'status';

  try {
    switch (action) {
      case 'status': {
        const defaultConfig = getDefaultMilvusConfig();
        const milvus = getMilvusInstance(defaultConfig);
        const health = await milvus.checkHealth();
        const stats = health.healthy ? await milvus.getCollectionStats() : null;
        
        return NextResponse.json({
          success: true,
          connected: health.healthy,
          health,
          stats,
          config: {
            provider: getMilvusProvider(),
            isZillizCloud: isZillizCloud(),
            address: defaultConfig.address,
            database: defaultConfig.database,
            collectionName: defaultConfig.collectionName,
            embeddingDimension: defaultConfig.embeddingDimension,
            indexType: defaultConfig.indexType,
            metricType: defaultConfig.metricType,
          },
        });
      }

      case 'config': {
        const configSummary = getMilvusConfigSummary();
        return NextResponse.json({
          success: true,
          config: {
            ...configSummary,
            embeddingModel: EMBEDDING_MODEL,
            supportedIndexTypes: ['FLAT', 'IVF_FLAT', 'IVF_SQ8', 'IVF_PQ', 'HNSW', 'ANNOY'],
            supportedMetricTypes: ['L2', 'IP', 'COSINE'],
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
    console.error('[Milvus API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
