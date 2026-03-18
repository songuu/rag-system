'use client';

import React, { useState } from 'react';
import Link from 'next/link';

// ==================== 类型定义 ====================

interface Ontology {
  entity_types: Array<{
    name: string;
    description: string;
    attributes: Array<{ name: string; type: string; description: string }>;
    examples: string[];
  }>;
  edge_types: Array<{
    name: string;
    description: string;
    source_targets: Array<{ source: string; target: string }>;
    attributes: unknown[];
  }>;
  analysis_summary: string;
}

export default function OntologyPage() {
  const [simulationRequirement, setSimulationRequirement] = useState('');
  const [texts, setTexts] = useState<string[]>([]);
  const [customText, setCustomText] = useState('');
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 添加示例文本
  const addSampleText = () => {
    const sampleTexts = [
      '小米手机用户社区今天炸锅了！有网友曝光称小米新推出的旗舰机存在严重发热问题，引发了大量讨论。许多自称是真实用户的网友纷纷发声，有人指责小米品控有问题，有人则为小米辩护说是竞品恶意抹黑。科技博主"小刚测评"发布了详细测评视频，指出发热问题确实存在但不影响日常使用。',
      '随着事件持续发酵，多个相关方陆续表态。某知名数码博主发文称收到小米法务警告信，引发关于言论自由的讨论。有网友扒出最初曝光者的身份，称其是某竞争对手的员工。双方支持者在社交媒体上展开激烈交锋，舆论场陷入混战。'
    ];
    setTexts(prev => [...prev, ...sampleTexts]);
  };

  // 清除文本
  const clearTexts = () => {
    setTexts([]);
    setCustomText('');
  };

  // 生成本体
  const generateOntology = async () => {
    if (!simulationRequirement.trim()) {
      setError('请输入模拟需求描述');
      return;
    }

    if (texts.length === 0 && !customText.trim()) {
      setError('请提供分析文本内容');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const inputTexts = customText.trim()
        ? [...texts, customText]
        : texts;

      const response = await fetch('/api/mirofish/ontology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texts: inputTexts,
          simulationRequirement: simulationRequirement,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '本体生成失败');
      }

      setOntology(data.ontology);
    } catch (err) {
      setError(err instanceof Error ? err.message : '本体生成失败');
    } finally {
      setLoading(false);
    }
  };

  // 下载本体为 JSON
  const downloadOntology = () => {
    if (!ontology) return;

    const blob = new Blob([JSON.stringify(ontology, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ontology.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* 顶部导航 */}
      <nav className="bg-slate-900/80 backdrop-blur-sm border-b border-slate-700/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-14">
            <div className="flex items-center gap-4">
              <Link href="/mirofish" className="flex items-center gap-2 text-white hover:text-purple-300 transition-colors">
                <span className="text-xl">←</span>
                <span className="text-sm">返回首页</span>
              </Link>
              <div className="h-6 w-px bg-slate-700" />
              <h1 className="text-lg font-semibold text-white flex items-center gap-2">
                <span className="text-2xl">📋</span>
                本体生成
              </h1>
            </div>

            {/* 功能模块导航 */}
            <div className="flex items-center gap-2">
              <Link
                href="/mirofish/process"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                🐟 完整流程
              </Link>
              <Link
                href="/mirofish/ontology"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-purple-600 text-white"
              >
                📋 本体
              </Link>
              <Link
                href="/mirofish/entity-extraction"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                🔍 实体抽取
              </Link>
              <Link
                href="/mirofish/graph-rag"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                🕸️ GraphRag
              </Link>
              <Link
                href="/mirofish/profile"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                👤 人设
              </Link>
              <Link
                href="/mirofish/simulation"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                🎮 模拟
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 左侧配置面板 */}
          <div className="space-y-4">
            {/* 模拟需求 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                🎯 模拟需求描述
              </h3>
              <textarea
                value={simulationRequirement}
                onChange={e => setSimulationRequirement(e.target.value)}
                placeholder="例如：模拟一个关于某品牌产品争议的社交媒体舆论场，分析不同立场用户的互动..."
                className="w-full h-28 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
              />
            </div>

            {/* 分析文本 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  📄 分析文本 ({texts.length + (customText ? 1 : 0)})
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={addSampleText}
                    className="px-2 py-1 text-xs bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                  >
                    + 示例文本
                  </button>
                  <button
                    onClick={clearTexts}
                    className="px-2 py-1 text-xs bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                  >
                    清空
                  </button>
                </div>
              </div>

              {/* 已添加的文本 */}
              {texts.length > 0 && (
                <div className="mb-3 space-y-2 max-h-48 overflow-auto">
                  {texts.map((text, i) => (
                    <div key={i} className="p-2 bg-slate-700/50 rounded-lg text-xs text-slate-300 line-clamp-2">
                      {text.substring(0, 100)}...
                    </div>
                  ))}
                </div>
              )}

              {/* 自定义输入 */}
              <textarea
                value={customText}
                onChange={e => setCustomText(e.target.value)}
                placeholder="输入要分析的文本内容，用于提取实体和关系类型..."
                className="w-full h-32 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
              />
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            {/* 生成按钮 */}
            <button
              onClick={generateOntology}
              disabled={loading}
              className={`w-full py-3 rounded-lg font-medium transition-colors ${
                loading
                  ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : 'bg-purple-600 text-white hover:bg-purple-500'
              }`}
            >
              {loading ? '生成中...' : '🚀 生成本体定义'}
            </button>
          </div>

          {/* 右侧本体展示 */}
          <div>
            {ontology ? (
              <div className="space-y-4">
                {/* 本体头部 */}
                <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                  <div className="flex justify-between items-center">
                    <h3 className="text-lg font-semibold text-white">📋 本体定义</h3>
                    <button
                      onClick={downloadOntology}
                      className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
                    >
                      💾 下载 JSON
                    </button>
                  </div>
                  {ontology.analysis_summary && (
                    <p className="mt-2 text-sm text-slate-400">
                      {ontology.analysis_summary}
                    </p>
                  )}
                </div>

                {/* 实体类型 */}
                <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                  <h4 className="text-sm font-semibold text-blue-400 mb-3">
                    实体类型 ({ontology.entity_types.length})
                  </h4>
                  <div className="space-y-3">
                    {ontology.entity_types.map((type, i) => (
                      <div key={i} className="bg-slate-700/50 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-white">{type.name}</span>
                          <span className="px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded text-xs">
                            {type.attributes.length} 属性
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 mb-2">{type.description}</p>
                        {type.examples.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {type.examples.slice(0, 3).map((ex, j) => (
                              <span key={j} className="px-2 py-0.5 bg-slate-600 text-slate-300 rounded text-xs">
                                {ex}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* 关系类型 */}
                <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                  <h4 className="text-sm font-semibold text-purple-400 mb-3">
                    关系类型 ({ontology.edge_types.length})
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    {ontology.edge_types.map((edge, i) => (
                      <div key={i} className="bg-slate-700/50 rounded-lg p-3">
                        <div className="font-medium text-purple-300 mb-1">{edge.name}</div>
                        <p className="text-xs text-slate-400">{edge.description}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {edge.source_targets.slice(0, 2).map((st, j) => (
                            <span key={j} className="px-1.5 py-0.5 bg-slate-600 text-slate-300 rounded text-xs">
                              {st.source} → {st.target}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 下一步 */}
                <div className="bg-gradient-to-r from-purple-600/20 to-pink-600/20 rounded-xl border border-purple-500/30 p-4">
                  <div className="text-center">
                    <h4 className="text-white font-medium mb-2">本体生成完成！</h4>
                    <p className="text-sm text-slate-400 mb-3">
                      接下来可以使用此本体进行图谱构建
                    </p>
                    <div className="flex justify-center gap-3">
                      <Link
                        href="/mirofish/graph-rag"
                        className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors"
                      >
                        🕸️ 构建图谱
                      </Link>
                      <Link
                        href="/mirofish/process"
                        className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                      >
                        🐟 完整流程
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-12 text-center">
                <div className="text-6xl mb-4">📋</div>
                <h3 className="text-xl font-bold text-white mb-2">
                  本体生成器
                </h3>
                <p className="text-slate-400 max-w-md mx-auto">
                  输入模拟需求描述和分析文本，AI 将自动生成适合社会舆论模拟的实体类型和关系类型定义。
                </p>
                <div className="mt-6 flex justify-center gap-4 flex-wrap">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-400">10</div>
                    <div className="text-xs text-slate-500">实体类型</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-purple-400">6-10</div>
                    <div className="text-xs text-slate-500">关系类型</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
