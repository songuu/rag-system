'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import ReasoningRAGVisualizer from '@/components/ReasoningRAGVisualizer';
import ThinkingProcessCollapsible from '@/components/ThinkingProcessCollapsible';
import ReasoningFileManager from '@/components/ReasoningFileManager';
import { reasoningDB, type ReasoningConversation, type ReasoningMessage, type ThinkingStep } from '@/lib/reasoning-indexeddb';

// ==================== 常量定义 ====================

/** 车道名称映射 */
const LANE_NAMES: Record<number, string> = {
  1: '极速车道',
  2: '标准车道',
  3: '推理车道',
};

/** 车道颜色映射 */
const LANE_COLORS: Record<number, { bg: string; text: string; border: string; dot: string }> = {
  1: { bg: 'bg-green-900/30', text: 'text-green-300', border: 'border-green-500/30', dot: 'bg-green-500' },
  2: { bg: 'bg-blue-900/30', text: 'text-blue-300', border: 'border-blue-500/30', dot: 'bg-blue-500' },
  3: { bg: 'bg-purple-900/30', text: 'text-purple-300', border: 'border-purple-500/30', dot: 'bg-purple-500' },
};

/** 获取车道名称 */
const getLaneName = (lane: number): string => LANE_NAMES[lane] || '未知车道';

/** 获取车道颜色配置 */
const getLaneColors = (lane: number) => LANE_COLORS[lane] || LANE_COLORS[3];

// ==================== 类型定义 ====================

/** 检索结果项 */
interface RetrievalResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/** 意图分类结果 */
interface IntentClassification {
  intent: string;
  confidence: number;
  reasoning: string;
  suggestedLane: number;
  estimatedTime?: string;
}

interface ReasoningRAGResponse {
  query: string;
  answer: string;
  thinkingProcess: ThinkingStep[];
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
  }>;
  retrieval?: {
    denseResults: RetrievalResult[];
    sparseResults: RetrievalResult[];
    mergedResults: RetrievalResult[];
    rerankedResults: RetrievalResult[];
    statistics: {
      denseCount: number;
      sparseCount: number;
      mergedCount: number;
      finalCount: number;
      denseTime: number;
      sparseTime: number;
      rerankTime: number;
      totalTime: number;
    };
  };
  orchestratorDecision?: {
    action: 'tool_call' | 'generate' | 'clarify';
    intent: string;
    confidence: number;
    reasoning: string;
  };
  workflow: {
    totalDuration: number;
    iterations: number;
    decisionPath: string[];
    nodeExecutions: Array<{
      node: string;
      status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
      duration?: number;
    }>;
  };
  config: {
    reasoningModel: string;
    embeddingModel: string;
    topK: number;
    rerankTopK: number;
    enableBM25: boolean;
    enableRerank: boolean;
  };
  error?: string;
}

interface RoutingInfo {
  lane: 1 | 2 | 3;
  laneName: string;
  intent: string;
  confidence: number;
  reasoning: string;
  estimatedTime: string;
}

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  response?: ReasoningRAGResponse;
  thinkingProcess?: ThinkingStep[];
  thinkingDuration?: number;
  routing?: RoutingInfo;
}

interface ModelInfo {
  id: string;
  name: string;
  displayName?: string;
  description: string;
  supportsThinking: boolean;
  installed: boolean;
  size?: number;
  sizeFormatted?: string;
  modifiedAt?: string;
  dimension?: number;
}

interface Config {
  fastModel: string;       // Lane 1 & 2 快速模型
  reasoningModel: string;  // Lane 3 推理模型
  embeddingModel: string;
  topK: number;
  rerankTopK: number;
  similarityThreshold: number;
  enableBM25: boolean;
  enableRerank: boolean;
  temperature: number;
  thinkingTimeout: number; // 思考超时（秒）
  enableRouting: boolean;  // 启用意图路由
  routerModel: string;     // 路由模型
}

/** 默认配置 */
const DEFAULT_CONFIG: Config = {
  fastModel: 'qwen2.5:0.5b',
  reasoningModel: 'deepseek-r1:7b',
  embeddingModel: 'nomic-embed-text',
  topK: 50,
  rerankTopK: 5,
  similarityThreshold: 0.3,
  enableBM25: true,
  enableRerank: true,
  temperature: 0.7,
  thinkingTimeout: 120,
  enableRouting: true,
  routerModel: 'llama3.2:1b',
};

// ==================== 配置面板组件 ====================

const ConfigPanel: React.FC<{
  config: Config;
  onChange: (config: Config) => void;
  availableModels: ModelInfo[];
  llmModels: ModelInfo[];
  embeddingModels: ModelInfo[];
  embeddingProvider?: string;
  isRemoteEmbedding?: boolean;
  reasoningProvider?: string;
  isRemoteReasoning?: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  errorMessage?: string | null;
  suggestion?: string | null;
  onRefresh?: () => void;
}> = ({ config, onChange, availableModels, llmModels, embeddingModels, embeddingProvider = 'ollama', isRemoteEmbedding = false, reasoningProvider = 'ollama', isRemoteReasoning = false, isExpanded, onToggle, errorMessage, suggestion, onRefresh }) => {
  
  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-purple-500/30 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between bg-gradient-to-r from-purple-900/50 to-indigo-900/50 hover:from-purple-900/70 hover:to-indigo-900/70 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">⚙️</span>
          <span className="font-semibold text-white">推理配置</span>
          {availableModels.length > 0 && (
            <span className="px-2 py-0.5 bg-green-500/30 text-green-300 text-xs rounded-full">
              {availableModels.length} 个模型
            </span>
          )}
        </div>
        <svg
          className={`w-5 h-5 text-purple-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      
      {isExpanded && (
        <div className="p-4 space-y-4">
          {/* 推理模型选择 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-purple-300">
                🧠 推理模型 {isRemoteReasoning ? `(${reasoningProvider})` : '(本地已安装)'}
              </label>
              {onRefresh && (
                <button
                  onClick={onRefresh}
                  className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  刷新
                </button>
              )}
            </div>
            
            {/* 远程推理模型提供商 - 显示环境变量配置的模型 */}
            {isRemoteReasoning ? (
              <div className="p-3 bg-purple-900/30 border border-purple-500/30 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-white font-medium">{config.reasoningModel}</div>
                    <div className="text-xs text-gray-400 mt-1">
                      通过环境变量配置 | {reasoningProvider}
                    </div>
                  </div>
                  <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <title>通过环境变量配置</title>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
              </div>
            ) : availableModels.length === 0 ? (
              /* 无推理模型时显示提示 */
              <div className="p-3 bg-amber-900/30 border border-amber-500/30 rounded-lg">
                <div className="flex items-center gap-2 text-amber-300 mb-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span className="text-sm font-medium">{errorMessage || '未检测到推理模型'}</span>
                </div>
                {suggestion && (
                  <div className="mt-2">
                    <p className="text-xs text-gray-400 mb-1">安装推理模型：</p>
                    <code className="block text-xs bg-slate-800 text-green-300 px-2 py-1 rounded">
                      {suggestion}
                    </code>
                  </div>
                )}
                <div className="mt-2 text-xs text-gray-500">
                  支持的推理模型：deepseek-r1、qwen3，或配置 REASONING_PROVIDER 使用远程模型
                </div>
              </div>
            ) : (
              <>
                <select
                  value={config.reasoningModel}
                  onChange={e => onChange({ ...config, reasoningModel: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                >
                  {availableModels.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name} {model.supportsThinking ? '🧠' : ''} {model.sizeFormatted ? `(${model.sizeFormatted})` : ''}
                    </option>
                  ))}
                </select>
                {(() => {
                  const selectedModel = availableModels.find(m => m.id === config.reasoningModel);
                  return selectedModel ? (
                    <div className="mt-1 flex items-center justify-between">
                      <p className="text-xs text-gray-500">
                        {selectedModel.description}
                      </p>
                      {selectedModel.sizeFormatted && (
                        <span className="text-xs text-purple-400">{selectedModel.sizeFormatted}</span>
                      )}
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">选择推理模型</p>
                  );
                })()}
              </>
            )}
          </div>
          
          {/* 向量模型选择 */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <label className="text-sm font-medium text-emerald-300">
                🔮 向量模型
              </label>
              {/* 提供商徽章 */}
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                embeddingProvider === 'ollama' ? 'bg-gray-500/30 text-gray-300' :
                embeddingProvider === 'siliconflow' ? 'bg-purple-500/30 text-purple-300' :
                embeddingProvider === 'openai' ? 'bg-green-500/30 text-green-300' :
                'bg-orange-500/30 text-orange-300'
              }`}>
                {embeddingProvider === 'ollama' ? 'Ollama' :
                 embeddingProvider === 'siliconflow' ? 'SiliconFlow' :
                 embeddingProvider === 'openai' ? 'OpenAI' :
                 embeddingProvider}
              </span>
            </div>
            {isRemoteEmbedding ? (
              /* 远程提供商：显示只读配置信息 */
              <div className="p-3 bg-slate-800/50 border border-emerald-500/30 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-white font-medium">{config.embeddingModel}</div>
                    <div className="text-xs text-gray-400 mt-1">
                      通过环境变量配置 | {embeddingModels[0]?.dimension ? `${embeddingModels[0].dimension}D` : ''}
                    </div>
                  </div>
                  <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <title>通过环境变量配置</title>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
              </div>
            ) : embeddingModels.length === 0 ? (
              <div className="p-2 bg-amber-900/20 border border-amber-500/20 rounded-lg text-xs text-amber-300">
                未检测到向量模型，请安装: ollama pull nomic-embed-text
              </div>
            ) : (
              <select
                value={config.embeddingModel}
                onChange={e => onChange({ ...config, embeddingModel: e.target.value })}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              >
                {embeddingModels.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.displayName || model.name} {model.dimension ? `(${model.dimension}D)` : ''} {model.sizeFormatted ? `- ${model.sizeFormatted}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          
          {/* 超时配置 */}
          <div>
            <label className="block text-sm font-medium text-rose-300 mb-2">
              ⏱️ 思考超时: {config.thinkingTimeout}秒
            </label>
            <input
              type="range"
              value={config.thinkingTimeout}
              onChange={e => onChange({ ...config, thinkingTimeout: parseInt(e.target.value) })}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer"
              min={30}
              max={300}
              step={10}
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>30秒</span>
              <span>300秒</span>
            </div>
          </div>
          
          {/* 检索配置 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-cyan-300 mb-2">
                🔍 初始检索数
              </label>
              <input
                type="number"
                value={config.topK}
                onChange={e => onChange({ ...config, topK: parseInt(e.target.value) || 50 })}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:ring-2 focus:ring-cyan-500"
                min={10}
                max={100}
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-cyan-300 mb-2">
                📊 重排后保留
              </label>
              <input
                type="number"
                value={config.rerankTopK}
                onChange={e => onChange({ ...config, rerankTopK: parseInt(e.target.value) || 5 })}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:ring-2 focus:ring-cyan-500"
                min={1}
                max={20}
              />
            </div>
          </div>
          
          {/* 开关选项 */}
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.enableBM25}
                onChange={e => onChange({ ...config, enableBM25: e.target.checked })}
                className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-green-500 focus:ring-green-500"
              />
              <span className="text-sm text-green-300">启用 BM25 稀疏检索</span>
            </label>
            
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.enableRerank}
                onChange={e => onChange({ ...config, enableRerank: e.target.checked })}
                className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-blue-500 focus:ring-blue-500"
              />
              <span className="text-sm text-blue-300">启用 LLM 重排序</span>
            </label>
          </div>
          
          {/* 温度 */}
          <div>
            <label className="block text-sm font-medium text-amber-300 mb-2">
              🌡️ 生成温度: {config.temperature}
            </label>
            <input
              type="range"
              value={config.temperature}
              onChange={e => onChange({ ...config, temperature: parseFloat(e.target.value) })}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer"
              min={0}
              max={1}
              step={0.1}
            />
          </div>
          
          {/* 意图路由配置 */}
          <div className="border-t border-slate-700 pt-4 mt-4">
            <h5 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
              🛤️ 意图路由
            </h5>
            
            <label className="flex items-center gap-2 cursor-pointer mb-3">
              <input
                type="checkbox"
                checked={config.enableRouting}
                onChange={e => onChange({ ...config, enableRouting: e.target.checked })}
                className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-purple-500 focus:ring-purple-500"
              />
              <span className="text-sm text-purple-300">启用智能意图路由</span>
            </label>
            
            {config.enableRouting && (
              <div className="space-y-3 pl-6">
                <div className="text-xs text-gray-500 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <span>Lane 1: 极速车道 (闲聊) - &lt; 1秒</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-500" />
                    <span>Lane 2: 标准车道 (RAG) - 3-5秒</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-purple-500" />
                    <span>Lane 3: 推理车道 (Agent) - 15-60秒</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ==================== 架构说明组件 ====================

const ArchitectureInfo: React.FC = () => (
  <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-indigo-500/30 p-4">
    <h4 className="font-semibold text-white mb-3 flex items-center gap-2">
      🏗️ 系统架构
    </h4>
    
    {/* 三层架构 */}
    <div className="space-y-3">
      {/* Graph State */}
      <div className="p-3 bg-purple-900/30 rounded-lg border border-purple-500/20">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-6 h-6 rounded bg-purple-500 flex items-center justify-center text-xs text-white">1</span>
          <span className="font-medium text-purple-300">Graph State</span>
        </div>
        <p className="text-xs text-gray-400">
          精细化状态管理：Messages (对话历史) + Scratchpad (思维链)
        </p>
      </div>
      
      {/* Cognitive Layer */}
      <div className="p-3 bg-amber-900/30 rounded-lg border border-amber-500/20">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-6 h-6 rounded bg-amber-500 flex items-center justify-center text-xs text-white">2</span>
          <span className="font-medium text-amber-300">Cognitive Layer</span>
        </div>
        <p className="text-xs text-gray-400">
          编排器 (Orchestrator)：意图识别 → 工具调用 / 直接生成
        </p>
      </div>
      
      {/* Tool Execution Layer */}
      <div className="p-3 bg-cyan-900/30 rounded-lg border border-cyan-500/20">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-6 h-6 rounded bg-cyan-500 flex items-center justify-center text-xs text-white">3</span>
          <span className="font-medium text-cyan-300">Tool Execution Layer</span>
        </div>
        <div className="text-xs text-gray-400 space-y-1">
          <p>• <strong className="text-cyan-400">Gateway</strong>: 参数验证 + 安全检查</p>
          <p>• <strong className="text-blue-400">Hybrid Retrieval</strong>: Dense + BM25</p>
          <p>• <strong className="text-pink-400">Reranker</strong>: LLM 深度重排序</p>
          <p>• <strong className="text-green-400">Formatter</strong>: XML 格式化</p>
        </div>
      </div>
    </div>
    
    {/* 流程图 */}
    <div className="mt-4 p-3 bg-slate-800/50 rounded-lg">
      <div className="text-xs text-gray-500 mb-2">执行流程</div>
      <div className="flex items-center justify-center gap-1 text-xs flex-wrap">
        <span className="px-2 py-1 bg-purple-500/30 text-purple-300 rounded">Query</span>
        <span className="text-gray-600">→</span>
        <span className="px-2 py-1 bg-amber-500/30 text-amber-300 rounded">Orchestrator</span>
        <span className="text-gray-600">→</span>
        <span className="px-2 py-1 bg-slate-700 text-gray-300 rounded">Gateway</span>
        <span className="text-gray-600">→</span>
        <span className="px-2 py-1 bg-cyan-500/30 text-cyan-300 rounded">Hybrid Search</span>
        <span className="text-gray-600">→</span>
        <span className="px-2 py-1 bg-blue-500/30 text-blue-300 rounded">Rerank</span>
        <span className="text-gray-600">→</span>
        <span className="px-2 py-1 bg-green-500/30 text-green-300 rounded">Format</span>
        <span className="text-gray-600">→</span>
        <span className="px-2 py-1 bg-pink-500/30 text-pink-300 rounded">Generate</span>
      </div>
    </div>
  </div>
);

// ==================== 主页面组件 ====================

export default function ReasoningRAGPage() {
  // 状态管理
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentResponse, setCurrentResponse] = useState<ReasoningRAGResponse | null>(null);
  const [configExpanded, setConfigExpanded] = useState(true);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [llmModels, setLlmModels] = useState<ModelInfo[]>([]);  // 快速模型列表
  const [embeddingModels, setEmbeddingModels] = useState<ModelInfo[]>([]);
  
  // 模型提供商配置
  const [embeddingProvider, setEmbeddingProvider] = useState<string>('ollama');
  const [reasoningProvider, setReasoningProvider] = useState<string>('ollama');
  const isRemoteEmbedding = embeddingProvider !== 'ollama';
  const isRemoteReasoning = reasoningProvider !== 'ollama';
  
  // 历史记录状态
  const [conversations, setConversations] = useState<ReasoningConversation[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  
  // 流式思考过程
  const [streamingThinking, setStreamingThinking] = useState<ThinkingStep[]>([]);
  const [streamingAnswer, setStreamingAnswer] = useState('');
  
  // 路由状态
  const [routingStatus, setRoutingStatus] = useState<{
    isRouting: boolean;
    currentLane?: number;
    laneName?: string;
    classification?: IntentClassification;
  }>({ isRouting: false });
  
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // 模型加载状态
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [modelSuggestion, setModelSuggestion] = useState<string | null>(null);
  
  // 知识库状态
  const [knowledgeBaseReady, setKnowledgeBaseReady] = useState(false);
  const [vectorCount, setVectorCount] = useState(0);
  
  // 知识库状态变化回调
  const handleKnowledgeBaseStatus = useCallback((isReady: boolean, docCount: number) => {
    setKnowledgeBaseReady(isReady);
    setVectorCount(docCount);
  }, []);
  
  // 加载历史记录
  const loadHistory = useCallback(async () => {
    try {
      const convs = await reasoningDB.getAllConversations();
      setConversations(convs);
      console.log('[History] 加载了', convs.length, '个历史对话');
    } catch (error) {
      console.error('[History] 加载历史记录失败:', error);
    }
  }, []);
  
  // 加载可用模型（使用统一的 API，自动处理远程/本地提供商）
  const loadModels = useCallback(async () => {
    try {
      setModelLoadError(null);
      setModelSuggestion(null);
      
      // 使用统一的模型 API，自动处理所有提供商
      const ollamaRes = await fetch('/api/ollama/models');
      const ollamaData = await ollamaRes.json();
      
      // 从 providerConfig 获取提供商配置
      if (ollamaData.providerConfig) {
        const { embedding, reasoning } = ollamaData.providerConfig;
        
        // 设置 Embedding 提供商
        if (embedding) {
          setEmbeddingProvider(embedding.provider || 'ollama');
        }
        
        // 设置推理模型提供商
        if (reasoning) {
          setReasoningProvider(reasoning.provider || 'ollama');
        }
      }
      
      // 处理推理模型
      const reasoningModels = ollamaData.reasoningModels || [];
      if (reasoningModels.length > 0) {
        setAvailableModels(reasoningModels.map((m: { name: string; displayName?: string; sizeFormatted?: string; supportsThinking?: boolean; isRemote?: boolean; provider?: string }) => ({
          id: m.name,
          name: m.name,
          displayName: m.displayName || m.name.split(':')[0],
          sizeFormatted: m.sizeFormatted,
          installed: true,
          supportsThinking: m.supportsThinking || true,
          isRemote: m.isRemote || false,
          provider: m.provider
        })));
        
        // 如果当前配置的模型不在列表中，选择第一个
        const currentExists = reasoningModels.find((m: { name: string }) => m.name === config.reasoningModel);
        if (!currentExists) {
          setConfig(prev => ({ ...prev, reasoningModel: reasoningModels[0].name }));
        }
      } else {
        setModelLoadError(ollamaData.message || '未检测到推理模型');
        setModelSuggestion(ollamaData.suggestion || '请安装推理模型或配置远程提供商');
      }
      
      // 处理 Embedding 模型
      const embedModels = ollamaData.embeddingModels || [];
      if (embedModels.length > 0) {
        setEmbeddingModels(embedModels.map((m: { name: string; displayName?: string; sizeFormatted?: string; dimension?: number; isRemote?: boolean; provider?: string }) => ({
          id: m.name,
          name: m.name,
          displayName: m.displayName || m.name.split('/').pop() || m.name,
          sizeFormatted: m.sizeFormatted,
          dimension: m.dimension,
          isRemote: m.isRemote || false,
          provider: m.provider
        })));
        
        // 如果当前配置的模型不在列表中，选择第一个
        const currentExists = embedModels.find((m: { name: string }) => m.name === config.embeddingModel);
        if (!currentExists) {
          setConfig(prev => ({ ...prev, embeddingModel: embedModels[0].name }));
        }
      }
      
      // 处理 LLM 模型 (快速模型)
      const llmModelsList = ollamaData.llmModels || [];
      if (llmModelsList.length > 0) {
        const fastModels = llmModelsList.map((m: { name: string; displayName?: string; sizeFormatted?: string; isRemote?: boolean; provider?: string }) => ({
          id: m.name,
          name: m.name,
          displayName: m.displayName || m.name.split(':')[0],
          description: '通用 LLM 模型',
          sizeFormatted: m.sizeFormatted,
          installed: true,
          supportsThinking: false,
          isRemote: m.isRemote || false,
          provider: m.provider
        }));
        setLlmModels(fastModels);
        
        // 如果当前选中的快速模型不在列表中，选择第一个
        const currentExists = fastModels.find((m: ModelInfo) => m.id === config.fastModel);
        if (!currentExists && fastModels.length > 0) {
          setConfig(prev => ({ ...prev, fastModel: fastModels[0].id }));
        }
      }
      
    } catch (error) {
      console.error('Failed to load models:', error);
      setModelLoadError('无法连接到服务');
      setModelSuggestion('请检查网络连接或服务配置');
    }
  }, [config.reasoningModel, config.embeddingModel, config.fastModel]);
  
  // 初始化加载
  useEffect(() => {
    loadModels();
    loadHistory();
  }, [loadModels, loadHistory]);
  
  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingAnswer, streamingThinking]);
  
  // 组件卸载时取消正在进行的请求
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);
  
  // 保存消息到 IndexedDB
  const saveMessage = useCallback(async (message: ReasoningMessage) => {
    try {
      let convId = currentConversationId;
      
      if (!convId) {
        // 创建新对话
        const conv = await reasoningDB.createConversation(
          message.content.substring(0, 50) + (message.content.length > 50 ? '...' : ''),
          { reasoningModel: config.reasoningModel, embeddingModel: config.embeddingModel }
        );
        convId = conv.id;
        setCurrentConversationId(convId);
      }
      
      await reasoningDB.addMessage(convId, message);
      await loadHistory(); // 刷新历史列表
    } catch (error) {
      console.error('[History] 保存消息失败:', error);
    }
  }, [currentConversationId, config.reasoningModel, config.embeddingModel, loadHistory]);
  
  // 发送消息 - 使用流式 API
  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    
    const trimmedInput = input.trim();
    if (!trimmedInput || isLoading) return;
    
    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      content: trimmedInput,
      timestamp: new Date()
    };
    
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setCurrentResponse(null);
    setStreamingThinking([]);
    setStreamingAnswer('');
    setRoutingStatus({ isRouting: true });
    
    // 保存用户消息
    await saveMessage({
      id: userMessage.id,
      type: 'user',
      content: userMessage.content,
      timestamp: userMessage.timestamp
    });
    
    try {
      // 取消之前的请求
      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();
      
      // 使用流式 API
      const response = await fetch('/api/reasoning-rag/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: trimmedInput,
          config: {
            ...config,
            thinkingTimeout: config.thinkingTimeout * 1000 // 转换为毫秒
          }
        }),
        signal: abortControllerRef.current.signal
      });
      
      if (!response.ok) {
        throw new Error('请求失败');
      }
      
      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取响应流');
      
      const decoder = new TextDecoder();
      let buffer = '';
      let finalAnswer = '';
      let finalThinking: ThinkingStep[] = [];
      let finalWorkflow: ReasoningRAGResponse['workflow'] | null = null;
      let finalRouting: IntentClassification | null = null;
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              
              switch (event.type) {
                case 'routing':
                  if (event.data.status === 'complete' && event.data.classification) {
                    const lane = event.data.classification.suggestedLane;
                    setRoutingStatus({
                      isRouting: false,
                      currentLane: lane,
                      laneName: getLaneName(lane),
                      classification: event.data.classification
                    });
                    finalRouting = event.data.classification;
                  }
                  break;
                
                case 'lane_start':
                  setRoutingStatus(prev => ({
                    ...prev,
                    isRouting: false,
                    currentLane: event.data.lane,
                    laneName: event.data.laneName
                  }));
                  break;
                
                case 'thinking':
                  if (event.data.status === 'completed') {
                    finalThinking.push(event.data);
                  }
                  setStreamingThinking(prev => {
                    const existing = prev.findIndex(t => t.id === event.data.id);
                    if (existing >= 0) {
                      const updated = [...prev];
                      updated[existing] = event.data;
                      return updated;
                    }
                    return [...prev, event.data];
                  });
                  break;
                  
                case 'generation':
                  if (event.data.content) {
                    setStreamingAnswer(event.data.fullContent || event.data.content);
                    finalAnswer = event.data.fullContent || finalAnswer + event.data.content;
                  }
                  break;
                  
                case 'complete':
                  finalAnswer = event.data.answer || finalAnswer;
                  finalThinking = event.data.thinkingProcess || finalThinking;
                  finalWorkflow = event.data.workflow;
                  if (event.data.routing) {
                    finalRouting = event.data.routing.classification;
                  }
                  break;
                  
                case 'error':
                  throw new Error(event.data.message);
              }
            } catch (parseError) {
              // 忽略解析错误
            }
          }
        }
      }
      
      // 创建最终响应
      const defaultWorkflow: ReasoningRAGResponse['workflow'] = {
        totalDuration: 0,
        iterations: 1,
        decisionPath: [],
        nodeExecutions: []
      };
      
      const result: ReasoningRAGResponse = {
        query: trimmedInput,
        answer: finalAnswer,
        thinkingProcess: finalThinking,
        messages: [],
        workflow: finalWorkflow ?? defaultWorkflow,
        config: {
          reasoningModel: config.reasoningModel,
          embeddingModel: config.embeddingModel,
          topK: config.topK,
          rerankTopK: config.rerankTopK,
          enableBM25: config.enableBM25,
          enableRerank: config.enableRerank
        }
      };
      
      setCurrentResponse(result);
      
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: finalAnswer,
        timestamp: new Date(),
        response: result,
        thinkingProcess: finalThinking,
        thinkingDuration: finalWorkflow?.totalDuration,
        routing: finalRouting ? {
          lane: finalRouting.suggestedLane as 1 | 2 | 3,
          laneName: getLaneName(finalRouting.suggestedLane),
          intent: finalRouting.intent,
          confidence: finalRouting.confidence,
          reasoning: finalRouting.reasoning,
          estimatedTime: finalRouting.estimatedTime || ''
        } : undefined
      };
      
      setMessages(prev => [...prev, assistantMessage]);
      
      // 保存助手消息
      await saveMessage({
        id: assistantMessage.id,
        type: 'assistant',
        content: assistantMessage.content,
        timestamp: assistantMessage.timestamp,
        thinkingProcess: finalThinking,
        thinkingDuration: finalWorkflow?.totalDuration,
        workflowInfo: finalWorkflow ?? undefined
      });
      
    } catch (error) {
      // 忽略取消请求的错误
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('[ReasoningRAG] 请求已取消');
        return;
      }
      
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: `抱歉，处理您的问题时出现了错误：${error instanceof Error ? error.message : '未知错误'}`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
      setStreamingThinking([]);
      setStreamingAnswer('');
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };
  
  // 示例问题
  const exampleQueries = [
    '什么是 RAG 系统的核心组件？',
    '如何优化向量检索的准确性？',
    '解释混合检索的工作原理',
  ];
  
  // 加载对话
  const loadConversation = useCallback(async (convId: string) => {
    try {
      const conv = await reasoningDB.getConversation(convId);
      if (conv) {
        setCurrentConversationId(conv.id);
        setMessages(conv.messages.map(m => ({
          id: m.id,
          type: m.type,
          content: m.content,
          timestamp: m.timestamp,
          thinkingProcess: m.thinkingProcess,
          thinkingDuration: m.thinkingDuration
        })));
        setShowHistory(false);
      }
    } catch (error) {
      console.error('[History] 加载对话失败:', error);
    }
  }, []);
  
  // 删除对话
  const deleteConversation = useCallback(async (convId: string) => {
    if (!confirm('确定要删除这条对话吗？')) return;
    try {
      await reasoningDB.deleteConversation(convId);
      if (currentConversationId === convId) {
        setMessages([]);
        setCurrentConversationId(null);
      }
      await loadHistory();
    } catch (error) {
      console.error('[History] 删除对话失败:', error);
    }
  }, [currentConversationId, loadHistory]);
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/20 to-slate-950">
      {/* 历史记录侧边栏 */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex">
          {/* 遮罩 */}
          <div 
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowHistory(false)}
          />
          
          {/* 侧边栏 */}
          <div className="relative w-80 bg-slate-900 border-r border-purple-500/30 h-full overflow-hidden flex flex-col">
            {/* 头部 */}
            <div className="p-4 border-b border-slate-700 flex items-center justify-between">
              <h3 className="font-semibold text-white flex items-center gap-2">
                📜 对话历史
                <span className="text-xs text-gray-500">({conversations.length})</span>
              </h3>
              <button
                onClick={() => setShowHistory(false)}
                className="text-gray-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            
            {/* 对话列表 */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {conversations.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <p>暂无对话历史</p>
                  <p className="text-xs mt-1">开始新对话后会自动保存</p>
                </div>
              ) : (
                conversations.map(conv => (
                  <div
                    key={conv.id}
                    className={`p-3 rounded-lg cursor-pointer transition-colors group ${
                      conv.id === currentConversationId
                        ? 'bg-purple-500/30 border border-purple-500/50'
                        : 'bg-slate-800/50 hover:bg-slate-700/50 border border-transparent'
                    }`}
                    onClick={() => loadConversation(conv.id)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{conv.title}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          {conv.messages.length} 条消息 · {new Date(conv.updatedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                        className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                      >
                        🗑️
                      </button>
                    </div>
                    {conv.config && (
                      <div className="mt-2 flex gap-1 flex-wrap">
                        <span className="px-1.5 py-0.5 bg-purple-500/20 text-purple-300 text-xs rounded">
                          {conv.config.reasoningModel?.split(':')[0]}
                        </span>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            
            {/* 底部操作 */}
            {conversations.length > 0 && (
              <div className="p-3 border-t border-slate-700">
                <button
                  onClick={async () => {
                    if (confirm('确定要清空所有对话历史吗？')) {
                      await reasoningDB.clearAll();
                      setConversations([]);
                      setMessages([]);
                      setCurrentConversationId(null);
                    }
                  }}
                  className="w-full py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded-lg transition-colors"
                >
                  🗑️ 清空所有历史
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* 导航栏 */}
      <nav className="bg-black/40 backdrop-blur-sm border-b border-purple-500/20 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-14">
            <div className="flex items-center gap-4">
              <Link href="/" className="flex items-center gap-2 text-gray-300 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                <span className="text-sm">返回主页</span>
              </Link>
              <div className="w-px h-6 bg-purple-500/30" />
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-lg">
                  🧠
                </div>
                <h1 className="text-lg font-semibold text-white">Reasoning RAG</h1>
                <span className="px-2 py-0.5 bg-purple-500/30 text-purple-300 text-xs rounded-full">
                  推理增强
                </span>
                {knowledgeBaseReady ? (
                  <span className="px-2 py-0.5 bg-emerald-500/30 text-emerald-300 text-xs rounded-full flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                    知识库就绪 ({vectorCount})
                  </span>
                ) : (
                  <span className="px-2 py-0.5 bg-amber-500/30 text-amber-300 text-xs rounded-full">
                    知识库为空
                  </span>
                )}
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              {/* 历史记录按钮 */}
              <button
                onClick={() => setShowHistory(!showHistory)}
                className={`px-3 py-1.5 rounded-lg transition-colors text-sm flex items-center gap-2 ${
                  showHistory 
                    ? 'bg-purple-500/40 text-purple-200' 
                    : 'bg-slate-700/50 text-gray-300 hover:bg-slate-600/50'
                }`}
              >
                📜 历史 {conversations.length > 0 && `(${conversations.length})`}
              </button>
              
              {/* 新对话按钮 */}
              <button
                onClick={() => {
                  setMessages([]);
                  setCurrentConversationId(null);
                  setCurrentResponse(null);
                }}
                className="px-3 py-1.5 bg-emerald-500/20 text-emerald-300 rounded-lg hover:bg-emerald-500/30 transition-colors text-sm"
              >
                ✨ 新对话
              </button>
              
              <Link 
                href="/self-corrective-rag"
                className="px-3 py-1.5 bg-teal-500/20 text-teal-300 rounded-lg hover:bg-teal-500/30 transition-colors text-sm"
              >
                🔄 Self-Corrective
              </Link>
              <Link 
                href="/agentic-rag"
                className="px-3 py-1.5 bg-fuchsia-500/20 text-fuchsia-300 rounded-lg hover:bg-fuchsia-500/30 transition-colors text-sm"
              >
                🤖 Agentic RAG
              </Link>
            </div>
          </div>
        </div>
      </nav>
      
      {/* 主内容 */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左侧：配置、知识库和架构说明 */}
          <div className="lg:col-span-1 space-y-6">
            <ConfigPanel
              config={config}
              onChange={setConfig}
              availableModels={availableModels}
              llmModels={llmModels}
              embeddingModels={embeddingModels}
              embeddingProvider={embeddingProvider}
              isRemoteEmbedding={isRemoteEmbedding}
              reasoningProvider={reasoningProvider}
              isRemoteReasoning={isRemoteReasoning}
              isExpanded={configExpanded}
              onToggle={() => setConfigExpanded(!configExpanded)}
              errorMessage={modelLoadError}
              suggestion={modelSuggestion}
              onRefresh={loadModels}
            />
            
            {/* 独立知识库管理 */}
            <ReasoningFileManager
              embeddingModel={config.embeddingModel}
              onStatusChange={handleKnowledgeBaseStatus}
            />
            
            <ArchitectureInfo />
            
            {/* 特性说明 */}
            <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-pink-500/30 p-4">
              <h4 className="font-semibold text-white mb-3 flex items-center gap-2">
                ✨ 核心特性
              </h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li className="flex items-start gap-2">
                  <span className="text-purple-400">•</span>
                  <span><strong className="text-purple-300">思维链</strong>: 展示推理模型的完整思考过程</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-cyan-400">•</span>
                  <span><strong className="text-cyan-300">混合检索</strong>: Dense + BM25 双路召回</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400">•</span>
                  <span><strong className="text-blue-300">深度重排</strong>: LLM 相关性精排</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-amber-400">•</span>
                  <span><strong className="text-amber-300">编排器</strong>: 智能意图识别与路由</span>
                </li>
              </ul>
            </div>
          </div>
          
          {/* 右侧：对话区域 */}
          <div className="lg:col-span-2 space-y-6">
            {/* 对话框 */}
            <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              {/* 消息列表 */}
              <div className="h-[400px] overflow-y-auto p-4 space-y-4">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-3xl mb-4">
                      🧠
                    </div>
                    <h3 className="text-lg font-semibold text-white mb-2">
                      Reasoning RAG
                    </h3>
                    <p className="text-gray-400 text-sm mb-4 max-w-md">
                      基于推理模型的高级 RAG 系统，支持思维链展示、混合检索和深度重排序
                    </p>
                    
                    {/* 知识库状态提示 */}
                    {!knowledgeBaseReady && (
                      <div className="mb-4 p-3 bg-amber-900/30 border border-amber-500/30 rounded-lg max-w-md">
                        <div className="flex items-center gap-2 text-amber-300 mb-1">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span className="text-sm font-medium">知识库为空</span>
                        </div>
                        <p className="text-xs text-gray-400">
                          请在左侧「知识库管理」面板上传文件并进行向量化
                        </p>
                      </div>
                    )}
                    
                    <div className="flex flex-wrap gap-2 justify-center">
                      {exampleQueries.map((q, idx) => (
                        <button
                          key={idx}
                          onClick={() => setInput(q)}
                          disabled={!knowledgeBaseReady}
                          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-gray-600 text-gray-300 text-sm rounded-lg transition-colors"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map(msg => (
                    <div
                      key={msg.id}
                      className={`${msg.type === 'user' ? 'flex justify-end' : 'flex flex-col items-start'}`}
                    >
                      {/* 用户消息 */}
                      {msg.type === 'user' ? (
                        <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white">
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                          <p className="text-xs mt-1 text-purple-200">
                            {msg.timestamp.toLocaleTimeString()}
                          </p>
                        </div>
                      ) : (
                        /* 助手消息 - 包含思考过程 */
                        <div className="max-w-[90%] w-full">
                          {/* 思考过程 - Gemini 风格可折叠面板 */}
                          {msg.thinkingProcess && msg.thinkingProcess.length > 0 && (
                            <ThinkingProcessCollapsible
                              steps={msg.thinkingProcess}
                              duration={msg.thinkingDuration}
                              defaultExpanded={false}
                            />
                          )}
                          
                          {/* 车道标签 */}
                          {msg.routing && (() => {
                            const colors = getLaneColors(msg.routing.lane);
                            return (
                              <div className={`mb-1 px-2 py-1 rounded-lg inline-flex items-center gap-1.5 text-xs border ${colors.bg} ${colors.text} ${colors.border}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
                                <span>Lane {msg.routing.lane}: {msg.routing.laneName}</span>
                              </div>
                            );
                          })()}
                          
                          {/* 回答内容 */}
                          <div className="rounded-2xl px-4 py-3 bg-slate-800 text-gray-300 border border-slate-700">
                            <p className="whitespace-pre-wrap">{msg.content}</p>
                            <p className="text-xs mt-1 text-gray-500">
                              {msg.timestamp.toLocaleTimeString()}
                              {msg.thinkingDuration && (
                                <span className="ml-2">
                                  · 耗时 {(msg.thinkingDuration / 1000).toFixed(1)}s
                                </span>
                              )}
                              {msg.routing && (
                                <span className="ml-2">
                                  · {msg.routing.intent === 'chat' ? '直接回答' : 
                                     msg.routing.intent === 'fast_rag' ? '知识库' : '深度推理'}
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
                
                {isLoading && (
                  <div className="flex flex-col items-start max-w-[90%] w-full">
                    {/* 路由状态指示器 */}
                    {routingStatus.isRouting ? (
                      <div className="mb-2 px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-lg w-full">
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                          <span className="text-sm text-purple-300">正在分析查询意图...</span>
                        </div>
                      </div>
                    ) : routingStatus.currentLane && (() => {
                      const colors = getLaneColors(routingStatus.currentLane);
                      return (
                        <div className={`mb-2 px-3 py-2 rounded-lg w-full border ${colors.bg} ${colors.border}`}>
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
                            <span className={`text-sm font-medium ${colors.text}`}>
                              Lane {routingStatus.currentLane}: {routingStatus.laneName}
                            </span>
                            {routingStatus.classification && (
                              <span className="text-xs text-gray-500 ml-auto">
                                {routingStatus.classification.estimatedTime}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                    
                    {/* 实时思考过程 */}
                    <ThinkingProcessCollapsible
                      steps={streamingThinking}
                      isThinking={true}
                      defaultExpanded={true}
                    />
                    
                    {/* 流式回答 */}
                    <div className="rounded-2xl px-4 py-3 bg-slate-800 border border-slate-700 w-full mt-2">
                      {streamingAnswer ? (
                        <p className="text-gray-300 whitespace-pre-wrap">{streamingAnswer}</p>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
                          <div className="w-2 h-2 bg-pink-500 rounded-full animate-pulse" style={{ animationDelay: '0.15s' }} />
                          <div className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse" style={{ animationDelay: '0.3s' }} />
                          <span className="text-gray-400 text-sm">
                            {routingStatus.currentLane === 1 ? '快速生成中...' :
                             routingStatus.currentLane === 2 ? '检索并生成中...' :
                             routingStatus.currentLane === 3 ? '深度推理中...' : '正在思考...'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>
              
              {/* 输入框 */}
              <div className="border-t border-slate-700 p-4">
                {/* 状态警告 */}
                {availableModels.length === 0 && (
                  <div className="mb-3 p-2 bg-amber-900/30 border border-amber-500/30 rounded-lg text-center">
                    <span className="text-amber-300 text-sm">⚠️ 请先安装推理模型才能使用此功能</span>
                  </div>
                )}
                {availableModels.length > 0 && !knowledgeBaseReady && (
                  <div className="mb-3 p-2 bg-emerald-900/30 border border-emerald-500/30 rounded-lg text-center">
                    <span className="text-emerald-300 text-sm">📁 请先上传文件并向量化到知识库</span>
                  </div>
                )}
                
                <form onSubmit={handleSubmit} className="flex gap-3">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSubmit();
                      }
                    }}
                    placeholder={
                      availableModels.length === 0 
                        ? "请先安装推理模型..." 
                        : !knowledgeBaseReady 
                          ? "请先上传文件到知识库..."
                          : "输入您的问题..."
                    }
                    className="flex-1 px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-gray-500 resize-none focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:opacity-50"
                    rows={2}
                    disabled={isLoading || availableModels.length === 0 || !knowledgeBaseReady}
                  />
                  <button
                    type="submit"
                    disabled={isLoading || !input.trim() || availableModels.length === 0 || !knowledgeBaseReady}
                    className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:from-gray-600 disabled:to-gray-600 text-white font-medium rounded-xl transition-all flex items-center gap-2"
                  >
                    {isLoading ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        思考中
                      </>
                    ) : (
                      <>
                        <span>发送</span>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                        </svg>
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>
            
            {/* 工作流可视化 */}
            {(currentResponse || isLoading) && (
              <ReasoningRAGVisualizer
                query={currentResponse?.query}
                answer={currentResponse?.answer}
                thinkingProcess={currentResponse?.thinkingProcess}
                messages={currentResponse?.messages}
                retrieval={currentResponse?.retrieval}
                orchestratorDecision={currentResponse?.orchestratorDecision}
                workflow={currentResponse?.workflow}
                config={currentResponse?.config}
                isLoading={isLoading}
                defaultExpanded={true}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
