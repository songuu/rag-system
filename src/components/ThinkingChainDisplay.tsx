'use client';

import React, { useState } from 'react';

// ==================== 类型定义 ====================

interface ThinkingStep {
  id: string;
  timestamp: number;
  type: 'reasoning' | 'planning' | 'reflection' | 'decision';
  content: string;
  confidence?: number;
  metadata?: Record<string, any>;
}

interface ThinkingChainDisplayProps {
  steps: ThinkingStep[];
  isLoading?: boolean;
  compact?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}

// ==================== 主组件 ====================

export default function ThinkingChainDisplay({
  steps,
  isLoading = false,
  compact = false,
  defaultExpanded = true,
  className = ''
}: ThinkingChainDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  
  const typeConfig = {
    reasoning: { icon: '🧠', label: '推理', color: 'purple', bgColor: 'bg-purple-100', borderColor: 'border-purple-300', textColor: 'text-purple-700' },
    planning: { icon: '📋', label: '规划', color: 'blue', bgColor: 'bg-blue-100', borderColor: 'border-blue-300', textColor: 'text-blue-700' },
    reflection: { icon: '🔍', label: '反思', color: 'amber', bgColor: 'bg-amber-100', borderColor: 'border-amber-300', textColor: 'text-amber-700' },
    decision: { icon: '⚡', label: '决策', color: 'emerald', bgColor: 'bg-emerald-100', borderColor: 'border-emerald-300', textColor: 'text-emerald-700' }
  };
  
  if (steps.length === 0 && !isLoading) {
    return null;
  }
  
  // 紧凑模式
  if (compact) {
    return (
      <div className={`bg-gradient-to-r from-purple-50 to-pink-50 rounded-lg border border-purple-200 p-3 ${className}`}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">🧠</span>
          <span className="text-sm font-medium text-purple-700">思维链</span>
          {isLoading && (
            <div className="ml-auto flex items-center gap-1">
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" />
              <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
              <div className="w-2 h-2 bg-purple-600 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
            </div>
          )}
        </div>
        
        <div className="flex flex-wrap gap-1.5">
          {steps.map((step, idx) => {
            const config = typeConfig[step.type] || typeConfig.reasoning;
            return (
              <div
                key={step.id}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${config.bgColor} ${config.borderColor} border ${config.textColor}`}
                title={step.content}
              >
                <span>{config.icon}</span>
                <span className="font-medium">{config.label}</span>
                {step.confidence !== undefined && (
                  <span className="opacity-70">({(step.confidence * 100).toFixed(0)}%)</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  
  // 完整模式
  return (
    <div className={`bg-white rounded-xl border border-purple-200 overflow-hidden shadow-sm ${className}`}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-gradient-to-r from-purple-50 via-pink-50 to-indigo-50 hover:from-purple-100 hover:via-pink-100 hover:to-indigo-100 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-lg">
            🧠
          </div>
          <div className="text-left">
            <span className="font-semibold text-gray-800">思维链 (Chain of Thought)</span>
            <span className="ml-2 px-2 py-0.5 bg-purple-100 text-purple-600 text-xs rounded-full">
              {steps.length} 步
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {isLoading && (
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" />
              <div className="w-2 h-2 bg-pink-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
              <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
              <span className="ml-1 text-purple-600 text-xs">思考中...</span>
            </div>
          )}
          
          <svg
            className={`w-5 h-5 text-purple-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      
      {isExpanded && (
        <div className="p-4">
          {steps.length === 0 ? (
            <div className="text-center text-gray-400 py-6">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-gray-100 flex items-center justify-center text-2xl">
                🧠
              </div>
              <p className="text-sm">推理模型会展示其思考过程</p>
              <p className="text-xs mt-1 text-gray-300">支持 DeepSeek-R1、Qwen3 等推理模型</p>
            </div>
          ) : (
            <div className="relative">
              {/* 连接线 */}
              <div className="absolute left-4 top-4 bottom-4 w-0.5 bg-gradient-to-b from-purple-300 via-pink-300 to-indigo-300" />
              
              {steps.map((step, idx) => {
                const config = typeConfig[step.type] || typeConfig.reasoning;
                return (
                  <div key={step.id} className="relative pl-10 pb-4 last:pb-0">
                    {/* 节点圆点 */}
                    <div className={`absolute left-2 w-5 h-5 rounded-full flex items-center justify-center text-xs text-white shadow-md bg-gradient-to-br ${
                      step.type === 'reasoning' ? 'from-purple-500 to-purple-600' :
                      step.type === 'planning' ? 'from-blue-500 to-blue-600' :
                      step.type === 'reflection' ? 'from-amber-500 to-amber-600' :
                      'from-emerald-500 to-emerald-600'
                    }`}>
                      {idx + 1}
                    </div>
                    
                    <div className={`${config.bgColor} rounded-lg p-3 border ${config.borderColor}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-base">{config.icon}</span>
                          <span className={`text-sm font-medium ${config.textColor}`}>{config.label}</span>
                        </div>
                        {step.confidence !== undefined && (
                          <div className="flex items-center gap-1.5">
                            <div className="w-16 h-1.5 bg-white/50 rounded-full overflow-hidden">
                              <div 
                                className={`h-full bg-gradient-to-r ${
                                  step.type === 'reasoning' ? 'from-purple-400 to-purple-600' :
                                  step.type === 'planning' ? 'from-blue-400 to-blue-600' :
                                  step.type === 'reflection' ? 'from-amber-400 to-amber-600' :
                                  'from-emerald-400 to-emerald-600'
                                }`}
                                style={{ width: `${step.confidence * 100}%` }}
                              />
                            </div>
                            <span className={`text-xs ${config.textColor}`}>
                              {(step.confidence * 100).toFixed(0)}%
                            </span>
                          </div>
                        )}
                      </div>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{step.content}</p>
                      
                      {step.metadata && Object.keys(step.metadata).length > 0 && (
                        <div className="mt-2 pt-2 border-t border-white/50">
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(step.metadata).map(([key, value]) => (
                              <span 
                                key={key}
                                className="text-xs px-1.5 py-0.5 bg-white/50 rounded text-gray-600"
                              >
                                {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
