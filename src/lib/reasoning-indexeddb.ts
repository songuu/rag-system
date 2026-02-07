/**
 * Reasoning RAG 专用 IndexedDB 管理器
 * 用于存储推理 RAG 的历史对话和配置
 */

// 思考步骤类型
export interface ThinkingStep {
  id: string;
  timestamp: number;
  type: 'reasoning' | 'planning' | 'reflection' | 'decision' | 'tool_call';
  content: string;
  confidence?: number;
  metadata?: Record<string, any>;
}

// 消息接口
export interface ReasoningMessage {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  
  // 助手消息的附加信息
  thinkingProcess?: ThinkingStep[];
  thinkingDuration?: number;
  retrievalDetails?: {
    denseCount: number;
    sparseCount: number;
    mergedCount: number;
    finalCount: number;
    totalTime: number;
  };
  orchestratorDecision?: {
    action: string;
    intent: string;
    confidence: number;
  };
  workflowInfo?: {
    totalDuration: number;
    iterations: number;
    nodeExecutions: Array<{ node: string; status: string; duration?: number }>;
  };
  config?: {
    reasoningModel: string;
    embeddingModel: string;
    topK: number;
    rerankTopK: number;
  };
  error?: string;
}

// 对话接口
export interface ReasoningConversation {
  id: string;
  title: string;
  messages: ReasoningMessage[];
  createdAt: Date;
  updatedAt: Date;
  config?: {
    reasoningModel: string;
    embeddingModel: string;
  };
}

/**
 * Reasoning RAG IndexedDB 管理器
 */
class ReasoningDBManager {
  private dbName = 'ReasoningRAGConversations';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;
  private storeName = 'conversations';

  /**
   * 初始化数据库
   */
  async init(): Promise<void> {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = (event) => {
        console.error('[ReasoningDB] 打开数据库失败:', event);
        reject(new Error('无法打开 IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[ReasoningDB] 数据库打开成功');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        console.log('[ReasoningDB] 数据库升级中...');

        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          console.log('[ReasoningDB] 创建对象存储成功');
        }
      };
    });
  }

  /**
   * 确保日期字段是 Date 对象
   */
  private normalizeConversation(conv: ReasoningConversation): ReasoningConversation {
    return {
      ...conv,
      createdAt: conv.createdAt instanceof Date ? conv.createdAt : new Date(conv.createdAt),
      updatedAt: conv.updatedAt instanceof Date ? conv.updatedAt : new Date(conv.updatedAt),
      messages: conv.messages.map(msg => ({
        ...msg,
        timestamp: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp)
      }))
    };
  }

  /**
   * 保存对话
   */
  async saveConversation(conversation: ReasoningConversation): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(conversation);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('保存对话失败'));
    });
  }

  /**
   * 获取所有对话（按更新时间排序）
   */
  async getAllConversations(): Promise<ReasoningConversation[]> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.openCursor();
      const conversations: ReasoningConversation[] = [];

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          conversations.push(this.normalizeConversation(cursor.value));
          cursor.continue();
        } else {
          // 按更新时间降序排序
          conversations.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          resolve(conversations);
        }
      };

      request.onerror = () => reject(new Error('获取对话列表失败'));
    });
  }

  /**
   * 获取单个对话
   */
  async getConversation(id: string): Promise<ReasoningConversation | null> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(id);

      request.onsuccess = () => {
        const conv = request.result;
        resolve(conv ? this.normalizeConversation(conv) : null);
      };

      request.onerror = () => reject(new Error('获取对话失败'));
    });
  }

  /**
   * 创建新对话
   */
  async createConversation(title: string, config?: ReasoningConversation['config']): Promise<ReasoningConversation> {
    if (!this.db) await this.init();

    const conversation: ReasoningConversation = {
      id: `reasoning_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      config
    };

    await this.saveConversation(conversation);
    return conversation;
  }

  /**
   * 添加消息到对话
   */
  async addMessage(conversationId: string, message: ReasoningMessage): Promise<void> {
    if (!this.db) await this.init();

    const conversation = await this.getConversation(conversationId);
    if (!conversation) {
      throw new Error('对话不存在');
    }

    conversation.messages.push({
      ...message,
      timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp)
    });
    conversation.updatedAt = new Date();

    await this.saveConversation(conversation);
  }

  /**
   * 更新消息（用于流式更新思考过程）
   */
  async updateMessage(conversationId: string, messageId: string, updates: Partial<ReasoningMessage>): Promise<void> {
    if (!this.db) await this.init();

    const conversation = await this.getConversation(conversationId);
    if (!conversation) {
      throw new Error('对话不存在');
    }

    const messageIndex = conversation.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) {
      throw new Error('消息不存在');
    }

    conversation.messages[messageIndex] = {
      ...conversation.messages[messageIndex],
      ...updates
    };
    conversation.updatedAt = new Date();

    await this.saveConversation(conversation);
  }

  /**
   * 删除对话
   */
  async deleteConversation(id: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('删除对话失败'));
    });
  }

  /**
   * 清空所有对话
   */
  async clearAll(): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('清空对话失败'));
    });
  }

  /**
   * 获取最新对话
   */
  async getLatestConversation(): Promise<ReasoningConversation | null> {
    const conversations = await this.getAllConversations();
    return conversations.length > 0 ? conversations[0] : null;
  }

  /**
   * 获取对话数量
   */
  async getConversationCount(): Promise<number> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('获取对话数量失败'));
    });
  }
}

// 导出单例
export const reasoningDB = new ReasoningDBManager();
