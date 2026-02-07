'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import TraceTrieVisualization from '@/components/TraceTrieVisualization';
import { dbManager, type ConversationMessage } from '@/lib/indexeddb';
import type {
  LogicWaterfall,
  PathToken
} from '@/lib/trace-trie';
import type {
  VectorWeightInfo,
  TokenDensityInfo,
  ModelComparison
} from '@/lib/token-analyzer';

// 用户问题接口
interface UserQuestion {
  id: string;
  content: string;
  timestamp: Date;
  conversationTitle: string;
}

export default function TraceTriePage() {
  const [inputText, setInputText] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [waterfall, setWaterfall] = useState<LogicWaterfall | undefined>();
  const [vectorWeights, setVectorWeights] = useState<VectorWeightInfo[]>([]);
  const [densityInfos, setDensityInfos] = useState<TokenDensityInfo[]>([]);
  const [modelComparisons, setModelComparisons] = useState<ModelComparison[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([
    'Xenova/bert-base-multilingual-cased'
  ]);
  const [error, setError] = useState<string | null>(null);
  
  // 历史问题相关状态
  const [userQuestions, setUserQuestions] = useState<UserQuestion[]>([]);
  const [isLoadingQuestions, setIsLoadingQuestions] = useState(false);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');

  // 可用的模型列表 - 扩展支持更多分词模型
  const availableModels = [
    // 多语言模型
    { name: 'Xenova/bert-base-multilingual-cased', label: 'BERT Multilingual', category: '多语言', description: '支持104种语言的BERT模型' },
    { name: 'Xenova/xlm-roberta-base', label: 'XLM-RoBERTa', category: '多语言', description: '跨语言预训练模型' },
    // 中文模型
    { name: 'Xenova/bge-small-zh-v1.5', label: 'BGE Small ZH', category: '中文', description: '中文嵌入模型' },
    { name: 'Xenova/text2vec-base-chinese-sentence', label: 'Text2Vec Chinese', category: '中文', description: '中文文本向量化' },
    // 英文模型
    { name: 'Xenova/all-MiniLM-L6-v2', label: 'All-MiniLM', category: '英文', description: '轻量级英文模型' },
    { name: 'Xenova/bert-base-uncased', label: 'BERT Base', category: '英文', description: '英文BERT基础模型' },
    { name: 'Xenova/distilbert-base-uncased', label: 'DistilBERT', category: '英文', description: '轻量级BERT' },
    // GPT系列
    { name: 'Xenova/gpt2', label: 'GPT-2', category: 'GPT', description: 'OpenAI GPT-2分词器' },
  ];
  
  // 按类别分组模型
  const modelCategories = availableModels.reduce((acc, model) => {
    if (!acc[model.category]) acc[model.category] = [];
    acc[model.category].push(model);
    return acc;
  }, {} as Record<string, typeof availableModels>);

  // 加载历史问题
  useEffect(() => {
    loadUserQuestions();
  }, []);

  const loadUserQuestions = async () => {
    setIsLoadingQuestions(true);
    try {
      const conversations = await dbManager.getAllConversations();
      const questions: UserQuestion[] = [];
      
      conversations.forEach(conv => {
        conv.messages
          .filter((msg: ConversationMessage) => msg.type === 'user')
          .forEach((msg: ConversationMessage) => {
            questions.push({
              id: msg.id,
              content: msg.content,
              timestamp: new Date(msg.timestamp),
              conversationTitle: conv.title
            });
          });
      });
      
      // 按时间倒序排列
      questions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      setUserQuestions(questions);
    } catch (err) {
      console.error('加载历史问题失败:', err);
    } finally {
      setIsLoadingQuestions(false);
    }
  };

  // 过滤后的问题列表
  const filteredQuestions = userQuestions.filter(q => 
    q.content.toLowerCase().includes(searchFilter.toLowerCase())
  );

  // 选择历史问题
  const handleSelectQuestion = (question: UserQuestion) => {
    setInputText(question.content);
    setSelectedQuestionId(question.id);
  };

  // 执行分析
  const handleAnalyze = async () => {
    if (!inputText.trim()) {
      setError('请输入要分析的文本');
      return;
    }

    setIsAnalyzing(true);
    setError(null);

    try {
      const response = await fetch('/api/trace-trie', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: inputText,
          modelNames: selectedModels
        })
      });

      const data = await response.json();

      if (data.success) {
        setWaterfall(data.data.waterfall);
        setVectorWeights(data.data.vectorWeights);
        setDensityInfos(data.data.densityInfos);
        setModelComparisons(data.data.modelComparisons || []);
      } else {
        setError(data.error || '分析失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '分析时发生错误');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // 处理 Token 点击
  const handleTokenClick = (token: PathToken) => {
    console.log('Token clicked:', token);
  };

  // 格式化时间
  const formatTime = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    if (days < 7) return `${days} 天前`;
    return date.toLocaleDateString('zh-CN');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
      {/* 导航栏 */}
      <nav className="bg-white/80 backdrop-blur-sm shadow-sm border-b border-slate-200/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <Link href="/" className="text-indigo-600 hover:text-indigo-700 mr-4 flex items-center gap-2 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                返回主页
              </Link>
              <div className="h-6 w-px bg-slate-200 mr-4"></div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                Trace-Trie 全路径监测系统
              </h1>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* 输入区域 - 左右分栏 */}
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200/50 p-6 mb-6">
          <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            文本来源
          </h2>
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 左侧 - 直接输入 */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center">
                  <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </div>
                <h3 className="font-semibold text-slate-700">直接输入</h3>
              </div>
              
              <textarea
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  setSelectedQuestionId(null);
                }}
                placeholder="请输入要分析的文本..."
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all resize-none bg-slate-50/50"
                rows={6}
                disabled={isAnalyzing}
              />
              
              {/* 快速示例 */}
              <div className="space-y-2">
                <p className="text-xs text-slate-500 font-medium">快速示例：</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    '深入理解神经网络的工作原理',
                    'Hello World',
                    '机器学习与深度学习的区别',
                    'Transformer architecture explained'
                  ].map((example, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setInputText(example);
                        setSelectedQuestionId(null);
                      }}
                      className="px-3 py-1.5 text-xs bg-slate-100 hover:bg-indigo-100 text-slate-600 hover:text-indigo-600 rounded-lg transition-colors"
                      disabled={isAnalyzing}
                    >
                      {example.length > 20 ? example.slice(0, 20) + '...' : example}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 右侧 - 选择历史问题 */}
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
                    <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="font-semibold text-slate-700">历史问题</h3>
                </div>
                <button
                  onClick={loadUserQuestions}
                  className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                  title="刷新列表"
                >
                  <svg className={`w-4 h-4 ${isLoadingQuestions ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </div>
              
              {/* 搜索框 */}
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder="搜索历史问题..."
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all bg-slate-50/50 text-sm"
                />
              </div>
              
              {/* 问题列表 */}
              <div className="h-48 overflow-y-auto border border-slate-200 rounded-xl bg-slate-50/30">
                {isLoadingQuestions ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="flex items-center gap-2 text-slate-400">
                      <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span className="text-sm">加载中...</span>
                    </div>
                  </div>
                ) : filteredQuestions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-slate-400">
                    <svg className="w-10 h-10 mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-sm">暂无历史问题</p>
                    <p className="text-xs mt-1">在主页提问后会显示在这里</p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {filteredQuestions.map((question) => (
                      <button
                        key={question.id}
                        onClick={() => handleSelectQuestion(question)}
                        className={`w-full px-4 py-3 text-left hover:bg-indigo-50/50 transition-colors ${
                          selectedQuestionId === question.id 
                            ? 'bg-indigo-50 border-l-2 border-indigo-500' 
                            : ''
                        }`}
                        disabled={isAnalyzing}
                      >
                        <p className={`text-sm truncate ${
                          selectedQuestionId === question.id 
                            ? 'text-indigo-700 font-medium' 
                            : 'text-slate-700'
                        }`}>
                          {question.content}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-slate-400">
                            {formatTime(question.timestamp)}
                          </span>
                          <span className="text-xs text-slate-300">•</span>
                          <span className="text-xs text-slate-400 truncate">
                            {question.conversationTitle}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              
              <p className="text-xs text-slate-400 text-center">
                共 {userQuestions.length} 条历史问题
                {searchFilter && ` · 已筛选 ${filteredQuestions.length} 条`}
              </p>
            </div>
          </div>

          {/* 模型选择和分析按钮 */}
          <div className="mt-6 pt-6 border-t border-slate-100">
            <div className="space-y-4">
              {/* 模型选择 - 按类别分组 */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-3 flex items-center gap-2">
                  <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  选择分词模型（多选用于对比分析）
                </label>
                
                <div className="space-y-4">
                  {Object.entries(modelCategories).map(([category, models]) => (
                    <div key={category} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          category === '多语言' ? 'bg-purple-100 text-purple-700' :
                          category === '中文' ? 'bg-red-100 text-red-700' :
                          category === '英文' ? 'bg-blue-100 text-blue-700' :
                          'bg-green-100 text-green-700'
                        }`}>
                          {category}
                        </span>
                        <div className="flex-1 h-px bg-slate-100"></div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {models.map((model) => (
                          <label 
                            key={model.name} 
                            className={`group relative flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all ${
                              selectedModels.includes(model.name)
                                ? 'bg-indigo-50 border-indigo-300 text-indigo-700 shadow-sm'
                                : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                            }`}
                            title={model.description}
                          >
                            <input
                              type="checkbox"
                              checked={selectedModels.includes(model.name)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedModels([...selectedModels, model.name]);
                                } else {
                                  setSelectedModels(selectedModels.filter(m => m !== model.name));
                                }
                              }}
                              className="sr-only"
                              disabled={isAnalyzing}
                            />
                            <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                              selectedModels.includes(model.name)
                                ? 'bg-indigo-500 border-indigo-500'
                                : 'border-slate-300 group-hover:border-slate-400'
                            }`}>
                              {selectedModels.includes(model.name) && (
                                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                            <span className="text-sm font-medium">{model.label}</span>
                            {/* Tooltip */}
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                              {model.description}
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                
                {/* 已选模型数量提示 */}
                <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                  <span>已选择 {selectedModels.length} 个模型</span>
                  {selectedModels.length > 1 && (
                    <span className="text-indigo-600">
                      ✓ 将进行多模型对比分析
                    </span>
                  )}
                </div>
              </div>
              
              {/* 分析按钮 */}
              <button
                onClick={handleAnalyze}
                disabled={isAnalyzing || !inputText.trim()}
                className="px-8 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl font-medium hover:from-indigo-700 hover:to-purple-700 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-indigo-200 flex items-center gap-2"
              >
                {isAnalyzing ? (
                  <>
                    <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    分析中...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    开始分析
                  </>
                )}
              </button>
            </div>

            {/* 当前分析文本预览 */}
            {inputText && (
              <div className="mt-4 p-3 bg-slate-50 rounded-xl">
                <p className="text-xs text-slate-500 mb-1">当前分析文本：</p>
                <p className="text-sm text-slate-700 line-clamp-2">{inputText}</p>
              </div>
            )}

            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
                <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}
          </div>
        </div>

        {/* 可视化区域 */}
        {waterfall && (
          <TraceTrieVisualization
            text={inputText}
            waterfall={waterfall}
            vectorWeights={vectorWeights}
            densityInfos={densityInfos}
            modelComparisons={modelComparisons}
            onTokenClick={handleTokenClick}
          />
        )}

        {/* 说明文档 */}
        {!waterfall && (
          <div className="bg-white rounded-2xl shadow-lg border border-slate-200/50 p-6">
            <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              系统说明
            </h2>
            <div className="prose max-w-none text-sm text-slate-600 space-y-6">
              <div className="p-4 bg-indigo-50/50 rounded-xl border border-indigo-100">
                <h3 className="font-semibold text-indigo-900 mb-2 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-indigo-200 text-indigo-700 flex items-center justify-center text-xs font-bold">1</span>
                  系统架构：基于 Trace-Trie 的全路径监测
                </h3>
                <p className="text-slate-600 mb-2">传统的 BPE 分词是"黑盒"合并，本系统将其改造为"透明"决策。</p>
                <ul className="list-disc pl-6 space-y-1 text-slate-600">
                  <li><strong className="text-slate-700">增强型 Trie 树结构</strong>：每个节点承载决策元数据（TokenID、MergeRank、频率）</li>
                  <li><strong className="text-slate-700">Trace 锚点</strong>：在 Trie 树的每个"分叉路口"和"终止点"记录当前状态</li>
                  <li><strong className="text-slate-700">逻辑瀑布流</strong>：展示从 Raw Bytes → Characters → Subwords → Full Words 的完整塌缩过程</li>
                </ul>
              </div>

              <div className="p-4 bg-purple-50/50 rounded-xl border border-purple-100">
                <h3 className="font-semibold text-purple-900 mb-2 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-purple-200 text-purple-700 flex items-center justify-center text-xs font-bold">2</span>
                  核心维度设计
                </h3>
                <ul className="list-disc pl-6 space-y-1 text-slate-600">
                  <li><strong className="text-slate-700">向量加权可视化</strong>：衡量词元对模型的语义贡献度，通过向量模长分析</li>
                  <li><strong className="text-slate-700">词元密度热力图</strong>：衡量编码效率与语言适应性，高密度区代表知识压缩率高</li>
                  <li><strong className="text-slate-700">多模型对比</strong>：A/B 测试不同模型的分词效能</li>
                </ul>
              </div>

              <div className="p-4 bg-emerald-50/50 rounded-xl border border-emerald-100">
                <h3 className="font-semibold text-emerald-900 mb-2 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-emerald-200 text-emerald-700 flex items-center justify-center text-xs font-bold">3</span>
                  交互功能
                </h3>
                <ul className="list-disc pl-6 space-y-1 text-slate-600">
                  <li><strong className="text-slate-700">瀑布流视图</strong>：展示文本被逐层剥离、合并的动态过程</li>
                  <li><strong className="text-slate-700">热力对比带</strong>：并排展示多个模型的分词结果，背景色深浅代表密度</li>
                  <li><strong className="text-slate-700">分布象限图</strong>：横轴为 Token 频率，纵轴为向量权重，分析模型对高频词的权重分配</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
