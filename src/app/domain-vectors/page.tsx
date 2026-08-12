'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

// 领域配置类型
interface DomainConfig {
  name: string;
  description: string;
  color: string;
  icon: string;
  seedPrompt?: string;
}

// 质心数据类型
interface CentroidData {
  name: string;
  description: string;
  color: string;
  icon: string;
  seedWords: string[];
  wordCount: number;
  centroid: number[];
  dimension: number;
  calculatedAt: string;
  isCustom?: boolean;
}

// Ollama 状态类型
interface OllamaStatus {
  status: 'online' | 'offline' | 'checking';
  models: string[];
  requirements?: {
    llm: { model: string; available: boolean };
    embedding: { model: string; available: boolean };
  };
}

// 预定义种子词
const DEFAULT_SEEDS: Record<string, string[]> = {
  tech: ['代码', '算法', '架构', '数据库', '并发', '接口', '部署', '系统', '开发', '模型', '训练', '硬件', '网络', '加密', 'API', '框架', '编程', '调试', '测试', '版本控制', '前端', '后端', '云计算', '容器', '微服务'],
  business: ['市场', '盈利', '销售', '客户', '投资', '战略', '成本', '预算', '合同', '增长', '竞争', '供应链', '管理', '营销', '品牌', '融资', '估值', '股权', '并购', '运营', '渠道', '定价', '利润', '资产', '负债'],
  daily: ['吃饭', '睡觉', '天气', '旅游', '购物', '运动', '心情', '家人', '周末', '打扫', '做饭', '健康', '散步', '休息', '娱乐', '朋友', '聚会', '电影', '音乐', '游戏', '宠物', '花园', '咖啡', '早餐', '晚餐'],
  emotion: ['开心', '难过', '愤怒', '焦虑', '期待', '失望', '感动', '孤独', '温暖', '幸福', '悲伤', '兴奋', '紧张', '平静', '满足', '遗憾', '思念', '感激', '委屈', '释然', '担忧', '希望', '绝望', '惊喜', '无奈'],
  academic: ['研究', '论文', '实验', '理论', '分析', '方法', '结论', '假设', '数据', '样本', '统计', '引用', '文献', '综述', '学科', '学术', '期刊', '会议', '答辩', '课题', '导师', '博士', '硕士', '本科', '学位'],
  health: ['健身', '营养', '睡眠', '压力', '免疫', '疾病', '治疗', '预防', '检查', '医院', '药物', '康复', '体检', '饮食', '运动', '心理', '焦虑', '抑郁', '减肥', '维生素', '蛋白质', '碳水', '脂肪', '热量', '代谢'],
  culture: ['艺术', '文学', '历史', '传统', '音乐', '绘画', '雕塑', '戏剧', '电影', '舞蹈', '诗歌', '小说', '散文', '哲学', '宗教', '民俗', '节日', '遗产', '博物馆', '展览', '收藏', '美学', '创作', '鉴赏', '批评'],
  nature: ['森林', '海洋', '山脉', '河流', '湖泊', '草原', '沙漠', '气候', '季节', '动物', '植物', '生态', '环境', '保护', '污染', '资源', '能源', '碳排放', '可持续', '生物多样性', '栖息地', '濒危', '自然灾害', '气象', '地理']
};

export default function DomainVectorsPage() {
  // 状态管理
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>({ status: 'checking', models: [] });
  const [domainConfig, setDomainConfig] = useState<Record<string, DomainConfig>>({});
  const [centroids, setCentroids] = useState<Record<string, CentroidData>>({});
  const [seedWords, setSeedWords] = useState<Record<string, string[]>>({ ...DEFAULT_SEEDS });
  const [activeTab, setActiveTab] = useState<'manage' | 'test' | 'custom'>('manage');
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState<Record<string, boolean>>({});
  const [isCalculating, setIsCalculating] = useState<Record<string, boolean>>({});
  const [testQuery, setTestQuery] = useState('');
  const [testResults, setTestResults] = useState<any>(null);
  const [customDomain, setCustomDomain] = useState({
    id: '',
    name: '',
    description: '',
    color: '#6B7280',
    icon: '📁',
    seeds: ''
  });
  const [notification, setNotification] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // 显示通知
  const showNotification = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  // 检查 Ollama 状态
  const checkOllamaStatus = useCallback(async () => {
    setOllamaStatus(prev => ({ ...prev, status: 'checking' }));
    try {
      const response = await fetch('/rag-api/domain-vectors?action=check-ollama');
      const data = await response.json();
      if (data.success) {
        setOllamaStatus({
          status: data.status,
          models: data.models || [],
          requirements: data.requirements
        });
      } else {
        setOllamaStatus({ status: 'offline', models: [] });
      }
    } catch (error) {
      setOllamaStatus({ status: 'offline', models: [] });
    }
  }, []);

  // 加载领域配置
  const loadDomainConfig = useCallback(async () => {
    try {
      const response = await fetch('/rag-api/domain-vectors?action=config');
      const data = await response.json();
      if (data.success) {
        setDomainConfig(data.domains);
      }
    } catch (error) {
      console.error('Failed to load domain config:', error);
    }
  }, []);

  // 加载已保存的质心
  const loadCentroids = useCallback(async () => {
    try {
      const response = await fetch('/rag-api/domain-vectors?action=centroids');
      const data = await response.json();
      if (data.success && data.centroids) {
        setCentroids(data.centroids);
        // 同步种子词
        const newSeeds = { ...seedWords };
        for (const [domain, centroid] of Object.entries(data.centroids)) {
          if (domain !== '_meta' && (centroid as CentroidData).seedWords) {
            newSeeds[domain] = (centroid as CentroidData).seedWords;
          }
        }
        setSeedWords(newSeeds);
      }
    } catch (error) {
      console.error('Failed to load centroids:', error);
    }
  }, []);

  // 初始化
  useEffect(() => {
    checkOllamaStatus();
    loadDomainConfig();
    loadCentroids();
  }, [checkOllamaStatus, loadDomainConfig, loadCentroids]);

  // 使用 LLM 生成种子词
  const generateSeeds = async (domain: string) => {
    setIsGenerating(prev => ({ ...prev, [domain]: true }));
    try {
      const response = await fetch('/rag-api/domain-vectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate-seeds', domain })
      });
      const data = await response.json();
      if (data.success) {
        setSeedWords(prev => ({ ...prev, [domain]: data.words }));
        showNotification('success', `成功生成 ${data.words.length} 个种子词`);
      } else {
        showNotification('error', data.error || '生成失败');
      }
    } catch (error) {
      showNotification('error', '生成种子词失败');
    } finally {
      setIsGenerating(prev => ({ ...prev, [domain]: false }));
    }
  };

  // 计算领域质心
  const calculateCentroid = async (domain: string) => {
    const words = seedWords[domain];
    if (!words || words.length === 0) {
      showNotification('error', '请先添加种子词');
      return;
    }

    setIsCalculating(prev => ({ ...prev, [domain]: true }));
    try {
      const response = await fetch('/rag-api/domain-vectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'calculate-centroid', domain, seedWords: words })
      });
      const data = await response.json();
      if (data.success) {
        showNotification('success', `已计算质心 (${data.dimension} 维向量)`);
        loadCentroids();
      } else {
        showNotification('error', data.error || '计算失败');
      }
    } catch (error) {
      showNotification('error', '计算质心失败');
    } finally {
      setIsCalculating(prev => ({ ...prev, [domain]: false }));
    }
  };

  // 批量计算所有质心
  const calculateAllCentroids = async () => {
    const domainsWithSeeds: Record<string, string[]> = {};
    for (const [domain, words] of Object.entries(seedWords)) {
      if (words && words.length > 0) {
        domainsWithSeeds[domain] = words;
      }
    }

    if (Object.keys(domainsWithSeeds).length === 0) {
      showNotification('error', '没有可用的种子词');
      return;
    }

    setIsCalculating(prev => {
      const newState = { ...prev };
      for (const domain of Object.keys(domainsWithSeeds)) {
        newState[domain] = true;
      }
      return newState;
    });

    try {
      const response = await fetch('/rag-api/domain-vectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'calculate-all', domains: domainsWithSeeds })
      });
      const data = await response.json();
      if (data.success) {
        showNotification('success', `已计算 ${Object.keys(data.results).length} 个领域的质心`);
        loadCentroids();
      } else {
        showNotification('error', data.error || '批量计算失败');
      }
    } catch (error) {
      showNotification('error', '批量计算失败');
    } finally {
      setIsCalculating({});
    }
  };

  // 测试查询
  const handleTestQuery = async (showDetails = true) => {
    if (!testQuery.trim()) {
      showNotification('error', '请输入测试查询');
      return;
    }

    // 检查是否有已计算的质心
    if (Object.keys(centroids).filter(k => k !== '_meta').length === 0) {
      showNotification('error', '请先计算至少一个领域的质心');
      return;
    }

    // 显示加载状态
    showNotification('info', '正在测试查询...');

    try {
      const response = await fetch('/rag-api/domain-vectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test-query', query: testQuery, showDetails })
      });
      
      // 检查 HTTP 状态
      if (!response.ok) {
        const errorText = await response.text();
        console.error('API Error Response:', errorText);
        showNotification('error', `API 错误 (${response.status}): ${errorText.substring(0, 100)}`);
        return;
      }
      
      const data = await response.json();
      console.log('API Response:', data);
      
      if (data.success) {
        setTestResults(data);
        showNotification('success', '测试完成');
      } else {
        const errorMsg = data.error || '测试失败';
        console.error('API Error:', errorMsg);
        showNotification('error', errorMsg);
      }
    } catch (error) {
      console.error('Test Query Error:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      showNotification('error', `测试查询失败: ${errorMsg}`);
    }
  };

  // 添加自定义领域
  const handleAddCustomDomain = async () => {
    if (!customDomain.id || !customDomain.seeds) {
      showNotification('error', '请填写领域ID和种子词');
      return;
    }

    const seeds = customDomain.seeds.split(/[,，、\n]+/).map(s => s.trim()).filter(s => s);
    if (seeds.length === 0) {
      showNotification('error', '请输入有效的种子词');
      return;
    }

    try {
      const response = await fetch('/rag-api/domain-vectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add-custom-domain',
          domainId: customDomain.id,
          name: customDomain.name || customDomain.id,
          description: customDomain.description,
          color: customDomain.color,
          icon: customDomain.icon,
          seedWords: seeds
        })
      });
      const data = await response.json();
      if (data.success) {
        showNotification('success', `已添加自定义领域: ${customDomain.name || customDomain.id}`);
        setCustomDomain({ id: '', name: '', description: '', color: '#6B7280', icon: '📁', seeds: '' });
        loadCentroids();
      } else {
        showNotification('error', data.error || '添加失败');
      }
    } catch (error) {
      showNotification('error', '添加自定义领域失败');
    }
  };

  // 删除领域
  const handleDeleteDomain = async (domainId: string) => {
    if (!confirm(`确定要删除领域 "${domainId}" 吗？`)) return;

    try {
      const response = await fetch('/rag-api/domain-vectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-domain', domainId })
      });
      const data = await response.json();
      if (data.success) {
        showNotification('success', '已删除领域');
        loadCentroids();
      }
    } catch (error) {
      showNotification('error', '删除失败');
    }
  };

  // 更新种子词
  const updateSeedWords = (domain: string, text: string) => {
    const words = text.split(/[,，、\n]+/).map(s => s.trim()).filter(s => s);
    setSeedWords(prev => ({ ...prev, [domain]: words }));
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* 通知 */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg transition-all ${
          notification.type === 'success' ? 'bg-green-500 text-white' :
          notification.type === 'error' ? 'bg-red-500 text-white' :
          'bg-blue-500 text-white'
        }`}>
          {notification.message}
        </div>
      )}

      {/* 头部 */}
      <header className="border-b border-white/10 bg-black/20 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/" className="text-white/60 hover:text-white transition-colors">
                ← 返回
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                  🎯 领域向量管理
                </h1>
                <p className="text-sm text-white/60 mt-1">
                  使用 Ollama 生成领域种子词并计算语义质心
                </p>
              </div>
            </div>

            {/* Ollama 状态 */}
            <div className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
              ollamaStatus.status === 'online' ? 'bg-green-500/20 text-green-400' :
              ollamaStatus.status === 'checking' ? 'bg-yellow-500/20 text-yellow-400' :
              'bg-red-500/20 text-red-400'
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                ollamaStatus.status === 'online' ? 'bg-green-400 animate-pulse' :
                ollamaStatus.status === 'checking' ? 'bg-yellow-400 animate-pulse' :
                'bg-red-400'
              }`} />
              <span className="text-sm font-medium">
                Ollama: {ollamaStatus.status === 'online' ? '在线' : ollamaStatus.status === 'checking' ? '检查中...' : '离线'}
              </span>
              {ollamaStatus.requirements && (
                <div className="flex items-center gap-2 ml-2 text-xs">
                  <span className={ollamaStatus.requirements.llm.available ? 'text-green-400' : 'text-red-400'}>
                    LLM {ollamaStatus.requirements.llm.available ? '✓' : '✗'}
                  </span>
                  <span className={ollamaStatus.requirements.embedding.available ? 'text-green-400' : 'text-red-400'}>
                    Embed {ollamaStatus.requirements.embedding.available ? '✓' : '✗'}
                  </span>
                </div>
              )}
              <button 
                onClick={checkOllamaStatus}
                className="ml-2 text-xs hover:underline"
              >
                刷新
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* 标签页 */}
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex gap-2">
          {[
            { id: 'manage', label: '领域管理', icon: '⚙️' },
            { id: 'test', label: '向量测试', icon: '🧪' },
            { id: 'custom', label: '自定义领域', icon: '➕' }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-purple-500 text-white'
                  : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 主内容 */}
      <main className="max-w-7xl mx-auto px-6 pb-12">
        {/* 领域管理标签页 */}
        {activeTab === 'manage' && (
          <div className="space-y-6">
            {/* 操作栏 */}
            <div className="flex items-center justify-between">
              <div className="text-white/60 text-sm">
                已配置 {Object.keys(centroids).filter(k => k !== '_meta').length} 个领域
              </div>
              <button
                onClick={calculateAllCentroids}
                disabled={Object.values(isCalculating).some(v => v)}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                {Object.values(isCalculating).some(v => v) ? '计算中...' : '🚀 批量计算所有质心'}
              </button>
            </div>

            {/* 领域卡片网格 */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {Object.entries(domainConfig).map(([domainId, config]) => {
                const centroid = centroids[domainId];
                const words = seedWords[domainId] || [];
                const isSelected = selectedDomain === domainId;

                return (
                  <div
                    key={domainId}
                    className={`rounded-xl border transition-all overflow-hidden ${
                      isSelected
                        ? 'border-purple-400 bg-purple-500/20'
                        : 'border-white/10 bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    {/* 卡片头部 */}
                    <div
                      className="p-4 cursor-pointer"
                      onClick={() => setSelectedDomain(isSelected ? null : domainId)}
                      style={{ borderLeft: `4px solid ${config.color}` }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-2xl">{config.icon}</span>
                          <div>
                            <h3 className="font-semibold text-white">{config.name}</h3>
                            <p className="text-xs text-white/50">{config.description}</p>
                          </div>
                        </div>
                        {centroid && (
                          <div className="text-right">
                            <div className="text-xs text-green-400 font-medium">已计算</div>
                            <div className="text-xs text-white/50">{centroid.dimension}维</div>
                          </div>
                        )}
                      </div>

                      {/* 种子词统计 */}
                      <div className="mt-3 flex items-center gap-4 text-xs text-white/60">
                        <span>📝 {words.length} 个种子词</span>
                        {centroid && <span>📅 {new Date(centroid.calculatedAt).toLocaleDateString()}</span>}
                      </div>
                    </div>

                    {/* 展开内容 */}
                    {isSelected && (
                      <div className="border-t border-white/10 p-4 space-y-4">
                        {/* 种子词编辑 */}
                        <div>
                          <label className="block text-sm font-medium text-white/80 mb-2">
                            种子词（逗号或换行分隔）
                          </label>
                          <textarea
                            value={words.join(', ')}
                            onChange={(e) => updateSeedWords(domainId, e.target.value)}
                            className="w-full h-32 px-3 py-2 bg-black/30 border border-white/20 rounded-lg text-white text-sm resize-none focus:outline-none focus:border-purple-400"
                            placeholder="输入种子词..."
                          />
                        </div>

                        {/* 操作按钮 */}
                        <div className="flex gap-2">
                          <button
                            onClick={() => generateSeeds(domainId)}
                            disabled={isGenerating[domainId] || ollamaStatus.status !== 'online'}
                            className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                          >
                            {isGenerating[domainId] ? '生成中...' : '🤖 AI生成'}
                          </button>
                          <button
                            onClick={() => calculateCentroid(domainId)}
                            disabled={isCalculating[domainId] || words.length === 0 || ollamaStatus.status !== 'online'}
                            className="flex-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                          >
                            {isCalculating[domainId] ? '计算中...' : '📊 计算质心'}
                          </button>
                        </div>

                        {/* 质心信息 */}
                        {centroid && (
                          <div className="p-3 bg-black/30 rounded-lg">
                            <div className="text-xs text-white/60 mb-2">质心向量信息</div>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                              <div className="text-white/80">
                                维度: <span className="text-white font-medium">{centroid.dimension}</span>
                              </div>
                              <div className="text-white/80">
                                词数: <span className="text-white font-medium">{centroid.wordCount}</span>
                              </div>
                            </div>
                            <div className="mt-2 text-xs text-white/40">
                              向量前5维: [{centroid.centroid.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 已保存的自定义领域 */}
            {Object.entries(centroids).filter(([k, v]) => k !== '_meta' && (v as CentroidData).isCustom).length > 0 && (
              <div className="mt-8">
                <h3 className="text-lg font-semibold text-white mb-4">📁 自定义领域</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Object.entries(centroids)
                    .filter(([k, v]) => k !== '_meta' && (v as CentroidData).isCustom)
                    .map(([domainId, data]) => {
                      const centroid = data as CentroidData;
                      return (
                        <div
                          key={domainId}
                          className="p-4 rounded-lg border border-white/10 bg-white/5"
                          style={{ borderLeft: `4px solid ${centroid.color}` }}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-xl">{centroid.icon}</span>
                              <div>
                                <h4 className="font-medium text-white">{centroid.name}</h4>
                                <p className="text-xs text-white/50">{centroid.description}</p>
                              </div>
                            </div>
                            <button
                              onClick={() => handleDeleteDomain(domainId)}
                              className="text-red-400 hover:text-red-300 text-sm"
                            >
                              删除
                            </button>
                          </div>
                          <div className="mt-2 text-xs text-white/60">
                            {centroid.wordCount} 词 · {centroid.dimension} 维
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 向量测试标签页 */}
        {activeTab === 'test' && (
          <div className="space-y-6">
            <div className="bg-white/5 rounded-xl border border-white/10 p-6">
              <h3 className="text-lg font-semibold text-white mb-4">🧪 测试查询向量</h3>
              <p className="text-sm text-white/60 mb-4">
                输入任意文本，查看其与各领域质心的相似度分布
              </p>

              <div className="flex gap-4">
                <input
                  type="text"
                  value={testQuery}
                  onChange={(e) => setTestQuery(e.target.value)}
                  placeholder="输入测试查询..."
                  className="flex-1 px-4 py-3 bg-black/30 border border-white/20 rounded-lg text-white focus:outline-none focus:border-purple-400"
                  onKeyDown={(e) => e.key === 'Enter' && handleTestQuery()}
                />
                <button
                  onClick={() => handleTestQuery()}
                  disabled={!testQuery.trim() || ollamaStatus.status !== 'online'}
                  className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
                >
                  测试
                </button>
              </div>

              {/* 快速示例 */}
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="text-xs text-white/40">快速测试:</span>
                {[
                  '如何优化数据库性能？',
                  '今年的市场趋势如何？',
                  '周末去哪里玩比较好？',
                  '我最近感到很焦虑',
                  '这篇论文的研究方法是什么？'
                ].map((q, i) => (
                  <button
                    key={i}
                    onClick={() => setTestQuery(q)}
                    className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-xs text-white/70 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            {/* 测试结果 */}
            {testResults && (
              <div className="space-y-6">
                {/* 查询信息卡片 */}
                <div className="bg-white/5 rounded-xl border border-white/10 p-6">
                  <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                    📊 测试结果
                    <span className="text-xs text-white/40 font-normal">完整计算过程展示</span>
                  </h3>
                  <p className="text-sm text-white/60 mb-4">
                    查询: <span className="text-white font-medium">&ldquo;{testResults.query}&rdquo;</span>
                  </p>

                  {/* 查询向量信息 */}
                  {testResults.queryVector && (
                    <div className="mb-4 p-4 bg-blue-500/10 rounded-lg border border-blue-400/20">
                      <div className="text-sm font-medium text-blue-300 mb-2">🔍 查询向量信息</div>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div className="text-white/70">
                          维度: <span className="text-white font-mono">{testResults.queryVector.dimension}</span>
                        </div>
                        <div className="text-white/70">
                          模长: <span className="text-white font-mono">{testResults.queryVector.norm.toFixed(4)}</span>
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-white/40 font-mono">
                        向量样本 (前20维): [{testResults.queryVector.sample.join(', ')}...]
                      </div>
                    </div>
                  )}

                  {/* 统计信息 */}
                  {testResults.stats && (
                    <div className="grid grid-cols-4 gap-4 mb-6">
                      <div className="p-3 bg-white/5 rounded-lg border border-white/10">
                        <div className="text-xs text-white/50 mb-1">平均相似度</div>
                        <div className="text-lg font-bold text-white">{(testResults.stats.mean * 100).toFixed(2)}%</div>
                      </div>
                      <div className="p-3 bg-white/5 rounded-lg border border-white/10">
                        <div className="text-xs text-white/50 mb-1">标准差</div>
                        <div className="text-lg font-bold text-white">{(testResults.stats.std * 100).toFixed(2)}%</div>
                      </div>
                      <div className="p-3 bg-white/5 rounded-lg border border-white/10">
                        <div className="text-xs text-white/50 mb-1">分数范围</div>
                        <div className="text-lg font-bold text-white">{(testResults.stats.range * 100).toFixed(2)}%</div>
                      </div>
                      <div className="p-3 bg-white/5 rounded-lg border border-white/10">
                        <div className="text-xs text-white/50 mb-1">向量维度</div>
                        <div className="text-lg font-bold text-white">{testResults.stats.queryDim}</div>
                      </div>
                    </div>
                  )}

                  {/* 最匹配领域 */}
                  {testResults.topDomain && (
                    <div className="mb-6 p-5 rounded-lg border-2" style={{ 
                      backgroundColor: `${testResults.topDomain.color}20`,
                      borderColor: `${testResults.topDomain.color}60`
                    }}>
                      <div className="text-sm font-medium mb-2" style={{ color: `${testResults.topDomain.color}` }}>
                        🏆 最匹配领域 (高出平均 {((testResults.topDomain.similarity - testResults.stats.mean) * 100).toFixed(2)}%)
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-4xl">{testResults.topDomain.icon}</span>
                          <div>
                            <div className="text-2xl font-bold text-white">{testResults.topDomain.name}</div>
                            <div className="text-sm text-white/70 mt-1">
                              相似度评分: {(testResults.topDomain.similarity * 100).toFixed(4)}%
                            </div>
                          </div>
                        </div>
                        {testResults.topDomain.details && (
                          <div className="text-right">
                            <div className="text-xs text-white/50">点积</div>
                            <div className="font-mono text-sm text-white">{testResults.topDomain.details.dotProduct.toFixed(6)}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 相似度分布排名 */}
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-white/80 mb-3">📈 所有领域相似度分布</div>
                    {testResults.similarities?.map((item: any, index: number) => {
                      const deviationFromMean = item.similarity - testResults.stats.mean;
                      const zScore = deviationFromMean / testResults.stats.std;
                      
                      return (
                        <details 
                          key={item.domain} 
                          className={`group rounded-lg border transition-all ${
                            index === 0 ? 'border-purple-400/50 bg-purple-500/10' : 'border-white/10 bg-white/5'
                          }`}
                        >
                          <summary className="cursor-pointer p-3 hover:bg-white/5 transition-colors">
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                                index === 0 ? 'bg-yellow-400 text-yellow-900' :
                                index === 1 ? 'bg-gray-300 text-gray-700' :
                                index === 2 ? 'bg-orange-300 text-orange-800' :
                                'bg-gray-600 text-white'
                              }`}>
                                {index + 1}
                              </div>
                              <span className="text-2xl">{item.icon}</span>
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-white font-medium">{item.name}</span>
                                  {deviationFromMean > testResults.stats.std && (
                                    <span className="px-1.5 py-0.5 bg-green-500/20 text-green-400 text-xs rounded">显著高于均值</span>
                                  )}
                                  {deviationFromMean < -testResults.stats.std && (
                                    <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 text-xs rounded">显著低于均值</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 mt-1">
                                  <div className="flex-1 h-2 bg-black/30 rounded-full overflow-hidden">
                                    <div
                                      className="h-full transition-all"
                                      style={{ 
                                        width: `${Math.max(0, item.similarity * 100)}%`,
                                        backgroundColor: item.color || '#6B7280'
                                      }}
                                    />
                                  </div>
                                  <div className={`w-24 text-right font-mono text-sm ${
                                    index === 0 ? 'text-purple-400 font-bold' : 'text-white/70'
                                  }`}>
                                    {(item.similarity * 100).toFixed(4)}%
                                  </div>
                                </div>
                              </div>
                              <span className="text-white/40 text-xs group-open:rotate-90 transition-transform">▶</span>
                            </div>
                          </summary>

                          {/* 详细计算信息 */}
                          {item.details && (
                            <div className="px-3 pb-3 space-y-3 border-t border-white/10 mt-2 pt-3">
                              {/* 计算过程 */}
                              <div className="grid grid-cols-3 gap-3">
                                <div className="p-2 bg-black/20 rounded">
                                  <div className="text-xs text-white/50">点积 (Dot Product)</div>
                                  <div className="font-mono text-sm text-white mt-1">{item.details.dotProduct.toFixed(6)}</div>
                                </div>
                                <div className="p-2 bg-black/20 rounded">
                                  <div className="text-xs text-white/50">查询模长</div>
                                  <div className="font-mono text-sm text-white mt-1">{item.details.queryNorm.toFixed(6)}</div>
                                </div>
                                <div className="p-2 bg-black/20 rounded">
                                  <div className="text-xs text-white/50">质心模长</div>
                                  <div className="font-mono text-sm text-white mt-1">{item.details.centroidNorm.toFixed(6)}</div>
                                </div>
                              </div>

                              {/* 统计指标 */}
                              <div className="grid grid-cols-3 gap-3">
                                <div className="p-2 bg-black/20 rounded">
                                  <div className="text-xs text-white/50">偏离均值</div>
                                  <div className={`font-mono text-sm mt-1 ${
                                    deviationFromMean > 0 ? 'text-green-400' : 'text-red-400'
                                  }`}>
                                    {deviationFromMean > 0 ? '+' : ''}{(deviationFromMean * 100).toFixed(2)}%
                                  </div>
                                </div>
                                <div className="p-2 bg-black/20 rounded">
                                  <div className="text-xs text-white/50">Z-Score</div>
                                  <div className={`font-mono text-sm mt-1 ${
                                    Math.abs(zScore) > 1 ? 'text-yellow-400' : 'text-white'
                                  }`}>
                                    {zScore.toFixed(3)}σ
                                  </div>
                                </div>
                                <div className="p-2 bg-black/20 rounded">
                                  <div className="text-xs text-white/50">种子词数量</div>
                                  <div className="font-mono text-sm text-white mt-1">{item.details.wordCount} 词</div>
                                </div>
                              </div>

                              {/* 贡献最大的维度 */}
                              <div className="p-3 bg-black/20 rounded">
                                <div className="text-xs text-white/50 mb-2">🎯 贡献最大的维度 (Top 5)</div>
                                <div className="space-y-1">
                                  {item.details.topDimensions?.slice(0, 5).map((dim: any, i: number) => (
                                    <div key={i} className="flex items-center gap-2 text-xs">
                                      <span className="text-white/40 w-4">{i + 1}</span>
                                      <span className="text-white/60 w-12">维度{dim.dim}</span>
                                      <div className="flex-1 flex items-center gap-2">
                                        <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                                          <div 
                                            className={`h-full ${dim.contrib > 0 ? 'bg-green-500' : 'bg-red-500'}`}
                                            style={{ width: `${Math.min(100, Math.abs(dim.contrib) * 1000)}%` }}
                                          />
                                        </div>
                                        <span className="font-mono text-white/70 w-20 text-right">
                                          {dim.contrib.toFixed(6)}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {/* 种子词样本 */}
                              <div className="p-3 bg-black/20 rounded">
                                <div className="text-xs text-white/50 mb-2">📝 种子词样本 (前10个)</div>
                                <div className="flex flex-wrap gap-1">
                                  {item.details.seedSample?.map((word: string, i: number) => (
                                    <span key={i} className="px-2 py-1 bg-white/10 text-white text-xs rounded">
                                      {word}
                                    </span>
                                  ))}
                                </div>
                              </div>

                              {/* 计算公式说明 */}
                              <div className="p-3 bg-blue-500/10 rounded border border-blue-400/20">
                                <div className="text-xs text-blue-300 mb-1">📐 余弦相似度计算公式</div>
                                <div className="text-xs text-white/60 font-mono">
                                  similarity = dot(query, centroid) / (||query|| × ||centroid||)
                                </div>
                                <div className="text-xs text-white/60 mt-2">
                                  = {item.details.dotProduct.toFixed(6)} / ({item.details.queryNorm.toFixed(6)} × {item.details.centroidNorm.toFixed(6)})
                                  = {item.similarity.toFixed(6)}
                                </div>
                              </div>
                            </div>
                          )}
                        </details>
                      );
                    })}
                  </div>

                  {/* 数据解读提示 */}
                  <div className="mt-6 p-4 bg-yellow-500/10 rounded-lg border border-yellow-400/20">
                    <div className="text-sm font-medium text-yellow-400 mb-2">💡 数据解读提示</div>
                    <ul className="text-xs text-white/70 space-y-1">
                      <li>• <strong>相似度</strong>: 余弦相似度，范围 -1 到 1，越接近 1 表示越相似</li>
                      <li>• <strong>Z-Score</strong>: 标准分数，绝对值 &gt; 1 表示显著偏离平均值</li>
                      <li>• <strong>点积</strong>: 向量点乘结果，反映向量在相同方向上的投影</li>
                      <li>• <strong>模长</strong>: 向量的欧几里得范数，已归一化的向量模长为 1</li>
                      <li>• <strong>贡献维度</strong>: 对相似度贡献最大的向量维度，值越大贡献越大</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 自定义领域标签页 */}
        {activeTab === 'custom' && (
          <div className="bg-white/5 rounded-xl border border-white/10 p-6">
            <h3 className="text-lg font-semibold text-white mb-4">➕ 添加自定义领域</h3>
            <p className="text-sm text-white/60 mb-6">
              创建自己的领域分类，输入种子词后自动计算质心向量
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* 基本信息 */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">领域ID *</label>
                  <input
                    type="text"
                    value={customDomain.id}
                    onChange={(e) => setCustomDomain(prev => ({ ...prev, id: e.target.value.toLowerCase().replace(/\s+/g, '_') }))}
                    placeholder="例如: finance, gaming..."
                    className="w-full px-4 py-2 bg-black/30 border border-white/20 rounded-lg text-white focus:outline-none focus:border-purple-400"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">显示名称</label>
                  <input
                    type="text"
                    value={customDomain.name}
                    onChange={(e) => setCustomDomain(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="例如: 金融, 游戏..."
                    className="w-full px-4 py-2 bg-black/30 border border-white/20 rounded-lg text-white focus:outline-none focus:border-purple-400"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">描述</label>
                  <input
                    type="text"
                    value={customDomain.description}
                    onChange={(e) => setCustomDomain(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="简短描述该领域..."
                    className="w-full px-4 py-2 bg-black/30 border border-white/20 rounded-lg text-white focus:outline-none focus:border-purple-400"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-white/80 mb-2">颜色</label>
                    <input
                      type="color"
                      value={customDomain.color}
                      onChange={(e) => setCustomDomain(prev => ({ ...prev, color: e.target.value }))}
                      className="w-full h-10 rounded-lg cursor-pointer"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-white/80 mb-2">图标 (Emoji)</label>
                    <input
                      type="text"
                      value={customDomain.icon}
                      onChange={(e) => setCustomDomain(prev => ({ ...prev, icon: e.target.value }))}
                      placeholder="📁"
                      className="w-full px-4 py-2 bg-black/30 border border-white/20 rounded-lg text-white text-center focus:outline-none focus:border-purple-400"
                    />
                  </div>
                </div>
              </div>

              {/* 种子词 */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">种子词 *</label>
                  <textarea
                    value={customDomain.seeds}
                    onChange={(e) => setCustomDomain(prev => ({ ...prev, seeds: e.target.value }))}
                    placeholder="输入种子词，用逗号或换行分隔...&#10;例如:&#10;股票, 基金, 债券, 期货&#10;投资, 理财, 收益, 风险"
                    className="w-full h-48 px-4 py-3 bg-black/30 border border-white/20 rounded-lg text-white resize-none focus:outline-none focus:border-purple-400"
                  />
                </div>

                <div className="text-sm text-white/60">
                  当前词数: {customDomain.seeds.split(/[,，、\n]+/).filter(s => s.trim()).length}
                </div>

                {/* 预览 */}
                {customDomain.id && (
                  <div className="p-4 rounded-lg border border-white/10 bg-black/20" style={{ borderLeft: `4px solid ${customDomain.color}` }}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-2xl">{customDomain.icon}</span>
                      <div>
                        <div className="font-medium text-white">{customDomain.name || customDomain.id}</div>
                        <div className="text-xs text-white/50">{customDomain.description || '无描述'}</div>
                      </div>
                    </div>
                    <div className="text-xs text-white/40">ID: {customDomain.id}</div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={handleAddCustomDomain}
                disabled={!customDomain.id || !customDomain.seeds || ollamaStatus.status !== 'online'}
                className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                🚀 创建领域并计算质心
              </button>
            </div>
          </div>
        )}
      </main>

      {/* 底部信息 */}
      <footer className="border-t border-white/10 bg-black/20 py-6">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex items-center justify-between text-sm text-white/40">
            <div>
              使用 <span className="text-purple-400">llama3.1</span> 生成种子词 · 
              使用 <span className="text-blue-400">nomic-embed-text</span> 计算向量
            </div>
            <div>
              质心数据保存于 <code className="px-1 py-0.5 bg-black/30 rounded text-xs">data/centroids.json</code>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
