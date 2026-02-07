// IndexedDB 工具类，用于存储历史对话

export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  traceId?: string;
  retrievalDetails?: any;
  queryAnalysis?: any;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ConversationMessage[];
  createdAt: Date;
  updatedAt: Date;
}

class IndexedDBManager {
  private dbName = 'RAGConversations';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = (event) => {
        console.error('[IndexedDB] 打开数据库失败:', event);
        reject(new Error('无法打开 IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[IndexedDB] 数据库打开成功');
        console.log('[IndexedDB] 对象存储:', Array.from(this.db.objectStoreNames));
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        console.log('[IndexedDB] 数据库升级中...');

        // 创建对话存储对象
        if (!db.objectStoreNames.contains('conversations')) {
          console.log('[IndexedDB] 创建 conversations 对象存储');
          const conversationStore = db.createObjectStore('conversations', {
            keyPath: 'id'
          });
          conversationStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          conversationStore.createIndex('createdAt', 'createdAt', { unique: false });
        } else {
          // 如果已存在，检查索引是否存在
          const conversationStore = (event.target as IDBOpenDBRequest).transaction!.objectStore('conversations');
          if (!conversationStore.indexNames.contains('updatedAt')) {
            conversationStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          }
          if (!conversationStore.indexNames.contains('createdAt')) {
            conversationStore.createIndex('createdAt', 'createdAt', { unique: false });
          }
        }

        // 创建消息存储对象（虽然我们主要使用 conversations，但保留以备后用）
        if (!db.objectStoreNames.contains('messages')) {
          console.log('[IndexedDB] 创建 messages 对象存储');
          const messageStore = db.createObjectStore('messages', {
            keyPath: 'id'
          });
          messageStore.createIndex('conversationId', 'conversationId', { unique: false });
          messageStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['conversations'], 'readwrite');
      const store = transaction.objectStore('conversations');
      const request = store.put(conversation);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('保存对话失败'));
    });
  }

  async getAllConversations(): Promise<Conversation[]> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db!.transaction(['conversations'], 'readonly');
        const store = transaction.objectStore('conversations');
        
        console.log('[IndexedDB] getAllConversations: 开始查询');
        console.log('[IndexedDB] 对象存储名称:', store.name);
        console.log('[IndexedDB] 可用索引:', Array.from(store.indexNames));
        
        // 直接使用 openCursor 获取所有数据，然后手动排序（更可靠）
        const request = store.openCursor();
        const conversations: Conversation[] = [];

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const conv = cursor.value;
            console.log(`[IndexedDB] 读取对话: ${conv.id}, 消息数: ${conv.messages?.length || 0}`);
            
            // 确保日期字段是 Date 对象
            if (conv.createdAt && !(conv.createdAt instanceof Date)) {
              conv.createdAt = new Date(conv.createdAt);
            }
            if (conv.updatedAt && !(conv.updatedAt instanceof Date)) {
              conv.updatedAt = new Date(conv.updatedAt);
            }
            // 确保消息的时间戳是 Date 对象
            if (conv.messages && Array.isArray(conv.messages)) {
              conv.messages = conv.messages.map((msg: ConversationMessage) => ({
                ...msg,
                timestamp: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp)
              }));
            }
            conversations.push(conv);
            cursor.continue();
          } else {
            // 手动排序（按 updatedAt 降序）
            conversations.sort((a, b) => {
              const timeA = a.updatedAt instanceof Date ? a.updatedAt.getTime() : new Date(a.updatedAt).getTime();
              const timeB = b.updatedAt instanceof Date ? b.updatedAt.getTime() : new Date(b.updatedAt).getTime();
              return timeB - timeA; // 降序
            });
            console.log(`[IndexedDB] getAllConversations: 获取到 ${conversations.length} 个对话`);
            resolve(conversations);
          }
        };

        request.onerror = (event) => {
          console.error('[IndexedDB] getAllConversations 错误:', event);
          reject(new Error('获取对话列表失败'));
        };
      } catch (error) {
        console.error('[IndexedDB] getAllConversations 异常:', error);
        reject(error);
      }
    });
  }

  async getConversation(id: string): Promise<Conversation | null> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['conversations'], 'readonly');
      const store = transaction.objectStore('conversations');
      const request = store.get(id);

      request.onsuccess = () => {
        const conv = request.result;
        if (!conv) {
          resolve(null);
          return;
        }
        
        // 确保日期字段是 Date 对象
        if (conv.createdAt && !(conv.createdAt instanceof Date)) {
          conv.createdAt = new Date(conv.createdAt);
        }
        if (conv.updatedAt && !(conv.updatedAt instanceof Date)) {
          conv.updatedAt = new Date(conv.updatedAt);
        }
        // 确保消息的时间戳是 Date 对象
        if (conv.messages && Array.isArray(conv.messages)) {
          conv.messages = conv.messages.map((msg: ConversationMessage) => ({
            ...msg,
            timestamp: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp)
          }));
        }
        
        resolve(conv);
      };

      request.onerror = () => reject(new Error('获取对话失败'));
    });
  }

  async deleteConversation(id: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['conversations'], 'readwrite');
      const store = transaction.objectStore('conversations');
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('删除对话失败'));
    });
  }

  async addMessageToConversation(
    conversationId: string,
    message: ConversationMessage
  ): Promise<void> {
    if (!this.db) await this.init();

    return new Promise(async (resolve, reject) => {
      try {
        // 先获取对话
        const conversation = await this.getConversation(conversationId);
        if (!conversation) {
          reject(new Error('对话不存在'));
          return;
        }

        // 确保消息的时间戳是 Date 对象
        const messageToAdd: ConversationMessage = {
          ...message,
          timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp)
        };

        // 添加消息
        conversation.messages.push(messageToAdd);
        conversation.updatedAt = new Date();

        // 保存对话
        const transaction = this.db!.transaction(['conversations'], 'readwrite');
        const store = transaction.objectStore('conversations');
        const request = store.put(conversation);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('添加消息失败'));
      } catch (error) {
        reject(error);
      }
    });
  }

  async createNewConversation(title: string): Promise<Conversation> {
    if (!this.db) await this.init();

    const conversation: Conversation = {
      id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.saveConversation(conversation);
    return conversation;
  }

  async deleteAllConversations(): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['conversations'], 'readwrite');
      const store = transaction.objectStore('conversations');
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('删除所有对话失败'));
    });
  }

  async getLatestConversation(): Promise<Conversation | null> {
    if (!this.db) await this.init();

    try {
      const conversations = await this.getAllConversations();
      console.log(`[IndexedDB] getLatestConversation: 找到 ${conversations.length} 个对话`);
      
      if (conversations.length > 0) {
        const latest = conversations[0];
        console.log(`[IndexedDB] 最新对话 ID: ${latest.id}, 消息数: ${latest.messages?.length || 0}`);
        return latest;
      }
      
      return null;
    } catch (error) {
      console.error('[IndexedDB] getLatestConversation 错误:', error);
      throw error;
    }
  }
}

export const dbManager = new IndexedDBManager();