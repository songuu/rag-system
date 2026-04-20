'use client';

import React, { useEffect, useRef, useState } from 'react';

interface ChatMessage {
  id: string;
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
  modelOverride?: import('@/lib/mirofish/types').ModelOverride | null;
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 头像组件：Agent 用紫色渐变，用户用蓝灰色 */
function Avatar({ variant, name }: { variant: 'user' | 'assistant'; name?: string }) {
  if (variant === 'user') {
    return (
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center flex-shrink-0">
        <span className="text-[11px] font-bold text-white">U</span>
      </div>
    );
  }
  const initial = name ? name.charAt(0).toUpperCase() : 'A';
  return (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center flex-shrink-0">
      <span className="text-[11px] font-bold text-white">{initial}</span>
    </div>
  );
}

/** 脉冲打字动画 */
function TypingIndicator() {
  return (
    <div className="flex items-end gap-2">
      <Avatar variant="assistant" name="R" />
      <div className="bg-white/[0.04] border border-white/[0.06] rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1.5 items-center">
          <span className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
          <span className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" style={{ animationDelay: '200ms' }} />
          <span className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" style={{ animationDelay: '400ms' }} />
        </div>
      </div>
    </div>
  );
}

/** 空状态：居中大 emoji + 旋转装饰环 */
function EmptyState({ mode }: { mode: 'chat' | 'interview' }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-20">
      {/* 旋转装饰环 */}
      <div className="relative w-28 h-28 flex items-center justify-center mb-6">
        <div className="absolute inset-0 rounded-full border border-dashed border-purple-500/30 animate-spin" style={{ animationDuration: '12s' }} />
        <div className="absolute inset-2 rounded-full border border-white/[0.06]" />
        <span className="text-5xl">
          {mode === 'chat' ? '💬' : '🎙️'}
        </span>
      </div>
      <p className="text-white/40 text-sm">
        {mode === 'chat'
          ? '向 ReportAgent 提问，深入了解模拟结果'
          : '选择 Agent 并提问，或使用批量采访模式'}
      </p>
    </div>
  );
}

export default function Step5Interaction({ simulationId, reportId, agents, modelOverride }: Step5Props) {
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

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  });

  // 与 ReportAgent 对话
  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;

    const question = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { id: generateMessageId(), role: 'user', content: question }]);
    setChatLoading(true);

    try {
      const response = await fetch('/api/mirofish/interaction/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_id: reportId,
          question,
          history: chatMessages.map(m => ({ role: m.role, content: m.content })),
          modelOverride: modelOverride || undefined,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setChatMessages(prev => [...prev, { id: generateMessageId(), role: 'assistant', content: data.answer }]);
      } else {
        setChatMessages(prev => [...prev, { id: generateMessageId(), role: 'assistant', content: `Error: ${data.error}` }]);
      }
    } catch {
      setChatMessages(prev => [...prev, { id: generateMessageId(), role: 'assistant', content: 'Network error' }]);
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
          modelOverride: modelOverride || undefined,
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
      // 忽略网络错误
    } finally {
      setInterviewLoading(false);
      setInterviewQuestion('');
    }
  };

  const selectedAgentProfile = agents.find(a => a.entity_id === selectedAgent);

  const quickQuestions = activeTab === 'chat'
    ? [
        { id: 'q-chat-1', text: '总结主要的舆论趋势' },
        { id: 'q-chat-2', text: '哪些Agent最活跃？' },
        { id: 'q-chat-3', text: '存在明显的意见对立吗？' },
        { id: 'q-chat-4', text: '如果加入新的变量会怎样？' },
      ]
    : [
        { id: 'q-int-1', text: '你对这个话题怎么看？' },
        { id: 'q-int-2', text: '你觉得其他人的观点有道理吗？' },
        { id: 'q-int-3', text: '如果政策改变，你会改变立场吗？' },
        { id: 'q-int-4', text: '你最担心什么？' },
      ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* 左侧控制面板 */}
      <div className="space-y-4">
        {/* Tab 切换：带底部指示条 */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <h3 className="text-[11px] font-medium text-white/40 uppercase tracking-wider mb-3">交互模式</h3>
          <div className="relative flex gap-1 p-1 rounded-lg bg-white/[0.03]">
            {/* 底部指示条 */}
            <div
              className="absolute bottom-1 h-[2px] bg-gradient-to-r from-purple-500 to-violet-500 rounded-full transition-all duration-300"
              style={{
                left: activeTab === 'chat' ? 'calc(0% + 4px)' : 'calc(50% + 4px)',
                width: 'calc(50% - 8px)',
              }}
            />
            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-all duration-200 ${
                activeTab === 'chat'
                  ? 'text-white bg-white/[0.06]'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              报告对话
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('interview')}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-all duration-200 ${
                activeTab === 'interview'
                  ? 'text-white bg-white/[0.06]'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              Agent 采访
            </button>
          </div>
        </div>

        {/* 采访模式：Agent 卡片列表 */}
        {activeTab === 'interview' && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <h3 className="text-[11px] font-medium text-white/40 uppercase tracking-wider mb-3">采访设置</h3>

            {/* 批量模式开关 */}
            <label className="flex items-center gap-2 mb-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={batchMode}
                onChange={e => setBatchMode(e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-white/[0.04] text-purple-500 focus:ring-purple-500/50 focus:ring-offset-0"
              />
              <span className="text-[12px] text-white/60 group-hover:text-white/80 transition-colors">
                批量采访所有 Agent
              </span>
            </label>

            {/* Agent 卡片选择 */}
            {!batchMode && (
              <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
                {agents.map(agent => {
                  const isSelected = selectedAgent === agent.entity_id;
                  return (
                    <button
                      type="button"
                      key={agent.entity_id}
                      onClick={() => setSelectedAgent(agent.entity_id)}
                      className={`w-full flex items-center gap-2.5 p-2.5 rounded-lg text-left transition-all duration-200 ${
                        isSelected
                          ? 'bg-purple-500/10 border border-purple-500/40 shadow-[0_0_12px_rgba(168,85,247,0.15)]'
                          : 'border border-white/[0.04] hover:border-white/[0.1] hover:bg-white/[0.03]'
                      }`}
                    >
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                        isSelected
                          ? 'bg-gradient-to-br from-purple-500 to-violet-600'
                          : 'bg-white/[0.06]'
                      }`}>
                        <span className={`text-[10px] font-bold ${isSelected ? 'text-white' : 'text-white/50'}`}>
                          {(agent.full_name || agent.entity_name).charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={`text-[12px] font-medium truncate ${isSelected ? 'text-white' : 'text-white/70'}`}>
                          {agent.full_name || agent.entity_name}
                        </p>
                        <p className="text-[10px] text-white/30 truncate">
                          {agent.occupation || agent.entity_type}
                        </p>
                      </div>
                      {isSelected && (
                        <div className="w-1.5 h-1.5 rounded-full bg-purple-400 flex-shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 快捷问题 */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <h3 className="text-[11px] font-medium text-white/40 uppercase tracking-wider mb-3">快捷问题</h3>
          <div className="space-y-1">
            {quickQuestions.map(q => (
              <button
                type="button"
                key={q.id}
                onClick={() => {
                  if (activeTab === 'chat') {
                    setChatInput(q.text);
                  } else {
                    setInterviewQuestion(q.text);
                  }
                }}
                className="w-full text-left px-3 py-2 rounded-lg text-[11px] text-white/40 hover:text-white hover:bg-white/[0.04] transition-all duration-150"
              >
                {q.text}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 右侧交互区域 */}
      <div className="lg:col-span-3">
        {activeTab === 'chat' ? (
          /* 报告对话 */
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] h-[600px] flex flex-col overflow-hidden">
            {/* 头部 */}
            <div className="px-5 py-4 border-b border-white/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center">
                  <span className="text-[11px] font-bold text-white">R</span>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-white">ReportAgent</h3>
                  <p className="text-[10px] text-white/40">基于分析报告回答问题，支持深度追问和假设分析</p>
                </div>
              </div>
            </div>

            {/* 消息区域 */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {chatMessages.length === 0 && !chatLoading && (
                <EmptyState mode="chat" />
              )}
              {chatMessages.map(msg => (
                <div
                  key={msg.id}
                  className={`flex items-end gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                >
                  <Avatar variant={msg.role} name={msg.role === 'assistant' ? 'R' : undefined} />
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
                      msg.role === 'user'
                        ? 'bg-gradient-to-r from-purple-600 to-violet-600 text-white rounded-br-sm'
                        : 'bg-white/[0.04] border border-white/[0.06] text-white/90 rounded-bl-sm'
                    }`}
                  >
                    <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                  </div>
                </div>
              ))}
              {chatLoading && <TypingIndicator />}
              <div ref={chatEndRef} />
            </div>

            {/* 输入区域 */}
            <div className="px-5 py-4 border-t border-white/[0.06]">
              <div className="flex gap-3">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendChat()}
                  placeholder="输入问题..."
                  className="flex-1 px-4 py-2.5 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white text-sm placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:shadow-[0_0_0_3px_rgba(168,85,247,0.1)] transition-all duration-200"
                />
                <button
                  type="button"
                  onClick={sendChat}
                  disabled={chatLoading || !chatInput.trim()}
                  className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-violet-600 text-white rounded-xl hover:from-purple-500 hover:to-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-all duration-200 shadow-lg shadow-purple-500/10"
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
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="flex items-center gap-2 mb-3">
                {selectedAgentProfile && !batchMode && (
                  <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-purple-500/10 border border-purple-500/30">
                    <div className="w-4 h-4 rounded-full bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center">
                      <span className="text-[8px] font-bold text-white">
                        {(selectedAgentProfile.full_name || selectedAgentProfile.entity_name).charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <span className="text-[11px] text-purple-300">
                      {selectedAgentProfile.full_name || selectedAgentProfile.entity_name}
                    </span>
                  </div>
                )}
                {batchMode && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30">
                    <span className="text-[11px] text-emerald-300">批量模式 · {agents.length} Agents</span>
                  </div>
                )}
              </div>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={interviewQuestion}
                  onChange={e => setInterviewQuestion(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && conductInterview()}
                  placeholder={batchMode ? '向所有 Agent 提问...' : '向选定 Agent 提问...'}
                  className="flex-1 px-4 py-2.5 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white text-sm placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:shadow-[0_0_0_3px_rgba(168,85,247,0.1)] transition-all duration-200"
                />
                <button
                  type="button"
                  onClick={conductInterview}
                  disabled={interviewLoading || !interviewQuestion.trim() || (!batchMode && !selectedAgent)}
                  className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-violet-600 text-white rounded-xl hover:from-purple-500 hover:to-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-all duration-200 shadow-lg shadow-purple-500/10"
                >
                  {interviewLoading ? '采访中...' : batchMode ? '批量采访' : '采访'}
                </button>
              </div>
            </div>

            {/* 采访结果 */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] min-h-[500px]">
              {interviews.length > 0 ? (
                <div className="p-4 space-y-3">
                  {interviews.map(interview => {
                    const interviewKey = `${interview.agent_id}-${interview.question}-${interview.confidence}`;
                    return (
                      <div
                        key={interviewKey}
                        className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 hover:bg-white/[0.04] transition-colors duration-150"
                      >
                        {/* Agent 头部 */}
                        <div className="flex items-center gap-2.5 mb-3">
                          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center">
                            <span className="text-[10px] font-bold text-white">
                              {interview.agent_name.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <span className="font-medium text-white text-sm">{interview.agent_name}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            interview.sentiment === 'positive'
                              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                              : interview.sentiment === 'negative'
                              ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                              : 'bg-white/[0.06] text-white/50 border border-white/[0.08]'
                          }`}>
                            {interview.sentiment}
                          </span>
                          <span className="text-[10px] text-white/30 ml-auto">
                            confidence {Math.round(interview.confidence * 100)}%
                          </span>
                        </div>
                        {/* 问题 */}
                        <div className="text-[11px] text-purple-400/80 mb-1.5 pl-9">
                          Q: {interview.question}
                        </div>
                        {/* 回答 */}
                        <p className="text-sm text-white/70 leading-relaxed pl-9">
                          {interview.answer}
                        </p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState mode="interview" />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
