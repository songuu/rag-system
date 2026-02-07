'use client';

import Link from 'next/link';
import SelfRAGVisualization from '@/components/SelfRAGVisualization';

export default function SelfRAGPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
      {/* 导航栏 */}
      <nav className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <Link href="/" className="text-gray-600 hover:text-gray-900 transition-colors flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                返回主页
              </Link>
              <span className="text-gray-300">|</span>
              <span className="text-lg font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                🔄 Self-RAG 可视化系统
              </span>
            </div>
            
            <div className="flex items-center gap-4">
              <Link 
                href="/domain-vectors"
                className="text-sm text-gray-600 hover:text-indigo-600 transition-colors"
              >
                领域向量
              </Link>
              <Link 
                href="/observability"
                className="text-sm text-gray-600 hover:text-indigo-600 transition-colors"
              >
                可观测性
              </Link>
              <Link 
                href="/trace-trie"
                className="text-sm text-gray-600 hover:text-indigo-600 transition-colors"
              >
                Trace Trie
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* 主内容 */}
      <SelfRAGVisualization />
    </div>
  );
}
