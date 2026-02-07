'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';

// ==================== 类型定义 ====================

interface FileInfo {
  filename: string;
  originalName: string;
  size: number;
  sizeFormatted: string;
  createdAt: string;
  fileInfo: {
    icon: string;
    color: string;
    label: string;
  };
  textFile: string | null;
  isVectorizable: boolean;
}

interface VectorStats {
  collection: string;
  collectionStats: {
    rowCount: number;
    name: string;
    embeddingDimension?: number;
  } | null;
  fileStats: {
    uploadedFiles: number;
    textFiles: number;
  };
  isReady: boolean;
}

interface ReasoningFileManagerProps {
  embeddingModel: string;
  onStatusChange?: (isReady: boolean, docCount: number) => void;
}

// ==================== 文件管理组件 ====================

const ReasoningFileManager: React.FC<ReasoningFileManagerProps> = ({
  embeddingModel,
  onStatusChange
}) => {
  // 状态
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [vectorStats, setVectorStats] = useState<VectorStats | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isVectorizing, setIsVectorizing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');
  const [vectorizeProgress, setVectorizeProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 支持的文件类型
  const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.pdf', '.xlsx', '.xls', '.csv', '.docx', '.doc', '.json'];

  // 加载文件列表和统计
  const loadData = useCallback(async () => {
    try {
      // 并行加载文件列表和向量状态
      const [filesRes, statsRes] = await Promise.all([
        fetch('/api/reasoning-rag/files'),
        fetch('/api/reasoning-rag/vectorize')
      ]);

      const filesData = await filesRes.json();
      const statsData = await statsRes.json();

      if (filesData.success) {
        setFiles(filesData.files || []);
      }

      if (statsData.success) {
        setVectorStats(statsData);
        onStatusChange?.(statsData.isReady, statsData.collectionStats?.rowCount || 0);
      }
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }, [onStatusChange]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 拖放处理
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    const droppedFiles = Array.from(e.dataTransfer.files);
    const validFiles = droppedFiles.filter(f => 
      SUPPORTED_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext))
    );
    setSelectedFiles(prev => [...prev, ...validFiles]);
  };

  // 文件选择
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files);
      setSelectedFiles(prev => [...prev, ...newFiles]);
    }
  };

  // 移除选中的文件
  const removeSelectedFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // 上传文件
  const handleUpload = async () => {
    if (selectedFiles.length === 0) return;

    setIsUploading(true);
    setUploadProgress('正在上传...');
    setError(null);

    try {
      const formData = new FormData();
      selectedFiles.forEach(file => formData.append('files', file));

      const response = await fetch('/api/reasoning-rag/files', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (data.success) {
        setUploadProgress(`成功上传 ${data.results?.length || 0} 个文件`);
        setSelectedFiles([]);
        await loadData();
        
        // 2秒后清除进度消息
        setTimeout(() => setUploadProgress(''), 2000);
      } else {
        throw new Error(data.error || '上传失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setIsUploading(false);
    }
  };

  // 向量化
  const handleVectorize = async () => {
    setIsVectorizing(true);
    setVectorizeProgress('正在向量化...');
    setError(null);

    try {
      const response = await fetch('/api/reasoning-rag/vectorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'vectorize-all',
          embeddingModel
        })
      });

      const data = await response.json();

      if (data.success) {
        setVectorizeProgress(`成功向量化 ${data.totalDocuments || 0} 个文件，共 ${data.totalChunks || 0} 个向量`);
        await loadData();
        
        // 3秒后清除进度消息
        setTimeout(() => setVectorizeProgress(''), 3000);
      } else {
        throw new Error(data.error || '向量化失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '向量化失败');
    } finally {
      setIsVectorizing(false);
    }
  };

  // 删除文件
  const handleDeleteFile = async (filename: string) => {
    if (!confirm(`确定要删除文件 ${filename} 吗？`)) return;

    try {
      const response = await fetch(`/api/reasoning-rag/files?filename=${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });

      const data = await response.json();

      if (data.success) {
        await loadData();
      } else {
        throw new Error(data.error || '删除失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  };

  // 清空向量集合
  const handleClearVectors = async () => {
    if (!confirm('确定要清空所有向量数据吗？此操作不可撤销。')) return;

    try {
      const response = await fetch('/api/reasoning-rag/vectorize', {
        method: 'DELETE'
      });

      const data = await response.json();

      if (data.success) {
        await loadData();
      } else {
        throw new Error(data.error || '清空失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空失败');
    }
  };

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-emerald-500/30 overflow-hidden">
      {/* 标题栏 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-gradient-to-r from-emerald-900/50 to-teal-900/50 hover:from-emerald-900/70 hover:to-teal-900/70 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">📁</span>
          <span className="font-semibold text-white">知识库管理</span>
          {vectorStats?.isReady && (
            <span className="px-2 py-0.5 bg-green-500/30 text-green-300 text-xs rounded-full">
              {vectorStats.collectionStats?.rowCount || 0} 向量
            </span>
          )}
          {!vectorStats?.isReady && files.length > 0 && (
            <span className="px-2 py-0.5 bg-amber-500/30 text-amber-300 text-xs rounded-full">
              待向量化
            </span>
          )}
        </div>
        <svg
          className={`w-5 h-5 text-emerald-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="p-4 space-y-4">
          {/* 错误提示 */}
          {error && (
            <div className="p-3 bg-red-900/30 border border-red-500/30 rounded-lg text-red-300 text-sm">
              ⚠️ {error}
              <button 
                onClick={() => setError(null)}
                className="ml-2 text-red-400 hover:text-red-300"
              >
                ✕
              </button>
            </div>
          )}

          {/* 状态概览 */}
          <div className="grid grid-cols-3 gap-2">
            <div className="p-2 bg-slate-800/50 rounded-lg text-center">
              <div className="text-lg font-bold text-emerald-400">{files.length}</div>
              <div className="text-xs text-gray-500">文件数</div>
            </div>
            <div className="p-2 bg-slate-800/50 rounded-lg text-center">
              <div className="text-lg font-bold text-cyan-400">
                {vectorStats?.collectionStats?.rowCount || 0}
              </div>
              <div className="text-xs text-gray-500">向量数</div>
            </div>
            <div className="p-2 bg-slate-800/50 rounded-lg text-center">
              <div className="text-lg font-bold text-amber-400">
                {vectorStats?.collectionStats?.embeddingDimension || '-'}
              </div>
              <div className="text-xs text-gray-500">维度</div>
            </div>
          </div>

          {/* 上传区域 */}
          <div
            className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
              dragActive 
                ? 'border-emerald-400 bg-emerald-900/20' 
                : 'border-slate-700 hover:border-emerald-600/50'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={SUPPORTED_EXTENSIONS.join(',')}
              onChange={handleFileSelect}
              className="hidden"
            />
            <div className="text-3xl mb-2">📤</div>
            <p className="text-gray-400 text-sm">
              拖放文件到这里，或点击选择
            </p>
            <p className="text-gray-600 text-xs mt-1">
              支持: {SUPPORTED_EXTENSIONS.join(', ')}
            </p>
          </div>

          {/* 待上传文件列表 */}
          {selectedFiles.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm text-gray-400">待上传 ({selectedFiles.length})</div>
              <div className="max-h-24 overflow-y-auto space-y-1">
                {selectedFiles.map((file, idx) => (
                  <div 
                    key={idx}
                    className="flex items-center justify-between p-2 bg-slate-800/50 rounded-lg"
                  >
                    <div className="flex items-center gap-2 text-sm text-gray-300 truncate">
                      <span>📄</span>
                      <span className="truncate">{file.name}</span>
                      <span className="text-gray-500 text-xs">({formatSize(file.size)})</span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeSelectedFile(idx); }}
                      className="text-gray-500 hover:text-red-400 p-1"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              
              <button
                onClick={handleUpload}
                disabled={isUploading}
                className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-600 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {isUploading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    上传中...
                  </>
                ) : (
                  <>📤 上传文件</>
                )}
              </button>
            </div>
          )}

          {/* 上传进度 */}
          {uploadProgress && (
            <div className="p-2 bg-emerald-900/30 border border-emerald-500/30 rounded-lg text-emerald-300 text-sm text-center">
              ✅ {uploadProgress}
            </div>
          )}

          {/* 已上传文件列表 */}
          {files.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">已上传文件</span>
                <button
                  onClick={loadData}
                  className="text-xs text-emerald-400 hover:text-emerald-300"
                >
                  🔄 刷新
                </button>
              </div>
              
              <div className="max-h-40 overflow-y-auto space-y-1">
                {files.map((file, idx) => (
                  <div 
                    key={idx}
                    className="flex items-center justify-between p-2 bg-slate-800/50 rounded-lg group"
                  >
                    <div className="flex items-center gap-2 text-sm truncate flex-1">
                      <span>{file.fileInfo?.icon || '📄'}</span>
                      <span className="text-gray-300 truncate">{file.originalName}</span>
                      <span className="text-gray-500 text-xs">({file.sizeFormatted})</span>
                    </div>
                    <button
                      onClick={() => handleDeleteFile(file.filename)}
                      className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                      title="删除文件"
                    >
                      🗑️
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 向量化操作 */}
          {files.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={handleVectorize}
                disabled={isVectorizing}
                className="w-full py-2 bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-500 hover:to-teal-500 disabled:from-gray-600 disabled:to-gray-600 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {isVectorizing ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    向量化中...
                  </>
                ) : (
                  <>🔮 向量化所有文件</>
                )}
              </button>

              {vectorStats?.isReady && (
                <button
                  onClick={handleClearVectors}
                  className="w-full py-2 bg-slate-700 hover:bg-red-900/50 text-gray-400 hover:text-red-300 rounded-lg transition-colors text-sm"
                >
                  🗑️ 清空向量数据
                </button>
              )}
            </div>
          )}

          {/* 向量化进度 */}
          {vectorizeProgress && (
            <div className="p-2 bg-cyan-900/30 border border-cyan-500/30 rounded-lg text-cyan-300 text-sm text-center">
              ✅ {vectorizeProgress}
            </div>
          )}

          {/* 空状态 */}
          {files.length === 0 && !isUploading && (
            <div className="text-center py-4 text-gray-500 text-sm">
              <p>暂无文件</p>
              <p className="text-xs mt-1">上传文件后可进行向量化</p>
            </div>
          )}

          {/* 提示信息 */}
          <div className="p-3 bg-slate-800/30 rounded-lg">
            <p className="text-xs text-gray-500">
              💡 此知识库独立于主页面，专用于 Reasoning RAG 模式
            </p>
            <p className="text-xs text-gray-600 mt-1">
              集合名称: <code className="text-emerald-400">reasoning_rag_documents</code>
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReasoningFileManager;
