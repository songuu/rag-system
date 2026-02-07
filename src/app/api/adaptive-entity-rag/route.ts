import { NextRequest, NextResponse } from 'next/server';
import { 
  createAdaptiveEntityRAG, 
  AdaptiveEntityRAG,
  EntityMetadata,
  EntityType,
} from '@/lib/adaptive-entity-rag';
import { getMilvusInstance, MilvusVectorStore, getModelDimension } from '@/lib/milvus-client';
import { 
  vectorizeAndInsert, 
  DocumentInput,
  DEFAULT_EMBEDDING_MODEL,
} from '@/lib/vectorization-utils';
import { promises as fs } from 'fs';
import path from 'path';

// 独立的集合名称
const ADAPTIVE_RAG_COLLECTION = 'adaptive_entity_rag_docs';

// 独立的上传目录
const UPLOAD_DIR = path.join(process.cwd(), 'adaptive-rag-uploads');

// 单例实例缓存
let ragInstance: AdaptiveEntityRAG | null = null;
let milvusInstance: MilvusVectorStore | null = null;

// 获取独立的 Milvus 实例
async function getAdaptiveMilvus(embeddingModel: string = DEFAULT_EMBEDDING_MODEL): Promise<MilvusVectorStore> {
  const dimension = getModelDimension(embeddingModel) || 768;
  
  if (!milvusInstance) {
    milvusInstance = getMilvusInstance({
      collectionName: ADAPTIVE_RAG_COLLECTION,
      embeddingDimension: dimension,
    });
  }
  return milvusInstance;
}

async function getRAGInstance(config?: {
  llmModel?: string;
  embeddingModel?: string;
  maxRetries?: number;
  enableReranking?: boolean;
  similarityThreshold?: number;
}): Promise<AdaptiveEntityRAG> {
  if (!ragInstance || config) {
    ragInstance = createAdaptiveEntityRAG({
      ...config,
      milvusCollection: ADAPTIVE_RAG_COLLECTION,
    });
    // 初始化（加载持久化数据）
    await ragInstance.initialize();
  }
  return ragInstance;
}

/**
 * GET: 获取系统状态和实体元数据
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action') || 'status';

  try {
    switch (action) {
      case 'status': {
        const rag = await getRAGInstance();
        const entityStore = await rag.getEntityMetadataStoreAsync();
        const entities = entityStore.getAllEntities();
        
        // 按类型统计实体
        const entityStats: Record<string, number> = {};
        entities.forEach(e => {
          entityStats[e.type] = (entityStats[e.type] || 0) + 1;
        });

        // 获取知识库统计
        let knowledgeBaseStats = {
          documentCount: 0,
          connected: false,
          collectionName: ADAPTIVE_RAG_COLLECTION,
          embeddingDimension: null as number | null,  // 集合的向量维度
        };

        try {
          const milvus = await getAdaptiveMilvus();
          const stats = await milvus.getCollectionStats();
          knowledgeBaseStats = {
            documentCount: stats?.rowCount || 0,
            connected: true,
            collectionName: ADAPTIVE_RAG_COLLECTION,
            embeddingDimension: stats?.embeddingDimension || null,  // 返回集合的实际维度
          };
        } catch (e) {
          console.log('[AdaptiveEntityRAG] Milvus 未连接或集合不存在');
        }

        // 获取上传文件列表
        let uploadedFiles: string[] = [];
        try {
          await fs.mkdir(UPLOAD_DIR, { recursive: true });
          const files = await fs.readdir(UPLOAD_DIR);
          uploadedFiles = files.filter(f => f.endsWith('.txt'));
        } catch (e) {
          // 目录可能不存在
        }

        return NextResponse.json({
          success: true,
          status: 'ready',
          entityCount: entities.length,
          entityStats,
          knowledgeBase: knowledgeBaseStats,
          uploadedFiles: uploadedFiles.length,
          message: '自适应实体路由 RAG 系统就绪',
        });
      }

      case 'entities': {
        const type = searchParams.get('type') as EntityType | null;
        const rag = await getRAGInstance();
        const entityStore = await rag.getEntityMetadataStoreAsync();
        
        let entities: EntityMetadata[];
        if (type) {
          entities = entityStore.getEntitiesByType(type);
        } else {
          entities = entityStore.getAllEntities();
        }

        return NextResponse.json({
          success: true,
          entities,
          count: entities.length,
        });
      }

      case 'entity-types': {
        const types: EntityType[] = ['PERSON', 'ORGANIZATION', 'LOCATION', 'PRODUCT', 'DATE', 'EVENT', 'CONCEPT', 'OTHER'];
        return NextResponse.json({
          success: true,
          types,
        });
      }

      case 'files': {
        // 获取独立知识库的文件列表
        try {
          await fs.mkdir(UPLOAD_DIR, { recursive: true });
          const files = await fs.readdir(UPLOAD_DIR);
          const fileList = await Promise.all(
            files.filter(f => f.endsWith('.txt')).map(async (filename) => {
              const filePath = path.join(UPLOAD_DIR, filename);
              const stats = await fs.stat(filePath);
              return {
                name: filename,
                size: stats.size,
                modified: stats.mtime.toISOString(),
              };
            })
          );
          return NextResponse.json({ success: true, files: fileList });
        } catch (e) {
          return NextResponse.json({ success: true, files: [] });
        }
      }

      case 'knowledge-stats': {
        // 获取知识库详细统计
        try {
          const embeddingModel = searchParams.get('embeddingModel') || 'nomic-embed-text';
          const milvus = await getAdaptiveMilvus(embeddingModel);
          const stats = await milvus.getCollectionStats();
          
          return NextResponse.json({
            success: true,
            stats: {
              collectionName: ADAPTIVE_RAG_COLLECTION,
              rowCount: stats?.rowCount || 0,
              embeddingDimension: stats?.embeddingDimension || 768,
              indexType: stats?.indexType || 'IVF_FLAT',
              connected: true,
            },
          });
        } catch (e) {
          return NextResponse.json({
            success: true,
            stats: {
              collectionName: ADAPTIVE_RAG_COLLECTION,
              rowCount: 0,
              connected: false,
              error: e instanceof Error ? e.message : '连接失败',
            },
          });
        }
      }

      default:
        return NextResponse.json(
          { success: false, error: '未知操作' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[AdaptiveEntityRAG API] GET 错误:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}

/**
 * POST: 执行查询或添加实体
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action = 'query', ...params } = body;

    switch (action) {
      case 'query': {
        const { 
          question, 
          topK = 5,
          llmModel,
          embeddingModel,
          maxRetries = 3,
          enableReranking = true,
          similarityThreshold = 0.3,
        } = params;

        if (!question || typeof question !== 'string') {
          return NextResponse.json(
            { success: false, error: '请提供有效的问题' },
            { status: 400 }
          );
        }

        console.log(`[AdaptiveEntityRAG] 处理查询: "${question}"`);
        console.log(`[AdaptiveEntityRAG] 配置: LLM=${llmModel}, Embedding=${embeddingModel}, MaxRetries=${maxRetries}, Threshold=${similarityThreshold}`);

        const rag = await getRAGInstance({
          llmModel,
          embeddingModel,
          maxRetries,
          enableReranking,
          similarityThreshold,
        });

        const startTime = Date.now();
        const result = await rag.query(question, topK);
        const duration = Date.now() - startTime;

        console.log(`[AdaptiveEntityRAG] 查询完成, 耗时 ${duration}ms`);
        console.log(`[AdaptiveEntityRAG] 解析意图: ${result.query.intent}, 实体数: ${result.query.entities.length}`);
        console.log(`[AdaptiveEntityRAG] 检索结果: ${result.searchResults.length} -> 重排序后: ${result.rankedResults.length}`);

        return NextResponse.json({
          success: true,
          answer: result.finalResponse,
          workflow: {
            steps: result.steps,
            totalDuration: result.totalDuration,
          },
          queryAnalysis: {
            originalQuery: result.query.originalQuery,
            intent: result.query.intent,
            complexity: result.query.complexity,
            confidence: result.query.confidence,
            entities: result.query.entities,
            logicalRelations: result.query.logicalRelations,
            keywords: result.query.keywords,
          },
          entityValidation: result.validatedEntities.map(e => ({
            name: e.name,
            type: e.type,
            normalizedName: e.normalizedName,
            isValid: e.isValid,
            matchScore: e.matchScore,
            suggestions: e.suggestions,
          })),
          routingDecision: {
            action: result.currentDecision.action,
            reason: result.currentDecision.reason,
            constraints: result.currentDecision.constraints,
            relaxedConstraints: result.currentDecision.relaxedConstraints,
            retryCount: result.currentDecision.retryCount,
          },
          retrievalDetails: {
            searchResultCount: result.searchResults.length,
            rankedResultCount: result.rankedResults.length,
            topResults: result.rankedResults.slice(0, 3).map(r => ({
              id: r.id,
              score: r.score,
              rerankedScore: r.rerankedScore,
              relevanceExplanation: r.relevanceExplanation,
              contentPreview: r.content.substring(0, 200) + (r.content.length > 200 ? '...' : ''),
              matchType: r.matchType,
            })),
          },
          duration,
        });
      }

      case 'add-entity': {
        const { standardName, type, aliases = [], hierarchy } = params;

        if (!standardName || !type) {
          return NextResponse.json(
            { success: false, error: '请提供标准名称和类型' },
            { status: 400 }
          );
        }

        const rag = await getRAGInstance();
        const entityStore = await rag.getEntityMetadataStoreAsync();
        
        // 添加实体并持久化
        entityStore.addEntity({
          standardName,
          type,
          aliases,
          hierarchy,
        }, true); // persist = true

        return NextResponse.json({
          success: true,
          message: `已添加实体: ${standardName}`,
        });
      }

      case 'remove-entity': {
        const { standardName } = params;

        if (!standardName) {
          return NextResponse.json(
            { success: false, error: '请提供实体标准名称' },
            { status: 400 }
          );
        }

        const rag = await getRAGInstance();
        const entityStore = await rag.getEntityMetadataStoreAsync();
        const deleted = entityStore.removeEntity(standardName, true);

        return NextResponse.json({
          success: deleted,
          message: deleted ? `已删除实体: ${standardName}` : `未找到实体: ${standardName}`,
        });
      }

      case 'reset-entities': {
        const rag = await getRAGInstance();
        const entityStore = await rag.getEntityMetadataStoreAsync();
        await entityStore.reset();

        return NextResponse.json({
          success: true,
          message: '实体库已重置为默认映射',
        });
      }

      case 'parse-only': {
        // 仅解析查询，不执行检索
        const { question, llmModel, embeddingModel } = params;

        if (!question) {
          return NextResponse.json(
            { success: false, error: '请提供问题' },
            { status: 400 }
          );
        }

        const rag = await getRAGInstance({ llmModel, embeddingModel });
        
        // 使用内部方法进行解析
        const { CognitiveParser } = await import('@/lib/adaptive-entity-rag');
        const parser = new CognitiveParser(llmModel || 'qwen2.5:7b');
        const parsed = await parser.parse(question);

        // 校验实体
        const entityStore = rag.getEntityMetadataStore();
        const validatedEntities = [];

        for (const entity of parsed.entities) {
          const candidates = await entityStore.findSimilar(entity.name, entity.type, 3);
          validatedEntities.push({
            ...entity,
            candidates: candidates.map(c => ({
              standardName: c.standardName,
              aliases: c.aliases,
            })),
          });
        }

        return NextResponse.json({
          success: true,
          parsed: {
            originalQuery: parsed.originalQuery,
            intent: parsed.intent,
            complexity: parsed.complexity,
            confidence: parsed.confidence,
            keywords: parsed.keywords,
          },
          entities: validatedEntities,
          logicalRelations: parsed.logicalRelations,
        });
      }

      case 'reinitialize': {
        // 重新初始化实例
        const { llmModel, embeddingModel } = params;
        ragInstance = null;
        milvusInstance = null;
        await getRAGInstance({ llmModel, embeddingModel });
        
        return NextResponse.json({
          success: true,
          message: '系统已重新初始化',
        });
      }

      case 'upload': {
        // 处理文本上传
        const { content, filename } = params;
        
        if (!content || !filename) {
          return NextResponse.json(
            { success: false, error: '请提供文件内容和文件名' },
            { status: 400 }
          );
        }

        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        const timestamp = Date.now();
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const savedFilename = `${timestamp}_${safeName}.txt`;
        const filePath = path.join(UPLOAD_DIR, savedFilename);
        
        await fs.writeFile(filePath, content, 'utf-8');
        
        return NextResponse.json({
          success: true,
          message: `文件已保存: ${savedFilename}`,
          filename: savedFilename,
          size: Buffer.byteLength(content, 'utf-8'),
        });
      }

      case 'vectorize': {
        // 向量化文档并存入独立的 Milvus 集合
        const { embeddingModel = DEFAULT_EMBEDDING_MODEL, chunkSize = 500, chunkOverlap = 50 } = params;
        
        console.log(`[AdaptiveEntityRAG] 开始向量化, 模型: ${embeddingModel}`);
        
        // 读取所有上传的文件
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        const files = await fs.readdir(UPLOAD_DIR);
        const txtFiles = files.filter(f => f.endsWith('.txt'));
        
        if (txtFiles.length === 0) {
          return NextResponse.json({
            success: false,
            error: '没有可向量化的文件，请先上传文档',
          });
        }

        // 读取所有文档内容
        const documents: DocumentInput[] = [];
        for (const filename of txtFiles) {
          const content = await fs.readFile(path.join(UPLOAD_DIR, filename), 'utf-8');
          if (content.trim()) {
            documents.push({ content: content.trim(), filename });
          }
        }

        // 获取 Milvus 实例
        const milvus = await getAdaptiveMilvus(embeddingModel);
        
        // 使用公共向量化工具
        const result = await vectorizeAndInsert(milvus, documents, {
          embeddingModel,
          chunkSize,
          chunkOverlap,
        });

        if (!result.success) {
          return NextResponse.json({
            success: false,
            error: result.error,
          });
        }

        return NextResponse.json({
          success: true,
          message: `向量化完成`,
          stats: {
            filesProcessed: result.filesProcessed,
            chunksCreated: result.chunksCreated,
            chunksInserted: result.chunksInserted,
            collectionName: result.collectionName,
            dimension: result.dimension,
            embeddingModel: result.embeddingModel,
          },
        });
      }

      case 'delete-file': {
        // 删除指定文件
        const { filename } = params;
        
        if (!filename) {
          return NextResponse.json(
            { success: false, error: '请提供文件名' },
            { status: 400 }
          );
        }

        const filePath = path.join(UPLOAD_DIR, filename);
        try {
          await fs.unlink(filePath);
          return NextResponse.json({
            success: true,
            message: `文件已删除: ${filename}`,
          });
        } catch (e) {
          return NextResponse.json(
            { success: false, error: '文件不存在或无法删除' },
            { status: 404 }
          );
        }
      }

      case 'clear-collection': {
        // 清空 Milvus 集合
        const { embeddingModel = DEFAULT_EMBEDDING_MODEL } = params;
        
        try {
          const milvus = await getAdaptiveMilvus(embeddingModel);
          await milvus.clearCollection();
          milvusInstance = null;
          
          return NextResponse.json({
            success: true,
            message: '知识库已清空',
          });
        } catch (e) {
          return NextResponse.json({
            success: false,
            error: e instanceof Error ? e.message : '清空失败',
          });
        }
      }

      default:
        return NextResponse.json(
          { success: false, error: '未知操作' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[AdaptiveEntityRAG API] POST 错误:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}

/**
 * DELETE: 清除缓存或删除实体
 */
export async function DELETE(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action') || 'clear-cache';

    switch (action) {
      case 'clear-cache': {
        ragInstance = null;
        return NextResponse.json({
          success: true,
          message: '缓存已清除',
        });
      }

      default:
        return NextResponse.json(
          { success: false, error: '未知操作' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[AdaptiveEntityRAG API] DELETE 错误:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}
