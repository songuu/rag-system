'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { dbManager, type Conversation } from '@/lib/indexeddb';

export default function HistoryPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  useEffect(() => {
    loadConversations();
  }, []);

  const loadConversations = async () => {
    try {
      await dbManager.init();
      const convs = await dbManager.getAllConversations();
      setConversations(convs);
    } catch (error) {
      console.error('加载对话历史失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteConversation = async (id: string) => {
    if (!confirm('确定要删除这条对话记录吗？')) return;
    
    try {
      await dbManager.deleteConversation(id);
      await loadConversations();
      if (selectedConversation?.id === id) {
        setSelectedConversation(null);
      }
    } catch (error) {
      console.error('删除对话失败:', error);
      alert('删除失败');
    }
  };

  const formatDate = (date: Date) => {
    const d = new Date(date);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="typing-indicator mx-auto mb-4"></div>
          <p className="text-gray-600">加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 导航栏 */}
      <nav className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <Link href="/" className="mr-4">
                <i className="fas fa-arrow-left text-gray-600 hover:text-gray-900"></i>
              </Link>
              <i className="fas fa-history text-blue-600 text-2xl mr-3"></i>
              <h1 className="text-xl font-semibold text-gray-900">历史对话</h1>
            </div>
            <div className="flex items-center space-x-4">
              <button
                onClick={loadConversations}
                className="p-2 text-gray-400 hover:text-gray-600"
                title="刷新"
              >
                <i className="fas fa-sync-alt"></i>
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* 对话列表 */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg shadow-sm border">
              <div className="border-b px-6 py-4">
                <h2 className="text-lg font-medium text-gray-900">对话列表</h2>
                <p className="text-sm text-gray-500 mt-1">
                  {conversations.length} 条记录
                </p>
              </div>
              
              <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                {conversations.length === 0 ? (
                  <div className="p-6 text-center text-gray-500 text-sm">
                    <i className="fas fa-inbox text-2xl mb-2"></i>
                    <p>暂无历史对话</p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {conversations.map((conv) => (
                      <div
                        key={conv.id}
                        className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors group ${
                          selectedConversation?.id === conv.id ? 'bg-blue-50 border-l-4 border-blue-600' : ''
                        }`}
                        onClick={() => setSelectedConversation(conv)}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <h3 className="text-sm font-medium text-gray-900 truncate">
                              {conv.title}
                            </h3>
                            <p className="text-xs text-gray-500 mt-1">
                              {conv.messages.length} 条消息
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                              {formatDate(conv.updatedAt)}
                            </p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteConversation(conv.id);
                            }}
                            className="ml-2 p-1 text-red-600 hover:text-red-800 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <i className="fas fa-trash text-xs"></i>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 对话详情 */}
          <div className="lg:col-span-2">
            {selectedConversation ? (
              <div className="bg-white rounded-lg shadow-sm border">
                <div className="border-b px-6 py-4 flex justify-between items-center">
                  <div>
                    <h2 className="text-lg font-medium text-gray-900">
                      {selectedConversation.title}
                    </h2>
                    <p className="text-sm text-gray-500 mt-1">
                      {formatDate(selectedConversation.createdAt)}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDeleteConversation(selectedConversation.id)}
                    className="p-2 text-red-600 hover:text-red-800"
                  >
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
                
                <div className="h-[calc(100vh-300px)] overflow-y-auto p-6 space-y-4">
                  {selectedConversation.messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex chat-message ${
                        message.type === 'user' ? 'justify-end' : 'justify-start'
                      }`}
                    >
                      <div
                        className={`max-w-[80%] rounded-lg px-4 py-2 ${
                          message.type === 'user'
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-900'
                        }`}
                      >
                        <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                        <div className="flex items-center justify-between mt-2 text-xs opacity-70">
                          <span>
                            {new Date(message.timestamp).toLocaleTimeString()}
                          </span>
                          {message.traceId && (
                            <span className="ml-2 text-xs opacity-60">
                              Trace: {message.traceId.slice(0, 8)}
                            </span>
                          )}
                        </div>
                        
                        {/* 检索详情 */}
                        {message.retrievalDetails && message.type === 'assistant' && (
                          <details className="mt-2 text-xs">
                            <summary className="cursor-pointer hover:opacity-80">
                              查看检索详情 ({message.retrievalDetails.searchResults?.length || 0} 个匹配文档)
                            </summary>
                            <div className="mt-2 space-y-2 pt-2 border-t border-gray-700">
                              <div className="text-xs opacity-80">
                                <p>检索耗时: {message.retrievalDetails.searchTime}ms</p>
                                <p>总文档数: {message.retrievalDetails.totalDocuments}</p>
                                <p>相似度阈值: {message.retrievalDetails.threshold}</p>
                              </div>
                              {message.retrievalDetails.searchResults?.map((result: any, index: number) => (
                                <div key={index} className="bg-gray-200 rounded p-2 mt-2">
                                  <div className="flex justify-between items-center mb-1">
                                    <span className="font-medium">文档 {index + 1}</span>
                                    <span className="text-blue-400">
                                      相似度: {(result.similarity * 100).toFixed(2)}%
                                    </span>
                                  </div>
                                  <p className="text-xs opacity-90 line-clamp-2">
                                    {result.document?.content || ''}
                                  </p>
                                  <p className="text-xs opacity-60 mt-1">
                                    来源: {result.document?.metadata?.source || 'Unknown'}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-lg shadow-sm border p-12 text-center">
                <i className="fas fa-comments text-4xl text-gray-300 mb-4"></i>
                <p className="text-gray-500">请从左侧选择一条对话记录查看详情</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}