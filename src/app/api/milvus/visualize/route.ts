import { NextRequest, NextResponse } from 'next/server';
import { getMilvusInstance, MilvusConfig } from '@/lib/milvus-client';
import { createEmbedding } from '@/lib/model-config';
import { getMilvusConnectionConfig } from '@/lib/milvus-config';

// 环境变量配置
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

// 获取默认 Milvus 配置（使用统一配置系统）
function getDefaultMilvusConfig(): MilvusConfig {
  const connConfig = getMilvusConnectionConfig();
  return {
    address: connConfig.address,
    collectionName: connConfig.defaultCollection,
    embeddingDimension: connConfig.defaultDimension,
    indexType: connConfig.defaultIndexType,
    metricType: connConfig.defaultMetricType,
    token: connConfig.token,
    ssl: connConfig.ssl,
  };
}

// t-SNE 简化实现（用于降维可视化）
function simpleTSNE(vectors: number[][], targetDim: number = 2, iterations: number = 100): number[][] {
  const n = vectors.length;
  if (n === 0) return [];
  
  // 初始化随机位置
  const result: number[][] = vectors.map(() => 
    Array(targetDim).fill(0).map(() => (Math.random() - 0.5) * 10)
  );
  
  // 计算高维空间中的距离
  const distances: number[][] = [];
  for (let i = 0; i < n; i++) {
    distances[i] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) {
        distances[i][j] = 0;
      } else {
        let sum = 0;
        for (let k = 0; k < Math.min(vectors[i].length, 100); k++) {
          sum += Math.pow(vectors[i][k] - vectors[j][k], 2);
        }
        distances[i][j] = Math.sqrt(sum);
      }
    }
  }
  
  // 迭代优化
  const learningRate = 0.5;
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < targetDim; d++) {
        let gradient = 0;
        for (let j = 0; j < n; j++) {
          if (i !== j) {
            const lowDimDist = Math.sqrt(
              result[i].reduce((sum, val, idx) => sum + Math.pow(val - result[j][idx], 2), 0)
            ) + 0.001;
            
            const highDimDist = distances[i][j] + 0.001;
            const diff = (lowDimDist - highDimDist) / highDimDist;
            
            gradient += diff * (result[i][d] - result[j][d]) / lowDimDist;
          }
        }
        result[i][d] -= learningRate * gradient / n;
      }
    }
  }
  
  // 归一化到 [-1, 1]
  for (let d = 0; d < targetDim; d++) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      min = Math.min(min, result[i][d]);
      max = Math.max(max, result[i][d]);
    }
    const range = max - min || 1;
    for (let i = 0; i < n; i++) {
      result[i][d] = ((result[i][d] - min) / range) * 2 - 1;
    }
  }
  
  return result;
}

// 计算向量聚类（简化版 K-Means）
function simpleClustering(vectors: number[][], k: number = 5): number[] {
  const n = vectors.length;
  if (n === 0) return [];
  if (n <= k) return vectors.map((_, i) => i);
  
  // 随机初始化聚类中心
  const centroids: number[][] = [];
  const usedIndices = new Set<number>();
  for (let i = 0; i < k; i++) {
    let idx;
    do {
      idx = Math.floor(Math.random() * n);
    } while (usedIndices.has(idx));
    usedIndices.add(idx);
    centroids.push([...vectors[idx]]);
  }
  
  // 分配点到最近的聚类
  const assignments: number[] = new Array(n).fill(0);
  for (let iter = 0; iter < 10; iter++) {
    // 分配
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      let minCluster = 0;
      for (let c = 0; c < k; c++) {
        let dist = 0;
        for (let d = 0; d < Math.min(vectors[i].length, 100); d++) {
          dist += Math.pow(vectors[i][d] - centroids[c][d], 2);
        }
        if (dist < minDist) {
          minDist = dist;
          minCluster = c;
        }
      }
      assignments[i] = minCluster;
    }
    
    // 更新中心
    for (let c = 0; c < k; c++) {
      const members = vectors.filter((_, i) => assignments[i] === c);
      if (members.length > 0) {
        for (let d = 0; d < centroids[c].length; d++) {
          centroids[c][d] = members.reduce((sum, v) => sum + v[d], 0) / members.length;
        }
      }
    }
  }
  
  return assignments;
}

// POST: 可视化操作
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ...params } = body;

    switch (action) {
      // 获取向量空间数据（降维后）
      case 'vector-space': {
        const { sampleSize = 100, dimensions = 2 } = params;
        
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.connect();
        await milvus.initializeCollection();
        
        // 获取随机样本的向量数据
        // 注意：这需要 Milvus 支持，这里我们使用模拟数据作为示例
        const stats = await milvus.getCollectionStats();
        const totalDocs = stats?.rowCount || 0;
        
        // 生成模拟的降维数据点
        // 实际实现中，这里应该从 Milvus 获取真实向量数据
        const points: Array<{
          id: string;
          x: number;
          y: number;
          z?: number;
          content: string;
          source: string;
          cluster: number;
        }> = [];
        
        // 搜索一些样本数据
        if (totalDocs > 0) {
          const embeddings = createEmbedding(EMBEDDING_MODEL);
          
          // 使用多个查询获取数据点
          const queries = ['技术', '商业', '日常', '科学', '文化'];
          const allResults: any[] = [];
          
          for (const q of queries) {
            try {
              const queryEmbed = await embeddings.embedQuery(q);
              const results = await milvus.search(queryEmbed, Math.ceil(sampleSize / queries.length), 0);
              allResults.push(...results.map(r => ({ ...r, queryTopic: q })));
            } catch (e) {
              console.error('Query error:', e);
            }
          }
          
          // 去重
          const uniqueResults = Array.from(
            new Map(allResults.map(r => [r.id, r])).values()
          ).slice(0, sampleSize);
          
          // 根据查询主题分配聚类
          const topicClusters: Record<string, number> = {
            '技术': 0, '商业': 1, '日常': 2, '科学': 3, '文化': 4
          };
          
          // 生成 2D/3D 坐标（基于相似度分布）
          uniqueResults.forEach((result, i) => {
            const angle = (i / uniqueResults.length) * Math.PI * 2;
            const radius = (1 - result.score) * 2;
            const cluster = topicClusters[result.queryTopic] || 0;
            const clusterOffset = cluster * (Math.PI * 2 / 5);
            
            points.push({
              id: result.id,
              x: Math.cos(angle + clusterOffset) * radius + (Math.random() - 0.5) * 0.3,
              y: Math.sin(angle + clusterOffset) * radius + (Math.random() - 0.5) * 0.3,
              z: dimensions === 3 ? (Math.random() - 0.5) * 2 : undefined,
              content: result.content.substring(0, 100) + '...',
              source: result.metadata?.source || 'unknown',
              cluster,
            });
          });
        }
        
        return NextResponse.json({
          success: true,
          totalDocuments: totalDocs,
          sampledPoints: points.length,
          points,
          clusters: [
            { id: 0, name: '技术', color: '#3B82F6' },
            { id: 1, name: '商业', color: '#10B981' },
            { id: 2, name: '日常', color: '#F59E0B' },
            { id: 3, name: '科学', color: '#8B5CF6' },
            { id: 4, name: '文化', color: '#EC4899' },
          ],
        });
      }

      // 获取相似度分布
      case 'similarity-distribution': {
        const { query, topK = 50 } = params;
        
        if (!query) {
          return NextResponse.json({
            success: false,
            error: '请提供查询文本',
          }, { status: 400 });
        }
        
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.connect();
        await milvus.initializeCollection();
        
        const stats = await milvus.getCollectionStats();
        const collectionDimension = stats?.embeddingDimension || 768;
        
        // 根据集合维度选择模型
        const actualModel = collectionDimension === 768 ? 'nomic-embed-text' : 'mxbai-embed-large';
        
        const embeddings = createEmbedding(actualModel);
        
        const queryEmbed = await embeddings.embedQuery(query);
        const results = await milvus.search(queryEmbed, topK, 0);
        
        // 生成相似度分布
        const distribution = {
          '0.9-1.0': 0,
          '0.8-0.9': 0,
          '0.7-0.8': 0,
          '0.6-0.7': 0,
          '0.5-0.6': 0,
          '0.4-0.5': 0,
          '0.3-0.4': 0,
          '0.2-0.3': 0,
          '0.1-0.2': 0,
          '0.0-0.1': 0,
        };
        
        results.forEach(r => {
          if (r.score >= 0.9) distribution['0.9-1.0']++;
          else if (r.score >= 0.8) distribution['0.8-0.9']++;
          else if (r.score >= 0.7) distribution['0.7-0.8']++;
          else if (r.score >= 0.6) distribution['0.6-0.7']++;
          else if (r.score >= 0.5) distribution['0.5-0.6']++;
          else if (r.score >= 0.4) distribution['0.4-0.5']++;
          else if (r.score >= 0.3) distribution['0.3-0.4']++;
          else if (r.score >= 0.2) distribution['0.2-0.3']++;
          else if (r.score >= 0.1) distribution['0.1-0.2']++;
          else distribution['0.0-0.1']++;
        });
        
        return NextResponse.json({
          success: true,
          query,
          embeddingModel: actualModel,
          topK: results.length,
          distribution,
          statistics: {
            mean: results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0,
            max: results.length > 0 ? Math.max(...results.map(r => r.score)) : 0,
            min: results.length > 0 ? Math.min(...results.map(r => r.score)) : 0,
            median: results.length > 0 ? results.sort((a, b) => a.score - b.score)[Math.floor(results.length / 2)].score : 0,
          },
          results: results.slice(0, 10), // 只返回前10个详细结果
        });
      }

      // 获取集合详细信息
      case 'collection-info': {
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.connect();
        await milvus.initializeCollection();
        
        const stats = await milvus.getCollectionStats();
        const healthResult = await milvus.checkHealth();
        const config = milvus.getConfig();
        
        return NextResponse.json({
          success: true,
          collection: {
            name: config.collectionName,
            stats,
            health: healthResult,
            schema: {
              fields: [
                { name: 'id', type: 'VarChar', isPrimaryKey: true },
                { name: 'content', type: 'VarChar', maxLength: 65535 },
                { name: 'embedding', type: 'FloatVector', dimension: stats?.embeddingDimension || 768 },
                { name: 'source', type: 'VarChar', maxLength: 1024 },
                { name: 'metadata_json', type: 'VarChar', maxLength: 65535 },
                { name: 'created_at', type: 'Int64' },
              ],
              indexes: [
                { field: 'embedding', type: config.indexType, metric: config.metricType },
              ],
            },
          },
          config: {
            address: config.address,
            database: config.database,
            indexType: config.indexType,
            metricType: config.metricType,
            embeddingDimension: stats?.embeddingDimension || config.embeddingDimension,
          },
        });
      }

      // 查询路径可视化
      case 'query-path': {
        const { query, topK = 5 } = params;
        
        if (!query) {
          return NextResponse.json({
            success: false,
            error: '请提供查询文本',
          }, { status: 400 });
        }
        
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        await milvus.connect();
        await milvus.initializeCollection();
        
        const stats = await milvus.getCollectionStats();
        const collectionDimension = stats?.embeddingDimension || 768;
        const actualModel = collectionDimension === 768 ? 'nomic-embed-text' : 'mxbai-embed-large';
        
        const embeddings = createEmbedding(actualModel);
        
        const startTime = Date.now();
        const queryEmbed = await embeddings.embedQuery(query);
        const embeddingTime = Date.now() - startTime;
        
        const searchStart = Date.now();
        const results = await milvus.search(queryEmbed, topK, 0);
        const searchTime = Date.now() - searchStart;
        
        // 生成查询路径可视化数据
        const centerX = 0, centerY = 0;
        const nodes = [
          {
            id: 'query',
            type: 'query',
            label: query.substring(0, 30) + '...',
            x: centerX,
            y: centerY,
          },
          ...results.map((r, i) => {
            const angle = (i / results.length) * Math.PI * 2;
            const radius = (1 - r.score) * 3 + 0.5;
            return {
              id: r.id,
              type: 'document',
              label: r.content.substring(0, 30) + '...',
              x: centerX + Math.cos(angle) * radius,
              y: centerY + Math.sin(angle) * radius,
              score: r.score,
              source: r.metadata?.source,
            };
          }),
        ];
        
        const edges = results.map(r => ({
          source: 'query',
          target: r.id,
          weight: r.score,
        }));
        
        return NextResponse.json({
          success: true,
          query,
          embeddingModel: actualModel,
          timing: {
            embedding: embeddingTime,
            search: searchTime,
            total: embeddingTime + searchTime,
          },
          visualization: {
            nodes,
            edges,
          },
          results,
        });
      }

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Milvus Visualize API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

// GET: 获取可视化数据
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'summary';

  try {
    switch (action) {
      case 'summary': {
        const milvus = getMilvusInstance(getDefaultMilvusConfig());
        
        try {
          await milvus.connect();
          await milvus.initializeCollection();
          
          const stats = await milvus.getCollectionStats();
          const healthResult = await milvus.checkHealth();
          
          return NextResponse.json({
            success: true,
            summary: {
              connected: healthResult.healthy,
              totalDocuments: stats?.rowCount || 0,
              embeddingDimension: stats?.embeddingDimension || 768,
              indexType: stats?.indexType || 'IVF_FLAT',
              metricType: stats?.metricType || 'COSINE',
              loaded: stats?.loaded || false,
            },
          });
        } catch (e) {
          return NextResponse.json({
            success: true,
            summary: {
              connected: false,
              totalDocuments: 0,
              embeddingDimension: 768,
              indexType: 'IVF_FLAT',
              metricType: 'COSINE',
              loaded: false,
            },
          });
        }
      }

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Milvus Visualize API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
