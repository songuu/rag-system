'use client';

import React, { useState, useEffect, useRef } from 'react';

interface ThinkingStep {
  id: string;
  timestamp: number;
  type: 'reasoning' | 'planning' | 'reflection' | 'decision';
  content: string;
  confidence?: number;
  metadata?: Record<string, any>;
}

interface ThinkingProcessCollapsibleProps {
  steps: ThinkingStep[];
  isThinking?: boolean;
  duration?: number;
  defaultExpanded?: boolean;
  className?: string;
}

/**
 * Gemini 风格的可折叠思考过程组件
 * 在回答前显示 AI 的思考过程
 */
export default function ThinkingProcessCollapsible({
  steps,
  isThinking = false,
  duration,
  defaultExpanded = false,
  className = ''
}: ThinkingProcessCollapsibleProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [displayedSteps, setDisplayedSteps] = useState<ThinkingStep[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);
  
  // 动态显示思考步骤（打字机效果）
  useEffect(() => {
    if (isThinking) {
      setDisplayedSteps([]);
      setIsExpanded(true);
    } else {
      setDisplayedSteps(steps);
    }
  }, [steps, isThinking]);
  
  // 思考中时逐步显示
  useEffect(() => {
    if (isThinking && steps.length > displayedSteps.length) {
      const timer = setTimeout(() => {
        setDisplayedSteps(prev => [...prev, steps[prev.length]]);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isThinking, steps, displayedSteps]);
  
  // 自动滚动到底部
  useEffect(() => {
    if (contentRef.current && isExpanded) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [displayedSteps, isExpanded]);
  
  if (steps.length === 0 && !isThinking) {
    return null;
  }
  
  const getStepIcon = (type: string) => {
    switch (type) {
      case 'reasoning': return '💭';
      case 'planning': return '📋';
      case 'reflection': return '🔍';
      case 'decision': return '⚡';
      default: return '🧠';
    }
  };
  
  const getStepColor = (type: string) => {
    switch (type) {
      case 'reasoning': return 'text-purple-400 border-purple-500/30 bg-purple-500/10';
      case 'planning': return 'text-blue-400 border-blue-500/30 bg-blue-500/10';
      case 'reflection': return 'text-amber-400 border-amber-500/30 bg-amber-500/10';
      case 'decision': return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
      default: return 'text-gray-400 border-gray-500/30 bg-gray-500/10';
    }
  };
  
  return (
    <div className={`mb-3 ${className}`}>
      {/* 折叠按钮 - Gemini 风格 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full group"
      >
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-purple-500/10 via-pink-500/10 to-indigo-500/10 border border-purple-500/20 hover:border-purple-500/40 transition-all">
          {/* 思考图标 - 动画效果 */}
          <div className={`relative ${isThinking ? 'animate-pulse' : ''}`}>
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
              <span className="text-xs">🧠</span>
            </div>
            {isThinking && (
              <div className="absolute inset-0 rounded-full bg-purple-400/30 animate-ping" />
            )}
          </div>
          
          {/* 标题 */}
          <div className="flex-1 text-left">
            <span className="text-sm font-medium text-purple-300">
              {isThinking ? '正在思考...' : '思考过程'}
            </span>
            {!isThinking && duration && (
              <span className="ml-2 text-xs text-gray-500">
                ({(duration / 1000).toFixed(1)}秒)
              </span>
            )}
          </div>
          
          {/* 步骤数量 */}
          {steps.length > 0 && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-purple-500/20 text-purple-300">
              {steps.length} 步
            </span>
          )}
          
          {/* 展开/折叠箭头 */}
          <svg
            className={`w-4 h-4 text-purple-400 transition-transform duration-200 ${
              isExpanded ? 'rotate-180' : ''
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      
      {/* 展开内容 */}
      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          isExpanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div
          ref={contentRef}
          className="mt-2 p-3 rounded-lg bg-slate-900/50 border border-slate-700/50 max-h-64 overflow-y-auto"
        >
          {/* 思考中的动画 */}
          {isThinking && displayedSteps.length === 0 && (
            <div className="flex items-center gap-2 text-purple-400 text-sm">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 bg-pink-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="animate-pulse">分析问题中...</span>
            </div>
          )}
          
          {/* 思考步骤列表 */}
          <div className="space-y-2">
            {displayedSteps.map((step, idx) => (
              <div
                key={step.id}
                className={`flex gap-2 p-2 rounded-lg border ${getStepColor(step.type)} animate-fadeIn`}
                style={{ animationDelay: `${idx * 50}ms` }}
              >
                {/* 步骤图标 */}
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-sm">
                  {getStepIcon(step.type)}
                </div>
                
                {/* 步骤内容 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium capitalize">
                      {step.type === 'reasoning' ? '推理' :
                       step.type === 'planning' ? '规划' :
                       step.type === 'reflection' ? '反思' :
                       step.type === 'decision' ? '决策' : step.type}
                    </span>
                    {step.confidence !== undefined && (
                      <span className="text-xs text-gray-500">
                        置信度: {(step.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap break-words">
                    {step.content}
                  </p>
                </div>
              </div>
            ))}
          </div>
          
          {/* 思考完成提示 */}
          {!isThinking && steps.length > 0 && (
            <div className="mt-3 pt-2 border-t border-slate-700/50 flex items-center justify-between text-xs text-gray-500">
              <span>✓ 思考完成</span>
              {duration && <span>耗时 {(duration / 1000).toFixed(1)}s</span>}
            </div>
          )}
        </div>
      </div>
      
      {/* CSS 动画 */}
      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out forwards;
        }
      `}</style>
    </div>
  );
}
