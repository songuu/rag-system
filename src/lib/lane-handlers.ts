/**
 * 车道处理器 (Lane Handlers)
 * 
 * 实现三条车道的具体处理逻辑
 * 
 * 重要：所有车道都使用用户配置的推理模型，只是处理复杂度不同
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Embeddings } from '@langchain/core/embeddings';
import { getMilvusInstance } from './milvus-client';
import { IntentClassification } from './intent-router';
import { createLLM, createEmbedding, createReasoningModel, selectModelByDimension, getModelFactory } from './model-config';

// 帮助函数：从 LLM 响应中提取内容
function extractContent(response: any): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'content' in response) {
    return typeof response.content === 'string' ? response.content : '';
  }
  return '';
}

// ==================== 流式事件类型 ====================

export interface StreamEvent {
  type: 'routing' | 'thinking' | 'retrieval' | 'generation' | 'complete' | 'error' | 'lane_start';
  data: any;
  timestamp: number;
}

// ==================== 公共配置接口 ====================

export interface LaneConfig {
  // 模型配置
  fastModel: string;       // Lane 1 & 2 使用的快速模型
  reasoningModel: string;  // Lane 3 使用的推理模型
  embeddingModel: string;
  
  // RAG 配置
  topK?: number;
  rerankTopK?: number;
  similarityThreshold?: number;
  enableBM25?: boolean;
  enableRerank?: boolean;
  
  // 生成配置
  temperature?: number;
  thinkingTimeout?: number;
  
  // 集合配置
  collectionName?: string;
}

// ==================== Lane 1: 极速车道 (Fast Track) ====================

/**
 * Lane 1: 极速车道
 * 场景：闲聊、通用问题
 * 特点：0 IO 操作（不检索），直接使用推理模型回答
 * 延迟：< 5秒（取决于模型速度）
 */
export async function* executeLane1(
  query: string,
  config: LaneConfig
): AsyncGenerator<StreamEvent> {
  const startTime = Date.now();
  // Lane 1 使用快速模型，而不是推理模型
  const model = config.fastModel || 'qwen2.5:0.5b';

  console.log(`\n[Lane 1] 极速车道启动`);
  console.log(`[Lane 1] 使用快速模型: ${model}`);
  console.log(`[Lane 1] 查询: ${query}`);

  yield {
    type: 'lane_start',
    data: {
      lane: 1,
      laneName: '极速车道 (Fast Track)',
      description: '闲聊/通用问题，直接对话',
      estimatedTime: '< 5秒',
      model
    },
    timestamp: Date.now()
  };

  yield {
    type: 'thinking',
    data: {
      id: `think_lane1_${Date.now()}`,
      step: 1,
      type: 'decision',
      content: `识别为闲聊/通用问题，使用快速模型 ${model} 直接回答`,
      confidence: 0.95,
      status: 'completed'
    },
    timestamp: Date.now()
  };

  try {
    // 使用统一配置系统创建 LLM
    const llm = createLLM(model, { temperature: config.temperature ?? 0.7 });

    // 使用快速模型的简洁闲聊提示词
    const prompt = `你是一个友好的AI助手。简洁自然地回答：

${query}`;

    yield {
      type: 'generation',
      data: { status: 'start', content: '' },
      timestamp: Date.now()
    };

    let answer = '';
    const stream = await llm.stream(prompt);

    for await (const chunk of stream) {
      const chunkContent = extractContent(chunk);
      answer += chunkContent;
      yield {
        type: 'generation',
        data: { status: 'streaming', content: chunkContent, fullContent: answer },
        timestamp: Date.now()
      };
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[Lane 1] 完成，耗时: ${totalDuration}ms`);

    yield {
      type: 'complete',
      data: {
        lane: 1,
        laneName: '极速车道',
        answer,
        thinkingProcess: [{
          id: `think_lane1_${startTime}`,
          type: 'decision',
          content: '直接对话回答',
          confidence: 0.95,
          timestamp: startTime
        }],
        workflow: {
          totalDuration,
          iterations: 1,
          nodeExecutions: [
            { node: 'direct_generation', status: 'completed', duration: totalDuration }
          ]
        }
      },
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('[Lane 1] 错误:', error);
    yield {
      type: 'error',
      data: { message: error instanceof Error ? error.message : '生成失败' },
      timestamp: Date.now()
    };
  }
}

// ==================== Lane 2: 标准车道 (Standard RAG) ====================

/**
 * Lane 2: 标准车道
 * 场景：知识库问答
 * 特点：检索 → 生成，使用推理模型基于检索结果回答
 * 延迟：5-15秒
 */
export async function* executeLane2(
  query: string,
  config: LaneConfig
): AsyncGenerator<StreamEvent> {
  const startTime = Date.now();
  // Lane 2 使用快速模型进行 RAG，而不是推理模型
  const model = config.fastModel || 'llama3.2';
  const topK = config.topK || 10;
  const threshold = config.similarityThreshold || 0.3;
  const collectionName = config.collectionName || 'reasoning_rag_documents';

  console.log(`\n[Lane 2] 标准车道启动`);
  console.log(`[Lane 2] 使用快速模型: ${model}`);
  console.log(`[Lane 2] 查询: ${query}`);
  console.log(`[Lane 2] 集合: ${collectionName}, TopK: ${topK}`);

  yield {
    type: 'lane_start',
    data: {
      lane: 2,
      laneName: '标准车道 (Standard RAG)',
      description: '知识库问答，检索后生成',
      estimatedTime: '5-15秒',
      model
    },
    timestamp: Date.now()
  };

  const thinkingSteps: any[] = [];

  try {
    // Step 1: 检索
    yield {
      type: 'thinking',
      data: {
        id: `think_lane2_1_${Date.now()}`,
        step: 1,
        type: 'planning',
        content: `正在从知识库检索相关信息 (Top-${topK})...`,
        confidence: 0.7,
        status: 'in_progress'
      },
      timestamp: Date.now()
    };

    const retrievalStartTime = Date.now();
    
    const milvus = getMilvusInstance({ collectionName });
    await milvus.connect();

    // 获取集合统计信息
    const stats = await milvus.getCollectionStats();
    const dimension = (stats as any)?.embeddingDimension || 768;
    const embeddingModelName = selectModelByDimension(dimension) || config.embeddingModel || 'nomic-embed-text';

    console.log(`[Lane 2] 向量维度: ${dimension}, 嵌入模型: ${embeddingModelName}`);

    // 使用统一配置系统创建 Embedding 模型
    const embeddings = createEmbedding(embeddingModelName);

    const queryVector = await embeddings.embedQuery(query);
    const searchResults = await milvus.search(queryVector, topK, threshold);
    const retrievedDocs = searchResults || [];

    const retrievalTime = Date.now() - retrievalStartTime;
    console.log(`[Lane 2] 检索完成，找到 ${retrievedDocs.length} 条文档，耗时: ${retrievalTime}ms`);

    thinkingSteps.push({
      id: `think_lane2_1_${startTime}`,
      type: 'planning',
      content: `检索完成: 找到 ${retrievedDocs.length} 条相关文档`,
      confidence: 0.85,
      timestamp: Date.now()
    });

    yield {
      type: 'thinking',
      data: {
        id: `think_lane2_1_${Date.now()}`,
        step: 1,
        type: 'planning',
        content: `检索完成: 找到 ${retrievedDocs.length} 条相关文档`,
        confidence: 0.85,
        status: 'completed'
      },
      timestamp: Date.now()
    };

    yield {
      type: 'retrieval',
      data: {
        documents: retrievedDocs.slice(0, 5).map((doc: any, i: number) => ({
          id: i,
          content: doc.content?.substring(0, 200) + (doc.content?.length > 200 ? '...' : ''),
          score: doc.score,
          source: doc.metadata?.source
        })),
        stats: {
          totalCount: retrievedDocs.length,
          retrievalTime
        }
      },
      timestamp: Date.now()
    };

    // Step 2: 使用快速模型生成回答
    yield {
      type: 'thinking',
      data: {
        id: `think_lane2_2_${Date.now()}`,
        step: 2,
        type: 'decision',
        content: `使用快速模型 ${model} 基于检索结果生成回答...`,
        confidence: 0.8,
        status: 'in_progress'
      },
      timestamp: Date.now()
    };

    // 使用统一配置系统创建 LLM
    const llm = createLLM(model, {
      temperature: config.temperature ?? 0.3,
    });

    // 构建上下文
    const context = retrievedDocs.length > 0
      ? retrievedDocs.slice(0, 5).map((doc: any, i: number) => 
          `[文档 ${i + 1}] (相关度: ${((doc.score || 0) * 100).toFixed(1)}%)\n${doc.content || ''}`
        ).join('\n\n---\n\n')
      : '';

    let prompt: string;
    if (context) {
      prompt = `你是一个专业的知识库问答助手。请根据以下参考资料准确回答用户的问题。

## 参考资料
${context}

## 用户问题
${query}

## 回答要求
1. 基于参考资料中的信息回答
2. 如果资料中没有相关信息，请明确说明"根据现有资料无法回答"
3. 不要编造资料中没有的信息
4. 回答要准确、简洁、有条理

请回答:`;
    } else {
      prompt = `用户问题: ${query}

注意：知识库中未找到相关资料。请基于通用知识回答，并在开头说明"知识库中未找到相关信息，以下是基于通用知识的回答"。`;
    }

    yield {
      type: 'generation',
      data: { status: 'start', content: '' },
      timestamp: Date.now()
    };

    let answer = '';
    const stream = await llm.stream(prompt);

    for await (const chunk of stream) {
      const chunkContent = extractContent(chunk);
      answer += chunkContent;
      yield {
        type: 'generation',
        data: { status: 'streaming', content: chunkContent, fullContent: answer },
        timestamp: Date.now()
      };
    }

    thinkingSteps.push({
      id: `think_lane2_2_${Date.now()}`,
      type: 'decision',
      content: '回答生成完成',
      confidence: 0.9,
      timestamp: Date.now()
    });

    yield {
      type: 'thinking',
      data: {
        id: `think_lane2_2_${Date.now()}`,
        step: 2,
        type: 'decision',
        content: '回答生成完成',
        confidence: 0.9,
        status: 'completed'
      },
      timestamp: Date.now()
    };

    const totalDuration = Date.now() - startTime;
    console.log(`[Lane 2] 完成，总耗时: ${totalDuration}ms`);

    yield {
      type: 'complete',
      data: {
        lane: 2,
        laneName: '标准车道',
        answer,
        thinkingProcess: thinkingSteps,
        retrieval: {
          documents: retrievedDocs.slice(0, 5),
          stats: { totalCount: retrievedDocs.length, retrievalTime }
        },
        workflow: {
          totalDuration,
          iterations: 1,
          nodeExecutions: [
            { node: 'retrieval', status: 'completed', duration: retrievalTime },
            { node: 'generation', status: 'completed', duration: totalDuration - retrievalTime }
          ]
        }
      },
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('[Lane 2] 错误:', error);
    yield {
      type: 'error',
      data: { message: error instanceof Error ? error.message : '处理失败' },
      timestamp: Date.now()
    };
  }
}

// ==================== Lane 3: 推理车道 (Reasoning Agent) ====================

/**
 * Lane 3: 推理车道
 * 场景：复杂推理、多步骤分析
 * 特点：规划 → 多路检索 → 深度推理 → 自省
 * 延迟：15-60秒
 */
export async function* executeLane3(
  query: string,
  config: LaneConfig
): AsyncGenerator<StreamEvent> {
  const startTime = Date.now();
  const reasoningModel = config.reasoningModel || 'deepseek-r1:7b';
  const topK = config.topK || 50;
  const rerankTopK = config.rerankTopK || 5;
  const threshold = config.similarityThreshold || 0.3;
  const collectionName = config.collectionName || 'reasoning_rag_documents';

  console.log(`\n[Lane 3] 推理车道启动`);
  console.log(`[Lane 3] 使用模型: ${reasoningModel}`);
  console.log(`[Lane 3] 查询: ${query}`);
  console.log(`[Lane 3] 集合: ${collectionName}, TopK: ${topK}, RerankTopK: ${rerankTopK}`);

  yield {
    type: 'lane_start',
    data: {
      lane: 3,
      laneName: '推理车道 (Reasoning Agent)',
      description: '复杂推理，深度分析',
      estimatedTime: '15-60秒',
      model: reasoningModel
    },
    timestamp: Date.now()
  };

  const thinkingSteps: any[] = [];

  try {
    // Phase 1: 查询分解 (Planner)
    yield {
      type: 'thinking',
      data: {
        id: `think_lane3_1_${Date.now()}`,
        step: 1,
        type: 'planning',
        content: '分析复杂查询，制定检索策略...',
        confidence: 0.6,
        status: 'in_progress'
      },
      timestamp: Date.now()
    };

    // 使用统一配置系统创建推理模型（使用独立的 REASONING_PROVIDER）
    const plannerLLM = createReasoningModel(reasoningModel, {
      temperature: 0.3,
    });

    const planPrompt = `分析以下复杂查询，提取关键信息点用于知识库检索：

查询: "${query}"

请列出 2-4 个需要检索的关键问题（每行一个）:`;

    const planResponse = await plannerLLM.invoke(planPrompt);
    // 提取字符串内容（plannerLLM.invoke 返回 AIMessage 对象）
    const planResult = extractContent(planResponse);
    
    thinkingSteps.push({
      id: `think_lane3_1_${startTime}`,
      type: 'planning',
      content: `查询分解完成`,
      confidence: 0.75,
      timestamp: Date.now()
    });

    yield {
      type: 'thinking',
      data: {
        id: `think_lane3_1_${Date.now()}`,
        step: 1,
        type: 'planning',
        content: `查询分解完成`,
        confidence: 0.75,
        status: 'completed',
        metadata: { plan: planResult.substring(0, 500) }
      },
      timestamp: Date.now()
    };

    // Phase 2: 多路检索 (Executor)
    yield {
      type: 'thinking',
      data: {
        id: `think_lane3_2_${Date.now()}`,
        step: 2,
        type: 'reasoning',
        content: `执行多路检索 (Top-${topK})，收集相关信息...`,
        confidence: 0.7,
        status: 'in_progress'
      },
      timestamp: Date.now()
    };

    const retrievalStartTime = Date.now();
    
    const milvus = getMilvusInstance({ collectionName });
    await milvus.connect();

    const stats = await milvus.getCollectionStats();
    const dimension = (stats as any)?.embeddingDimension || 768;
    const embeddingModelName = selectModelByDimension(dimension) || config.embeddingModel || 'nomic-embed-text';

    console.log(`[Lane 3] 向量维度: ${dimension}, 嵌入模型: ${embeddingModelName}`);

    // 使用统一配置系统创建 Embedding 模型
    const embeddings = createEmbedding(embeddingModelName);

    // 多查询检索：原始查询 + 从分析结果提取的子查询
    const queries = [query];
    
    // 尝试从 planResult 提取子查询
    const subQueries = planResult.split('\n')
      .filter(line => line.trim() && line.trim().length > 5)
      .slice(0, 3)
      .map(line => line.replace(/^[\d\.\-\*]+\s*/, '').trim());
    
    if (subQueries.length > 0) {
      queries.push(...subQueries);
    }

    console.log(`[Lane 3] 检索查询数: ${queries.length}`);

    const allResults: any[] = [];
    for (const q of queries) {
      const queryVector = await embeddings.embedQuery(q);
      const results = await milvus.search(queryVector, Math.ceil(topK / queries.length), threshold);
      if (results) {
        allResults.push(...results);
      }
    }

    // 去重和排序
    const uniqueResults = Array.from(
      new Map(allResults.map(r => [r.content, r])).values()
    ).sort((a: any, b: any) => (b.score || 0) - (a.score || 0));

    const topResults = uniqueResults.slice(0, rerankTopK);
    const retrievalTime = Date.now() - retrievalStartTime;

    console.log(`[Lane 3] 检索完成，共 ${uniqueResults.length} 条，精选 ${topResults.length} 条，耗时: ${retrievalTime}ms`);

    thinkingSteps.push({
      id: `think_lane3_2_${Date.now()}`,
      type: 'reasoning',
      content: `检索完成: 收集到 ${uniqueResults.length} 条，精选 ${topResults.length} 条`,
      confidence: 0.8,
      timestamp: Date.now()
    });

    yield {
      type: 'thinking',
      data: {
        id: `think_lane3_2_${Date.now()}`,
        step: 2,
        type: 'reasoning',
        content: `检索完成: 精选 ${topResults.length} 条高相关文档`,
        confidence: 0.8,
        status: 'completed'
      },
      timestamp: Date.now()
    };

    yield {
      type: 'retrieval',
      data: {
        documents: topResults.map((doc: any, i: number) => ({
          id: i,
          content: doc.content?.substring(0, 200) + (doc.content?.length > 200 ? '...' : ''),
          score: doc.score,
          source: doc.metadata?.source
        })),
        stats: {
          totalCount: uniqueResults.length,
          finalCount: topResults.length,
          retrievalTime,
          queriesUsed: queries.length
        }
      },
      timestamp: Date.now()
    };

    // Phase 3: 深度推理 (Reasoner)
    yield {
      type: 'thinking',
      data: {
        id: `think_lane3_3_${Date.now()}`,
        step: 3,
        type: 'reflection',
        content: '启动深度推理，综合分析信息...',
        confidence: 0.7,
        status: 'in_progress'
      },
      timestamp: Date.now()
    };

    // 使用统一配置系统创建推理模型（使用独立的 REASONING_PROVIDER）
    const reasonerLLM = createReasoningModel(reasoningModel, {
      temperature: config.temperature ?? 0.5,
    });

    // 构建详细上下文
    const context = topResults.map((doc: any, i: number) => 
      `[来源 ${i + 1}] (相关度: ${((doc.score || 0) * 100).toFixed(1)}%)\n${doc.content || ''}`
    ).join('\n\n---\n\n');

    let reasoningPrompt: string;
    if (context) {
      reasoningPrompt = `你是一个专业的分析师，擅长深度分析和逻辑推理。

## 参考信息
${context}

## 用户问题
${query}

## 分析要求
1. 仔细阅读并理解所有参考信息
2. 进行逻辑推理和综合分析
3. 如果涉及对比，列出异同点
4. 如果涉及因果，说明推理过程
5. 给出有理有据的结论
6. 如果信息不足，明确指出哪些信息缺失

## 请提供详细的分析和回答:`;
    } else {
      reasoningPrompt = `用户问题: ${query}

注意：知识库中未找到相关资料。请基于你的知识进行分析，并在开头说明"知识库中未找到相关信息"。`;
    }

    yield {
      type: 'generation',
      data: { status: 'start', content: '' },
      timestamp: Date.now()
    };

    let answer = '';
    const stream = await reasonerLLM.stream(reasoningPrompt);

    for await (const chunk of stream) {
      const chunkContent = extractContent(chunk);
      answer += chunkContent;
      yield {
        type: 'generation',
        data: { status: 'streaming', content: chunkContent, fullContent: answer },
        timestamp: Date.now()
      };
    }

    thinkingSteps.push({
      id: `think_lane3_3_${Date.now()}`,
      type: 'reflection',
      content: '深度推理完成',
      confidence: 0.85,
      timestamp: Date.now()
    });

    yield {
      type: 'thinking',
      data: {
        id: `think_lane3_3_${Date.now()}`,
        step: 3,
        type: 'reflection',
        content: '深度推理完成',
        confidence: 0.85,
        status: 'completed'
      },
      timestamp: Date.now()
    };

    // Phase 4: 质量检查
    yield {
      type: 'thinking',
      data: {
        id: `think_lane3_4_${Date.now()}`,
        step: 4,
        type: 'decision',
        content: '验证回答质量...',
        confidence: 0.8,
        status: 'in_progress'
      },
      timestamp: Date.now()
    };

    const hasAnswer = answer.length > 50;
    const hasStructure = answer.includes('\n');
    const quality = hasAnswer && hasStructure ? 'high' : hasAnswer ? 'medium' : 'low';

    thinkingSteps.push({
      id: `think_lane3_4_${Date.now()}`,
      type: 'decision',
      content: `质量检查: ${quality}`,
      confidence: 0.9,
      timestamp: Date.now()
    });

    yield {
      type: 'thinking',
      data: {
        id: `think_lane3_4_${Date.now()}`,
        step: 4,
        type: 'decision',
        content: `质量检查完成: ${quality}`,
        confidence: 0.9,
        status: 'completed'
      },
      timestamp: Date.now()
    };

    const totalDuration = Date.now() - startTime;
    console.log(`[Lane 3] 完成，总耗时: ${totalDuration}ms`);

    yield {
      type: 'complete',
      data: {
        lane: 3,
        laneName: '推理车道',
        answer,
        thinkingProcess: thinkingSteps,
        retrieval: {
          documents: topResults,
          stats: { 
            totalCount: uniqueResults.length, 
            finalCount: topResults.length,
            retrievalTime,
            queriesUsed: queries.length
          }
        },
        workflow: {
          totalDuration,
          iterations: 1,
          phases: ['planner', 'executor', 'reasoner', 'reflector'],
          nodeExecutions: [
            { node: 'planner', status: 'completed', duration: 0 },
            { node: 'retrieval', status: 'completed', duration: retrievalTime },
            { node: 'reasoning', status: 'completed', duration: totalDuration - retrievalTime },
            { node: 'reflection', status: 'completed', duration: 0 }
          ]
        }
      },
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('[Lane 3] 错误:', error);
    yield {
      type: 'error',
      data: { message: error instanceof Error ? error.message : '推理失败' },
      timestamp: Date.now()
    };
  }
}

// ==================== 车道选择器 ====================

/**
 * 根据意图分类选择并执行对应车道
 * 
 * 重要：所有车道都使用相同的 reasoningModel
 */
export async function* executeLaneByIntent(
  query: string,
  classification: IntentClassification,
  config: LaneConfig
): AsyncGenerator<StreamEvent> {
  const lane = classification.suggestedLane;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[LANE SELECTOR] 选择车道: Lane ${lane}`);
  console.log(`[LANE SELECTOR] 快速模型 (L1/L2): ${config.fastModel}`);
  console.log(`[LANE SELECTOR] 推理模型 (L3): ${config.reasoningModel}`);
  console.log(`[LANE SELECTOR] 嵌入模型: ${config.embeddingModel}`);
  console.log(`${'='.repeat(60)}\n`);

  // 确保配置完整
  const laneConfig: LaneConfig = {
    fastModel: config.fastModel || 'llama3.2',
    reasoningModel: config.reasoningModel || 'deepseek-r1:7b',
    embeddingModel: config.embeddingModel || 'nomic-embed-text',
    topK: config.topK,
    rerankTopK: config.rerankTopK,
    similarityThreshold: config.similarityThreshold,
    enableBM25: config.enableBM25,
    enableRerank: config.enableRerank,
    temperature: config.temperature,
    thinkingTimeout: config.thinkingTimeout,
    collectionName: config.collectionName || 'reasoning_rag_documents'
  };

  switch (lane) {
    case 1:
      yield* executeLane1(query, laneConfig);
      break;

    case 2:
      yield* executeLane2(query, laneConfig);
      break;

    case 3:
      yield* executeLane3(query, laneConfig);
      break;

    default:
      // 默认使用 Lane 2
      yield* executeLane2(query, laneConfig);
  }
}
