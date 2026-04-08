'use client';

import React, { useState } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface InterviewResponse {
  agent_id: string;
  agent_name: string;
  question: string;
  answer: string;
  sentiment: string;
  confidence: number;
}

interface AgentProfile {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  full_name: string;
  occupation?: string;
}

interface Step5Props {
  simulationId: string;
  reportId: string;
  agents: AgentProfile[];
}

export default function Step5Interaction({ simulationId, reportId, agents }: Step5Props) {
  const [activeTab, setActiveTab] = useState<'chat' | 'interview'>('chat');

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  // Interview state
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [interviewQuestion, setInterviewQuestion] = useState('');
  const [interviews, setInterviews] = useState<InterviewResponse[]>([]);
  const [interviewLoading, setInterviewLoading] = useState(false);
  const [batchMode, setBatchMode] = useState(false);

  // 与 ReportAgent 对话
  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;

    const question = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: question }]);
    setChatLoading(true);

    try {
      const response = await fetch('/api/mirofish/interaction/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_id: reportId,
          question,
          history: chatMessages,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setChatMessages(prev => [...prev, { role: 'assistant', content: data.answer }]);
      } else {
        setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${data.error}` }]);
      }
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Network error' }]);
    } finally {
      setChatLoading(false);
    }
  };

  // 采访 Agent
  const conductInterview = async () => {
    if (!interviewQuestion.trim() || interviewLoading) return;
    if (!batchMode && !selectedAgent) return;

    setInterviewLoading(true);

    try {
      const response = await fetch('/api/mirofish/interaction/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          simulation_id: simulationId,
          agent_id: batchMode ? undefined : selectedAgent,
          question: interviewQuestion,
          batch: batchMode,
        }),
      });

      const data = await response.json();
      if (data.success) {
        if (batchMode && data.responses) {
          setInterviews(prev => [...prev, ...data.responses]);
        } else if (data.response) {
          setInterviews(prev => [...prev, data.response]);
        }
      }
    } catch {
      // 忽略
    } finally {
      setInterviewLoading(false);
      setInterviewQuestion('');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* 左侧控制 */}
      <div className="space-y-4">
        {/* 模式切换 */}
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-white mb-3">交互模式</h3>
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab('chat')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'chat'
                  ? 'bg-purple-600 text-white'
                  : 'bg-slate-700 text-slate-400 hover:text-white'
              }`}
            >
              报告对话
            </button>
            <button
              onClick={() => setActiveTab('interview')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'interview'
                  ? 'bg-purple-600 text-white'
                  : 'bg-slate-700 text-slate-400 hover:text-white'
              }`}
            >
              Agent采访
            </button>
          </div>
        </div>

        {/* 采访模式配置 */}
        {activeTab === 'interview' && (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
            <h3 className="text-sm font-semibold text-white mb-3">采访设置</h3>

            {/* 批量模式 */}
            <label className="flex items-center gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={batchMode}
                onChange={e => setBatchMode(e.target.checked)}
                className="rounded border-slate-500 text-purple-500"
              />
              <span className="text-sm text-slate-300">批量采访所有Agent</span>
            </label>

            {/* Agent 选择 */}
            {!batchMode && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">选择Agent</label>
                <select
                  value={selectedAgent}
                  onChange={e => setSelectedAgent(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="">选择Agent...</option>
                  {agents.map(agent => (
                    <option key={agent.entity_id} value={agent.entity_id}>
                      {agent.full_name || agent.entity_name} ({agent.entity_type})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* 快捷问题 */}
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-white mb-3">快捷问题</h3>
          <div className="space-y-1">
            {(activeTab === 'chat'
              ? [
                  '总结主要的舆论趋势',
                  '哪些Agent最活跃？',
                  '存在明显的意见对立吗？',
                  '如果加入新的变量会怎样？',
                ]
              : [
                  '你对这个话题怎么看？',
                  '你觉得其他人的观点有道理吗？',
                  '如果政策改变，你会改变立场吗？',
                  '你最担心什么？',
                ]
            ).map((q, i) => (
              <button
                key={i}
                onClick={() => {
                  if (activeTab === 'chat') {
                    setChatInput(q);
                  } else {
                    setInterviewQuestion(q);
                  }
                }}
                className="w-full text-left px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 右侧交互区域 */}
      <div className="lg:col-span-3">
        {activeTab === 'chat' ? (
          /* 报告对话 */
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 h-[600px] flex flex-col">
            <div className="p-4 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-white">与 ReportAgent 对话</h3>
              <p className="text-xs text-slate-400">基于分析报告回答问题，支持深度追问和假设分析</p>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-3">
              {chatMessages.length === 0 && (
                <div className="text-center py-12 text-slate-500">
                  <div className="text-4xl mb-2">5</div>
                  <p className="text-sm">向 ReportAgent 提问，深入了解模拟结果</p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg p-3 ${
                      msg.role === 'user'
                        ? 'bg-purple-600 text-white'
                        : 'bg-slate-700 text-slate-200'
                    }`}
                  >
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-slate-700 rounded-lg p-3">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-slate-700">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendChat()}
                  placeholder="输入问题..."
                  className="flex-1 px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <button
                  onClick={sendChat}
                  disabled={chatLoading || !chatInput.trim()}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Agent 采访 */
          <div className="space-y-4">
            {/* 采访输入 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={interviewQuestion}
                  onChange={e => setInterviewQuestion(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && conductInterview()}
                  placeholder={batchMode ? '向所有Agent提问...' : '向选定Agent提问...'}
                  className="flex-1 px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <button
                  onClick={conductInterview}
                  disabled={interviewLoading || !interviewQuestion.trim() || (!batchMode && !selectedAgent)}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                >
                  {interviewLoading ? '采访中...' : batchMode ? '批量采访' : '采访'}
                </button>
              </div>
            </div>

            {/* 采访结果 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 min-h-[500px]">
              {interviews.length > 0 ? (
                <div className="p-4 space-y-3">
                  {interviews.map((interview, i) => (
                    <div key={i} className="bg-slate-700/30 rounded-lg p-4 border border-slate-600/50">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="font-medium text-white text-sm">{interview.agent_name}</span>
                        <span className={`px-1.5 py-0.5 rounded text-xs ${
                          interview.sentiment === 'positive' ? 'bg-green-500/20 text-green-300' :
                          interview.sentiment === 'negative' ? 'bg-red-500/20 text-red-300' :
                          'bg-slate-600 text-slate-300'
                        }`}>
                          {interview.sentiment}
                        </span>
                        <span className="text-xs text-slate-500">
                          confidence: {Math.round(interview.confidence * 100)}%
                        </span>
                      </div>
                      <div className="text-xs text-purple-400 mb-1">Q: {interview.question}</div>
                      <p className="text-sm text-slate-300">{interview.answer}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-20 text-slate-500">
                  <div className="text-4xl mb-2">5</div>
                  <p className="text-sm">选择Agent并提问，或使用批量采访模式</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
