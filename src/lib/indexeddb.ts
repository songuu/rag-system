// IndexedDB 工具类，用于存储历史对话
import type { AnswerProcessingDetails } from '@/lib/rag/answer-processing';
import type { RagCitations, RagCitationItem } from '@/lib/rag/citations/types';

export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  traceId?: string;
  storageBackend?: 'memory' | 'milvus';
  retrievalDetails?: any;
  queryAnalysis?: any;
  processingDetails?: AnswerProcessingDetails;
  citations?: RagCitations;
}

/** Store reference handles only; cached source text cannot authorize a later preview. */
export function projectMessageCitations(
  value: unknown,
  currentPartition?: string | null,
  now: number | null = null
): RagCitations | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.version !== 'rag-citations/v1'
    || !['available', 'missing', 'unavailable'].includes(String(input.status))
    || typeof input.partition !== 'string' || !/^[a-f0-9]{64}$/.test(input.partition)
    || (currentPartition != null && input.partition !== currentPartition)
    || !Array.isArray(input.items) || input.items.length > 256) return undefined;
  if (!input.diagnostics || typeof input.diagnostics !== 'object') return undefined;
  const diagnostics = input.diagnostics as Record<string, unknown>;
  if (!['ready', 'no-numbered-citations', 'configuration-unavailable', 'sources-unavailable'].includes(String(diagnostics.reason))
    || !['citationCount', 'invalidCitationCount', 'unavailableCitationCount'].every(key =>
      Number.isSafeInteger(diagnostics[key]) && (diagnostics[key] as number) >= 0)) return undefined;
  const items: RagCitationItem[] = [];
  const seen = new Set<number>();
  for (const raw of input.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(item.number) || (item.number as number) < 1
      || (item.number as number) > 1000 || typeof item.locator !== 'string'
      || !item.locator || item.locator.length > 16_384 || /\s/.test(item.locator)
      || typeof item.expiresAt !== 'number' || !Number.isFinite(item.expiresAt)
      || (now !== null && item.expiresAt <= now)) continue;
    const number = item.number as number;
    if (seen.has(number)) return undefined;
    seen.add(number);
    items.push({
      number, locator: item.locator, expiresAt: item.expiresAt,
      ...(Number.isSafeInteger(item.page) && (item.page as number) > 0 ? { page: item.page as number } : {}),
    });
  }
  return {
    version: 'rag-citations/v1', status: input.status as RagCitations['status'],
    partition: input.partition, items,
    diagnostics: {
      reason: diagnostics.reason as RagCitations['diagnostics']['reason'],
      citationCount: diagnostics.citationCount as number,
      invalidCitationCount: diagnostics.invalidCitationCount as number,
      unavailableCitationCount: diagnostics.unavailableCitationCount as number,
    },
  };
}

function projectStoredMessage(
  message: ConversationMessage,
  partition?: string,
  now: number | null = null
): ConversationMessage {
  const projected = { ...message };
  delete projected.citations;
  const citations = projectMessageCitations(message.citations, partition, now);
  if (citations) projected.citations = citations;
  return projected;
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
  private citationClockOffsetMs: number | null = null;
  private citationPartition: string | null | undefined;
  private citationGeneration = 0;
  private readonly citationSnapshotGenerations = new WeakMap<object, number>();
  private citationClearRequired = false;
  private citationClearTask: Promise<void> | null = null;

  captureCitationWriteGeneration(): number { return this.citationGeneration; }

  setCitationIdentity(partition: string | null): void {
    if (partition !== null && !/^[a-f0-9]{64}$/.test(partition)) throw new Error('引用身份分区无效。');
    if (partition !== null && (this.citationClearRequired || this.citationClearTask)) {
      throw new Error('历史引用清理尚未完成，不能启用新身份。');
    }
    if (partition !== this.citationPartition && (this.citationPartition !== undefined || partition === null)) this.citationGeneration++;
    this.citationPartition = partition;
  }

  invalidateCitationReferences(): Promise<void> {
    this.setCitationIdentity(null);
    this.citationClearRequired = true;
    return this.waitForCitationClear();
  }

  /** A required clear survives HTTP cancellation and must finish before a new identity is enabled. */
  waitForCitationClear(): Promise<void> {
    if (this.citationClearTask) return this.citationClearTask;
    if (!this.citationClearRequired) return Promise.resolve();
    const task = (async () => {
      await this.init();
      await this.pruneConversationCitations(null, null);
    })();
    this.citationClearTask = task;
    void task.then(() => {
      if (this.citationClearTask === task) { this.citationClearRequired = false; this.citationClearTask = null; }
    }, () => {
      // Keep the obligation on failure; the next identity refresh retries it.
      if (this.citationClearTask === task) this.citationClearTask = null;
    });
    return task;
  }

  private projectCitationWrite(message: ConversationMessage, generation: number): ConversationMessage {
    const projected = projectStoredMessage(message, this.citationPartition ?? undefined, this.citationNow());
    const snapshotGeneration = this.citationSnapshotGenerations.get(message);
    if (this.citationPartition === null || generation !== this.citationGeneration
      || (snapshotGeneration !== undefined && snapshotGeneration !== this.citationGeneration)) delete projected.citations;
    return projected;
  }

  private projectCitationRead(message: ConversationMessage, generation: number): ConversationMessage {
    const projected = this.projectCitationWrite(message, generation);
    this.citationSnapshotGenerations.set(projected, generation);
    return projected;
  }

  setCitationClockOffset(offsetMs: number | null): void {
    if (offsetMs !== null && !Number.isFinite(offsetMs)) {
      throw new Error('引用服务器时钟偏差无效。');
    }
    this.citationClockOffsetMs = offsetMs;
  }

  private citationNow(): number | null {
    return this.citationClockOffsetMs === null ? null : Date.now() - this.citationClockOffsetMs;
  }

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

  async saveConversation(conversation: Conversation, expectedCitationGeneration = this.citationGeneration): Promise<void> {
    const generation = this.citationSnapshotGenerations.get(conversation) ?? expectedCitationGeneration;
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['conversations'], 'readwrite');
      const store = transaction.objectStore('conversations');
      const request = store.put({
        ...conversation,
        messages: conversation.messages.map(message => this.projectCitationWrite(message, generation)),
      });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('保存对话失败'));
    });
  }

  async getAllConversations(): Promise<Conversation[]> {
    const generation = this.citationGeneration;
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
              conv.messages = conv.messages.map((msg: ConversationMessage) => {
                const projected = this.projectCitationRead(msg, generation);
                projected.timestamp = msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp);
                return projected;
              });
            }
            this.citationSnapshotGenerations.set(conv, generation);
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
    const generation = this.citationGeneration;
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
          conv.messages = conv.messages.map((msg: ConversationMessage) => {
            const projected = this.projectCitationRead(msg, generation);
            projected.timestamp = msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp);
            return projected;
          });
        }
        
        this.citationSnapshotGenerations.set(conv, generation);
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
    message: ConversationMessage,
    expectedCitationGeneration = this.citationGeneration
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
        this.citationSnapshotGenerations.set(messageToAdd,
          this.citationSnapshotGenerations.get(message) ?? expectedCitationGeneration);

        // 添加消息
        conversation.messages.push(messageToAdd);
        conversation.updatedAt = new Date();

        // 保存对话
        const transaction = this.db!.transaction(['conversations'], 'readwrite');
        const store = transaction.objectStore('conversations');
        const request = store.put({
          ...conversation,
          messages: conversation.messages.map(entry => this.projectCitationWrite(entry, expectedCitationGeneration)),
        });

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

  /** Remove stale account/scope handles without discarding the user's conversation. */
  async pruneConversationCitations(partition: string | null, now: number | null = this.citationNow()): Promise<void> {
    if ((partition !== null && !/^[a-f0-9]{64}$/.test(partition)) || (now !== null && !Number.isFinite(now))) {
      throw new Error('引用身份校验结果无效，无法清理历史引用。');
    }
    if (partition === null) this.setCitationIdentity(null);
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['conversations'], 'readwrite');
      const request = transaction.objectStore('conversations').openCursor();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('清理历史引用失败。'));
      transaction.onabort = () => reject(new Error('清理历史引用事务已中止。'));
      request.onsuccess = event => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (!cursor) return;
        const conversation = cursor.value as Conversation;
        if (Array.isArray(conversation.messages)) {
          let changed = false;
          const messages = conversation.messages.map(message => {
            if (!message.citations) return message;
            const projected = partition === null ? { ...message } : projectStoredMessage(message, partition, now);
            if (partition === null) delete projected.citations;
            if (JSON.stringify(projected.citations) !== JSON.stringify(message.citations)) changed = true;
            return projected;
          });
          if (changed) cursor.update({ ...conversation, messages });
        }
        cursor.continue();
      };
    });
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
