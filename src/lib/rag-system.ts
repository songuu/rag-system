import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { Document } from "@langchain/core/documents";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Embeddings } from "@langchain/core/embeddings";
import { ObservabilityEngine, type Trace } from "./observability";
import { AutoTokenizer } from "@xenova/transformers";
import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { createLLM, createEmbedding, getModelFactory, isOllamaProvider, isCustomProvider } from "./model-config";
import { getEmbeddingProvider, getEmbeddingConfigSummary } from "./embedding-config";

// 接口定义
export interface TokenInfo {
  token: string;
  tokenId: number;
  position: number;
  type: 'chinese' | 'english' | 'number' | 'punctuation' | 'special';
}

export interface VectorFeatures {
  techScore: number;
  businessScore: number;
  dailyScore: number;
  emotionScore: number;
  vectorMagnitude: number;
}

export interface SemanticAnalysis {
  context: string;
  semanticCategory: string;
  nearestConcepts: string[];
  confidence: number;
  vectorFeatures?: VectorFeatures;
}

export interface VectorizationProgress {
  current: number;
  total: number;
  filename: string;
  status: string;
  dimension?: number;
  timeTaken?: number;
}

export interface QueryVectorizationProgress {
  status: 'started' | 'tokenizing' | 'preprocessing' | 'embedding' | 'completed';
  message: string;
  timeTaken?: number;
  tokenization?: {
    tokenCount: number;
    tokens: TokenInfo[];
    processingTime: number;
  };
  embedding?: {
    embedding: number[];
    embeddingDimension: number;
    semanticAnalysis: SemanticAnalysis;
    modelInfo: {
      name: string;
      vocabularySize?: number;
    };
  };
}

export interface SimilaritySearchResult {
  document: Document;
  similarity: number;
  index: number;
}

export interface RetrievalDetails {
  query: string;
  queryEmbedding: number[];
  queryVectorizationTime: number;
  topK: number;
  threshold: number;
  totalDocuments: number;
  searchTime: number;
  searchResults: SimilaritySearchResult[];
}

// 使用 @xenova/transformers 的词元化器
class SimpleTokenizer {
  private tokenizer: any = null;
  private loadingPromise: Promise<void> | null = null;
  private modelName: string = 'Xenova/bert-base-multilingual-cased'; // 支持中英文的多语言模型
  private initialized: boolean = false;

  constructor() {
    // 延迟加载，不在构造函数中初始化
    // 注意：在 Node.js 环境中，@xenova/transformers 会自动使用 ONNX Runtime
  }

  /**
   * 初始化 tokenizer（异步加载模型）
   */
  private async initialize(): Promise<void> {
    if (this.tokenizer) {
      return; // 已经初始化
    }

    if (this.loadingPromise) {
      return this.loadingPromise; // 正在加载，等待完成
    }

    this.loadingPromise = (async () => {
      try {
        console.log(`[Tokenizer] 开始加载模型: ${this.modelName}`);
        
        // 使用 AutoTokenizer 自动加载模型
        // 这个模型支持中文、英文等多种语言
        // 在 Node.js 环境中，会自动使用 ONNX Runtime
        this.tokenizer = await AutoTokenizer.from_pretrained(this.modelName, {
          // 可选：设置本地缓存路径
          // cache_dir: './models',
          // 在服务器端运行时，可以禁用进度回调以提高性能
          progress_callback: undefined,
        });
        
        this.initialized = true;
        console.log(`[Tokenizer] 模型加载成功: ${this.modelName}`);
      } catch (error) {
        console.error('[Tokenizer] 模型加载失败:', error);
        this.initialized = false;
        // 如果加载失败，抛出错误
        throw new Error(`Tokenizer initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    })();

    return this.loadingPromise;
  }

  /**
   * 从 tokenizer 中提取词汇表 (id -> token 映射)
   */
  private extractIdToTokenMap(): Map<number, string> {
    const idToToken = new Map<number, string>();
    
    const extractFromVocabObject = (vocabObj: any) => {
      if (!vocabObj) return;
      
      if (vocabObj instanceof Map) {
        vocabObj.forEach((value: any, key: any) => {
          if (typeof key === 'string' && typeof value === 'number') {
            idToToken.set(value, key);
          } else if (typeof value === 'string' && typeof key === 'number') {
            idToToken.set(key, value);
          }
        });
      } else if (Array.isArray(vocabObj)) {
        vocabObj.forEach((token, index) => {
          if (typeof token === 'string') {
            idToToken.set(index, token);
          }
        });
      } else if (typeof vocabObj === 'object') {
        Object.entries(vocabObj).forEach(([key, value]) => {
          if (typeof value === 'number') {
            idToToken.set(value, key);
          }
        });
      }
    };

    const vocabPaths = [
      () => this.tokenizer?.model?.vocab,
      () => this.tokenizer?.model?.encoder,
      () => this.tokenizer?.vocab,
      () => this.tokenizer?.encoder,
      () => this.tokenizer?.tokenizer_?.model?.vocab,
      () => this.tokenizer?._tokenizer?.model?.vocab
    ];

    for (const getVocab of vocabPaths) {
      try {
        const vocabObj = getVocab();
        if (vocabObj) {
          extractFromVocabObject(vocabObj);
          if (idToToken.size > 0) break;
        }
      } catch {
        // 忽略访问错误
      }
    }
    
    return idToToken;
  }

  /**
   * 词元化文本
   * @param text 要词元化的文本
   * @returns TokenInfo 数组
   */
  async tokenize(text: string | any): Promise<TokenInfo[]> {
    // 确保 tokenizer 已初始化
    await this.initialize();

    if (!this.tokenizer || !this.initialized) {
      throw new Error('Tokenizer not initialized');
    }

    // 强制转换为字符串类型 - 增强类型检查
    let textStr: string;
    
    try {
      if (typeof text === 'string') {
        textStr = text;
      } else if (text === null || text === undefined) {
        textStr = '';
      } else if (typeof text === 'object') {
        // 如果是对象，尝试获取其 text/content/query 属性
        const extracted = text.text || text.content || text.query || text.pageContent;
        if (typeof extracted === 'string') {
          textStr = extracted;
        } else if (extracted != null) {
          textStr = String(extracted);
        } else {
          // 尝试 toString，但确保结果是字符串
          const toStr = text.toString?.();
          textStr = typeof toStr === 'string' ? toStr : '';
        }
      } else {
        textStr = String(text);
      }
    } catch (conversionError) {
      console.error('[Tokenizer] 文本转换错误:', conversionError, 'Input type:', typeof text);
      textStr = '';
    }

    // 最终验证：确保 textStr 是字符串类型
    if (typeof textStr !== 'string') {
      console.error('[Tokenizer] 转换后的文本不是字符串类型:', typeof textStr, textStr);
      textStr = '';
    }

    // 如果 text 为空，返回空数组
    if (!textStr || !textStr.trim()) {
      return [];
    }

    try {
      // 使用真实的 tokenizer 进行编码，获取 token IDs
      const encoded = this.tokenizer.encode(textStr, {
        add_special_tokens: true,
        return_tensors: false,
      });

      // 获取 token 文本
      let tokenTexts: string[] = [];
      
      try {
        // 方法1: 尝试使用 batch_decode
        tokenTexts = this.tokenizer.batch_decode(
          encoded.map((id: number) => [id]),
          { skip_special_tokens: false }
        );
      } catch {
        try {
          // 方法2: 使用单个 decode
          tokenTexts = encoded.map((tokenId: number) => {
            try {
              return this.tokenizer.decode([tokenId], { skip_special_tokens: false }) || `[TOKEN:${tokenId}]`;
            } catch {
              return `[TOKEN:${tokenId}]`;
            }
          });
        } catch {
          // 方法3: 从词汇表中获取
          const idToToken = this.extractIdToTokenMap();
          if (idToToken.size > 0) {
            tokenTexts = encoded.map((tokenId: number) => {
              return idToToken.get(tokenId) || `[UNK:${tokenId}]`;
            });
          } else {
            tokenTexts = encoded.map((tokenId: number) => `[TOKEN:${tokenId}]`);
          }
        }
      }

      // 确保 tokenTexts 数组长度与 encoded 数组长度一致
      if (tokenTexts.length !== encoded.length) {
        // 如果长度不匹配，使用编码结果创建默认 token 文本
        tokenTexts = encoded.map((tokenId: number, index: number) => {
          return tokenTexts[index] || `[TOKEN:${tokenId}]`;
        });
      }

      // 构建 TokenInfo 数组
      const tokens: TokenInfo[] = [];
      let position = 0;

      for (let i = 0; i < encoded.length; i++) {
        const tokenId = encoded[i];
        let tokenText = tokenTexts[i] || `[TOKEN:${tokenId}]`;

        // 清理 token 文本（移除 BPE 标记等）
        tokenText = this.cleanTokenText(tokenText);

        // 确定 token 类型
        const tokenType = this.getTokenType(tokenText);

        tokens.push({
          token: tokenText,
          tokenId: tokenId,
          position: position++,
          type: tokenType
        });
      }

      return tokens;
    } catch (error) {
      console.error('Tokenization error:', error);
      // 如果出错，返回一个基本的 token 信息
      return [{
        token: text,
        tokenId: 1, // UNK token ID
        position: 0,
        type: this.getTokenType(text)
      }];
    }
  }

  /**
   * 清理 token 文本
   */
  private cleanTokenText(text: string): string {
    // 移除 BPE 标记（如 ## 前缀）
    return text.replace(/^##/, '').trim();
  }

  /**
   * 确定 token 类型
   */
  private getTokenType(token: string): TokenInfo['type'] {
    // 检查特殊 tokens
    if (/^\[(CLS|SEP|PAD|UNK|MASK)\]/i.test(token)) {
      return 'special';
    }

    // 检查是否为纯英文
    if (/^[a-zA-Z]+$/.test(token)) {
      return 'english';
    }

    // 检查是否为中文
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      return 'chinese';
    }

    // 检查是否为数字
    if (/^[0-9]+$/.test(token)) {
      return 'number';
    }

    // 检查是否为标点符号
    if (/^[.,!?:;()"'\-/\[\]{}]+$/.test(token)) {
      return 'punctuation';
    }

    // 混合类型（如中英文混合、数字+字母等）
    return 'special';
  }

  /**
   * 获取原始文本（用于显示）
   */
  getOriginalText(text: string): string {
    return text;
  }
}

// 内存向量存储
class SimpleMemoryVectorStore {
  private documents: Document[] = [];
  private embeddings: number[][] = [];
  private tokenizer: SimpleTokenizer;

  constructor(
    private embeddingModel: Embeddings,
    private onProgress?: (progress: VectorizationProgress) => void,
    private onQueryProgress?: (progress: QueryVectorizationProgress) => void
  ) {
    this.tokenizer = new SimpleTokenizer();
  }

  clear() {
    this.documents = [];
    this.embeddings = [];
  }

  async addDocuments(docs: Document[]) {
    const total = docs.length;
    
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const filename = doc.metadata?.source || `document-${i}`;
      
      this.onProgress?.({
        current: i + 1,
        total,
        filename,
        status: `正在向量化文档 ${i + 1}/${total}: ${filename}`
      });

      const startTime = Date.now();
      const embedding = await this.embeddingModel.embedQuery(doc.pageContent);
      const timeTaken = Date.now() - startTime;

      this.documents.push(doc);
      this.embeddings.push(embedding);

      this.onProgress?.({
        current: i + 1,
        total,
        filename,
        status: `文档 ${i + 1} 向量化完成，向量维度: ${embedding.length}`,
        dimension: embedding.length,
        timeTaken
      });
    }
  }

  async similaritySearchWithDetails(
    query: string,
    k: number,
    threshold: number,
    onQueryProgress?: (progress: QueryVectorizationProgress) => void
  ): Promise<RetrievalDetails> {
    const startTime = Date.now();

    // 1. 词元化
    onQueryProgress?.({
      status: 'tokenizing',
      message: '正在进行词元化...'
    });

    const tokens = await this.tokenizer.tokenize(query);
    const tokenizationTime = Date.now() - startTime;

    onQueryProgress?.({
      status: 'tokenizing',
      message: '词元化完成',
      timeTaken: tokenizationTime,
      tokenization: {
        tokenCount: tokens.length,
        tokens,
        processingTime: tokenizationTime
      }
    });

    // 2. 向量化
    onQueryProgress?.({
      status: 'embedding',
      message: '正在生成查询向量...'
    });

    const embeddingStartTime = Date.now();
    const queryEmbedding = await this.embeddingModel.embedQuery(query);
    const embeddingTime = Date.now() - embeddingStartTime;

    // 简化的语义分析
    const semanticAnalysis = this.analyzeSemantics(query, queryEmbedding);

    onQueryProgress?.({
      status: 'completed',
      message: '查询向量化完成',
      timeTaken: Date.now() - startTime,
      embedding: {
        embedding: queryEmbedding,
        embeddingDimension: queryEmbedding.length,
        semanticAnalysis,
        modelInfo: {
          name: 'nomic-embed-text'
        }
      }
    });

    // 3. 相似度搜索
    const searchStartTime = Date.now();
    const similarities = this.embeddings.map((embedding, index) => ({
      index,
      similarity: this.cosineSimilarity(queryEmbedding, embedding)
    }));

    // 过滤和排序
    const filteredResults = similarities
      .filter(result => result.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);

    const searchResults: SimilaritySearchResult[] = filteredResults.map(result => ({
      document: this.documents[result.index],
      similarity: result.similarity,
      index: result.index
    }));

    const searchTime = Date.now() - searchStartTime;

    return {
      query,
      queryEmbedding,
      queryVectorizationTime: embeddingTime,
      topK: k,
      threshold,
      totalDocuments: this.documents.length,
      searchTime,
      searchResults
    };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
  }

  private analyzeSemantics(text: string, embedding: number[]): SemanticAnalysis {
    // 简化的语义分析
    const lowerText = text.toLowerCase();
    let context = '';
    let semanticCategory = '';
    let nearestConcepts: string[] = [];
    let confidence = 0.8;

    if (lowerText.includes('智能') || lowerText.includes('AI') || lowerText.includes('人工智能')) {
      context = '人工智能语境';
      semanticCategory = 'AI技术';
      nearestConcepts = ['人工智能', '机器学习', '深度学习', '算法'];
      confidence = 0.9;
    } else if (lowerText.includes('手机') || lowerText.includes('苹果')) {
      context = '科技产品语境';
      semanticCategory = '电子设备';
      nearestConcepts = ['智能手机', '电子设备', '科技产品'];
      confidence = 0.85;
    } else {
      context = '通用语境';
      semanticCategory = '一般';
      nearestConcepts = ['文本', '信息', '内容'];
      confidence = 0.7;
    }

    return {
      context,
      semanticCategory,
      nearestConcepts,
      confidence
    };
  }

  getDocumentCount(): number {
    return this.documents.length;
  }

  getEmbeddingDimension(): number {
    return this.embeddings.length > 0 ? this.embeddings[0].length : 0;
  }
}

// 主要的 RAG 系统类
export class LocalRAGSystem {
  private llm: BaseChatModel;
  private embeddings: Embeddings;
  private vectorStore!: SimpleMemoryVectorStore;
  private isInitialized = false;
  private observabilityEngine: ObservabilityEngine;

  constructor(
    private config: {
      /** @deprecated 使用 MODEL_PROVIDER 环境变量代替 */
      ollamaBaseUrl?: string;
      llmModel?: string;
      /** @deprecated 使用 EMBEDDING_PROVIDER 环境变量代替 */
      embeddingModel?: string;
      onVectorizationProgress?: (progress: VectorizationProgress) => void;
      onRetrievalDetails?: (details: RetrievalDetails) => void;
      onQueryVectorizationProgress?: (progress: QueryVectorizationProgress) => void;
      onTraceUpdate?: (trace: Trace) => void;
    } = {}
  ) {
    const factory = getModelFactory();
    const envConfig = factory.getEnvConfig();

    const customModel = isCustomProvider() ? envConfig.CUSTOM_LLM_MODEL : null;

    // LLM 模型 - 从 MODEL_PROVIDER 配置
    const llmModel = customModel || config.llmModel || (isOllamaProvider() ? envConfig.OLLAMA_LLM_MODEL : envConfig.OPENAI_LLM_MODEL);


    // Embedding 模型 - 从 EMBEDDING_PROVIDER 独立配置
    // 不再使用 isOllamaProvider()，而是使用独立的 embedding 配置系统
    const embeddingConfig = getEmbeddingConfigSummary();
    const embeddingProvider = getEmbeddingProvider();

    // 使用统一模型配置系统
    this.llm = createLLM(llmModel, { temperature: 0 });
    
    // Embedding 使用独立配置系统，如果没有指定 embeddingModel，则自动从 EMBEDDING_PROVIDER 获取
    this.embeddings = createEmbedding(config.embeddingModel);

    console.log(`[LocalRAGSystem] 初始化完成:`);
    console.log(`  - LLM 提供商: ${factory.getProvider()}, 模型: ${llmModel}`);
    console.log(`  - Embedding 提供商: ${embeddingProvider}, 模型: ${embeddingConfig.model}`);

    this.observabilityEngine = new ObservabilityEngine({
      onTraceUpdate: config.onTraceUpdate,
    });

    this.vectorStore = new SimpleMemoryVectorStore(
      this.embeddings,
      config.onVectorizationProgress,
      config.onQueryVectorizationProgress
    );
  }

  async initializeDatabase(docsPath?: string): Promise<void> {
    console.log("正在初始化 RAG 系统...");
    console.log("--- 正在初始化向量数据库 ---");

    // 尝试从 uploads 文件夹读取文档
    const uploadsDir = docsPath || path.join(process.cwd(), "uploads");
    let documents: Document[] = [];

    try {
      if (existsSync(uploadsDir)) {
        const files = await readdir(uploadsDir);
        const txtFiles = files.filter(file => file.endsWith('.txt'));
        
        if (txtFiles.length > 0) {
          console.log(`发现 ${txtFiles.length} 个上传的文档文件`);
          
          for (const filename of txtFiles) {
            const filePath = path.join(uploadsDir, filename);
            const content = await readFile(filePath, 'utf-8');
            
            if (content.trim()) {
              documents.push(new Document({
                pageContent: content,
                metadata: { source: filename }
              }));
              console.log(`已加载: ${filename}`);
            }
          }
        }
      }
    } catch (error) {
      console.error("读取上传文档时出错:", error);
    }

    // 如果没有上传的文档，使用示例文档作为回退
    if (documents.length === 0) {
      console.log("没有找到上传的文档，使用示例文档...");
      documents = [
        new Document({
          pageContent: "人工智能（AI）是计算机科学的一个分支，致力于创建能够执行通常需要人类智能的任务的系统。这包括学习、推理、问题解决、感知和语言理解。",
          metadata: { source: "ai-intro.txt" }
        }),
        new Document({
          pageContent: "机器学习是人工智能的一个子集，它使计算机能够在没有明确编程的情况下学习和改进。它基于算法，这些算法可以从数据中学习并做出预测或决策。",
          metadata: { source: "ml-intro.txt" }
        }),
        new Document({
          pageContent: "深度学习是机器学习的一个子领域，它使用具有多层的神经网络来模拟人脑的工作方式。这种方法在图像识别、自然语言处理和语音识别等领域取得了显著成功。",
          metadata: { source: "dl-intro.txt" }
        }),
        new Document({
          pageContent: "智能手机是一种功能强大的移动设备，集成了计算、通信和娱乐功能。现代智能手机配备了先进的处理器、高分辨率显示屏和多种传感器。",
          metadata: { source: "smartphone-intro.txt" }
        }),
        new Document({
          pageContent: "苹果公司是一家美国跨国科技公司，以设计、开发和销售消费电子产品、计算机软件和在线服务而闻名。其产品包括iPhone、iPad、Mac电脑等。",
          metadata: { source: "apple-intro.txt" }
        })
      ];
    } else {
      console.log(`成功加载 ${documents.length} 个上传的文档`);
    }

    // 文本分割
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 500,
      chunkOverlap: 50,
    });

    const splitDocs = await textSplitter.splitDocuments(documents);
    console.log(`切分为 ${splitDocs.length} 个文本块`);

    // 向量化
    await this.vectorStore.addDocuments(splitDocs);

    this.isInitialized = true;
    console.log("向量数据库初始化完成。");
    console.log("RAG 系统初始化完成！");
  }

  async reinitialize(documents: Array<{ content: string; filename: string }> | string[]): Promise<void> {
    console.log("正在重新初始化 RAG 系统...");
    
    // 清空现有数据
    this.vectorStore.clear();
    
    // 将输入转换为 Document 对象
    const docs = documents.map((doc, index) => {
      // 兼容旧的字符串数组格式和新的对象格式
      if (typeof doc === 'string') {
        return new Document({
          pageContent: doc,
          metadata: { source: `document-${index}.txt` }
        });
      }
      return new Document({
        pageContent: doc.content,
        metadata: { source: doc.filename }
      });
    });
    
    if (docs.length === 0) {
      this.isInitialized = false;
      console.log("系统已清空");
      return;
    }
    
    // 文本分割
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 500,
      chunkOverlap: 50,
    });

    const splitDocs = await textSplitter.splitDocuments(docs);
    console.log(`切分为 ${splitDocs.length} 个文本块`);

    // 向量化
    await this.vectorStore.addDocuments(splitDocs);

    this.isInitialized = true;
    console.log("向量数据库重新初始化完成。");
    console.log("RAG 系统重新初始化完成！");
  }

  async askWithDetails(
    question: string,
    options: {
      topK?: number;
      similarityThreshold?: number;
      llmModel?: string;
      embeddingModel?: string;
      userId?: string;
      sessionId?: string;
    } = {}
  ): Promise<{
    answer: string;
    retrievalDetails: RetrievalDetails;
    context: string;
    traceId: string;
  }> {
    if (!this.isInitialized) {
      throw new Error("RAG 系统尚未初始化，请先调用 initializeDatabase()");
    }

    const { topK = 3, similarityThreshold = 0.0, userId, sessionId } = options;

    // 创建 Trace
    const traceId = this.observabilityEngine.createTrace({
      name: 'RAG Query',
      userId,
      sessionId,
      input: { question, topK, similarityThreshold },
      metadata: {
        model: this.llm.model,
        embeddingModel: this.embeddings.model,
        timestamp: new Date().toISOString()
      },
      tags: ['rag', 'question-answering']
    });

    try {
      // 查询理解与向量化 Span
      const querySpanId = this.observabilityEngine.createSpan({
        traceId,
        name: 'Query Understanding & Vectorization',
        input: { question },
        metadata: { stage: 'query_processing' }
      });

      // 向量检索 Span
      const retrievalSpanId = this.observabilityEngine.createSpan({
        traceId,
        name: 'Vector Retrieval',
        parentObservationId: querySpanId,
        input: { question, topK, similarityThreshold },
        metadata: { stage: 'retrieval' }
      });

      // 执行检索
      const retrievalDetails = await this.vectorStore.similaritySearchWithDetails(
        question,
        topK,
        similarityThreshold,
        this.config.onQueryVectorizationProgress
      );

      // 更新检索 Span
      this.observabilityEngine.updateObservation(retrievalSpanId, {
        output: {
          totalDocuments: retrievalDetails.totalDocuments,
          matchedDocuments: retrievalDetails.searchResults.length,
          searchTime: retrievalDetails.searchTime,
        },
        endTime: new Date(),
      });

      // 发送检索详情
      this.config.onRetrievalDetails?.(retrievalDetails);

      // 构造上下文
      const context = retrievalDetails.searchResults
        .map((result, index) =>
          `[文档${index + 1}] (相似度: ${result.similarity.toFixed(4)}) (来源: ${result.document.metadata?.source || 'Unknown'})\n${result.document.pageContent}`
        )
        .join("\n---\n");

      // LLM 生成 Generation
      const generationId = this.observabilityEngine.createGeneration({
        traceId,
        name: 'Answer Generation',
        input: { question, context },
        model: this.llm.model,
        modelParameters: { temperature: 0 },
        metadata: { stage: 'generation' }
      });

      // 构造 Prompt
      const prompt = ChatPromptTemplate.fromTemplate(`
        你是一个专业的知识库助手。请根据下方提供的上下文信息来回答用户的问题。
        
        【上下文信息】：
        {context}
        
        【用户问题】：
        {question}
        
        如果上下文信息中不包含答案，请礼貌地说明你不知道，不要胡乱编造。
        请使用中文回答，回答要简洁明了。
      `);

      const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
      const result = await chain.invoke({
        context: context,
        question: question,
      });

      // 更新 Generation
      this.observabilityEngine.updateObservation(generationId, {
        output: result,
        endTime: new Date(),
        usage: {
          promptTokens: Math.ceil(context.length / 4),
          completionTokens: Math.ceil(result.length / 4),
          totalTokens: Math.ceil((context.length + result.length) / 4)
        }
      });

      // 完成 Trace
      this.observabilityEngine.updateTrace(traceId, {
        output: { answer: result, context },
        status: 'SUCCESS',
        endTime: new Date(),
      });

      return {
        answer: result,
        retrievalDetails,
        context,
        traceId
      };

    } catch (error) {
      this.observabilityEngine.updateTrace(traceId, {
        status: 'ERROR',
        endTime: new Date(),
        metadata: { error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  }

  // 可观测性方法
  getObservabilityData() {
    return {
      traces: this.observabilityEngine.getAllTraces(),
      stats: this.observabilityEngine.getTraceStats()
    };
  }

  getTrace(traceId: string) {
    return this.observabilityEngine.getTrace(traceId);
  }

  addUserFeedback(traceId: string, score: number | boolean, comment?: string) {
    return this.observabilityEngine.addScore({
      traceId,
      name: 'user_feedback',
      value: score,
      source: 'USER',
      comment
    });
  }

  clearObservabilityData() {
    this.observabilityEngine.clear();
  }

  getStatus() {
    return {
      initialized: this.isInitialized,
      documentCount: this.vectorStore?.getDocumentCount() || 0,
      embeddingDimension: this.vectorStore?.getEmbeddingDimension() || 0
    };
  }

  // 获取统计信息（兼容旧接口）
  getStats() {
    return this.getStatus();
  }

  // 公开的相似度搜索方法
  async similaritySearch(
    query: string,
    topK: number = 5,
    threshold: number = 0.3
  ): Promise<RetrievalDetails> {
    if (!this.isInitialized) {
      throw new Error("RAG 系统尚未初始化，请先调用 initializeDatabase()");
    }
    return this.vectorStore.similaritySearchWithDetails(query, topK, threshold);
  }
}