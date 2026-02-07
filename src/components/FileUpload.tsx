'use client';

import React, { useRef, useState, useEffect } from 'react';

interface FileUploadProps {
  selectedFiles: File[];
  isUploading: boolean;
  onFileSelect: (files: File[]) => void;
  onUpload: () => void;
}

// 支持的文件扩展名
const SUPPORTED_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.pdf', 
  '.xlsx', '.xls', '.csv', 
  '.docx', '.doc', '.json'
];

// 文件类型图标映射
const FILE_ICONS: Record<string, { icon: string; color: string; label: string }> = {
  '.pdf': { icon: 'fa-file-pdf', color: 'text-red-500', label: 'PDF' },
  '.xlsx': { icon: 'fa-file-excel', color: 'text-green-600', label: 'Excel' },
  // '.xls': { icon: 'fa-file-excel', color: 'text-green-600', label: 'Excel' },
  '.csv': { icon: 'fa-file-csv', color: 'text-green-500', label: 'CSV' },
  '.docx': { icon: 'fa-file-word', color: 'text-blue-600', label: 'Word' },
  // '.doc': { icon: 'fa-file-word', color: 'text-blue-600', label: 'Word' },
  '.md': { icon: 'fa-file-code', color: 'text-purple-500', label: 'Markdown' },
  // '.markdown': { icon: 'fa-file-code', color: 'text-purple-500', label: 'Markdown' },
  '.json': { icon: 'fa-file-code', color: 'text-yellow-600', label: 'JSON' },
  '.txt': { icon: 'fa-file-alt', color: 'text-gray-500', label: 'Text' },
};

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

function getFileInfo(filename: string) {
  const ext = getFileExtension(filename);
  return FILE_ICONS[ext] || { icon: 'fa-file', color: 'text-gray-400', label: '文件' };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function isSupportedFile(filename: string): boolean {
  const ext = getFileExtension(filename);
  return SUPPORTED_EXTENSIONS.includes(ext);
}

export default function FileUpload({ selectedFiles, isUploading, onFileSelect, onUpload }: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [invalidFiles, setInvalidFiles] = useState<string[]>([]);

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
    
    if (e.dataTransfer.files) {
      processFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(Array.from(e.target.files));
    }
  };

  const processFiles = (files: File[]) => {
    const validFiles: File[] = [];
    const invalid: string[] = [];
    
    for (const file of files) {
      if (isSupportedFile(file.name)) {
        validFiles.push(file);
      } else {
        invalid.push(file.name);
      }
    }
    
    setInvalidFiles(invalid);
    
    if (validFiles.length > 0) {
      onFileSelect([...selectedFiles, ...validFiles]);
    }
    
    // 3秒后清除无效文件提示
    if (invalid.length > 0) {
      setTimeout(() => setInvalidFiles([]), 3000);
    }
  };

  const removeFile = (index: number) => {
    const newFiles = [...selectedFiles];
    newFiles.splice(index, 1);
    onFileSelect(newFiles);
  };

  const clearFiles = () => {
    onFileSelect([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // 按文件类型分组统计
  const fileStats = selectedFiles.reduce((acc, file) => {
    const ext = getFileExtension(file.name);
    const info = getFileInfo(file.name);
    if (!acc[info.label]) {
      acc[info.label] = { count: 0, size: 0, color: info.color };
    }
    acc[info.label].count++;
    acc[info.label].size += file.size;
    return acc;
  }, {} as Record<string, { count: number; size: number; color: string }>);

  return (
    <div className="bg-white rounded-lg shadow-sm border">
      <div className="border-b px-6 py-4">
        <h3 className="text-lg font-medium text-gray-900">文档管理</h3>
        <p className="text-sm text-gray-500 mt-1">上传文档到知识库</p>
      </div>
      
      <div className="p-6">
        {/* 支持的文件类型展示 */}
        <div className="mb-4 flex flex-wrap gap-2">
          {Object.entries(FILE_ICONS).slice(0, 6).map(([ext, info]) => (
            <span 
              key={ext}
              className={`inline-flex items-center px-2 py-1 rounded text-xs ${info.color} bg-gray-50 border`}
            >
              <i className={`fas ${info.icon} mr-1`}></i>
              {info.label}
            </span>
          ))}
        </div>

        {/* 拖拽上传区域 */}
        <div 
          className={`file-upload-area rounded-lg p-6 text-center mb-4 cursor-pointer border-2 border-dashed transition-all duration-200 ${
            dragActive 
              ? 'border-blue-500 bg-blue-50 scale-[1.02]' 
              : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
          }`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className={`transition-transform duration-200 ${dragActive ? 'scale-110' : ''}`}>
            <i className={`fas fa-cloud-upload-alt text-4xl mb-3 ${dragActive ? 'text-blue-500' : 'text-gray-400'}`}></i>
          </div>
          <p className="text-sm text-gray-600 mb-2">
            {dragActive ? '释放文件以上传' : '拖拽文件到此处或点击选择'}
          </p>
          <p className="text-xs text-gray-500">
            支持 PDF, Word, Excel, Markdown, TXT, CSV, JSON • 最大 10MB
          </p>
          <input 
            ref={fileInputRef}
            type="file" 
            accept={SUPPORTED_EXTENSIONS.join(',')}
            multiple 
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>

        {/* 无效文件提示 */}
        {invalidFiles.length > 0 && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
            <i className="fas fa-exclamation-circle mr-2"></i>
            以下文件类型不支持: {invalidFiles.join(', ')}
          </div>
        )}
        
        {/* 已选择的文件列表 */}
        {selectedFiles.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">
                已选择 {selectedFiles.length} 个文件
              </span>
              <button
                onClick={clearFiles}
                className="text-xs text-red-500 hover:text-red-700"
              >
                <i className="fas fa-times mr-1"></i>
                清除全部
              </button>
            </div>
            
            {/* 文件类型统计 */}
            <div className="flex flex-wrap gap-2 mb-3">
              {Object.entries(fileStats).map(([label, stats]) => (
                <span 
                  key={label}
                  className={`text-xs px-2 py-1 rounded-full bg-gray-100 ${stats.color}`}
                >
                  {label}: {stats.count} ({formatFileSize(stats.size)})
                </span>
              ))}
            </div>
            
            {/* 文件列表 */}
            <div className="max-h-48 overflow-y-auto space-y-2 border rounded-lg p-2 bg-gray-50">
              {selectedFiles.map((file, index) => {
                const info = getFileInfo(file.name);
                return (
                  <div 
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between p-2 bg-white rounded border hover:shadow-sm transition-shadow"
                  >
                    <div className="flex items-center min-w-0 flex-1">
                      <i className={`fas ${info.icon} ${info.color} mr-2 flex-shrink-0`}></i>
                      <span className="text-sm text-gray-700 truncate" title={file.name}>
                        {file.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                      <span className="text-xs text-gray-400">
                        {formatFileSize(file.size)}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFile(index);
                        }}
                        className="text-gray-400 hover:text-red-500 transition-colors p-1"
                        title="移除文件"
                      >
                        <i className="fas fa-times text-xs"></i>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        
        {/* 上传按钮 */}
        <button 
          onClick={onUpload}
          disabled={selectedFiles.length === 0 || isUploading}
          className={`w-full px-4 py-3 rounded-lg font-medium transition-all duration-200 ${
            selectedFiles.length === 0 || isUploading
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-gradient-to-r from-green-500 to-green-600 text-white hover:from-green-600 hover:to-green-700 shadow-md hover:shadow-lg'
          }`}
        >
          {isUploading ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>
              上传处理中...
            </>
          ) : (
            <>
              <i className="fas fa-upload mr-2"></i>
              上传 {selectedFiles.length > 0 ? `${selectedFiles.length} 个文件` : '文件'}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
