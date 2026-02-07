/**
 * Reasoning RAG 流式 API - 带意图路由
 * 
 * 支持三条车道:
 * - Lane 1 (Fast Track): 闲聊/通用，< 1秒
 * - Lane 2 (Standard RAG): 知识库问答，3-5秒
 * - Lane 3 (Reasoning Agent): 复杂推理，15-60秒
 */

import { NextRequest } from 'next/server';
import { routeIntent, IntentClassification } from '@/lib/intent-router';
import { executeLaneByIntent, LaneConfig, StreamEvent } from '@/lib/lane-handlers';

// 发送 SSE 事件
function sendEvent(controller: ReadableStreamDefaultController, event: StreamEvent) {
  const data = JSON.stringify(event);
  controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query, config = {} } = body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: '查询不能为空' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 提取配置
    const {
      // 路由配置
      routerModel = 'llama3.2:1b',
      enableRouting = true,
      
      // 模型配置
      fastModel = 'qwen2.5:0.5b',        // Lane 1 & 2 使用快速模型
      reasoningModel = 'deepseek-r1:7b',  // Lane 3 使用推理模型
      embeddingModel = 'nomic-embed-text',
      
      // RAG 配置
      topK = 50,
      rerankTopK = 5,
      similarityThreshold = 0.3,
      enableBM25 = true,
      enableRerank = true,
      
      // 生成配置
      temperature = 0.7,
      thinkingTimeout = 120000,
      
      // 集合配置
      collectionName = 'reasoning_rag_documents',
      
      // 强制指定车道（可选）
      forceLane = null
    } = config;

    console.log(`[STREAM API] 接收到的配置:`, {
      fastModel,
      reasoningModel,
      embeddingModel,
      topK,
      rerankTopK,
      collectionName,
      enableRouting
    });

    const stream = new ReadableStream({
      async start(controller) {
        const startTime = Date.now();
        let timeoutId: NodeJS.Timeout | null = null;

        // 设置总超时
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`处理超时（${thinkingTimeout / 1000}秒）`));
          }, thinkingTimeout);
        });

        try {
          // ==================== Phase 1: 意图路由 ====================
          
          let classification: IntentClassification;

          if (forceLane) {
            // 强制指定车道
            classification = {
              intent: forceLane === 1 ? 'chat' : forceLane === 2 ? 'fast_rag' : 'reasoning',
              confidence: 1.0,
              reasoning: '用户强制指定车道',
              keywords: [],
              complexity: forceLane === 1 ? 'low' : forceLane === 2 ? 'medium' : 'high',
              requiresRetrieval: forceLane !== 1,
              requiresReasoning: forceLane === 3,
              suggestedLane: forceLane as 1 | 2 | 3,
              estimatedTime: forceLane === 1 ? '< 1秒' : forceLane === 2 ? '3-5秒' : '15-60秒'
            };
          } else if (enableRouting) {
            // 执行意图路由
            sendEvent(controller, {
              type: 'routing',
              data: {
                status: 'analyzing',
                message: '正在分析查询意图...'
              },
              timestamp: Date.now()
            });

            classification = await routeIntent(query, { routerModel });

            sendEvent(controller, {
              type: 'routing',
              data: {
                status: 'complete',
                classification,
                message: `路由到 Lane ${classification.suggestedLane}: ${
                  classification.suggestedLane === 1 ? '极速车道' :
                  classification.suggestedLane === 2 ? '标准车道' : '推理车道'
                }`
              },
              timestamp: Date.now()
            });
          } else {
            // 默认使用 Lane 2
            classification = {
              intent: 'fast_rag',
              confidence: 0.7,
              reasoning: '路由禁用，使用默认车道',
              keywords: [],
              complexity: 'medium',
              requiresRetrieval: true,
              requiresReasoning: false,
              suggestedLane: 2,
              estimatedTime: '3-5秒'
            };
          }

          console.log(`\n${'='.repeat(60)}`);
          console.log(`[STREAM API] 查询: "${query}"`);
          console.log(`[STREAM API] 路由结果: Lane ${classification.suggestedLane}`);
          console.log(`[STREAM API] 意图: ${classification.intent}`);
          console.log(`[STREAM API] 置信度: ${(classification.confidence * 100).toFixed(0)}%`);
          console.log(`${'='.repeat(60)}\n`);

          // ==================== Phase 2: 执行车道 ====================

          // 构建车道配置
          // Lane 1 & 2 使用 fastModel (快速响应)
          // Lane 3 使用 reasoningModel (深度推理)
          const laneConfig: LaneConfig = {
            // 模型配置
            fastModel,      // Lane 1 & 2
            reasoningModel, // Lane 3
            embeddingModel,
            
            // RAG 配置
            topK,
            rerankTopK,
            similarityThreshold,
            enableBM25,
            enableRerank,
            
            // 生成配置
            temperature,
            thinkingTimeout,
            
            // 集合配置
            collectionName
          };

          console.log(`[STREAM API] 车道配置:`, JSON.stringify(laneConfig, null, 2));

          // 执行对应车道
          for await (const event of executeLaneByIntent(query, classification, laneConfig)) {
            sendEvent(controller, event);

            // 如果是完成或错误事件，添加路由信息
            if (event.type === 'complete') {
              // 在完成数据中添加路由信息
              const completeData = {
                ...event.data,
                routing: {
                  classification,
                  routingTime: Date.now() - startTime - (event.data.workflow?.totalDuration || 0)
                }
              };
              
              sendEvent(controller, {
                type: 'complete',
                data: completeData,
                timestamp: Date.now()
              });
            }
          }

          const totalDuration = Date.now() - startTime;
          console.log(`[STREAM API] 总耗时: ${totalDuration}ms`);

        } catch (error) {
          console.error('[STREAM API] 处理错误:', error);
          sendEvent(controller, {
            type: 'error',
            data: {
              message: error instanceof Error ? error.message : '处理失败',
              stack: process.env.NODE_ENV === 'development' && error instanceof Error ? error.stack : undefined
            },
            timestamp: Date.now()
          });
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    console.error('[STREAM API] 初始化错误:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * GET: 获取路由器状态和车道信息
 */
export async function GET() {
  return new Response(
    JSON.stringify({
      success: true,
      router: {
        name: 'Semantic Intent Router',
        version: '1.0',
        description: '基于 LangGraph 的智能意图路由系统'
      },
      lanes: [
        {
          id: 1,
          name: '极速车道 (Fast Track)',
          description: '闲聊/通用问题，无需检索',
          estimatedTime: '< 1秒',
          triggers: ['你好', '你是谁', '帮我写...', '谢谢'],
          color: '#22c55e' // green
        },
        {
          id: 2,
          name: '标准车道 (Standard RAG)',
          description: '知识库问答，标准检索流程',
          estimatedTime: '3-5秒',
          triggers: ['...是什么', '总结...', '查找...'],
          color: '#3b82f6' // blue
        },
        {
          id: 3,
          name: '推理车道 (Reasoning Agent)',
          description: '复杂推理，深度分析',
          estimatedTime: '15-60秒',
          triggers: ['对比...', '分析...', '如果...'],
          color: '#a855f7' // purple
        }
      ]
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
