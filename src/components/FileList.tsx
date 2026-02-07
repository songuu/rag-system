'use client';

import React from 'react';

interface FileInfo {
  id?: string;
  name: string;
  extension?: string;  // 原始文件扩展名
  size: number;
  contentLength?: number;  // 解析后文本长度
  modified: string;
  parseMethod?: string;
  pages?: number;
  _storedFilename?: string;   // 存储的原始文件名（内部用）
  _parsedFilename?: string;   // 解析后的文件名（内部用）
}

interface FileListProps {
  files: FileInfo[];
  onRefresh: () => void;
  onDelete: (filename: string) => void;
  formatFileSize: (bytes: number) => string;
}

// 文件类型图标和颜色映射
const FILE_TYPE_MAP: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  '.pdf': { icon: 'fa-file-pdf', color: 'text-red-500', bg: 'bg-red-50', label: 'PDF' },
  '.xlsx': { icon: 'fa-file-excel', color: 'text-green-600', bg: 'bg-green-50', label: 'Excel' },
  '.xls': { icon: 'fa-file-excel', color: 'text-green-600', bg: 'bg-green-50', label: 'Excel' },
  '.csv': { icon: 'fa-file-csv', color: 'text-green-500', bg: 'bg-green-50', label: 'CSV' },
  '.docx': { icon: 'fa-file-word', color: 'text-blue-600', bg: 'bg-blue-50', label: 'Word' },
  '.doc': { icon: 'fa-file-word', color: 'text-blue-600', bg: 'bg-blue-50', label: 'Word' },
  '.md': { icon: 'fa-file-code', color: 'text-purple-500', bg: 'bg-purple-50', label: 'MD' },
  '.markdown': { icon: 'fa-file-code', color: 'text-purple-500', bg: 'bg-purple-50', label: 'MD' },
  '.json': { icon: 'fa-file-code', color: 'text-yellow-600', bg: 'bg-yellow-50', label: 'JSON' },
  '.txt': { icon: 'fa-file-alt', color: 'text-gray-500', bg: 'bg-gray-50', label: 'TXT' },
};

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

function getFileTypeInfo(file: FileInfo) {
  // 优先使用 extension 字段（新版本），否则从文件名提取
  const ext = file.extension || getFileExtension(file.name);
  return FILE_TYPE_MAP[ext] || { icon: 'fa-file', color: 'text-gray-400', bg: 'bg-gray-50', label: '文件' };
}

function getFileTypeLabel(file: FileInfo): string {
  const ext = file.extension || getFileExtension(file.name);
  return FILE_TYPE_MAP[ext]?.label || ext.slice(1).toUpperCase() || '文件';
}

export default function FileList({ files, onRefresh, onDelete, formatFileSize }: FileListProps) {
  // 按文件类型分组统计
  const fileStats = files.reduce((acc, file) => {
    const label = getFileTypeLabel(file);
    if (!acc[label]) {
      acc[label] = { count: 0, size: 0 };
    }
    acc[label].count++;
    acc[label].size += file.size;
    return acc;
  }, {} as Record<string, { count: number; size: number }>);

  return (
    <div className="bg-white rounded-lg shadow-sm border">
      <div className="border-b px-6 py-4 flex justify-between items-center">
        <div>
          <h3 className="text-lg font-medium text-gray-900">已上传文件</h3>
          <p className="text-sm text-gray-500 mt-1">管理知识库中的文档</p>
        </div>
        <button 
          onClick={onRefresh}
          className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          title="刷新列表"
        >
          <i className="fas fa-sync-alt"></i>
        </button>
      </div>
      
      <div className="p-6">
        {files.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">
            <i className="fas fa-folder-open text-4xl mb-3 text-gray-300"></i>
            <p>暂无文件</p>
            <p className="text-xs mt-1">支持 PDF, Word, Excel, Markdown, TXT 等格式</p>
          </div>
        ) : (
          <>
            {/* 文件类型统计 */}
            {Object.keys(fileStats).length > 1 && (
              <div className="flex flex-wrap gap-2 mb-4 pb-4 border-b">
                {Object.entries(fileStats).map(([label, stats]) => (
                  <span 
                    key={label}
                    className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600"
                  >
                    {label}: {stats.count}
                  </span>
                ))}
                <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-600 font-medium">
                  共 {files.length} 个文件
                </span>
              </div>
            )}

            {/* 文件列表 */}
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {files.map((file, index) => {
                const typeInfo = getFileTypeInfo(file);
                const typeLabel = getFileTypeLabel(file);
                // 用于删除的标识符：优先使用 id，否则使用文件名
                const deleteKey = file.id || file.name;
                
                return (
                  <div 
                    key={file.id || index} 
                    className={`flex items-center justify-between p-3 rounded-lg ${typeInfo.bg} hover:shadow-sm transition-all group`}
                  >
                    <div className="flex items-center min-w-0 flex-1">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${typeInfo.color} bg-white shadow-sm mr-3 flex-shrink-0`}>
                        <i className={`fas ${typeInfo.icon} text-lg`}></i>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate" title={file.name}>
                          {file.name}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${typeInfo.color} bg-white/50`}>
                            {typeLabel}
                          </span>
                          <span className="text-xs text-gray-500">
                            {formatFileSize(file.size)}
                          </span>
                          {file.pages && (
                            <span className="text-xs text-gray-400">
                              {file.pages} 页
                            </span>
                          )}
                          {file.contentLength && (
                            <span className="text-xs text-gray-400" title="解析后文本长度">
                              {file.contentLength > 1000 
                                ? `${(file.contentLength / 1000).toFixed(1)}K 字符` 
                                : `${file.contentLength} 字符`}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => onDelete(deleteKey)}
                      className="ml-2 p-2 text-gray-400 hover:text-red-600 hover:bg-white rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                      title="删除文件"
                    >
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
