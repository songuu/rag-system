'use client';

import React, { useState, useEffect } from 'react';

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
  onReportGenerated: (reportId: string) => void;
  onComplete: () => void;
}

export default function Step4Report({
  simulationId,
  projectId,
  reportId,
  onReportGenerated,
  onComplete,
}: Step4Props) {
  const [report, setReport] = useState<ReportInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState(0);

  // 生成报告
  const generateReport = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/mirofish/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulation_id: simulationId, project_id: projectId }),
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* 左侧导航 */}
      <div className="space-y-4">
        {!reportId && (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
            <h3 className="text-sm font-semibold text-white mb-3">报告生成</h3>
            <p className="text-xs text-slate-400 mb-3">
              ReportAgent 将分析模拟数据，生成包含情感分析、阵营分析、时间线和预测的结构化报告。
            </p>
            <button
              onClick={generateReport}
              disabled={loading}
              className={`w-full py-2 rounded-lg font-medium transition-colors ${
                loading
                  ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : 'bg-purple-600 text-white hover:bg-purple-500'
              }`}
            >
              {loading ? '生成中...' : '生成分析报告'}
            </button>
          </div>
        )}

        {report && report.status === 'completed' && (
          <>
            {/* 章节导航 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-white mb-3">章节目录</h3>
              <div className="space-y-1">
                {report.sections.map((section, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveSection(i)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                      activeSection === i
                        ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                        : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                    }`}
                  >
                    {section.title}
                  </button>
                ))}
              </div>
            </div>

            {/* 关键发现 */}
            {report.key_findings.length > 0 && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-white mb-3">关键发现</h3>
                <ul className="space-y-2">
                  {report.key_findings.map((finding, i) => (
                    <li key={i} className="text-xs text-slate-300 flex gap-2">
                      <span className="text-purple-400 shrink-0">{i + 1}.</span>
                      {finding}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 操作 */}
            <div className="space-y-2">
              <button
                onClick={downloadReport}
                className="w-full py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 text-sm"
              >
                下载 Markdown
              </button>
              <button
                onClick={onComplete}
                className="w-full py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium hover:from-purple-500 hover:to-pink-500"
              >
                下一步: 深度交互 →
              </button>
            </div>
          </>
        )}

        {loading && (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4 text-center">
            <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full mx-auto mb-3" />
            <p className="text-sm text-slate-400">ReportAgent 正在分析模拟数据...</p>
          </div>
        )}

        {error && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">{error}</div>
        )}
      </div>

      {/* 右侧报告内容 */}
      <div className="lg:col-span-3">
        {report && report.status === 'completed' ? (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-6">
            <h2 className="text-2xl font-bold text-white mb-2">{report.title}</h2>
            <p className="text-sm text-slate-400 mb-6">{report.summary}</p>

            {/* 情感趋势图 */}
            {report.sentiment_trend.length > 0 && (
              <div className="mb-6 p-4 bg-slate-700/30 rounded-lg">
                <h4 className="text-sm font-semibold text-white mb-3">情感趋势</h4>
                <div className="flex items-end gap-1 h-20">
                  {report.sentiment_trend.map((entry, i) => {
                    const total = entry.positive + entry.neutral + entry.negative;
                    if (total === 0) return null;
                    const posH = (entry.positive / total) * 100;
                    const negH = (entry.negative / total) * 100;
                    return (
                      <div key={i} className="flex-1 flex flex-col gap-0.5" title={`R${entry.round}`}>
                        <div className="bg-green-500 rounded-t" style={{ height: `${posH * 0.8}px` }} />
                        <div className="bg-gray-500" style={{ height: `${(100 - posH - negH) * 0.8}px` }} />
                        <div className="bg-red-500 rounded-b" style={{ height: `${negH * 0.8}px` }} />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-xs text-slate-500 mt-1">
                  <span>R1</span>
                  <span>R{report.sentiment_trend.length}</span>
                </div>
              </div>
            )}

            {/* 章节内容 */}
            {report.sections[activeSection] && (
              <div>
                <h3 className="text-lg font-semibold text-white mb-3">
                  {report.sections[activeSection].title}
                </h3>
                <div className="prose prose-invert prose-sm max-w-none">
                  {report.sections[activeSection].content.split('\n').map((line, i) => (
                    <p key={i} className="text-slate-300 mb-2">{line}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-12 text-center">
            <div className="text-6xl mb-4">4</div>
            <h3 className="text-xl font-bold text-white mb-2">报告生成</h3>
            <p className="text-slate-400 max-w-md mx-auto">
              ReportAgent 将分析模拟产生的所有数据，包括情感变化、阵营形成、关键转折点，
              生成一份结构化的预测分析报告。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
