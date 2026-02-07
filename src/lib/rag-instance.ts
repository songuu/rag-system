/*
 * @Author: songyu
 * @Date: 2026-01-09 13:56:11
 * @LastEditTime: 2026-01-28 16:15:06
 * @LastEditor: songyu
 */
import { LocalRAGSystem } from './rag-system';

// 使用 globalThis 来确保在 Next.js 热重载时保持单例
// 这是 Next.js 推荐的方式来保持服务器端的单例
declare global {
  // eslint-disable-next-line no-var
  var ragSystemInstance: LocalRAGSystem | undefined;
  // eslint-disable-next-line no-var
  var ragSystemInitPromise: Promise<LocalRAGSystem> | undefined;
}

export async function getRagSystem(): Promise<LocalRAGSystem> {
  // 如果已经有初始化好的实例，直接返回
  if (globalThis.ragSystemInstance) {
    return globalThis.ragSystemInstance;
  }

  // 如果正在初始化，等待初始化完成
  if (globalThis.ragSystemInitPromise) {
    return globalThis.ragSystemInitPromise;
  }

  // 创建初始化 Promise 并存储到 globalThis
  globalThis.ragSystemInitPromise = (async () => {
    try {
      console.log('[RAG Instance] Creating new RAG system instance...');
      
      // 使用空配置，让 LocalRAGSystem 从环境变量自动获取配置
      // LLM 使用 MODEL_PROVIDER
      // Embedding 使用 EMBEDDING_PROVIDER (独立配置)
      const instance = new LocalRAGSystem({});

      // 初始化数据库
      await instance.initializeDatabase();
      
      // 存储实例到 globalThis
      globalThis.ragSystemInstance = instance;
      
      console.log('[RAG Instance] RAG system instance initialized successfully');
      
      return instance;
    } catch (error) {
      // 如果初始化失败，清除 Promise 以便下次重试
      globalThis.ragSystemInitPromise = undefined;
      throw error;
    }
  })();

  return globalThis.ragSystemInitPromise;
}

export function resetRagSystem() {
  console.log('[RAG Instance] Resetting RAG system instance...');
  globalThis.ragSystemInstance = undefined;
  globalThis.ragSystemInitPromise = undefined;
}

// 获取当前实例（不创建新实例）
export function getCurrentRagSystem(): LocalRAGSystem | undefined {
  return globalThis.ragSystemInstance;
}