import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// Ollama 配置
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const LLM_MODEL = 'llama3.1';
const EMBEDDING_MODEL = 'nomic-embed-text';

// 质心数据存储路径
const CENTROIDS_FILE = path.join(process.cwd(), 'data', 'centroids.json');

// 预定义的领域配置
const DOMAIN_CONFIG = {
  tech: {
    name: '技术',
    description: '软件开发、编程、系统架构相关',
    color: '#3B82F6',
    icon: '💻',
    seedPrompt: '请列出50个与软件开发、编程、系统架构、人工智能、数据科学相关的核心技术词汇。只输出词汇，用逗号分隔，不要编号和解释。'
  },
  business: {
    name: '商业',
    description: '市场营销、企业管理、投资金融',
    color: '#10B981',
    icon: '💼',
    seedPrompt: '请列出50个与市场营销、企业管理、投资金融、商业战略相关的核心商业词汇。只输出词汇，用逗号分隔，不要编号和解释。'
  },
  daily: {
    name: '日常',
    description: '生活起居、休闲娱乐、人际交往',
    color: '#F59E0B',
    icon: '🏠',
    seedPrompt: '请列出50个与日常生活、休闲娱乐、家庭生活、社交活动相关的常用词汇。只输出词汇，用逗号分隔，不要编号和解释。'
  },
  emotion: {
    name: '情感',
    description: '情绪表达、心理状态、人际情感',
    color: '#EC4899',
    icon: '❤️',
    seedPrompt: '请列出50个与情感表达、心理状态、人际关系情感相关的词汇。只输出词汇，用逗号分隔，不要编号和解释。'
  },
  academic: {
    name: '学术',
    description: '科学研究、论文写作、学术交流',
    color: '#8B5CF6',
    icon: '📚',
    seedPrompt: '请列出50个与科学研究、学术论文、实验方法、理论分析相关的学术词汇。只输出词汇，用逗号分隔，不要编号和解释。'
  },
  health: {
    name: '健康',
    description: '医疗保健、运动健身、营养饮食',
    color: '#EF4444',
    icon: '🏥',
    seedPrompt: '请列出50个与医疗健康、运动健身、营养饮食、心理健康相关的词汇。只输出词汇，用逗号分隔，不要编号和解释。'
  },
  culture: {
    name: '文化',
    description: '艺术文学、历史传统、文化现象',
    color: '#06B6D4',
    icon: '🎭',
    seedPrompt: '请列出50个与艺术文学、历史传统、文化现象、人文艺术相关的词汇。只输出词汇，用逗号分隔，不要编号和解释。'
  },
  nature: {
    name: '自然',
    description: '自然环境、生态系统、地理气候',
    color: '#22C55E',
    icon: '🌿',
    seedPrompt: '请列出50个与自然环境、生态系统、地理气候、动植物相关的词汇。只输出词汇，用逗号分隔，不要编号和解释。'
  }
};

// 确保数据目录存在
function ensureDataDir() {
  const dataDir = path.dirname(CENTROIDS_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

// 加载已保存的质心数据
function loadCentroids(): Record<string, any> {
  try {
    ensureDataDir();
    if (fs.existsSync(CENTROIDS_FILE)) {
      const data = fs.readFileSync(CENTROIDS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load centroids:', error);
  }
  return {};
}

// 保存质心数据
function saveCentroids(centroids: Record<string, any>) {
  try {
    ensureDataDir();
    fs.writeFileSync(CENTROIDS_FILE, JSON.stringify(centroids, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('Failed to save centroids:', error);
    return false;
  }
}

// 调用 Ollama LLM 生成种子词
async function generateSeedWords(domain: string, customPrompt?: string): Promise<string[]> {
  const config = DOMAIN_CONFIG[domain as keyof typeof DOMAIN_CONFIG];
  if (!config && !customPrompt) {
    throw new Error(`Unknown domain: ${domain}`);
  }
  
  const prompt = customPrompt || config.seedPrompt;
  
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 500
        }
      })
    });
    
    if (!response.ok) {
      throw new Error(`Ollama LLM request failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    const text = data.response || '';
    
    // 解析返回的词汇（支持逗号、顿号、换行分隔）
    const words = text
      .split(/[,，、\n]+/)
      .map((w: string) => w.trim().replace(/^\d+[.、)）]\s*/, '')) // 移除可能的编号
      .filter((w: string) => w.length > 0 && w.length < 20); // 过滤无效词
    
    return words;
  } catch (error) {
    console.error('Failed to generate seed words:', error);
    throw error;
  }
}

// 调用 Ollama Embedding API 获取向量
async function getEmbedding(text: string): Promise<number[]> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        prompt: text
      })
    });
    
    if (!response.ok) {
      throw new Error(`Ollama embedding request failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.embedding || [];
  } catch (error) {
    console.error('Failed to get embedding:', error);
    throw error;
  }
}

// 批量获取向量
async function getEmbeddings(texts: string[]): Promise<Array<{ text: string; embedding: number[] }>> {
  const results: Array<{ text: string; embedding: number[] }> = [];
  
  // 分批处理，避免过载
  const batchSize = 10;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (text) => {
        const embedding = await getEmbedding(text);
        return { text, embedding };
      })
    );
    results.push(...batchResults);
  }
  
  return results;
}

// 计算向量平均值（质心）
function calculateCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  
  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);
  
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }
  
  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
  }
  
  // 归一化
  const norm = Math.sqrt(centroid.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      centroid[i] /= norm;
    }
  }
  
  return centroid;
}

// GET: 获取领域配置和已保存的质心
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action');
  
  if (action === 'config') {
    // 返回领域配置
    return NextResponse.json({
      success: true,
      domains: DOMAIN_CONFIG
    });
  }
  
  if (action === 'centroids') {
    // 返回已保存的质心数据
    const centroids = loadCentroids();
    return NextResponse.json({
      success: true,
      centroids,
      savedAt: centroids._meta?.savedAt
    });
  }
  
  if (action === 'check-ollama') {
    // 检查 Ollama 服务状态
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        throw new Error('Ollama service not responding');
      }
      
      const data = await response.json();
      const models = data.models || [];
      const hasLLM = models.some((m: any) => m.name.includes('llama3.1'));
      const hasEmbed = models.some((m: any) => m.name.includes('nomic-embed-text'));
      
      return NextResponse.json({
        success: true,
        status: 'online',
        models: models.map((m: any) => m.name),
        requirements: {
          llm: { model: LLM_MODEL, available: hasLLM },
          embedding: { model: EMBEDDING_MODEL, available: hasEmbed }
        }
      });
    } catch (error) {
      return NextResponse.json({
        success: false,
        status: 'offline',
        error: 'Cannot connect to Ollama service'
      });
    }
  }
  
  return NextResponse.json({
    success: true,
    message: 'Domain Vectors API',
    actions: ['config', 'centroids', 'check-ollama']
  });
}

// POST: 处理各种操作
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;
    
    // 生成种子词
    if (action === 'generate-seeds') {
      const { domain, customPrompt } = body;
      const words = await generateSeedWords(domain, customPrompt);
      return NextResponse.json({
        success: true,
        domain,
        words,
        count: words.length
      });
    }
    
    // 计算单个领域的质心
    if (action === 'calculate-centroid') {
      const { domain, seedWords } = body;
      
      if (!seedWords || seedWords.length === 0) {
        return NextResponse.json({
          success: false,
          error: 'No seed words provided'
        }, { status: 400 });
      }
      
      // 获取所有种子词的向量
      const embeddings = await getEmbeddings(seedWords);
      
      // 计算质心
      const centroid = calculateCentroid(embeddings.map(e => e.embedding));
      
      // 保存结果
      const centroids = loadCentroids();
      const config = DOMAIN_CONFIG[domain as keyof typeof DOMAIN_CONFIG];
      
      centroids[domain] = {
        name: config?.name || domain,
        description: config?.description || '',
        color: config?.color || '#6B7280',
        icon: config?.icon || '📁',
        seedWords,
        wordCount: seedWords.length,
        centroid,
        dimension: centroid.length,
        calculatedAt: new Date().toISOString()
      };
      centroids._meta = {
        savedAt: new Date().toISOString(),
        totalDomains: Object.keys(centroids).filter(k => k !== '_meta').length
      };
      
      saveCentroids(centroids);
      
      return NextResponse.json({
        success: true,
        domain,
        wordCount: seedWords.length,
        dimension: centroid.length,
        embeddings: embeddings.map(e => ({
          text: e.text,
          magnitude: Math.sqrt(e.embedding.reduce((s, v) => s + v * v, 0))
        }))
      });
    }
    
    // 批量计算所有领域的质心
    if (action === 'calculate-all') {
      const { domains } = body; // domains: { tech: [...words], business: [...words], ... }
      
      const results: Record<string, any> = {};
      const centroids = loadCentroids();
      
      for (const [domain, seedWords] of Object.entries(domains)) {
        if (!Array.isArray(seedWords) || seedWords.length === 0) continue;
        
        const embeddings = await getEmbeddings(seedWords as string[]);
        const centroid = calculateCentroid(embeddings.map(e => e.embedding));
        
        const config = DOMAIN_CONFIG[domain as keyof typeof DOMAIN_CONFIG];
        
        centroids[domain] = {
          name: config?.name || domain,
          description: config?.description || '',
          color: config?.color || '#6B7280',
          icon: config?.icon || '📁',
          seedWords,
          wordCount: (seedWords as string[]).length,
          centroid,
          dimension: centroid.length,
          calculatedAt: new Date().toISOString()
        };
        
        results[domain] = {
          wordCount: (seedWords as string[]).length,
          dimension: centroid.length
        };
      }
      
      centroids._meta = {
        savedAt: new Date().toISOString(),
        totalDomains: Object.keys(centroids).filter(k => k !== '_meta').length
      };
      
      saveCentroids(centroids);
      
      return NextResponse.json({
        success: true,
        results,
        savedPath: CENTROIDS_FILE
      });
    }
    
    // 测试查询向量与各领域的相似度
    if (action === 'test-query') {
      const { query, showDetails = false } = body;
      
      // 验证输入
      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return NextResponse.json({
          success: false,
          error: '查询文本不能为空'
        }, { status: 400 });
      }
      
      console.log(`[test-query] Query: "${query}", showDetails: ${showDetails}`);
      
      // 加载质心数据
      const centroids = loadCentroids();
      const domainCount = Object.keys(centroids).filter(k => k !== '_meta').length;
      
      if (domainCount === 0) {
        return NextResponse.json({
          success: false,
          error: '没有可用的领域质心数据，请先计算至少一个领域的质心'
        }, { status: 400 });
      }
      
      console.log(`[test-query] Loaded ${domainCount} domain centroids`);
      
      // 获取查询向量
      let queryEmbedding: number[];
      try {
        queryEmbedding = await getEmbedding(query);
        console.log(`[test-query] Query embedding dimension: ${queryEmbedding.length}`);
      } catch (error) {
        console.error('[test-query] Failed to get query embedding:', error);
        return NextResponse.json({
          success: false,
          error: `获取查询向量失败: ${error instanceof Error ? error.message : 'Ollama 服务可能未启动'}`
        }, { status: 500 });
      }
      
      // 归一化查询向量
      const queryNorm = Math.sqrt(queryEmbedding.reduce((sum, v) => sum + v * v, 0));
      const normalizedQuery = queryEmbedding.map(v => v / queryNorm);
      
      // 计算与各领域质心的余弦相似度
      const similarities: Array<{ 
        domain: string; 
        similarity: number; 
        name: string; 
        icon: string;
        color: string;
        details?: any;
      }> = [];
      
      for (const [domain, data] of Object.entries(centroids)) {
        if (domain === '_meta' || !data.centroid) continue;
        
        const centroid = data.centroid;
        
        // 余弦相似度（使用归一化后的向量）
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < normalizedQuery.length; i++) {
          dotProduct += normalizedQuery[i] * centroid[i];
          normA += normalizedQuery[i] * normalizedQuery[i];
          normB += centroid[i] * centroid[i];
        }
        
        const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
        
        // 计算详细信息
        const details = showDetails ? {
          dotProduct,
          queryNorm: Math.sqrt(normA),
          centroidNorm: Math.sqrt(normB),
          wordCount: data.wordCount,
          dimension: data.dimension,
          // 找出贡献最大的维度
          topDimensions: normalizedQuery
            .map((v, i) => ({ dim: i, queryVal: v, centroidVal: centroid[i], contrib: v * centroid[i] }))
            .sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib))
            .slice(0, 10),
          // 种子词样本
          seedSample: data.seedWords?.slice(0, 10) || []
        } : undefined;
        
        similarities.push({
          domain,
          similarity,
          name: data.name,
          icon: data.icon,
          color: data.color || '#6B7280',
          details
        });
      }
      
      // 按相似度排序
      similarities.sort((a, b) => b.similarity - a.similarity);
      
      // 计算统计信息
      const stats = {
        mean: similarities.reduce((sum, s) => sum + s.similarity, 0) / similarities.length,
        std: 0,
        range: similarities[0].similarity - similarities[similarities.length - 1].similarity,
        queryNorm: queryNorm,
        queryDim: queryEmbedding.length
      };
      
      // 计算标准差
      const variance = similarities.reduce((sum, s) => sum + Math.pow(s.similarity - stats.mean, 2), 0) / similarities.length;
      stats.std = Math.sqrt(variance);
      
      console.log(`[test-query] Results:`, {
        totalDomains: similarities.length,
        topDomain: similarities[0]?.name,
        topSimilarity: similarities[0]?.similarity,
        mean: stats.mean,
        std: stats.std
      });
      
      const result = {
        success: true,
        query,
        similarities,
        topDomain: similarities[0] || null,
        stats,
        queryVector: showDetails ? {
          dimension: queryEmbedding.length,
          norm: queryNorm,
          sample: normalizedQuery.slice(0, 20).map(v => v.toFixed(6))
        } : undefined
      };
      
      return NextResponse.json(result);
    }
    
    // 添加自定义领域
    if (action === 'add-custom-domain') {
      const { domainId, name, description, color, icon, seedWords } = body;
      
      if (!domainId || !seedWords || seedWords.length === 0) {
        return NextResponse.json({
          success: false,
          error: 'Missing required fields'
        }, { status: 400 });
      }
      
      const embeddings = await getEmbeddings(seedWords);
      const centroid = calculateCentroid(embeddings.map(e => e.embedding));
      
      const centroids = loadCentroids();
      
      centroids[domainId] = {
        name: name || domainId,
        description: description || '',
        color: color || '#6B7280',
        icon: icon || '📁',
        seedWords,
        wordCount: seedWords.length,
        centroid,
        dimension: centroid.length,
        isCustom: true,
        calculatedAt: new Date().toISOString()
      };
      
      centroids._meta = {
        savedAt: new Date().toISOString(),
        totalDomains: Object.keys(centroids).filter(k => k !== '_meta').length
      };
      
      saveCentroids(centroids);
      
      return NextResponse.json({
        success: true,
        domainId,
        wordCount: seedWords.length,
        dimension: centroid.length
      });
    }
    
    // 删除领域
    if (action === 'delete-domain') {
      const { domainId } = body;
      
      const centroids = loadCentroids();
      if (centroids[domainId]) {
        delete centroids[domainId];
        centroids._meta = {
          savedAt: new Date().toISOString(),
          totalDomains: Object.keys(centroids).filter(k => k !== '_meta').length
        };
        saveCentroids(centroids);
      }
      
      return NextResponse.json({
        success: true,
        deleted: domainId
      });
    }
    
    return NextResponse.json({
      success: false,
      error: 'Unknown action'
    }, { status: 400 });
    
  } catch (error) {
    console.error('Domain vectors API error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
