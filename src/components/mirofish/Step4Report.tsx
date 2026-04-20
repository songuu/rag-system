'use client';

import React, { useState, useEffect } from 'react';
import type { ModelOverride } from '@/lib/mirofish/types';

interface ReportSection {
  index: number;
  title: string;
  content: string;
  type: string;
}

interface ReportInfo {
  report_id: string;
  status: string;
  title: string;
  summary: string;
  sections: ReportSection[];
  key_findings: string[];
  sentiment_trend: Array<{ round: number; positive: number; neutral: number; negative: number }>;
}

interface Step4Props {
  simulationId: string;
  projectId: string;
  reportId: string | null;
  modelOverride?: ModelOverride | null;
  onReportGenerated: (reportId: string) => void;
  onComplete: () => void;
}

export default function Step4Report({
  simulationId,
  projectId,
  reportId,
  modelOverride,
  onReportGenerated,
  onComplete,
}: Step4Props) {
  const [report, setReport] = useState<ReportInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  // 生成报告
  const generateReport = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/mirofish/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulation_id: simulationId, project_id: projectId, modelOverride: modelOverride || undefined }),
      });

      const data = await response.json();
      if (!data.success) throw new Error(data.error);

      onReportGenerated(data.report_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成报告失败');
      setLoading(false);
    }
  };

  // 轮询报告状态
  useEffect(() => {
    if (!reportId) return;

    const poll = async () => {
      try {
        const response = await fetch(`/api/mirofish/report/${reportId}`);
        const data = await response.json();

        if (data.success && data.report) {
          setReport(data.report);
          if (data.report.status === 'completed' || data.report.status === 'failed') {
            setLoading(false);
          }
        }
      } catch {
        // 忽略
      }
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [reportId]);

  // 下载 Markdown
  const downloadReport = () => {
    if (!reportId) return;
    window.open(`/api/mirofish/report/${reportId}?action=download`, '_blank');
  };

  const toggleSection = (title: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(title)) {
        next.delete(title);
      } else {
        next.add(title);
      }
      return next;
    });
  };

  const isCompleted = report && report.status === 'completed';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* 左侧控制面板 */}
      <div className="space-y-5 lg:col-span-2">
        {/* 状态指示 */}
        <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-3">
          {(['generate', 'analyze', 'done'] as const).map((p, i) => {
            const isDone = isCompleted ||
              (p === 'generate' && !!reportId);
            const isCur = !isCompleted && (
              (p === 'generate' && !reportId && !loading) ||
              (p === 'analyze' && loading)
            );
            const labels = ['生成报告', '分析中', '完成'];
            return (
              <React.Fragment key={p}>
                {i > 0 && <div className={`h-px flex-1 ${isDone ? 'bg-emerald-500/50' : 'bg-white/10'}`} />}
                <div className="flex items-center gap-2">
                  <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                    isDone ? 'bg-emerald-500 text-white' : isCur ? 'bg-purple-500/20 text-purple-300 ring-2 ring-purple-500/40' : 'bg-white/5 text-white/30'
                  }`}>
                    {isDone ? '✓' : i + 1}
                  </div>
                  <span className={`text-xs font-medium ${isDone ? 'text-emerald-300' : isCur ? 'text-white' : 'text-white/30'}`}>
                    {labels[i]}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* 报告生成卡片 */}
        {!reportId && (
          <div className="rounded-2xl border border-purple-500/30 bg-purple-500/[0.04] p-5 shadow-lg shadow-purple-500/5">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/20 text-sm font-bold text-purple-400">
                4
              </div>
              <div>
                <div className="text-sm font-semibold text-white">生成分析报告</div>
                <div className="text-[11px] text-white/40">ReportAgent 将分析模拟数据</div>
              </div>
            </div>
            <p className="mb-4 text-[11px] leading-relaxed text-white/50">
              包含情感分析、阵营分析、时间线和预测的结构化报告。
            </p>
            <button
              type="button"
              onClick={generateReport}
              disabled={loading}
              className={`relative w-full overflow-hidden rounded-xl py-2.5 text-sm font-medium transition-all ${
                loading
                  ? 'cursor-not-allowed bg-white/5 text-white/30'
                  : 'bg-gradient-to-r from-purple-600 to-violet-600 text-white shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30'
              }`}
            >
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-300 border-t-transparent" />
                </div>
              )}
              <span className={loading ? 'opacity-0' : ''}>
                生成分析报告
              </span>
            </button>
          </div>
        )}

        {/* 加载中状态 */}
        {loading && (
          <div className="rounded-2xl border border-purple-500/20 bg-purple-500/[0.03] p-5">
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="relative h-12 w-12">
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-purple-500/30 border-t-purple-400" />
                <div className="absolute inset-2 animate-spin rounded-full border-2 border-violet-500/20 border-b-violet-400" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
              </div>
              <div className="text-center">
                <div className="text-sm font-medium text-purple-300">ReportAgent 分析中</div>
                <div className="mt-1 text-[10px] text-white/30">正在处理模拟数据并生成报告...</div>
              </div>
            </div>
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-rose-400" />
              <span className="text-[11px] font-medium text-rose-300">错误</span>
            </div>
            <p className="mt-2 text-xs text-rose-200/80">{error}</p>
          </div>
        )}

        {/* 关键发现 */}
        {isCompleted && report.key_findings.length > 0 && (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
            <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-emerald-400/70">关键发现</div>
            <div className="space-y-2">
              {report.key_findings.map((finding) => (
                <div
                  key={`finding-${finding.slice(0, 20)}`}
                  className="flex items-start gap-2 rounded-xl border border-emerald-500/10 bg-emerald-500/[0.04] p-3"
                >
                  <div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                  <span className="text-[11px] leading-relaxed text-white/70">{finding}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 操作按钮区域 */}
        {isCompleted && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={downloadReport}
              className="w-full rounded-xl border border-white/[0.06] bg-white/[0.03] py-2.5 text-sm font-medium text-white/70 transition-all hover:bg-white/[0.06] hover:text-white"
            >
              下载 Markdown
            </button>
            {/* 下一步 - 空心 gradient 按钮 */}
            <div className="rounded-xl bg-gradient-to-r from-purple-600 to-violet-600 p-px">
              <button
                type="button"
                onClick={onComplete}
                className="w-full rounded-[11px] bg-[#0d0d12] py-3 text-sm font-medium text-white transition-all hover:bg-[#14141a]"
              >
                下一步: 深度交互 →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 右侧报告内容 */}
      <div className="lg:col-span-3">
        {isCompleted ? (
          <div className="space-y-4">
            {/* 报告标题 */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
              <h2 className="text-xl font-bold text-white">{report.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-white/40">{report.summary}</p>
            </div>

            {/* 情绪趋势柱状图 */}
            {report.sentiment_trend.length > 0 && (
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-purple-400/70">情绪趋势</div>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1 text-[10px] text-white/30">
                      <span className="inline-block h-2 w-2 rounded-sm bg-emerald-400" /> 正面
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-white/30">
                      <span className="inline-block h-2 w-2 rounded-sm bg-white/20" /> 中性
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-white/30">
                      <span className="inline-block h-2 w-2 rounded-sm bg-rose-400" /> 负面
                    </span>
                  </div>
                </div>
                <div className="flex items-end gap-1" style={{ height: '100px' }}>
                  {report.sentiment_trend.map((entry) => {
                    const total = entry.positive + entry.neutral + entry.negative;
                    if (total === 0) return null;
                    const posPercent = (entry.positive / total) * 100;
                    const neuPercent = (entry.neutral / total) * 100;
                    const negPercent = (entry.negative / total) * 100;
                    return (
                      <div
                        key={`round-${entry.round}`}
                        className="flex flex-1 flex-col gap-px overflow-hidden rounded-sm"
                        title={`R${entry.round}: +${Math.round(posPercent)}% =${Math.round(neuPercent)}% -${Math.round(negPercent)}%`}
                        style={{ height: '100%' }}
                      >
                        <div
                          className="w-full bg-emerald-400/80 transition-all"
                          style={{ height: `${posPercent}%` }}
                        />
                        <div
                          className="w-full bg-white/10 transition-all"
                          style={{ height: `${neuPercent}%` }}
                        />
                        <div
                          className="w-full bg-rose-400/80 transition-all"
                          style={{ height: `${negPercent}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex justify-between text-[10px] text-white/20">
                  <span>R1</span>
                  <span>R{report.sentiment_trend.length}</span>
                </div>
              </div>
            )}

            {/* 章节 - 可折叠卡片 */}
            <div className="space-y-3">
              {report.sections.map((section) => {
                const isExpanded = expandedSections.has(section.title);
                return (
                  <div
                    key={`section-${section.title}`}
                    className="rounded-2xl border border-white/[0.06] bg-white/[0.02] transition-all"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSection(section.title)}
                      className="flex w-full items-center justify-between p-5 text-left"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/10 text-[11px] font-bold text-purple-300">
                          {section.index + 1}
                        </div>
                        <span className="text-sm font-medium text-white">{section.title}</span>
                      </div>
                      <svg
                        className={`h-4 w-4 text-white/30 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isExpanded && (
                      <div className="border-t border-white/[0.04] px-5 pb-5 pt-4">
                        <div className="mb-2">
                          <span className="rounded-md bg-purple-500/10 px-2 py-0.5 text-[10px] font-medium text-purple-300">
                            {section.type}
                          </span>
                        </div>
                        <div className="space-y-2">
                          {section.content.split('\n').filter(Boolean).map((line) => (
                            <p key={`line-${line.slice(0, 30)}`} className="text-[12px] leading-relaxed text-white/60">
                              {line}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          /* 空状态 */
          <div className="flex h-full min-h-[400px] items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.02]">
            <div className="relative flex flex-col items-center px-8 py-12 text-center">
              {/* 装饰旋转环 */}
              <div className="relative mb-6 h-28 w-28">
                <div className="absolute inset-0 animate-spin rounded-full border border-dashed border-purple-500/20" style={{ animationDuration: '12s' }} />
                <div className="absolute inset-3 animate-spin rounded-full border border-dashed border-violet-500/15" style={{ animationDuration: '8s', animationDirection: 'reverse' }} />
                <div className="absolute inset-6 animate-spin rounded-full border border-dashed border-purple-400/10" style={{ animationDuration: '15s' }} />
                <div className="absolute inset-0 flex items-center justify-center text-5xl">
                  📊
                </div>
              </div>
              <h3 className="text-lg font-bold text-white">报告生成</h3>
              <p className="mt-3 max-w-sm text-[12px] leading-relaxed text-white/40">
                ReportAgent 将分析模拟产生的所有数据，包括情感变化、阵营形成、关键转折点，
                生成一份结构化的预测分析报告。
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
