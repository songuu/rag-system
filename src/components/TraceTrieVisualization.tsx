'use client';

import React, { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

// 导入类型定义
import type {
  LogicWaterfall,
  WaterfallStage,
  PathToken
} from '@/lib/trace-trie';
import type {
  VectorWeightInfo,
  TokenDensityInfo,
  ModelComparison
} from '@/lib/token-analyzer';

// 语义密度警告接口
interface SemanticWarning {
  type: 'low_density' | 'high_fragmentation' | 'byte_fallback';
  severity: 'warning' | 'error';
  token: string;
  position: number;
  message: string;
  suggestion: string;
}

interface TraceTrieVisualizationProps {
  text: string;
  waterfall?: LogicWaterfall;
  vectorWeights?: VectorWeightInfo[];
  densityInfos?: TokenDensityInfo[];
  modelComparisons?: ModelComparison[];
  onTokenClick?: (token: PathToken) => void;
}

export default function TraceTrieVisualization({
  text,
  waterfall,
  vectorWeights = [],
  densityInfos = [],
  modelComparisons = [],
  onTokenClick
}: TraceTrieVisualizationProps) {
  const [selectedStage, setSelectedStage] = useState<number>(0);
  const [selectedToken, setSelectedToken] = useState<PathToken | null>(null);
  const [showComparison, setShowComparison] = useState(true);
  const [showWarnings, setShowWarnings] = useState(true);

  // 处理 Token 点击
  const handleTokenClick = (token: PathToken) => {
    setSelectedToken(token);
    onTokenClick?.(token);
  };

  // 计算语义密度警告
  const semanticWarnings = useMemo<SemanticWarning[]>(() => {
    if (!waterfall) return [];
    
    const warnings: SemanticWarning[] = [];
    const finalStage = waterfall.stages[waterfall.stages.length - 1];
    
    if (!finalStage) return warnings;
    
    let position = 0;
    finalStage.tokens.forEach((token, index) => {
      const density = densityInfos.find(d => d.tokenId === token.tokenId);
      const vectorWeight = vectorWeights.find(v => v.tokenId === token.tokenId);
      
      // 检查是否是字节回退（碎片化）
      if (token.token.startsWith('[0x') || token.token.length === 1) {
        // 连续多个单字符可能表示碎片化
        const nextTokens = finalStage.tokens.slice(index, index + 3);
        const consecutiveSingleChars = nextTokens.filter(t => t.token.length === 1).length;
        
        if (consecutiveSingleChars >= 2) {
          warnings.push({
            type: 'high_fragmentation',
            severity: 'warning',
            token: token.token,
            position,
            message: `检测到高碎片化区域: "${nextTokens.map(t => t.token).join('')}"`,
            suggestion: '此处的语义密度过低，可能导致检索偏移。建议检查专有名词或特殊词汇的处理。'
          });
        }
      }
      
      // 检查低密度 token
      if (density && density.density < 0.5) {
        warnings.push({
          type: 'low_density',
          severity: 'warning',
          token: token.token,
          position,
          message: `Token "${token.token}" 语义密度过低 (${density.density.toFixed(2)})`,
          suggestion: '低密度词元可能无法有效捕获语义信息，考虑使用同义词替换或上下文补充。'
        });
      }
      
      // 检查字节回退
      if (token.decisionPoint?.decisionType === 'fallback') {
        warnings.push({
          type: 'byte_fallback',
          severity: 'error',
          token: token.token,
          position,
          message: `字符 "${token.token}" 触发了字节回退机制`,
          suggestion: '该字符不在模型词汇表中，可能影响语义理解。建议使用更通用的表达方式。'
        });
      }
      
      position += token.token.length;
    });
    
    return warnings;
  }, [waterfall, densityInfos, vectorWeights]);

  // 渲染语义密度警告面板
  const renderWarningsPanel = () => {
    if (semanticWarnings.length === 0) return null;

    return (
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            语义密度分析警告
            <span className="text-sm font-normal text-slate-500">({semanticWarnings.length})</span>
          </h3>
              <button
            onClick={() => setShowWarnings(!showWarnings)}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            {showWarnings ? '收起' : '展开'}
          </button>
        </div>
        
        {showWarnings && (
          <div className="space-y-3">
            {semanticWarnings.map((warning, index) => (
              <div 
                key={index}
                className={`p-4 rounded-lg border-l-4 ${
                  warning.severity === 'error' 
                    ? 'bg-red-50 border-red-500' 
                    : 'bg-amber-50 border-amber-500'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`p-1 rounded-full ${
                    warning.severity === 'error' ? 'bg-red-200' : 'bg-amber-200'
                  }`}>
                    {warning.severity === 'error' ? (
                      <svg className="w-4 h-4 text-red-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                        warning.type === 'low_density' ? 'bg-blue-100 text-blue-700' :
                        warning.type === 'high_fragmentation' ? 'bg-purple-100 text-purple-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {warning.type === 'low_density' ? '低密度' :
                         warning.type === 'high_fragmentation' ? '高碎片化' : '字节回退'}
                      </span>
                      <span className="text-xs text-slate-500">位置: {warning.position}</span>
                    </div>
                    <p className={`text-sm font-medium ${
                      warning.severity === 'error' ? 'text-red-800' : 'text-amber-800'
                    }`}>
                      {warning.message}
                    </p>
                    <p className="text-xs text-slate-600 mt-1">
                      💡 {warning.suggestion}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // 渲染瀑布流视图 - 增强版
  const renderWaterfallView = () => {
    if (!waterfall) return null;

    const stageLabels = {
      'bytes': { label: '原始字节', icon: '🔢', color: 'from-slate-500 to-slate-600' },
      'characters': { label: '字符序列', icon: '📝', color: 'from-blue-500 to-blue-600' },
      'subwords': { label: 'BPE合并', icon: '🔗', color: 'from-purple-500 to-purple-600' },
      'fullwords': { label: '最终词元', icon: '✨', color: 'from-emerald-500 to-emerald-600' }
    };

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
            BPE 分词瀑布流
          </h3>
          <div className="flex items-center gap-2">
            {waterfall.stages.map((stage, index) => {
              const stageInfo = stageLabels[stage.level as keyof typeof stageLabels] || { label: stage.level, icon: '📄', color: 'from-gray-500 to-gray-600' };
              return (
                <button
                  key={index}
                  onClick={() => setSelectedStage(index)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    selectedStage === index
                      ? `bg-gradient-to-r ${stageInfo.color} text-white shadow-md`
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <span>{stageInfo.icon}</span>
                  <span>{stageInfo.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 瀑布流可视化 */}
        <div className="relative">
          {/* 阶段连接线 */}
          <div className="absolute left-8 top-0 bottom-0 w-0.5 bg-gradient-to-b from-slate-300 via-purple-300 to-emerald-300"></div>
          
          {waterfall.stages.map((stage, stageIndex) => {
            const stageInfo = stageLabels[stage.level as keyof typeof stageLabels] || { label: stage.level, icon: '📄', color: 'from-gray-500 to-gray-600' };
            const isSelected = selectedStage === stageIndex;
            
            return (
              <div 
                key={stageIndex}
                className={`relative pl-20 py-4 transition-all ${isSelected ? '' : 'opacity-60'}`}
              >
                {/* 阶段节点 */}
                <div className={`absolute left-5 w-6 h-6 rounded-full flex items-center justify-center text-sm ${
                  isSelected 
                    ? `bg-gradient-to-r ${stageInfo.color} text-white shadow-lg` 
                    : 'bg-slate-200 text-slate-500'
                }`}>
                  {stageIndex + 1}
                </div>
                
                <div className={`bg-white rounded-xl border ${isSelected ? 'border-indigo-200 shadow-lg' : 'border-slate-100'} p-4`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{stageInfo.icon}</span>
                      <span className="font-semibold text-slate-700">{stageInfo.label}</span>
                      <span className="text-xs text-slate-400">
                        ({stage.tokens.length} tokens)
              </span>
                    </div>
                    {stage.processingTime > 0 && (
                      <span className="text-xs text-slate-400">
                        耗时: {stage.processingTime}ms
                      </span>
                    )}
            </div>

                  {/* Token 展示 */}
                  <div className="flex flex-wrap gap-1.5">
                    {stage.tokens.map((token, tokenIndex) => {
                const vectorWeight = vectorWeights.find(v => v.tokenId === token.tokenId);
                const density = densityInfos.find(d => d.tokenId === token.tokenId);
                
                      // 计算样式
                const magnitude = vectorWeight?.vectorMagnitude || 0.5;
                      const isHighWeight = magnitude > 0.8;
                const densityValue = density?.density || 1;
                      const isLowDensity = densityValue < 0.5;
                      const isFallback = token.decisionPoint?.decisionType === 'fallback';
                      
                      // 根据向量权重设置颜色深度
                      let bgClass = 'bg-slate-100 text-slate-700';
                      if (stage.level === 'fullwords' || stage.level === 'subwords') {
                        if (isHighWeight) {
                          bgClass = 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-md';
                        } else if (magnitude > 0.6) {
                          bgClass = 'bg-indigo-100 text-indigo-800';
                        } else if (isLowDensity) {
                          bgClass = 'bg-amber-100 text-amber-800 border border-amber-300';
                        } else if (isFallback) {
                          bgClass = 'bg-red-100 text-red-800 border border-red-300';
                        } else {
                          bgClass = 'bg-blue-50 text-blue-700';
                        }
                      }

                return (
                  <div
                          key={tokenIndex}
                    onClick={() => handleTokenClick(token)}
                          className={`${bgClass} px-2 py-1 rounded-md cursor-pointer hover:ring-2 hover:ring-indigo-400 transition-all text-sm font-mono relative group`}
                    title={`Token: ${token.token}\nID: ${token.tokenId}\n权重: ${magnitude.toFixed(3)}\n密度: ${densityValue.toFixed(2)}`}
                  >
                          {/* 高权重标记 */}
                          {isHighWeight && (
                            <span className="absolute -top-1 -right-1 w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></span>
                          )}
                          {/* 低密度标记 */}
                          {isLowDensity && stage.level !== 'bytes' && stage.level !== 'characters' && (
                            <span className="absolute -top-1 -left-1 w-2 h-2 bg-amber-500 rounded-full"></span>
                          )}
                          
                          <span>{token.token}</span>
                          
                          {/* Hover 详情 */}
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-slate-800 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-20 shadow-xl">
                            <div className="space-y-1">
                              <div>Token ID: {token.tokenId}</div>
                              <div>向量权重: {magnitude.toFixed(3)} {isHighWeight && '⭐'}</div>
                              <div>语义密度: {densityValue.toFixed(2)} {isLowDensity && '⚠️'}</div>
                              {token.mergeRank && <div>合并等级: {token.mergeRank}</div>}
                            </div>
                          </div>
                  </div>
                );
              })}
            </div>

                  {/* 合并操作 - 只在 subwords 阶段显示 */}
                  {stage.level === 'subwords' && stage.mergeOperations.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-slate-100">
                      <h4 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                        <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        BPE 合并路径
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {stage.mergeOperations.slice(0, 6).map((op, opIndex) => (
                    <div
                            key={opIndex}
                            className="flex items-center gap-2 bg-slate-50 rounded-lg p-2 text-xs"
                    >
                            <span className="font-mono bg-white px-1.5 py-0.5 rounded border">{op.left}</span>
                            <span className="text-slate-400">+</span>
                            <span className="font-mono bg-white px-1.5 py-0.5 rounded border">{op.right}</span>
                            <span className="text-purple-500">→</span>
                            <span className="font-mono font-semibold bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">{op.merged}</span>
                            <span className="text-slate-400 text-[10px]">R:{op.rank}</span>
                          </div>
                        ))}
                        {stage.mergeOperations.length > 6 && (
                          <div className="text-xs text-slate-400 col-span-2 text-center">
                            ... 还有 {stage.mergeOperations.length - 6} 个合并操作
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          </div>

        {/* 选中 Token 的详细决策路径 */}
        {selectedToken?.decisionPoint && (
          <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-xl p-5 border border-amber-200">
            <h4 className="text-sm font-bold text-amber-800 mb-3 flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Token "{selectedToken.token}" 的决策详情
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div className="bg-white rounded-lg p-3">
                <div className="text-xs text-slate-500 mb-1">位置</div>
                <div className="font-semibold text-slate-800">{selectedToken.decisionPoint.position}</div>
              </div>
              <div className="bg-white rounded-lg p-3">
                <div className="text-xs text-slate-500 mb-1">决策类型</div>
                <div className={`font-semibold ${
                  selectedToken.decisionPoint.decisionType === 'merge' ? 'text-purple-600' :
                  selectedToken.decisionPoint.decisionType === 'fallback' ? 'text-red-600' : 'text-blue-600'
                }`}>
                  {selectedToken.decisionPoint.decisionType === 'merge' ? '合并' :
                   selectedToken.decisionPoint.decisionType === 'fallback' ? '回退' : '分裂'}
                </div>
              </div>
              <div className="bg-white rounded-lg p-3">
                <div className="text-xs text-slate-500 mb-1">选中候选</div>
                <div className="font-semibold text-slate-800 font-mono">{selectedToken.decisionPoint.selectedCandidate}</div>
              </div>
              <div className="bg-white rounded-lg p-3 col-span-2 md:col-span-1">
                <div className="text-xs text-slate-500 mb-1">决策原因</div>
                <div className="font-semibold text-slate-800 text-xs">{selectedToken.decisionPoint.reason}</div>
              </div>
            </div>
            
              {selectedToken.decisionPoint.candidates.length > 0 && (
              <div className="mt-4">
                <div className="text-xs font-semibold text-amber-700 mb-2">候选列表:</div>
                <div className="flex flex-wrap gap-2">
                    {selectedToken.decisionPoint.candidates.map((candidate, idx) => (
                      <div
                        key={idx}
                      className={`px-3 py-1.5 rounded-lg text-sm ${
                          candidate.token === selectedToken.decisionPoint!.selectedCandidate
                          ? 'bg-indigo-500 text-white font-semibold'
                          : 'bg-white border border-slate-200 text-slate-600'
                        }`}
                      >
                      <span className="font-mono">{candidate.token}</span>
                      <span className="text-xs opacity-70 ml-2">
                        Score: {candidate.score.toFixed(3)}
                      </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>
        )}
      </div>
    );
  };

  // 渲染模型对比视图 - 增强版
  const renderModelComparison = () => {
    if (modelComparisons.length === 0) return null;

    // 计算最佳模型
    const bestModel = modelComparisons.reduce((best, current) => 
      current.scorecard.overallScore > best.scorecard.overallScore ? current : best
    );

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            多模型分词对比
            <span className="text-sm font-normal text-slate-500">({modelComparisons.length} 个模型)</span>
          </h3>
          <button
            onClick={() => setShowComparison(!showComparison)}
            className="px-4 py-2 bg-purple-100 text-purple-700 rounded-lg text-sm font-medium hover:bg-purple-200 transition-colors"
          >
            {showComparison ? '收起对比' : '展开对比'}
          </button>
        </div>

        {showComparison && (
          <div className="space-y-6">
            {/* 模型评分总览 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {modelComparisons.map((comparison, index) => {
                const isBest = comparison.modelName === bestModel.modelName;
                return (
                  <div 
                    key={index}
                    className={`relative p-4 rounded-xl border ${
                      isBest 
                        ? 'bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-300' 
                        : 'bg-white border-slate-200'
                    }`}
                  >
                    {isBest && (
                      <div className="absolute -top-2 -right-2 bg-emerald-500 text-white text-xs px-2 py-0.5 rounded-full">
                        最佳
                      </div>
                    )}
                    <div className="text-sm font-semibold text-slate-800 truncate mb-2">
                      {comparison.modelName.split('/').pop()}
                    </div>
                    <div className="text-3xl font-bold text-slate-900 mb-2">
                      {comparison.scorecard.overallScore.toFixed(1)}
                      <span className="text-sm font-normal text-slate-400">/100</span>
                    </div>
                    <div className="space-y-1 text-xs text-slate-500">
                      <div className="flex justify-between">
                        <span>Token数:</span>
                        <span className="font-medium text-slate-700">{comparison.tokenization.tokenCount}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>碎片化率:</span>
                        <span className="font-medium text-slate-700">{comparison.scorecard.fragmentationRate.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>耗时:</span>
                        <span className="font-medium text-slate-700">{comparison.processingTime}ms</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 详细对比 */}
            {modelComparisons.map((comparison, modelIndex) => (
              <div key={modelIndex} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="bg-slate-50 px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${
                      comparison.modelName === bestModel.modelName ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}></div>
                    <h4 className="font-semibold text-slate-800">{comparison.modelName}</h4>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-slate-500">
                    <span>评分: <strong className="text-slate-700">{comparison.scorecard.overallScore.toFixed(2)}</strong></span>
                    <span>OOV回退: <strong className={comparison.scorecard.oovRobustness.byteFallbackCount > 0 ? 'text-amber-600' : 'text-emerald-600'}>
                      {comparison.scorecard.oovRobustness.byteFallbackCount}
                    </strong></span>
                  </div>
                </div>

                <div className="p-5">
                  {/* 热力图风格的 Token 展示 */}
                  <div className="flex flex-wrap gap-1 mb-4">
                  {comparison.tokenization.tokens.map((token, tokenIndex) => {
                    const density = token.density?.density || 1;
                      const vectorWeight = token.vectorWeight?.vectorMagnitude || 0.5;
                      
                      // 根据密度和权重计算颜色
                      let bgClass = 'bg-slate-100 text-slate-600';
                      if (vectorWeight > 0.8) {
                        bgClass = 'bg-indigo-500 text-white';
                      } else if (density > 1.0) {
                        bgClass = 'bg-blue-400 text-white';
                      } else if (density > 0.5) {
                        bgClass = 'bg-blue-200 text-blue-800';
                      } else {
                        bgClass = 'bg-amber-100 text-amber-800';
                      }
                    
                    return (
                      <span
                        key={tokenIndex}
                          className={`${bgClass} px-1.5 py-0.5 rounded text-xs font-mono`}
                          title={`${token.token}\n密度: ${density.toFixed(2)}\n权重: ${vectorWeight.toFixed(3)}`}
                      >
                        {token.token}
                      </span>
                    );
                  })}
                  </div>
                  
                  {/* 评分详情 */}
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="bg-slate-50 rounded-lg p-3">
                      <div className="text-xs text-slate-500 mb-1">碎片化率</div>
                      <div className="text-lg font-bold text-slate-800">
                        {comparison.scorecard.fragmentationRate.toFixed(2)}
                      </div>
                      <div className="text-xs text-slate-400">字节/Token</div>
                    </div>
                    <div className="bg-slate-50 rounded-lg p-3">
                      <div className="text-xs text-slate-500 mb-1">语义对齐</div>
                      <div className="text-lg font-bold text-slate-800">
                        {comparison.scorecard.semanticAlignment.mean.toFixed(3)}
                      </div>
                      <div className="text-xs text-slate-400">平均权重</div>
                    </div>
                    <div className="bg-slate-50 rounded-lg p-3">
                      <div className="text-xs text-slate-500 mb-1">OOV鲁棒性</div>
                      <div className={`text-lg font-bold ${
                        comparison.scorecard.oovRobustness.byteFallbackRate < 0.1 
                          ? 'text-emerald-600' 
                          : 'text-amber-600'
                      }`}>
                        {(1 - comparison.scorecard.oovRobustness.byteFallbackRate).toFixed(2)}
                      </div>
                      <div className="text-xs text-slate-400">覆盖率</div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // 渲染分布象限图
  const renderDistributionQuadrant = () => {
    if (vectorWeights.length === 0 || densityInfos.length === 0) return null;

    // 准备 ECharts 数据
    const scatterData = vectorWeights.map((vw, index) => {
      const density = densityInfos[index];
      const frequency = 1 / (vw.tokenId + 1);
      return [frequency, vw.vectorMagnitude, vw.token, density?.density || 1];
    });

    const option = {
      title: {
        text: 'Token 分布象限图',
        subtext: '分析语义权重与频率的关系',
        left: 'center',
        textStyle: { fontSize: 14, fontWeight: 'bold' },
        subtextStyle: { fontSize: 11 }
      },
      tooltip: {
        trigger: 'item',
        formatter: (params: any) => {
          return `<div style="font-family: monospace;">
            <strong>${params.data[2]}</strong><br/>
            频率: ${params.data[0].toFixed(4)}<br/>
            权重: ${params.data[1].toFixed(3)}<br/>
            密度: ${params.data[3].toFixed(2)}
          </div>`;
        }
      },
      grid: {
        left: '15%',
        right: '15%',
        bottom: '15%'
      },
      xAxis: {
        type: 'value',
        name: 'Token 频率',
        nameLocation: 'middle',
        nameGap: 30,
        splitLine: { lineStyle: { type: 'dashed' } }
      },
      yAxis: {
        type: 'value',
        name: '向量权重',
        nameLocation: 'middle',
        nameGap: 50,
        splitLine: { lineStyle: { type: 'dashed' } }
      },
      series: [{
        type: 'scatter',
        data: scatterData,
        symbolSize: (data: number[]) => {
          const density = data[3] || 1;
          return Math.max(8, Math.min(25, density * 15));
        },
        itemStyle: {
          color: (params: any) => {
            const weight = params.data[1];
            if (weight > 0.8) return '#6366f1'; // indigo
            if (weight > 0.6) return '#8b5cf6'; // violet
            if (weight > 0.4) return '#a855f7'; // purple
            return '#d946ef'; // fuchsia
          },
          opacity: 0.8
        },
        label: {
          show: true,
          position: 'top',
          formatter: (params: any) => params.data[2],
          fontSize: 10,
          color: '#64748b'
        }
      }],
      visualMap: {
        show: true,
        min: 0,
        max: 1.5,
        dimension: 1,
        inRange: {
          color: ['#e2e8f0', '#6366f1']
        },
        right: 10,
        top: 'center',
        text: ['高权重', '低权重'],
        textStyle: { fontSize: 10 }
      }
    };

    return (
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
          <svg className="w-5 h-5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
          </svg>
          语义分布分析
        </h3>
        <div style={{ width: '100%', height: '400px' }}>
          <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />
        </div>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div className="bg-indigo-50 rounded-lg p-3 text-center">
            <div className="text-indigo-600 font-semibold mb-1">高权重 Token</div>
            <div className="text-slate-500">位于上方，语义贡献大</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-3 text-center">
            <div className="text-purple-600 font-semibold mb-1">高频 Token</div>
            <div className="text-slate-500">位于右侧，出现频繁</div>
          </div>
          <div className="bg-fuchsia-50 rounded-lg p-3 text-center">
            <div className="text-fuchsia-600 font-semibold mb-1">大点</div>
            <div className="text-slate-500">高密度，编码效率高</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-3 text-center">
            <div className="text-slate-600 font-semibold mb-1">小点</div>
            <div className="text-slate-500">低密度，可能碎片化</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* 语义密度警告 */}
      {renderWarningsPanel()}
      
      {/* 瀑布流视图 */}
      <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-6">
        {renderWaterfallView()}
      </div>

      {/* 模型对比 */}
      {modelComparisons.length > 0 && (
        <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-6">
          {renderModelComparison()}
      </div>
      )}

      {/* 分布象限图 */}
      <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-6">
        {renderDistributionQuadrant()}
      </div>
    </div>
  );
}
