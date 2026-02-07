'use client';

import { useState } from 'react';

// ==================== 类型定义 ====================

interface CandidateQuestion {
  question: string;
  strategy: 'drill-down' | 'lateral-move' | 'logical-flow';
  strategyLabel: string;
  sourceChunkIds: string[];
  relevanceScore: number;
  validated: boolean;
  validationDetails?: {
    hasEvidence: boolean;
    isDuplicate: boolean;
    keywordsFound: string[];
  };
}

interface IntentAnchor {
  entities: { name: string; type: string; confidence: number }[];
  attributes: string[];
  intentType: string;
  stage: string;
}

interface SuggestedQuestionsProps {
  suggestions: CandidateQuestion[];
  anchor?: IntentAnchor;
  processingTime?: number;
  timings?: {
    anchorAnalysis: number;
    strategyRouting: number;
    questionGeneration: number;
    validation: number;
  };
  isLoading?: boolean;
  onQuestionClick?: (question: string) => void;
  showDetails?: boolean;
}

// ==================== 策略图标和颜色 ====================

const STRATEGY_STYLES: Record<string, { icon: string; color: string; bgColor: string }> = {
  'drill-down': {
    icon: '🔍',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/20',
  },
  'lateral-move': {
    icon: '↔️',
    color: 'text-green-400',
    bgColor: 'bg-green-500/10 border-green-500/30 hover:bg-green-500/20',
  },
  'logical-flow': {
    icon: '💡',
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20',
  },
};

// ==================== 组件 ====================

export default function SuggestedQuestions({
  suggestions,
  anchor,
  processingTime,
  timings,
  isLoading = false,
  onQuestionClick,
  showDetails = false,
}: SuggestedQuestionsProps) {
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (isLoading) {
    return (
      <div className="mt-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
        <div className="flex items-center gap-3">
          <div className="animate-spin w-5 h-5 border-2 border-cyan-400 border-t-transparent rounded-full" />
          <span className="text-slate-400 text-sm">正在生成推荐问题...</span>
        </div>
        <div className="mt-3 space-y-2">
          {[1, 2, 3].map(i => (
            <div
              key={i}
              className="h-10 bg-slate-700/30 rounded-lg animate-pulse"
              style={{ animationDelay: `${i * 100}ms` }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (!suggestions || suggestions.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 space-y-3">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">💬</span>
          <span className="text-sm font-medium text-slate-300">猜你想问</span>
          <span className="text-xs text-slate-500">({suggestions.length})</span>
        </div>
        
        {showDetails && (
          <button
            onClick={() => setShowAnalysis(!showAnalysis)}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
          >
            <span>{showAnalysis ? '收起' : '详情'}</span>
            <span className="transform transition-transform" style={{ transform: showAnalysis ? 'rotate(180deg)' : '' }}>
              ▼
            </span>
          </button>
        )}
      </div>

      {/* 意图分析详情 */}
      {showAnalysis && anchor && (
        <div className="p-3 bg-slate-800/70 rounded-lg border border-slate-700/50 text-xs space-y-2">
          {/* 实体 */}
          {anchor.entities.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-slate-500 w-16 flex-shrink-0">实体:</span>
              <div className="flex flex-wrap gap-1">
                {anchor.entities.map((e, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 bg-cyan-500/20 text-cyan-300 rounded"
                    title={`类型: ${e.type}, 置信度: ${(e.confidence * 100).toFixed(0)}%`}
                  >
                    {e.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          
          {/* 属性 */}
          {anchor.attributes.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-slate-500 w-16 flex-shrink-0">属性:</span>
              <div className="flex flex-wrap gap-1">
                {anchor.attributes.map((attr, i) => (
                  <span key={i} className="px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">
                    {attr}
                  </span>
                ))}
              </div>
            </div>
          )}
          
          {/* 意图和阶段 */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-slate-500">意图:</span>
              <span className="text-slate-300">{anchor.intentType}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-500">阶段:</span>
              <span className="text-slate-300">{anchor.stage}</span>
            </div>
          </div>
          
          {/* 耗时 */}
          {timings && (
            <div className="flex items-center gap-3 pt-2 border-t border-slate-700/50">
              <span className="text-slate-500">耗时:</span>
              <span className="text-slate-400">
                分析 {timings.anchorAnalysis}ms | 
                路由 {timings.strategyRouting}ms | 
                生成 {timings.questionGeneration}ms | 
                校验 {timings.validation}ms
              </span>
              {processingTime && (
                <span className="text-cyan-400">= {processingTime}ms</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 推荐问题列表 */}
      <div className="space-y-2">
        {suggestions.map((suggestion, index) => {
          const style = STRATEGY_STYLES[suggestion.strategy] || STRATEGY_STYLES['drill-down'];
          const isHovered = hoveredIndex === index;

          return (
            <button
              key={index}
              onClick={() => onQuestionClick?.(suggestion.question)}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              className={`
                w-full text-left p-3 rounded-xl border transition-all duration-200
                ${style.bgColor}
                ${isHovered ? 'transform scale-[1.01]' : ''}
              `}
            >
              <div className="flex items-start gap-3">
                {/* 策略图标 */}
                <span className="text-lg flex-shrink-0">{style.icon}</span>
                
                {/* 问题内容 */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200 leading-relaxed">
                    {suggestion.question}
                  </p>
                  
                  {/* 标签 */}
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={`text-xs ${style.color}`}>
                      {suggestion.strategyLabel}
                    </span>
                    {suggestion.relevanceScore > 0 && (
                      <span className="text-xs text-slate-500">
                        · 相关度 {(suggestion.relevanceScore * 100).toFixed(0)}%
                      </span>
                    )}
                    {suggestion.validated && (
                      <span className="text-xs text-green-400">
                        · ✓ 已校验
                      </span>
                    )}
                  </div>
                </div>

                {/* 箭头 */}
                <span className={`
                  text-slate-500 transition-all duration-200 flex-shrink-0
                  ${isHovered ? 'text-slate-300 translate-x-1' : ''}
                `}>
                  →
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* 策略图例 */}
      <div className="flex items-center justify-center gap-4 pt-2 text-xs text-slate-500">
        <div className="flex items-center gap-1">
          <span>🔍</span>
          <span>深入细节</span>
        </div>
        <div className="flex items-center gap-1">
          <span>↔️</span>
          <span>横向对比</span>
        </div>
        <div className="flex items-center gap-1">
          <span>💡</span>
          <span>逻辑延伸</span>
        </div>
      </div>
    </div>
  );
}

// ==================== 紧凑版组件 ====================

interface CompactSuggestionsProps {
  suggestions: CandidateQuestion[];
  onQuestionClick?: (question: string) => void;
}

export function CompactSuggestions({ suggestions, onQuestionClick }: CompactSuggestionsProps) {
  if (!suggestions || suggestions.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {suggestions.slice(0, 3).map((suggestion, index) => {
        const style = STRATEGY_STYLES[suggestion.strategy] || STRATEGY_STYLES['drill-down'];
        
        return (
          <button
            key={index}
            onClick={() => onQuestionClick?.(suggestion.question)}
            className={`
              inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm
              border transition-all duration-200 hover:scale-105
              ${style.bgColor}
            `}
          >
            <span className="text-sm">{style.icon}</span>
            <span className="text-slate-200 truncate max-w-[200px]">
              {suggestion.question}
            </span>
          </button>
        );
      })}
    </div>
  );
}
