'use client';

import React from 'react';

interface RealtimeMonitoringProps {
  showVectorization: boolean;
  vectorizationDetails: any;
  vectorizationProgress: number;
  vectorizationStatus: string;
  showQueryProcessing: boolean;
  queryProcessingStatus: string;
  isLoading: boolean;
  queryAnalysis: any;
  retrievalDetails: any;
}

export default function RealtimeMonitoring({
  showVectorization,
  vectorizationDetails,
  vectorizationProgress,
  vectorizationStatus,
  showQueryProcessing,
  queryProcessingStatus,
  isLoading,
  queryAnalysis,
  retrievalDetails
}: RealtimeMonitoringProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border">
      <div className="border-b px-6 py-4">
        <h3 className="text-lg font-medium text-gray-900">实时监控</h3>
        <p className="text-sm text-gray-500 mt-1">向量化和检索过程</p>
      </div>
      
      <div className="p-6 space-y-4">
        {/* 文档向量化进度 */}
        <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
          <h4 className="text-sm font-medium text-blue-800 mb-2">
            <i className="fas fa-database mr-2"></i>
            文档向量化进度
          </h4>
          {showVectorization && vectorizationDetails ? (
            <>
              <div className="bg-gray-200 rounded-full h-2 mb-2">
                <div 
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                  style={{ width: `${Math.min(100, Math.max(0, vectorizationProgress))}%` }}
                ></div>
              </div>
              <div className="text-xs text-gray-700 space-y-1">
                <div className="flex justify-between">
                  <span>状态:</span>
                  <span className="font-medium">{vectorizationStatus || '处理中...'}</span>
                </div>
                {vectorizationDetails.current && vectorizationDetails.total && (
                  <div className="flex justify-between">
                    <span>进度:</span>
                    <span className="font-medium">
                      {vectorizationDetails.current} / {vectorizationDetails.total}
                    </span>
                  </div>
                )}
                {vectorizationDetails.filename && (
                  <div className="flex justify-between">
                    <span>文件:</span>
                    <span className="font-medium truncate ml-2">{vectorizationDetails.filename}</span>
                  </div>
                )}
                {vectorizationDetails.dimension && (
                  <div className="flex justify-between">
                    <span>向量维度:</span>
                    <span className="font-medium">{vectorizationDetails.dimension}</span>
                  </div>
                )}
                {vectorizationDetails.timeTaken && (
                  <div className="flex justify-between">
                    <span>耗时:</span>
                    <span className="font-medium">{vectorizationDetails.timeTaken}ms</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs text-gray-500 text-center py-2">
              <i className="fas fa-info-circle mr-1"></i>
              等待文档向量化...
            </div>
          )}
        </div>
        
        {/* 查询文本处理进度 */}
        <div className="mb-4 p-3 bg-green-50 rounded-lg border border-green-200">
          <h4 className="text-sm font-medium text-green-800 mb-2">
            <i className="fas fa-search mr-2"></i>
            查询文本处理
          </h4>
          {showQueryProcessing || isLoading ? (
            <div className="bg-white rounded p-3 space-y-2">
              <div className="flex items-center space-x-2">
                {isLoading && <div className="typing-indicator"></div>}
                <span className="text-xs text-gray-700">{queryProcessingStatus || '处理中...'}</span>
              </div>
              {queryAnalysis && (
                <div className="text-xs text-gray-600 space-y-1 mt-2 pt-2 border-t">
                  {queryAnalysis.tokenization && (
                    <div className="flex items-center space-x-2">
                      <i className="fas fa-check-circle text-green-500"></i>
                      <span>词元化完成 ({queryAnalysis.tokenization.tokenCount} 个词元)</span>
                    </div>
                  )}
                  {queryAnalysis.embedding && (
                    <div className="flex items-center space-x-2">
                      <i className="fas fa-check-circle text-green-500"></i>
                      <span>向量化完成 ({queryAnalysis.embedding.embeddingDimension} 维)</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-gray-500 text-center py-2">
              <i className="fas fa-info-circle mr-1"></i>
              等待查询处理...
            </div>
          )}
        </div>
        
        {/* 检索过程概览 */}
        <div className="mb-4 p-3 bg-purple-50 rounded-lg border border-purple-200">
          <h4 className="text-sm font-medium text-purple-800 mb-2">
            <i className="fas fa-list-alt mr-2"></i>
            检索过程
          </h4>
          {retrievalDetails ? (
            <div className="bg-white rounded p-3 text-xs">
              {/* 状态指示器 */}
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                <span className="text-green-700 font-medium">检索完成</span>
              </div>
              
              {/* 快速统计 */}
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="bg-purple-50 rounded p-2 text-center">
                  <div className="text-lg font-bold text-purple-600">
                    {retrievalDetails.searchResults?.length || 0}
                  </div>
                  <div className="text-[10px] text-gray-500">匹配文档</div>
                </div>
                <div className="bg-blue-50 rounded p-2 text-center">
                  <div className="text-lg font-bold text-blue-600">
                    {retrievalDetails.searchTime || 0}ms
                  </div>
                  <div className="text-[10px] text-gray-500">检索耗时</div>
                </div>
              </div>
              
              {/* Top 3 相似度预览 */}
              {retrievalDetails.searchResults && retrievalDetails.searchResults.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">相似度排名</div>
                  {retrievalDetails.searchResults.slice(0, 3).map((result: any, index: number) => {
                    const similarity = (result.similarity || 0) * 100;
                    const barColor = similarity >= 80 ? 'bg-green-500' : 
                                     similarity >= 60 ? 'bg-blue-500' : 
                                     similarity >= 40 ? 'bg-yellow-500' : 'bg-red-500';
                    return (
                      <div key={index} className="flex items-center gap-2">
                        <span className={`w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center ${
                          index === 0 ? 'bg-yellow-100 text-yellow-700' :
                          index === 1 ? 'bg-gray-100 text-gray-600' :
                          'bg-orange-100 text-orange-600'
                        }`}>
                          {index + 1}
                        </span>
                        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div 
                            className={`h-full ${barColor} transition-all duration-500`}
                            style={{ width: `${similarity}%` }}
                          />
                        </div>
                        <span className="w-12 text-right font-mono text-purple-600">
                          {similarity.toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              
              {/* 查看详情提示 */}
              <div className="mt-3 pt-2 border-t border-purple-100 text-center">
                <span className="text-[10px] text-purple-600">
                  ↓ 下方面板查看详细匹配信息
                </span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500 text-center py-4">
              <div className="w-8 h-8 mx-auto mb-2 rounded-full bg-gray-100 flex items-center justify-center">
                <i className="fas fa-search text-gray-400"></i>
              </div>
              等待检索结果...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}