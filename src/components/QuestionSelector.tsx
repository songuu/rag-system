'use client';

import React from 'react';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  queryAnalysis?: any;
}

interface QuestionSelectorProps {
  messages: Message[];
  viewingAnalysisFor: string | null;
  onSelect: (messageId: string | null) => void;
}

export default function QuestionSelector({ messages, viewingAnalysisFor, onSelect }: QuestionSelectorProps) {
  const userMessagesWithAnalysis = messages.filter(m => m.type === 'user' && m.queryAnalysis);
  
  if (userMessagesWithAnalysis.length === 0) return null;
  
  return (
    <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-gray-700">
          <i className="fas fa-list mr-2"></i>
          选择要查看的问题分析:
        </label>
        {viewingAnalysisFor && (
          <button
            onClick={() => onSelect(null)}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            <i className="fas fa-times mr-1"></i>清除
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {userMessagesWithAnalysis.map((msg) => (
          <button
            key={msg.id}
            onClick={() => onSelect(viewingAnalysisFor === msg.id ? null : msg.id)}
            className={`text-xs px-3 py-1.5 rounded transition-colors ${
              viewingAnalysisFor === msg.id
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
            }`}
          >
            {msg.content.substring(0, 30)}
            {msg.content.length > 30 ? '...' : ''}
          </button>
        ))}
      </div>
    </div>
  );
}