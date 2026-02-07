import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// Ollama 配置
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const LLM_MODEL = 'llama3.1';
const EMBEDDING_MODEL = 'nomic-embed-text';

// 质心数据路径
const CENTROIDS_FILE = path.join(process.cwd(), 'data', 'centroids.json');

// 加载质心数据
function loadCentroids(): Record<string, any> {
  try {
    if (fs.existsSync(CENTROIDS_FILE)) {
      const data = fs.readFileSync(CENTROIDS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load centroids:', error);
  }
  return {};
}

// 获取向量
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
      throw new Error(`Ollama embedding failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.embedding || [];
  } catch (error) {
    console.error('Failed to get embedding:', error);
    throw error;
  }
}

// 计算领域相似度
async function analyzeDomainDistribution(query: string): Promise<{
  domains: Array<{ domain: string; name: string; similarity: number; icon: string }>;
  topDomain: { domain: string; name: string; similarity: number; icon: string } | null;
}> {
  const centroids = loadCentroids();
  const queryEmbedding = await getEmbedding(query);
  
  // 归一化
  const queryNorm = Math.sqrt(queryEmbedding.reduce((sum, v) => sum + v * v, 0));
  const normalizedQuery = queryEmbedding.map(v => v / queryNorm);
  
  const domains: Array<{ domain: string; name: string; similarity: number; icon: string }> = [];
  
  for (const [domain, data] of Object.entries(centroids)) {
    if (domain === '_meta' || !data.centroid) continue;
    
    const centroid = data.centroid;
    
    // 余弦相似度
    let dotProduct = 0;
    for (let i = 0; i < normalizedQuery.length; i++) {
      dotProduct += normalizedQuery[i] * centroid[i];
    }
    
    const normA = Math.sqrt(normalizedQuery.reduce((s, v) => s + v * v, 0));
    const normB = Math.sqrt(centroid.reduce((s: number, v: number) => s + v * v, 0));
    const similarity = dotProduct / (normA * normB);
    
    domains.push({
      domain,
      name: data.name,
      similarity,
      icon: data.icon
    });
  }
  
  // 排序
  domains.sort((a, b) => b.similarity - a.similarity);
  
  return {
    domains,
    topDomain: domains[0] || null
  };
}

// Query Expansion - 关键词扩展
async function expandQueryKeywords(query: string, domainContext: any): Promise<{
  originalKeywords: string[];
  synonyms: Record<string, string[]>;
  relatedTerms: string[];
  expandedQueries: string[];
  reasoning: string;
}> {
  const topDomainName = domainContext.topDomain?.name || '通用';
  
  const prompt = `你是一个专业的语义扩展专家。请分析以下查询并进行关键词扩展。

用户查询: "${query}"
主要领域: ${topDomainName}

请完成以下任务：
1. 提取原始查询中的核心关键词（3-5个）
2. 为每个关键词提供2-3个同义词或近义词
3. 根据领域上下文，提供5-8个相关术语
4. 生成2-3个包含扩展关键词的优化查询

请以JSON格式返回（只输出JSON，不要其他内容）：
{
  "originalKeywords": ["关键词1", "关键词2", "关键词3"],
  "synonyms": {
    "关键词1": ["同义词1", "同义词2"],
    "关键词2": ["同义词1", "同义词2"]
  },
  "relatedTerms": ["相关术语1", "相关术语2", "相关术语3", "相关术语4", "相关术语5"],
  "expandedQueries": [
    "包含同义词的扩展查询1",
    "包含相关术语的扩展查询2"
  ],
  "reasoning": "扩展推理：解释为什么选择这些同义词和相关术语"
}`;

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.4,
          top_p: 0.9,
          num_predict: 1000
        }
      })
    });

    if (!response.ok) {
      throw new Error('Query expansion LLM request failed');
    }

    const data = await response.json();
    const responseText = data.response || '';
    
    // 提取 JSON
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        originalKeywords: parsed.originalKeywords || [],
        synonyms: parsed.synonyms || {},
        relatedTerms: parsed.relatedTerms || [],
        expandedQueries: parsed.expandedQueries || [],
        reasoning: parsed.reasoning || '自动扩展分析'
      };
    }
    
    throw new Error('Failed to parse query expansion response');
  } catch (error) {
    console.error('Query expansion failed:', error);
    // 返回基础结果
    const words = query.split(/[\s,，、]+/).filter(w => w.length > 1);
    return {
      originalKeywords: words.slice(0, 3),
      synonyms: {},
      relatedTerms: [],
      expandedQueries: [query],
      reasoning: '扩展失败，使用原始查询'
    };
  }
}

// 使用 LLM 进行意图分析
async function analyzeIntentWithLLM(query: string, domainContext: any): Promise<{
  intent: string;
  intentType: string;
  confidence: number;
  expandedQueries: string[];
  keywords: string[];
  reasoning: string;
}> {
  const topDomains = domainContext.domains.slice(0, 3)
    .map((d: any) => `${d.name}(${(d.similarity * 100).toFixed(1)}%)`)
    .join(', ');
  
  const prompt = `你是一个专业的查询意图分析专家。请深入分析以下用户查询的意图。

用户查询: "${query}"

领域分布分析:
- 主要领域: ${topDomains}
- 最匹配领域: ${domainContext.topDomain?.name || '未知'} (${((domainContext.topDomain?.similarity || 0) * 100).toFixed(1)}%)

请按照以下 JSON 格式输出分析结果（只输出 JSON，不要其他内容）:

{
  "intent": "用简洁的一句话描述用户的核心意图",
  "intentType": "选择一个: 信息查询/问题解决/学习探索/操作指导/对比分析/创意生成",
  "confidence": 0.0-1.0之间的数字,
  "expandedQueries": [
    "扩展查询1: 从不同角度重新表述",
    "扩展查询2: 添加相关细节",
    "扩展查询3: 深入特定方面"
  ],
  "keywords": ["关键词1", "关键词2", "关键词3", "..."],
  "reasoning": "详细解释你的分析思路，为什么这样理解用户意图，以及如何生成扩展查询"
}`;

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 1000
        }
      })
    });
    
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    const text = data.response || '';
    
    // 提取 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from LLM response');
    }
    
    const result = JSON.parse(jsonMatch[0]);
    
    return {
      intent: result.intent || '未识别',
      intentType: result.intentType || '信息查询',
      confidence: result.confidence || 0.5,
      expandedQueries: result.expandedQueries || [query],
      keywords: result.keywords || [],
      reasoning: result.reasoning || '无详细分析'
    };
  } catch (error) {
    console.error('LLM intent analysis failed:', error);
    
    // 回退到基础分析
    return {
      intent: `查询关于 ${domainContext.topDomain?.name || '通用'} 领域的信息`,
      intentType: '信息查询',
      confidence: 0.6,
      expandedQueries: [query],
      keywords: query.split(/\s+/).filter(w => w.length > 1),
      reasoning: 'LLM 分析失败，使用基础分析'
    };
  }
}

// 生成查询改写建议
async function generateQueryRewrite(query: string, intentAnalysis: any, domainContext: any): Promise<{
  original: string;
  rewritten: string[];
  improvements: Array<{ type: string; description: string }>;
}> {
  const improvements: Array<{ type: string; description: string }> = [];
  const rewritten: string[] = [];
  
  // 基于领域的改写
  if (domainContext.topDomain && domainContext.topDomain.similarity > 0.7) {
    improvements.push({
      type: '领域聚焦',
      description: `查询与 ${domainContext.topDomain.name} 领域高度相关，已添加领域特定术语`
    });
  }
  
  // 基于意图的改写
  if (intentAnalysis.intentType === '问题解决') {
    improvements.push({
      type: '解决方案导向',
      description: '将查询重构为明确的解决方案请求'
    });
  }
  
  // 使用 LLM 生成的扩展查询
  rewritten.push(...intentAnalysis.expandedQueries);
  
  // 添加关键词增强查询
  if (intentAnalysis.keywords.length > 0) {
    const enhancedQuery = `${query} (关键词: ${intentAnalysis.keywords.slice(0, 5).join(', ')})`;
    rewritten.push(enhancedQuery);
    improvements.push({
      type: '关键词增强',
      description: `添加了 ${intentAnalysis.keywords.length} 个识别的关键词`
    });
  }
  
  return {
    original: query,
    rewritten: [...new Set(rewritten)], // 去重
    improvements
  };
}

// 计算意图置信度
function calculateIntentConfidence(domainAnalysis: any, intentAnalysis: any): {
  overall: number;
  factors: Array<{ factor: string; score: number; weight: number }>;
} {
  const factors: Array<{ factor: string; score: number; weight: number }> = [];
  
  // 领域匹配度
  const domainConfidence = domainAnalysis.topDomain?.similarity || 0;
  factors.push({
    factor: '领域匹配度',
    score: domainConfidence,
    weight: 0.3
  });
  
  // LLM 分析置信度
  factors.push({
    factor: 'LLM 分析置信度',
    score: intentAnalysis.confidence,
    weight: 0.4
  });
  
  // 关键词丰富度
  const keywordRichness = Math.min(1.0, intentAnalysis.keywords.length / 10);
  factors.push({
    factor: '关键词丰富度',
    score: keywordRichness,
    weight: 0.2
  });
  
  // 扩展查询质量
  const expansionQuality = Math.min(1.0, intentAnalysis.expandedQueries.length / 3);
  factors.push({
    factor: '查询扩展质量',
    score: expansionQuality,
    weight: 0.1
  });
  
  // 加权平均
  const overall = factors.reduce((sum, f) => sum + f.score * f.weight, 0);
  
  return {
    overall,
    factors
  };
}

// POST: 意图蒸馏
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query, includeRewrite = true } = body;
    
    // 验证输入
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return NextResponse.json({
        success: false,
        error: '查询文本不能为空'
      }, { status: 400 });
    }
    
    console.log(`[Intent Distillation] Query: "${query}"`);
    
    // 步骤 1: 领域分布分析
    console.log('[Intent Distillation] Step 1: Domain distribution analysis');
    const domainAnalysis = await analyzeDomainDistribution(query);
    
    // 步骤 2: LLM 意图分析
    console.log('[Intent Distillation] Step 2: LLM intent analysis');
    const intentAnalysis = await analyzeIntentWithLLM(query, domainAnalysis);
    
    // 步骤 2.5: Query Expansion - 关键词扩展
    console.log('[Intent Distillation] Step 2.5: Query expansion');
    const queryExpansion = await expandQueryKeywords(query, domainAnalysis);
    
    // 步骤 3: 查询改写
    let queryRewrite = null;
    if (includeRewrite) {
      console.log('[Intent Distillation] Step 3: Query rewrite');
      queryRewrite = await generateQueryRewrite(query, intentAnalysis, domainAnalysis);
    }
    
    // 步骤 4: 置信度计算
    console.log('[Intent Distillation] Step 4: Confidence calculation');
    const confidence = calculateIntentConfidence(domainAnalysis, intentAnalysis);
    
    // 生成建议
    const suggestions: Array<{ type: string; message: string; priority: 'high' | 'medium' | 'low' }> = [];
    
    // 领域建议
    if (domainAnalysis.topDomain && domainAnalysis.topDomain.similarity < 0.6) {
      suggestions.push({
        type: '领域模糊',
        message: `查询领域不够明确（${domainAnalysis.topDomain.name} ${(domainAnalysis.topDomain.similarity * 100).toFixed(1)}%），建议添加更具体的领域相关词汇`,
        priority: 'high'
      });
    }
    
    // 关键词建议
    if (intentAnalysis.keywords.length < 3) {
      suggestions.push({
        type: '关键词不足',
        message: '查询包含的关键词较少，建议使用更详细的描述',
        priority: 'medium'
      });
    }
    
    // 意图建议
    if (intentAnalysis.confidence < 0.7) {
      suggestions.push({
        type: '意图模糊',
        message: '查询意图不够明确，建议使用更具体的问题描述',
        priority: 'high'
      });
    }
    
    // 扩展查询建议
    if (intentAnalysis.expandedQueries.length > 1) {
      suggestions.push({
        type: '查询扩展',
        message: `已生成 ${intentAnalysis.expandedQueries.length} 个扩展查询，可以帮助获得更全面的结果`,
        priority: 'low'
      });
    }
    
    const result = {
      success: true,
      query,
      timestamp: new Date().toISOString(),
      
      // 领域分析
      domainAnalysis: {
        topDomain: domainAnalysis.topDomain,
        allDomains: domainAnalysis.domains,
        domainCount: domainAnalysis.domains.length
      },
      
      // 意图分析
      intentAnalysis: {
        intent: intentAnalysis.intent,
        intentType: intentAnalysis.intentType,
        confidence: intentAnalysis.confidence,
        keywords: intentAnalysis.keywords,
        reasoning: intentAnalysis.reasoning
      },
      
      // Query Expansion - 关键词扩展
      queryExpansion: {
        originalKeywords: queryExpansion.originalKeywords,
        synonyms: queryExpansion.synonyms,
        relatedTerms: queryExpansion.relatedTerms,
        expandedQueries: queryExpansion.expandedQueries,
        reasoning: queryExpansion.reasoning,
        totalSynonyms: Object.values(queryExpansion.synonyms).flat().length,
        totalRelated: queryExpansion.relatedTerms.length
      },
      
      // 查询改写
      queryRewrite,
      
      // 置信度
      confidence: {
        overall: confidence.overall,
        factors: confidence.factors,
        level: confidence.overall >= 0.8 ? 'high' : confidence.overall >= 0.6 ? 'medium' : 'low'
      },
      
      // 建议
      suggestions,
      
      // 推荐使用的查询
      recommendedQuery: queryRewrite?.rewritten[0] || query
    };
    
    console.log('[Intent Distillation] Complete:', {
      intent: intentAnalysis.intent,
      topDomain: domainAnalysis.topDomain?.name,
      confidence: confidence.overall.toFixed(3)
    });
    
    return NextResponse.json(result);
    
  } catch (error) {
    console.error('Intent distillation error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

// GET: 获取意图蒸馏统计信息
export async function GET() {
  const centroids = loadCentroids();
  const domainCount = Object.keys(centroids).filter(k => k !== '_meta').length;
  
  return NextResponse.json({
    success: true,
    available: domainCount > 0,
    domainCount,
    domains: Object.entries(centroids)
      .filter(([k]) => k !== '_meta')
      .map(([domain, data]) => ({
        domain,
        name: (data as any).name,
        icon: (data as any).icon
      })),
    supportedIntentTypes: [
      '信息查询',
      '问题解决',
      '学习探索',
      '操作指导',
      '对比分析',
      '创意生成'
    ]
  });
}
