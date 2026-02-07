/**
 * Self-Corrective RAG - 自省式修正检索增强生成系统
 * 
 * 基于 LangGraph + Milvus 的 4 节点质量控制闭环架构
 * 
 * 核心节点：
 * 1. Retrieve (检索者) - 从 Milvus 检索 Top-K 文档
 * 2. Grader (质检员) - 轻量级 LLM 判断文档相关性
 * 3. Rewrite (修正者) - 当质检失败时重写查询
 * 4. Generate (生成者) - 基于高质量文档生成回答
 * 
 * 与 Agentic RAG 的区别：
 * - 更精简的节点设计，专注于检索质量控制
 * - Grader 是独立的 LLM 调用，而非规则评分
 * - 强调"修正循环"而非"自省评分"
 * - 更清晰的状态流转和决策逻辑
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { getMilvusInstance, MilvusConfig } from './milvus-client';
import { 
  createLLM, 
  createEmbedding, 
  selectModelByDimension,
  getModelFactory 
} from './model-config';

// ==================== 类型定义 ====================

/** 检索文档 */
export interface SCDocument {
  id: string;
  content: string;
  metadata: Record<string, any>;
  score: number;
  gradeResult?: DocumentGrade;
}

/** 单文档评分结果 */
export interface DocumentGrade {
  isRelevant: boolean;
  confidence: number;
  reasoning: string;
}

/** Grader 评估结果 */
export interface GraderResult {
  passCount: number;           // 通过的文档数
  totalCount: number;          // 总文档数
  passRate: number;            // 通过率
  shouldRewrite: boolean;      // 是否需要重写
  documentGrades: Array<{
    docId: string;
    isRelevant: boolean;
    confidence: number;
    reasoning: string;
  }>;
  overallReasoning: string;    // 整体评估理由
}

/** 查询重写结果 */
export interface RewriteResult {
  originalQuery: string;
  rewrittenQuery: string;
  rewriteReason: string;
  keywords: string[];
  rewriteCount: number;
}

/** 生成结果 */
export interface GenerationResult {
  answer: string;
  usedDocuments: number;
  confidence: number;
  sources: string[];
}

/** 工作流节点状态 */
export interface NodeExecution {
  node: 'retrieve' | 'grade' | 'rewrite' | 'generate';
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  startTime?: number;
  endTime?: number;
  duration?: number;
  input?: any;
  output?: any;
  error?: string;
}

/** Self-Corrective RAG 状态 */
export interface SCRAGState {
  // 查询相关
  originalQuery: string;           // 用户原始查询（永不修改）
  currentQuery: string;            // 当前使用的查询（可能被重写）
  
  // 检索配置
  topK: number;
  similarityThreshold: number;
  maxRewriteAttempts: number;
  gradePassThreshold: number;      // 质检通过阈值 (0-1)
  
  // 检索结果
  retrievedDocuments: SCDocument[];
  graderResult?: GraderResult;
  filteredDocuments: SCDocument[]; // 通过质检的文档
  
  // 重写相关
  rewriteHistory: RewriteResult[];
  currentRewriteCount: number;
  
  // 生成结果
  generationResult?: GenerationResult;
  finalAnswer: string;
  
  // 流程控制
  currentNode: string;
  shouldContinue: boolean;
  decisionPath: string[];          // 决策路径追踪
  
  // 执行追踪
  nodeExecutions: NodeExecution[];
  startTime: number;
  endTime?: number;
  totalDuration?: number;
  
  // 错误处理
  error?: string;
  
  // Milvus 配置
  milvusConfig?: MilvusConfig;
}

// ==================== 状态图定义 ====================

const SCRAGStateAnnotation = Annotation.Root({
  originalQuery: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  currentQuery: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  
  topK: Annotation<number>({ reducer: (_, b) => b, default: () => 5 }),
  similarityThreshold: Annotation<number>({ reducer: (_, b) => b, default: () => 0.3 }),
  maxRewriteAttempts: Annotation<number>({ reducer: (_, b) => b, default: () => 3 }),
  gradePassThreshold: Annotation<number>({ reducer: (_, b) => b, default: () => 0.6 }),
  
  retrievedDocuments: Annotation<SCDocument[]>({ reducer: (_, b) => b, default: () => [] }),
  graderResult: Annotation<GraderResult | undefined>({ reducer: (_, b) => b }),
  filteredDocuments: Annotation<SCDocument[]>({ reducer: (_, b) => b, default: () => [] }),
  
  rewriteHistory: Annotation<RewriteResult[]>({ reducer: (_, b) => b, default: () => [] }),
  currentRewriteCount: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  
  generationResult: Annotation<GenerationResult | undefined>({ reducer: (_, b) => b }),
  finalAnswer: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  
  currentNode: Annotation<string>({ reducer: (_, b) => b, default: () => 'start' }),
  shouldContinue: Annotation<boolean>({ reducer: (_, b) => b, default: () => true }),
  decisionPath: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  
  nodeExecutions: Annotation<NodeExecution[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  startTime: Annotation<number>({ reducer: (_, b) => b, default: () => Date.now() }),
  endTime: Annotation<number | undefined>({ reducer: (_, b) => b }),
  totalDuration: Annotation<number | undefined>({ reducer: (_, b) => b }),
  
  error: Annotation<string | undefined>({ reducer: (_, b) => b }),
  milvusConfig: Annotation<MilvusConfig | undefined>({ reducer: (_, b) => b }),
});

// ==================== 节点实现 ====================

/**
 * 节点 1: Retrieve (检索者)
 * 
 * 职责：从 Milvus 向量数据库检索 Top-K 相关文档
 * 输入：当前查询词 (原始或重写后的)
 * 输出：检索到的文档列表
 */
async function retrieveNode(state: typeof SCRAGStateAnnotation.State): Promise<Partial<typeof SCRAGStateAnnotation.State>> {
  const startTime = Date.now();
  const query = state.currentQuery || state.originalQuery;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[RETRIEVE] 🔍 开始检索`);
  console.log(`[RETRIEVE] 查询: "${query}"`);
  console.log(`[RETRIEVE] Top-K: ${state.topK}, 阈值: ${state.similarityThreshold}`);
  console.log(`${'='.repeat(60)}`);
  
  try {
    // 获取 Milvus 实例
    const milvus = await getMilvusInstance(state.milvusConfig);
    
    // 获取 collection 统计信息以确定维度
    const stats = await milvus.getCollectionStats();
    const dimension = stats.dimension || 768;
    const embeddingModel = selectModelByDimension(dimension);
    
    console.log(`[RETRIEVE] Embedding 模型: ${embeddingModel}, 维度: ${dimension}`);
    
    // 生成查询向量 (使用统一配置系统)
    const embeddings = createEmbedding(embeddingModel);
    
    const queryVector = await embeddings.embedQuery(query);
    
    // 执行向量搜索
    const searchResults = await milvus.search(queryVector, state.topK);
    
    // 转换结果
    const documents: SCDocument[] = searchResults
      .filter(r => r.score >= state.similarityThreshold)
      .map((r, idx) => ({
        id: `doc_${idx}_${Date.now()}`,
        content: r.content,
        metadata: r.metadata,
        score: r.score,
      }));
    
    const duration = Date.now() - startTime;
    
    console.log(`[RETRIEVE] ✅ 检索完成，找到 ${documents.length} 个文档`);
    documents.forEach((doc, i) => {
      console.log(`[RETRIEVE]   ${i + 1}. Score: ${doc.score.toFixed(4)} | ${doc.content.substring(0, 80)}...`);
    });
    
    const execution: NodeExecution = {
      node: 'retrieve',
      status: 'completed',
      startTime,
      endTime: Date.now(),
      duration,
      input: { query, topK: state.topK },
      output: { documentCount: documents.length, scores: documents.map(d => d.score) },
    };
    
    return {
      retrievedDocuments: documents,
      currentNode: 'retrieve',
      nodeExecutions: [execution],
      decisionPath: [`RETRIEVE: 检索 ${documents.length} 个文档`],
    };
    
  } catch (error: any) {
    console.error(`[RETRIEVE] ❌ 检索失败:`, error.message);
    
    const execution: NodeExecution = {
      node: 'retrieve',
      status: 'error',
      startTime,
      endTime: Date.now(),
      duration: Date.now() - startTime,
      error: error.message,
    };
    
    return {
      retrievedDocuments: [],
      currentNode: 'retrieve',
      nodeExecutions: [execution],
      error: `检索失败: ${error.message}`,
      decisionPath: [`RETRIEVE: 检索失败 - ${error.message}`],
    };
  }
}

/**
 * 节点 2: Grader (质检员) - 核心节点！
 * 
 * 职责：使用轻量级 LLM 判断每个文档是否包含回答问题的必要信息
 * 特点：不回答问题，只做二分类判断 (相关/不相关)
 * 价值：过滤 Milvus 返回的噪音，防止垃圾输入导致垃圾输出
 */
async function graderNode(state: typeof SCRAGStateAnnotation.State): Promise<Partial<typeof SCRAGStateAnnotation.State>> {
  const startTime = Date.now();
  const query = state.originalQuery;
  const documents = state.retrievedDocuments;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[GRADER] 🔬 开始质量检查`);
  console.log(`[GRADER] 待检查文档数: ${documents.length}`);
  console.log(`[GRADER] 通过阈值: ${state.gradePassThreshold}`);
  console.log(`${'='.repeat(60)}`);
  
  // 无文档可检查
  if (documents.length === 0) {
    console.log(`[GRADER] ⚠️ 无文档可检查，需要重写查询`);
    
    const graderResult: GraderResult = {
      passCount: 0,
      totalCount: 0,
      passRate: 0,
      shouldRewrite: true,
      documentGrades: [],
      overallReasoning: '检索未返回任何文档，需要重写查询以获得更好的结果',
    };
    
    const execution: NodeExecution = {
      node: 'grade',
      status: 'completed',
      startTime,
      endTime: Date.now(),
      duration: Date.now() - startTime,
      input: { documentCount: 0 },
      output: graderResult,
    };
    
    return {
      graderResult,
      filteredDocuments: [],
      currentNode: 'grade',
      nodeExecutions: [execution],
      decisionPath: [`GRADE: 无文档 → 需要重写`],
    };
  }
  
  try {
    // 初始化 Grader LLM (使用统一配置系统)
    const graderLLM = createLLM(undefined, {
      temperature: 0, // 确保确定性输出
    });
    
    const graderPrompt = ChatPromptTemplate.fromTemplate(`你是一个专业的文档相关性评估专家。你的任务是判断给定的文档是否包含回答用户问题的必要信息。

用户问题：{question}

待评估文档：
{document}

请严格按照以下标准评估：
1. 文档是否包含与问题直接相关的信息？
2. 文档中的信息是否足以部分或完全回答问题？
3. 文档内容是否与问题的核心意图匹配？

你必须以 JSON 格式返回评估结果（不要返回任何其他内容）：
{{
  "is_relevant": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "简短解释你的判断理由"
}}

注意：
- is_relevant: 如果文档与问题相关且有价值，返回 true
- confidence: 你对这个判断的置信度
- reasoning: 用一句话解释判断理由`);
    
    const outputParser = new StringOutputParser();
    
    // 逐个评估文档
    const documentGrades: GraderResult['documentGrades'] = [];
    const filteredDocs: SCDocument[] = [];
    
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      console.log(`[GRADER] 评估文档 ${i + 1}/${documents.length}...`);
      
      try {
        const chain = graderPrompt.pipe(graderLLM).pipe(outputParser);
        const response = await chain.invoke({
          question: query,
          document: doc.content.substring(0, 1500), // 限制长度
        });
        
        // 解析 JSON 响应
        let gradeResult: { is_relevant: boolean; confidence: number; reasoning: string };
        try {
          // 尝试从响应中提取 JSON
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            gradeResult = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('No JSON found');
          }
        } catch (parseError) {
          // 如果解析失败，使用启发式方法
          const isRelevant = response.toLowerCase().includes('"is_relevant": true') || 
                            response.toLowerCase().includes('"is_relevant":true') ||
                            response.toLowerCase().includes('相关') && !response.includes('不相关');
          gradeResult = {
            is_relevant: isRelevant,
            confidence: 0.6,
            reasoning: '基于响应推断的结果',
          };
        }
        
        const grade: DocumentGrade = {
          isRelevant: gradeResult.is_relevant,
          confidence: gradeResult.confidence,
          reasoning: gradeResult.reasoning,
        };
        
        doc.gradeResult = grade;
        
        documentGrades.push({
          docId: doc.id,
          isRelevant: grade.isRelevant,
          confidence: grade.confidence,
          reasoning: grade.reasoning,
        });
        
        if (grade.isRelevant) {
          filteredDocs.push(doc);
        }
        
        console.log(`[GRADER]   ${grade.isRelevant ? '✅' : '❌'} 文档 ${i + 1}: ${grade.isRelevant ? '相关' : '不相关'} (置信度: ${grade.confidence.toFixed(2)})`);
        console.log(`[GRADER]      理由: ${grade.reasoning}`);
        
      } catch (gradeError: any) {
        console.error(`[GRADER]   ⚠️ 文档 ${i + 1} 评估失败:`, gradeError.message);
        // 评估失败时保守处理，认为文档可能相关
        documentGrades.push({
          docId: doc.id,
          isRelevant: true,
          confidence: 0.5,
          reasoning: '评估失败，默认保留',
        });
        filteredDocs.push(doc);
      }
    }
    
    // 计算通过率
    const passCount = filteredDocs.length;
    const passRate = documents.length > 0 ? passCount / documents.length : 0;
    const shouldRewrite = passRate < state.gradePassThreshold && state.currentRewriteCount < state.maxRewriteAttempts;
    
    const graderResult: GraderResult = {
      passCount,
      totalCount: documents.length,
      passRate,
      shouldRewrite,
      documentGrades,
      overallReasoning: passRate >= state.gradePassThreshold
        ? `${passCount}/${documents.length} 文档通过质检 (${(passRate * 100).toFixed(1)}%)，满足阈值要求`
        : `${passCount}/${documents.length} 文档通过质检 (${(passRate * 100).toFixed(1)}%)，低于阈值 ${state.gradePassThreshold * 100}%，${shouldRewrite ? '将触发查询重写' : '已达最大重写次数'}`,
    };
    
    const duration = Date.now() - startTime;
    
    console.log(`\n[GRADER] 📊 质检结果:`);
    console.log(`[GRADER]   通过率: ${(passRate * 100).toFixed(1)}%`);
    console.log(`[GRADER]   通过文档: ${passCount}/${documents.length}`);
    console.log(`[GRADER]   决策: ${shouldRewrite ? '需要重写查询 ↩️' : '进入生成阶段 ➡️'}`);
    
    const execution: NodeExecution = {
      node: 'grade',
      status: 'completed',
      startTime,
      endTime: Date.now(),
      duration,
      input: { documentCount: documents.length, threshold: state.gradePassThreshold },
      output: graderResult,
    };
    
    return {
      graderResult,
      filteredDocuments: filteredDocs,
      currentNode: 'grade',
      nodeExecutions: [execution],
      decisionPath: [`GRADE: ${passRate >= state.gradePassThreshold ? '通过' : '未通过'} (${(passRate * 100).toFixed(1)}%)`],
    };
    
  } catch (error: any) {
    console.error(`[GRADER] ❌ 质检失败:`, error.message);
    
    const execution: NodeExecution = {
      node: 'grade',
      status: 'error',
      startTime,
      endTime: Date.now(),
      duration: Date.now() - startTime,
      error: error.message,
    };
    
    // 失败时保守处理，使用所有文档
    return {
      graderResult: {
        passCount: documents.length,
        totalCount: documents.length,
        passRate: 1,
        shouldRewrite: false,
        documentGrades: documents.map(d => ({
          docId: d.id,
          isRelevant: true,
          confidence: 0.5,
          reasoning: '质检失败，默认通过',
        })),
        overallReasoning: `质检失败: ${error.message}，默认使用所有文档`,
      },
      filteredDocuments: documents,
      currentNode: 'grade',
      nodeExecutions: [execution],
      decisionPath: [`GRADE: 质检失败，使用全部文档`],
    };
  }
}

/**
 * 节点 3: Rewrite (修正者)
 * 
 * 职责：当 Grader 判定检索质量不佳时，分析失败原因并生成新的查询
 * 触发条件：质检通过率低于阈值
 * 价值：模拟人类"换个词搜搜看"的行为，是图中"循环"的动力
 */
async function rewriteNode(state: typeof SCRAGStateAnnotation.State): Promise<Partial<typeof SCRAGStateAnnotation.State>> {
  const startTime = Date.now();
  const currentRewriteCount = state.currentRewriteCount + 1;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[REWRITE] ✏️ 开始查询重写 (第 ${currentRewriteCount} 次)`);
  console.log(`[REWRITE] 原始查询: "${state.originalQuery}"`);
  console.log(`[REWRITE] 当前查询: "${state.currentQuery}"`);
  console.log(`${'='.repeat(60)}`);
  
  try {
    // 使用统一配置系统
    const rewriteLLM = createLLM(undefined, {
      temperature: 0.3, // 稍微有些创造性
    });
    
    // 构建失败检索的上下文
    const failedContext = state.retrievedDocuments.length > 0
      ? state.retrievedDocuments
          .filter(d => d.gradeResult && !d.gradeResult.isRelevant)
          .map(d => d.content.substring(0, 200))
          .join('\n---\n')
      : '无相关文档被检索到';
    
    // 历史重写记录
    const rewriteHistoryContext = state.rewriteHistory.length > 0
      ? state.rewriteHistory.map((r, i) => `尝试 ${i + 1}: "${r.rewrittenQuery}" - ${r.rewriteReason}`).join('\n')
      : '无历史重写记录';
    
    const rewritePrompt = ChatPromptTemplate.fromTemplate(`你是一个搜索查询优化专家。用户的原始查询没有获得理想的检索结果，你需要分析原因并生成更好的查询。

原始用户问题：{original_query}
当前使用的查询：{current_query}

之前的检索结果（被判定为不相关）：
{failed_context}

历史重写尝试：
{rewrite_history}

当前是第 {rewrite_count} 次重写尝试。

请分析检索失败的可能原因，然后生成一个新的、更精准的查询。

你必须以 JSON 格式返回（不要返回任何其他内容）：
{{
  "rewritten_query": "新的优化查询",
  "rewrite_reason": "重写原因的简短说明",
  "keywords": ["关键词1", "关键词2", "关键词3"]
}}

重写策略建议：
1. 如果原查询太宽泛，尝试添加具体限定词
2. 如果原查询太具体，尝试使用更通用的术语
3. 使用同义词或相关概念
4. 拆分复合问题为更简单的形式
5. 保留核心意图，调整表达方式`);
    
    const outputParser = new StringOutputParser();
    const chain = rewritePrompt.pipe(rewriteLLM).pipe(outputParser);
    
    const response = await chain.invoke({
      original_query: state.originalQuery,
      current_query: state.currentQuery,
      failed_context: failedContext.substring(0, 1000),
      rewrite_history: rewriteHistoryContext,
      rewrite_count: currentRewriteCount,
    });
    
    // 解析响应
    let rewriteResult: { rewritten_query: string; rewrite_reason: string; keywords: string[] };
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        rewriteResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseError) {
      // 使用简单的回退策略
      rewriteResult = {
        rewritten_query: `${state.originalQuery} ${currentRewriteCount > 1 ? '详细' : '具体'}`,
        rewrite_reason: '解析失败，使用默认重写策略',
        keywords: state.originalQuery.split(/\s+/),
      };
    }
    
    const newRewrite: RewriteResult = {
      originalQuery: state.originalQuery,
      rewrittenQuery: rewriteResult.rewritten_query,
      rewriteReason: rewriteResult.rewrite_reason,
      keywords: rewriteResult.keywords,
      rewriteCount: currentRewriteCount,
    };
    
    const duration = Date.now() - startTime;
    
    console.log(`[REWRITE] ✅ 重写完成`);
    console.log(`[REWRITE]   新查询: "${newRewrite.rewrittenQuery}"`);
    console.log(`[REWRITE]   原因: ${newRewrite.rewriteReason}`);
    console.log(`[REWRITE]   关键词: ${newRewrite.keywords.join(', ')}`);
    
    const execution: NodeExecution = {
      node: 'rewrite',
      status: 'completed',
      startTime,
      endTime: Date.now(),
      duration,
      input: { originalQuery: state.originalQuery, currentQuery: state.currentQuery },
      output: newRewrite,
    };
    
    return {
      currentQuery: newRewrite.rewrittenQuery,
      rewriteHistory: [...state.rewriteHistory, newRewrite],
      currentRewriteCount,
      currentNode: 'rewrite',
      nodeExecutions: [execution],
      decisionPath: [`REWRITE: "${state.currentQuery}" → "${newRewrite.rewrittenQuery}"`],
    };
    
  } catch (error: any) {
    console.error(`[REWRITE] ❌ 重写失败:`, error.message);
    
    const execution: NodeExecution = {
      node: 'rewrite',
      status: 'error',
      startTime,
      endTime: Date.now(),
      duration: Date.now() - startTime,
      error: error.message,
    };
    
    return {
      currentRewriteCount,
      currentNode: 'rewrite',
      nodeExecutions: [execution],
      shouldContinue: false,
      error: `查询重写失败: ${error.message}`,
      decisionPath: [`REWRITE: 重写失败 - ${error.message}`],
    };
  }
}

/**
 * 节点 4: Generate (生成者)
 * 
 * 职责：基于通过质检的高质量文档生成最终回答
 * 前置条件：只有通过 Grader 质检的文档才能进入
 * 价值：确保 LLM 拿到的 Context 是纯净的，从而生成准确的回答
 */
async function generateNode(state: typeof SCRAGStateAnnotation.State): Promise<Partial<typeof SCRAGStateAnnotation.State>> {
  const startTime = Date.now();
  const documents = state.filteredDocuments;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[GENERATE] 💬 开始生成回答`);
  console.log(`[GENERATE] 使用 ${documents.length} 个高质量文档`);
  console.log(`${'='.repeat(60)}`);
  
  // 特殊情况：无文档可用
  if (documents.length === 0) {
    console.log(`[GENERATE] ⚠️ 无文档可用，生成无法回答的响应`);
    
    const generationResult: GenerationResult = {
      answer: `抱歉，我在知识库中没有找到与您问题相关的信息。\n\n您的问题是："${state.originalQuery}"\n\n建议：\n1. 尝试使用不同的关键词描述您的问题\n2. 确保知识库中已上传相关文档\n3. 将复杂问题拆分为更简单的子问题`,
      usedDocuments: 0,
      confidence: 0,
      sources: [],
    };
    
    const execution: NodeExecution = {
      node: 'generate',
      status: 'completed',
      startTime,
      endTime: Date.now(),
      duration: Date.now() - startTime,
      input: { documentCount: 0 },
      output: generationResult,
    };
    
    return {
      generationResult,
      finalAnswer: generationResult.answer,
      currentNode: 'generate',
      shouldContinue: false,
      nodeExecutions: [execution],
      endTime: Date.now(),
      totalDuration: Date.now() - state.startTime,
      decisionPath: [`GENERATE: 无文档，生成默认响应`],
    };
  }
  
  try {
    // 使用统一配置系统
    const generateLLM = createLLM(undefined, {
      temperature: 0.7,
    });
    
    // 构建高质量上下文
    const context = documents
      .map((doc, i) => `[文档 ${i + 1}] (相关度: ${(doc.gradeResult?.confidence || doc.score).toFixed(2)})\n${doc.content}`)
      .join('\n\n---\n\n');
    
    const generatePrompt = ChatPromptTemplate.fromTemplate(`你是一个专业的智能助手。请基于以下经过质量验证的文档内容，准确回答用户的问题。

用户问题：{question}

参考文档（已通过相关性验证）：
{context}

回答要求：
1. 只使用参考文档中的信息，不要编造
2. 如果信息不完整，诚实说明
3. 用清晰、简洁的语言回答
4. 如果可能，引用信息来源（如"根据文档1..."）
5. 保持专业但友好的语气

请直接给出回答：`);
    
    const outputParser = new StringOutputParser();
    const chain = generatePrompt.pipe(generateLLM).pipe(outputParser);
    
    const answer = await chain.invoke({
      question: state.originalQuery,
      context: context.substring(0, 4000), // 限制 context 长度
    });
    
    const sources = documents.map((doc, i) => 
      doc.metadata?.filename || doc.metadata?.source || `文档 ${i + 1}`
    );
    
    const generationResult: GenerationResult = {
      answer: answer.trim(),
      usedDocuments: documents.length,
      confidence: documents.reduce((acc, d) => acc + (d.gradeResult?.confidence || d.score), 0) / documents.length,
      sources,
    };
    
    const duration = Date.now() - startTime;
    
    console.log(`[GENERATE] ✅ 生成完成`);
    console.log(`[GENERATE]   回答长度: ${answer.length} 字符`);
    console.log(`[GENERATE]   使用文档: ${documents.length}`);
    console.log(`[GENERATE]   置信度: ${(generationResult.confidence * 100).toFixed(1)}%`);
    
    const execution: NodeExecution = {
      node: 'generate',
      status: 'completed',
      startTime,
      endTime: Date.now(),
      duration,
      input: { documentCount: documents.length, question: state.originalQuery },
      output: { answerLength: answer.length, confidence: generationResult.confidence },
    };
    
    return {
      generationResult,
      finalAnswer: generationResult.answer,
      currentNode: 'generate',
      shouldContinue: false,
      nodeExecutions: [execution],
      endTime: Date.now(),
      totalDuration: Date.now() - state.startTime,
      decisionPath: [`GENERATE: 基于 ${documents.length} 个文档生成回答`],
    };
    
  } catch (error: any) {
    console.error(`[GENERATE] ❌ 生成失败:`, error.message);
    
    const execution: NodeExecution = {
      node: 'generate',
      status: 'error',
      startTime,
      endTime: Date.now(),
      duration: Date.now() - startTime,
      error: error.message,
    };
    
    return {
      finalAnswer: `抱歉，生成回答时遇到错误: ${error.message}`,
      currentNode: 'generate',
      shouldContinue: false,
      nodeExecutions: [execution],
      error: `生成失败: ${error.message}`,
      endTime: Date.now(),
      totalDuration: Date.now() - state.startTime,
      decisionPath: [`GENERATE: 生成失败 - ${error.message}`],
    };
  }
}

// ==================== 路由函数 ====================

/**
 * 根据 Grader 结果决定下一步
 * - 如果质检通过：进入 Generate
 * - 如果质检不通过且未达最大重写次数：进入 Rewrite
 * - 如果质检不通过但已达最大重写次数：强制进入 Generate
 */
function routeAfterGrade(state: typeof SCRAGStateAnnotation.State): 'rewrite' | 'generate' {
  const graderResult = state.graderResult;
  
  if (!graderResult) {
    console.log(`[ROUTE] Grader 结果为空，进入 Generate`);
    return 'generate';
  }
  
  if (graderResult.shouldRewrite && state.currentRewriteCount < state.maxRewriteAttempts) {
    console.log(`[ROUTE] 质检未通过，触发 Rewrite (${state.currentRewriteCount + 1}/${state.maxRewriteAttempts})`);
    return 'rewrite';
  }
  
  console.log(`[ROUTE] 质检通过或已达重写上限，进入 Generate`);
  return 'generate';
}

// ==================== 构建状态图 ====================

/**
 * 构建 Self-Corrective RAG 状态图
 * 
 * 流程：
 * START → retrieve → grade → [rewrite → retrieve] (循环) → generate → END
 */
function buildSCRAGGraph() {
  const workflow = new StateGraph(SCRAGStateAnnotation)
    // 添加节点
    .addNode('retrieve', retrieveNode)
    .addNode('grade', graderNode)
    .addNode('rewrite', rewriteNode)
    .addNode('generate', generateNode)
    
    // 定义边
    .addEdge(START, 'retrieve')       // 入口 → 检索
    .addEdge('retrieve', 'grade')     // 检索 → 质检
    .addConditionalEdges('grade', routeAfterGrade) // 质检 → 条件路由
    .addEdge('rewrite', 'retrieve')   // 重写 → 重新检索（循环）
    .addEdge('generate', END);        // 生成 → 结束
  
  return workflow.compile();
}

// ==================== 主入口 ====================

export interface SCRAGInput {
  query: string;
  topK?: number;
  similarityThreshold?: number;
  maxRewriteAttempts?: number;
  gradePassThreshold?: number;
  milvusConfig?: MilvusConfig;
}

export interface SCRAGOutput {
  answer: string;
  originalQuery: string;
  finalQuery: string;
  wasRewritten: boolean;
  rewriteCount: number;
  rewriteHistory: RewriteResult[];
  retrievedDocuments: SCDocument[];
  filteredDocuments: SCDocument[];
  graderResult?: GraderResult;
  generationResult?: GenerationResult;
  nodeExecutions: NodeExecution[];
  decisionPath: string[];
  totalDuration: number;
  error?: string;
}

/**
 * 执行 Self-Corrective RAG
 */
export async function executeSCRAG(input: SCRAGInput): Promise<SCRAGOutput> {
  console.log(`\n${'🔄'.repeat(30)}`);
  console.log(`[SC-RAG] 🚀 开始执行 Self-Corrective RAG`);
  console.log(`[SC-RAG] 查询: "${input.query}"`);
  console.log(`${'🔄'.repeat(30)}\n`);
  
  const startTime = Date.now();
  
  // 初始状态
  const initialState: Partial<typeof SCRAGStateAnnotation.State> = {
    originalQuery: input.query,
    currentQuery: input.query,
    topK: input.topK || 5,
    similarityThreshold: input.similarityThreshold || 0.3,
    maxRewriteAttempts: input.maxRewriteAttempts || 3,
    gradePassThreshold: input.gradePassThreshold || 0.6,
    milvusConfig: input.milvusConfig,
    startTime,
    currentRewriteCount: 0,
    rewriteHistory: [],
    decisionPath: [],
    nodeExecutions: [],
  };
  
  try {
    const graph = buildSCRAGGraph();
    const finalState = await graph.invoke(initialState);
    
    const output: SCRAGOutput = {
      answer: finalState.finalAnswer || '',
      originalQuery: finalState.originalQuery,
      finalQuery: finalState.currentQuery,
      wasRewritten: finalState.currentRewriteCount > 0,
      rewriteCount: finalState.currentRewriteCount,
      rewriteHistory: finalState.rewriteHistory,
      retrievedDocuments: finalState.retrievedDocuments,
      filteredDocuments: finalState.filteredDocuments,
      graderResult: finalState.graderResult,
      generationResult: finalState.generationResult,
      nodeExecutions: finalState.nodeExecutions,
      decisionPath: finalState.decisionPath,
      totalDuration: finalState.totalDuration || (Date.now() - startTime),
      error: finalState.error,
    };
    
    console.log(`\n${'✅'.repeat(30)}`);
    console.log(`[SC-RAG] 执行完成`);
    console.log(`[SC-RAG] 总耗时: ${output.totalDuration}ms`);
    console.log(`[SC-RAG] 重写次数: ${output.rewriteCount}`);
    console.log(`[SC-RAG] 决策路径: ${output.decisionPath.join(' → ')}`);
    console.log(`${'✅'.repeat(30)}\n`);
    
    return output;
    
  } catch (error: any) {
    console.error(`[SC-RAG] ❌ 执行失败:`, error);
    
    return {
      answer: `执行失败: ${error.message}`,
      originalQuery: input.query,
      finalQuery: input.query,
      wasRewritten: false,
      rewriteCount: 0,
      rewriteHistory: [],
      retrievedDocuments: [],
      filteredDocuments: [],
      nodeExecutions: [],
      decisionPath: [`ERROR: ${error.message}`],
      totalDuration: Date.now() - startTime,
      error: error.message,
    };
  }
}

// ==================== 导出 ====================

export { buildSCRAGGraph };
