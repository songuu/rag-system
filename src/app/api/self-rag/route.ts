import { NextRequest, NextResponse } from 'next/server';
import { getRagSystem } from '@/lib/rag-instance';

// Ollama 配置
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const LLM_MODEL = 'llama3.1';
const EMBEDDING_MODEL = 'nomic-embed-text';

// Self-RAG 评估结果类型
interface ReflectionToken {
  type: 'retrieve' | 'isrel' | 'issup' | 'isuse';
  value: string;
  score: number;
  reasoning: string;
  timestamp: number;
}

interface SelfRAGStep {
  stepId: number;
  stepName: string;
  input: any;
  output: any;
  reflection: ReflectionToken | null;
  duration: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

interface DocumentWithScore {
  content: string;
  source: string;
  similarity: number;
  isRelevant: boolean;
  relevanceScore: number;
  relevanceReasoning: string;
}

interface GenerationSegment {
  text: string;
  isSupported: boolean;
  supportScore: number;
  supportingDocs: string[];
  reasoning: string;
}

// 获取向量嵌入
async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      prompt: text
    })
  });
  
  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.embedding || [];
}

// 调用 LLM
async function callLLM(prompt: string, temperature: number = 0.3): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      prompt,
      stream: false,
      options: {
        temperature,
        num_predict: 1500
      }
    })
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.response || '';
}

// Step 1: Retrieve 决策 - 判断是否需要检索
async function evaluateRetrieveNeed(query: string): Promise<ReflectionToken> {
  const startTime = Date.now();
  
  const prompt = `你是一个智能检索决策系统。判断以下查询是否需要从知识库检索外部信息来回答。

查询: "${query}"

评估标准:
1. 如果查询是事实性问题、需要具体信息、或涉及特定领域知识 → 需要检索
2. 如果查询是简单的打招呼、数学计算、或常识性问题 → 不需要检索

请以JSON格式输出（只输出JSON）:
{
  "needRetrieval": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "解释为什么需要或不需要检索"
}`;

  try {
    const response = await callLLM(prompt, 0.2);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        type: 'retrieve',
        value: parsed.needRetrieval ? 'YES' : 'NO',
        score: parsed.confidence || 0.8,
        reasoning: parsed.reasoning || '自动判断',
        timestamp: Date.now() - startTime
      };
    }
    
    // 默认需要检索
    return {
      type: 'retrieve',
      value: 'YES',
      score: 0.7,
      reasoning: '无法确定，默认进行检索',
      timestamp: Date.now() - startTime
    };
  } catch (error) {
    return {
      type: 'retrieve',
      value: 'YES',
      score: 0.5,
      reasoning: '评估失败，默认进行检索',
      timestamp: Date.now() - startTime
    };
  }
}

// Step 2: IsRel 评估 - 判断检索文档的相关性
async function evaluateRelevance(query: string, document: string, source: string): Promise<{
  isRelevant: boolean;
  score: number;
  reasoning: string;
}> {
  const prompt = `你是一个文档相关性评估专家。判断以下文档是否与用户查询相关。

用户查询: "${query}"

文档内容: "${document.substring(0, 500)}${document.length > 500 ? '...' : ''}"
文档来源: ${source}

评估维度:
1. 主题相关性: 文档是否讨论了查询涉及的主题
2. 信息覆盖度: 文档是否包含回答查询所需的信息
3. 语义匹配度: 文档与查询的语义相似程度

请以JSON格式输出（只输出JSON）:
{
  "isRelevant": true/false,
  "relevanceScore": 0.0-1.0,
  "topicMatch": 0.0-1.0,
  "infoCoverage": 0.0-1.0,
  "semanticMatch": 0.0-1.0,
  "reasoning": "详细说明相关性判断的理由"
}`;

  try {
    const response = await callLLM(prompt, 0.2);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        isRelevant: parsed.isRelevant ?? (parsed.relevanceScore > 0.5),
        score: parsed.relevanceScore || 0.5,
        reasoning: parsed.reasoning || '自动评估'
      };
    }
    
    return { isRelevant: true, score: 0.5, reasoning: '无法解析评估结果' };
  } catch (error) {
    return { isRelevant: true, score: 0.5, reasoning: '评估失败' };
  }
}

// Step 3: IsSup 评估 - 判断生成内容是否被文档支持
async function evaluateSupport(response: string, documents: string[]): Promise<{
  segments: GenerationSegment[];
  overallSupport: number;
}> {
  const combinedDocs = documents.map((d, i) => `[Doc${i + 1}] ${d.substring(0, 300)}`).join('\n\n');
  
  const prompt = `你是一个事实核查专家。评估以下生成的回答是否被参考文档支持。

生成的回答:
"${response}"

参考文档:
${combinedDocs}

请将回答分解为多个陈述，并评估每个陈述是否有文档支持。

以JSON格式输出（只输出JSON）:
{
  "segments": [
    {
      "text": "陈述1",
      "isSupported": true/false,
      "supportScore": 0.0-1.0,
      "supportingDocs": ["Doc1", "Doc2"],
      "reasoning": "支持理由"
    }
  ],
  "overallSupport": 0.0-1.0,
  "unsupportedClaims": ["未支持的声明1"]
}`;

  try {
    const llmResponse = await callLLM(prompt, 0.2);
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        segments: parsed.segments || [{
          text: response,
          isSupported: true,
          supportScore: parsed.overallSupport || 0.7,
          supportingDocs: [],
          reasoning: '整体评估'
        }],
        overallSupport: parsed.overallSupport || 0.7
      };
    }
    
    return {
      segments: [{
        text: response,
        isSupported: true,
        supportScore: 0.5,
        supportingDocs: [],
        reasoning: '无法解析评估结果'
      }],
      overallSupport: 0.5
    };
  } catch (error) {
    return {
      segments: [{
        text: response,
        isSupported: true,
        supportScore: 0.5,
        supportingDocs: [],
        reasoning: '评估失败'
      }],
      overallSupport: 0.5
    };
  }
}

// Step 4: IsUse 评估 - 判断回答的有用性
async function evaluateUsefulness(query: string, response: string): Promise<ReflectionToken> {
  const startTime = Date.now();
  
  const prompt = `你是一个回答质量评估专家。评估以下回答对用户查询的有用性。

用户查询: "${query}"

生成的回答: "${response}"

评估维度:
1. 完整性: 是否全面回答了用户问题
2. 准确性: 信息是否准确无误
3. 清晰度: 表达是否清晰易懂
4. 实用性: 是否提供了可操作的信息
5. 相关性: 是否紧扣用户问题

请以JSON格式输出（只输出JSON）:
{
  "isUseful": true/false,
  "usefulnessScore": 0.0-1.0,
  "completeness": 0.0-1.0,
  "accuracy": 0.0-1.0,
  "clarity": 0.0-1.0,
  "practicality": 0.0-1.0,
  "relevance": 0.0-1.0,
  "reasoning": "详细说明有用性判断的理由",
  "improvements": ["改进建议1", "改进建议2"]
}`;

  try {
    const llmResponse = await callLLM(prompt, 0.3);
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        type: 'isuse',
        value: parsed.isUseful ? 'USEFUL' : 'NOT_USEFUL',
        score: parsed.usefulnessScore || 0.5,
        reasoning: parsed.reasoning || '自动评估',
        timestamp: Date.now() - startTime
      };
    }
    
    return {
      type: 'isuse',
      value: 'USEFUL',
      score: 0.5,
      reasoning: '无法解析评估结果',
      timestamp: Date.now() - startTime
    };
  } catch (error) {
    return {
      type: 'isuse',
      value: 'USEFUL',
      score: 0.5,
      reasoning: '评估失败',
      timestamp: Date.now() - startTime
    };
  }
}

// 生成回答
async function generateResponse(query: string, context: string): Promise<string> {
  const prompt = `基于以下参考信息回答用户问题。如果参考信息不足以回答问题，请诚实说明。

参考信息:
${context}

用户问题: ${query}

请提供准确、有帮助的回答:`;

  return await callLLM(prompt, 0.4);
}

// 重新生成回答（当支持度或有用性不足时）
async function regenerateResponse(
  query: string, 
  context: string, 
  previousResponse: string,
  feedback: string
): Promise<string> {
  const prompt = `你之前的回答需要改进。请根据反馈重新生成更好的回答。

参考信息:
${context}

用户问题: ${query}

之前的回答: ${previousResponse}

改进反馈: ${feedback}

请生成改进后的回答:`;

  return await callLLM(prompt, 0.5);
}

// 主要的 Self-RAG 处理函数
async function processSelfRAG(query: string, options: {
  topK?: number;
  similarityThreshold?: number;
  maxIterations?: number;
  supportThreshold?: number;
  usefulnessThreshold?: number;
} = {}): Promise<{
  success: boolean;
  query: string;
  finalResponse: string;
  steps: SelfRAGStep[];
  reflectionTokens: ReflectionToken[];
  documents: DocumentWithScore[];
  supportAnalysis: {
    segments: GenerationSegment[];
    overallSupport: number;
  };
  iterations: number;
  totalTime: number;
  metrics: {
    retrieveDecision: ReflectionToken;
    relevanceScores: number[];
    supportScore: number;
    usefulnessScore: number;
  };
}> {
  const {
    topK = 5,
    similarityThreshold = 0.3,
    maxIterations = 2,
    supportThreshold = 0.6,
    usefulnessThreshold = 0.6
  } = options;

  const startTime = Date.now();
  const steps: SelfRAGStep[] = [];
  const reflectionTokens: ReflectionToken[] = [];
  let iteration = 0;
  let finalResponse = '';
  let documents: DocumentWithScore[] = [];
  let supportAnalysis = { segments: [] as GenerationSegment[], overallSupport: 0 };

  try {
    // Step 1: Retrieve 决策
    const step1Start = Date.now();
    steps.push({
      stepId: 1,
      stepName: 'Retrieve Decision',
      input: { query },
      output: null,
      reflection: null,
      duration: 0,
      status: 'running'
    });

    const retrieveToken = await evaluateRetrieveNeed(query);
    reflectionTokens.push(retrieveToken);
    
    steps[0].output = { needRetrieval: retrieveToken.value === 'YES' };
    steps[0].reflection = retrieveToken;
    steps[0].duration = Date.now() - step1Start;
    steps[0].status = 'completed';

    // Step 2: 检索文档（如果需要）
    if (retrieveToken.value === 'YES') {
      const step2Start = Date.now();
      steps.push({
        stepId: 2,
        stepName: 'Document Retrieval',
        input: { query, topK, threshold: similarityThreshold },
        output: null,
        reflection: null,
        duration: 0,
        status: 'running'
      });

      const ragSystem = await getRagSystem();
      
      // 直接调用底层方法获取检索结果
      // @ts-ignore - 方法存在但 TypeScript 可能未识别
      let searchResults: any[] = [];
      
      if (typeof ragSystem.similaritySearch === 'function') {
        const retrievalDetails = await ragSystem.similaritySearch(query, topK, similarityThreshold);
        searchResults = retrievalDetails.searchResults;
      } else {
        // 回退方案：使用 askWithDetails 并忽略生成的回答
        console.log('[Self-RAG] Using fallback method for retrieval');
        const askResult = await ragSystem.askWithDetails(query, {
          topK,
          similarityThreshold
        });
        searchResults = askResult.retrievalDetails.searchResults;
      }
      
      // Step 3: IsRel 评估 - 评估每个文档的相关性
      const relevanceResults: DocumentWithScore[] = [];
      
      for (const result of searchResults) {
        const relevance = await evaluateRelevance(
          query, 
          result.document.pageContent,
          result.document.metadata?.source || 'unknown'
        );
        
        relevanceResults.push({
          content: result.document.pageContent,
          source: result.document.metadata?.source || 'unknown',
          similarity: result.similarity,
          isRelevant: relevance.isRelevant,
          relevanceScore: relevance.score,
          relevanceReasoning: relevance.reasoning
        });

        reflectionTokens.push({
          type: 'isrel',
          value: relevance.isRelevant ? 'RELEVANT' : 'NOT_RELEVANT',
          score: relevance.score,
          reasoning: relevance.reasoning,
          timestamp: Date.now() - step2Start
        });
      }

      documents = relevanceResults;
      const relevantDocs = relevanceResults.filter(d => d.isRelevant);
      
      steps[1].output = {
        totalRetrieved: searchResults.length,
        relevantCount: relevantDocs.length,
        documents: relevanceResults.map(d => ({
          source: d.source,
          similarity: d.similarity,
          isRelevant: d.isRelevant,
          relevanceScore: d.relevanceScore
        }))
      };
      steps[1].duration = Date.now() - step2Start;
      steps[1].status = 'completed';

      // Step 4: 生成回答
      const step3Start = Date.now();
      steps.push({
        stepId: 3,
        stepName: 'Response Generation',
        input: { relevantDocuments: relevantDocs.length },
        output: null,
        reflection: null,
        duration: 0,
        status: 'running'
      });

      const context = relevantDocs.map(d => d.content).join('\n\n---\n\n');
      let response = await generateResponse(query, context || '没有找到相关信息');
      
      steps[2].output = { response: response.substring(0, 200) + '...' };
      steps[2].duration = Date.now() - step3Start;
      steps[2].status = 'completed';

      // Step 5: IsSup 评估 - 支持度评估
      const step4Start = Date.now();
      steps.push({
        stepId: 4,
        stepName: 'Support Evaluation (IsSup)',
        input: { response: response.substring(0, 100) + '...' },
        output: null,
        reflection: null,
        duration: 0,
        status: 'running'
      });

      supportAnalysis = await evaluateSupport(response, relevantDocs.map(d => d.content));
      
      reflectionTokens.push({
        type: 'issup',
        value: supportAnalysis.overallSupport >= supportThreshold ? 'SUPPORTED' : 'NOT_SUPPORTED',
        score: supportAnalysis.overallSupport,
        reasoning: `${supportAnalysis.segments.filter(s => s.isSupported).length}/${supportAnalysis.segments.length} 陈述被支持`,
        timestamp: Date.now() - step4Start
      });

      steps[3].output = {
        overallSupport: supportAnalysis.overallSupport,
        supportedSegments: supportAnalysis.segments.filter(s => s.isSupported).length,
        totalSegments: supportAnalysis.segments.length
      };
      steps[3].reflection = reflectionTokens[reflectionTokens.length - 1];
      steps[3].duration = Date.now() - step4Start;
      steps[3].status = 'completed';

      // Step 6: IsUse 评估 - 有用性评估
      const step5Start = Date.now();
      steps.push({
        stepId: 5,
        stepName: 'Usefulness Evaluation (IsUse)',
        input: { response: response.substring(0, 100) + '...' },
        output: null,
        reflection: null,
        duration: 0,
        status: 'running'
      });

      const usefulnessToken = await evaluateUsefulness(query, response);
      reflectionTokens.push(usefulnessToken);

      steps[4].output = {
        isUseful: usefulnessToken.value === 'USEFUL',
        usefulnessScore: usefulnessToken.score
      };
      steps[4].reflection = usefulnessToken;
      steps[4].duration = Date.now() - step5Start;
      steps[4].status = 'completed';

      // 迭代优化（如果需要）
      while (
        iteration < maxIterations &&
        (supportAnalysis.overallSupport < supportThreshold || usefulnessToken.score < usefulnessThreshold)
      ) {
        iteration++;
        
        const iterStart = Date.now();
        steps.push({
          stepId: steps.length + 1,
          stepName: `Regeneration Iteration ${iteration}`,
          input: {
            previousSupport: supportAnalysis.overallSupport,
            previousUsefulness: usefulnessToken.score
          },
          output: null,
          reflection: null,
          duration: 0,
          status: 'running'
        });

        const feedback = `支持度: ${(supportAnalysis.overallSupport * 100).toFixed(1)}%, 有用性: ${(usefulnessToken.score * 100).toFixed(1)}%。请提供更准确、更有帮助的回答。`;
        response = await regenerateResponse(query, context, response, feedback);
        
        // 重新评估
        supportAnalysis = await evaluateSupport(response, relevantDocs.map(d => d.content));
        const newUsefulnessToken = await evaluateUsefulness(query, response);
        
        steps[steps.length - 1].output = {
          newResponse: response.substring(0, 100) + '...',
          newSupport: supportAnalysis.overallSupport,
          newUsefulness: newUsefulnessToken.score
        };
        steps[steps.length - 1].duration = Date.now() - iterStart;
        steps[steps.length - 1].status = 'completed';

        reflectionTokens.push({
          type: 'issup',
          value: supportAnalysis.overallSupport >= supportThreshold ? 'SUPPORTED' : 'NOT_SUPPORTED',
          score: supportAnalysis.overallSupport,
          reasoning: `迭代 ${iteration}: 重新评估支持度`,
          timestamp: Date.now() - iterStart
        });

        reflectionTokens.push(newUsefulnessToken);
      }

      finalResponse = response;
    } else {
      // 不需要检索，直接生成回答
      const directStart = Date.now();
      steps.push({
        stepId: 2,
        stepName: 'Direct Response Generation',
        input: { query },
        output: null,
        reflection: null,
        duration: 0,
        status: 'running'
      });

      finalResponse = await callLLM(`请回答以下问题: ${query}`, 0.5);
      
      steps[1].output = { response: finalResponse.substring(0, 200) + '...' };
      steps[1].duration = Date.now() - directStart;
      steps[1].status = 'completed';

      // 评估有用性
      const usefulnessToken = await evaluateUsefulness(query, finalResponse);
      reflectionTokens.push(usefulnessToken);
    }

    const totalTime = Date.now() - startTime;

    return {
      success: true,
      query,
      finalResponse,
      steps,
      reflectionTokens,
      documents,
      supportAnalysis,
      iterations: iteration,
      totalTime,
      metrics: {
        retrieveDecision: reflectionTokens.find(t => t.type === 'retrieve')!,
        relevanceScores: documents.map(d => d.relevanceScore),
        supportScore: supportAnalysis.overallSupport,
        usefulnessScore: reflectionTokens.filter(t => t.type === 'isuse').pop()?.score || 0
      }
    };
  } catch (error) {
    console.error('Self-RAG error:', error);
    return {
      success: false,
      query,
      finalResponse: `处理过程中发生错误: ${error instanceof Error ? error.message : 'Unknown error'}`,
      steps: steps.map(s => ({ ...s, status: s.status === 'running' ? 'failed' : s.status } as SelfRAGStep)),
      reflectionTokens,
      documents,
      supportAnalysis,
      iterations: iteration,
      totalTime: Date.now() - startTime,
      metrics: {
        retrieveDecision: reflectionTokens.find(t => t.type === 'retrieve') || {
          type: 'retrieve',
          value: 'ERROR',
          score: 0,
          reasoning: '处理失败',
          timestamp: 0
        },
        relevanceScores: [],
        supportScore: 0,
        usefulnessScore: 0
      }
    };
  }
}

// POST: 执行 Self-RAG
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query, options = {} } = body;

    if (!query || typeof query !== 'string') {
      return NextResponse.json({
        success: false,
        error: '请提供有效的查询'
      }, { status: 400 });
    }

    console.log('[Self-RAG] Processing query:', query);
    
    const result = await processSelfRAG(query, options);
    
    console.log('[Self-RAG] Complete:', {
      success: result.success,
      steps: result.steps.length,
      iterations: result.iterations,
      totalTime: result.totalTime
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Self-RAG API error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

// GET: 获取 Self-RAG 系统信息
export async function GET() {
  try {
    const ragSystem = await getRagSystem();
    const stats = ragSystem.getStats();

    return NextResponse.json({
      success: true,
      systemInfo: {
        name: 'Self-RAG System',
        version: '1.0.0',
        description: 'Self-Reflective RAG with Retrieve, IsRel, IsSup, IsUse tokens',
        llmModel: LLM_MODEL,
        embeddingModel: EMBEDDING_MODEL,
        documentCount: stats.documentCount,
        embeddingDimension: stats.embeddingDimension
      },
      reflectionTokens: [
        { name: 'Retrieve', description: '判断是否需要检索' },
        { name: 'IsRel', description: '评估文档相关性' },
        { name: 'IsSup', description: '评估回答支持度' },
        { name: 'IsUse', description: '评估回答有用性' }
      ],
      defaultOptions: {
        topK: 5,
        similarityThreshold: 0.3,
        maxIterations: 2,
        supportThreshold: 0.6,
        usefulnessThreshold: 0.6
      }
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
