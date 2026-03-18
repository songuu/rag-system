'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import * as d3 from 'd3';

// ==================== 类型定义 ====================

interface ExtractionConfig {
  chunkSize: number;
  chunkOverlap: number;
  enableGleaning: boolean;
  gleaningRounds: number;
  minEntityMentions: number;
  similarityThreshold: number;
  communityResolution: number;
  llmModel: string;
  embeddingModel: string;
  maxTotalTimeout: number;
  maxChunkTimeout: number;
}

interface Entity {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  mentions: number;
  sourceChunks: string[];
}

interface Relation {
  id: string;
  source: string;
  target: string;
  type: string;
  description: string;
  weight: number;
  sourceChunks: string[];
}

interface Community {
  id: string;
  name: string;
  entities: string[];
  relations: string[];
  summary: string;
  keywords: string[];
  level: number;
}

interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
  communities: Community[];
  chunks: string[];
  metadata: {
    documentId: string;
    createdAt: string;
    entityCount: number;
    relationCount: number;
    communityCount: number;
  };
}

interface ExtractionProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}

// ==================== 组件 ====================

export default function EntityExtractionPage() {
  const router = useRouter();

  // 状态
  const [text, setText] = useState<string>('');
  const [config, setConfig] = useState<ExtractionConfig>({
    chunkSize: 500,
    chunkOverlap: 100,
    enableGleaning: true,
    gleaningRounds: 1,
    minEntityMentions: 1,
    similarityThreshold: 0.85,
    communityResolution: 1.0,
    llmModel: 'qwen2.5:0.5b',
    embeddingModel: 'nomic-embed-text',
    maxTotalTimeout: 10 * 60 * 1000,
    maxChunkTimeout: 60 * 1000,
  });
  const [extracting, setExtracting] = useState<boolean>(false);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 图谱展示状态
  const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);
  const [isFullScreen, setIsFullScreen] = useState<boolean>(false);
  const [entityTypes, setEntityTypes] = useState<Array<{ name: string; count: number; color: string }>>([]);

  // DOM引用
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const graphSvgRef = useRef<SVGSVGElement>(null);

  // 颜色配置
  const colors = ['#FF6B35', '#004E89', '#7B2D8E', '#1A936F', '#C5283D', '#E9724C'];

  // ==================== 提取实体 ====================

  const extractEntities = async () => {
    if (!text.trim()) {
      setError('请输入要分析的文本');
      return;
    }

    setExtracting(true);
    setError(null);
    setProgress({ stage: 'init', current: 0, total: 100, message: '正在初始化...' });

    try {
      const response = await fetch('/api/entity-extraction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          config: config,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '实体抽取失败');
      }

      // 开始轮询状态
      pollExtractionStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '实体抽取失败');
      setExtracting(false);
    }
  };

  // 轮询抽取状态
  const pollExtractionStatus = async () => {
    const poll = async () => {
      try {
        const response = await fetch('/api/entity-extraction?action=status');
        const data = await response.json();

        if (data.success) {
          if (data.inProgress) {
            setProgress(data.progress);
          } else if (data.completed && data.graph) {
            setGraph(data.graph);
            setProgress(null);
            setExtracting(false);
          } else if (data.error) {
            setError(data.error);
            setExtracting(false);
          }
        }
      } catch (err) {
        console.error('获取状态失败:', err);
      }
    };

    // 立即查询一次
    await poll();

    // 然后每2秒轮询
    const interval = setInterval(async () => {
      if (!extracting) {
        clearInterval(interval);
        return;
      }
      await poll();
    }, 2000);
  };

  // 加载已有图谱
  const loadGraph = async () => {
    try {
      const response = await fetch('/api/entity-extraction?action=graph');
      const data = await response.json();

      if (data.success && data.hasGraph) {
        setGraph(data.graph);
      }
    } catch (err) {
      console.error('加载图谱失败:', err);
    }
  };

  // 初始化时加载图谱
  useEffect(() => {
    loadGraph();
  }, []);

  // 提取实体类型统计
  useEffect(() => {
    if (!graph?.entities) {
      setEntityTypes([]);
      return;
    }

    const typeMap: Record<string, number> = {};
    graph.entities.forEach(entity => {
      typeMap[entity.type] = (typeMap[entity.type] || 0) + 1;
    });

    const types = Object.entries(typeMap).map(([name, count], index) => ({
      name,
      count,
      color: colors[index % colors.length],
    }));
    setEntityTypes(types);
  }, [graph]);

  // 渲染图谱
  const renderGraph = useCallback(() => {
    if (!graph || !graphSvgRef.current || !graphContainerRef.current) return;

    const svg = d3.select(graphSvgRef.current);
    svg.selectAll('*').remove();

    const container = graphContainerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    svg.attr('width', width).attr('height', height);

    // 节点和边数据
    const nodes = graph.entities.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      ...e,
    }));

    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const links = graph.relations
      .filter(r => nodeMap.has(r.source) && nodeMap.has(r.target))
      .map(r => ({
        source: r.source,
        target: r.target,
        type: r.type,
        ...r,
      }));

    // 力导向图
    const simulation = d3.forceSimulation(nodes as d3.SimulationNodeDatum[])
      .force('link', d3.forceLink(links).id((d: any) => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(40));

    // 边
    const link = svg.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#999')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.6);

    // 节点
    const node = svg.append('g')
      .selectAll('circle')
      .data(nodes)
      .join('circle')
      .attr('r', 12)
      .attr('fill', (d: any) => colors[Object.keys(nodeMap).indexOf(d.id) % colors.length])
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)
      .style('cursor', 'pointer')
      .call(d3.drag<SVGCircleElement, any>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          (d as any).fx = d.x;
          (d as any).fy = d.y;
        })
        .on('drag', (event, d) => {
          (d as any).fx = event.x;
          (d as any).fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          (d as any).fx = null;
          (d as any).fy = null;
        }))
      .on('click', (event, d) => {
        event.stopPropagation();
        setSelectedEntity(d as Entity);
      });

    // 标签
    const label = svg.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .text(d => d.name)
      .attr('font-size', 10)
      .attr('fill', '#333')
      .attr('text-anchor', 'middle')
      .attr('dy', 25);

    // 更新位置
    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as any).x)
        .attr('y1', d => (d.source as any).y)
        .attr('x2', d => (d.target as any).x)
        .attr('y2', d => (d.target as any).y);

      node
        .attr('cx', d => d.x!)
        .attr('cy', d => d.y!);

      label
        .attr('x', d => d.x!)
        .attr('y', d => d.y!);
    });
  }, [graph]);

  // 初始化渲染
  useEffect(() => {
    if (graph && !isFullScreen) {
      setTimeout(renderGraph, 100);
    }
  }, [graph, renderGraph, isFullScreen]);

  // ==================== 渲染 ====================

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: "'Space Grotesk', 'Noto Sans SC', system-ui, sans-serif", background: '#fff' }}>
      {/* 顶部导航 */}
      <nav style={{
        height: '60px',
        background: '#fff',
        borderBottom: '1px solid #EAEAEA',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button onClick={() => router.push('/mirofish')} style={{
            background: 'none',
            border: 'none',
            fontSize: '18px',
            cursor: 'pointer',
            color: '#666',
          }}>
            ←
          </button>
          <span style={{ fontSize: '14px', color: '#999' }}>|</span>
          <h1 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>实体抽取</h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{
            fontSize: '12px',
            padding: '4px 12px',
            borderRadius: '12px',
            background: extracting ? '#FFF3E0' : graph ? '#E8F5E9' : '#F5F5F5',
            color: extracting ? '#FF9800' : graph ? '#4CAF50' : '#999',
          }}>
            {extracting ? '抽取中...' : graph ? '已完成' : '待抽取'}
          </span>
        </div>
      </nav>

      {/* 主内容 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* 左侧：配置和输入 */}
        <div style={{
          width: '360px',
          borderRight: '1px solid #EAEAEA',
          display: 'flex',
          flexDirection: 'column',
          background: '#FAFAFA',
          overflow: 'hidden',
        }}>
          <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
            {/* 文本输入 */}
            <div style={{
              background: '#fff',
              borderRadius: '8px',
              border: '1px solid #E0E0E0',
              padding: '16px',
              marginBottom: '16px',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>分析文本</div>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="输入要分析的文本内容..."
                style={{
                  width: '100%',
                  height: '150px',
                  padding: '12px',
                  border: '1px solid #E0E0E0',
                  borderRadius: '6px',
                  fontSize: '13px',
                  resize: 'none',
                  fontFamily: 'inherit',
                }}
              />
            </div>

            {/* 配置项 */}
            <div style={{
              background: '#fff',
              borderRadius: '8px',
              border: '1px solid #E0E0E0',
              padding: '16px',
              marginBottom: '16px',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>抽取配置</div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>
                  文本分块大小
                </label>
                <input
                  type="number"
                  value={config.chunkSize}
                  onChange={e => setConfig({ ...config, chunkSize: parseInt(e.target.value) || 500 })}
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid #E0E0E0',
                    borderRadius: '4px',
                    fontSize: '13px',
                  }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>
                  文本分块重叠
                </label>
                <input
                  type="number"
                  value={config.chunkOverlap}
                  onChange={e => setConfig({ ...config, chunkOverlap: parseInt(e.target.value) || 100 })}
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid #E0E0E0',
                    borderRadius: '4px',
                    fontSize: '13px',
                  }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>
                  LLM 模型
                </label>
                <select
                  value={config.llmModel}
                  onChange={e => setConfig({ ...config, llmModel: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid #E0E0E0',
                    borderRadius: '4px',
                    fontSize: '13px',
                    background: '#fff',
                  }}
                >
                  <option value="qwen2.5:0.5b">qwen2.5:0.5b</option>
                  <option value="qwen2.5:1.5b">qwen2.5:1.5b</option>
                  <option value="qwen2.5:3b">qwen2.5:3b</option>
                  <option value="qwen2.5:7b">qwen2.5:7b</option>
                </select>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#666' }}>
                <input
                  type="checkbox"
                  checked={config.enableGleaning}
                  onChange={e => setConfig({ ...config, enableGleaning: e.target.checked })}
                />
                启用深度抽取
              </label>
            </div>

            {/* 提取按钮 */}
            <button
              onClick={extractEntities}
              disabled={extracting || !text.trim()}
              style={{
                width: '100%',
                padding: '12px',
                background: extracting || !text.trim() ? '#F0F0F0' : '#000',
                color: extracting || !text.trim() ? '#999' : '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: extracting || !text.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {extracting ? '抽取中...' : '开始抽取'}
            </button>

            {/* 进度条 */}
            {progress && extracting && (
              <div style={{ marginTop: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                  <span>{progress.message}</span>
                  <span>{Math.round(progress.current / progress.total * 100)}%</span>
                </div>
                <div style={{ height: '4px', background: '#F0F0F0', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    background: 'linear-gradient(90deg, #004E89, #FF6B35)',
                    width: `${(progress.current / progress.total) * 100}%`,
                    transition: 'width 0.3s',
                  }} />
                </div>
              </div>
            )}

            {/* 错误 */}
            {error && (
              <div style={{
                marginTop: '16px',
                padding: '12px',
                background: '#FFF5F5',
                border: '1px solid #FED7D7',
                borderRadius: '6px',
                color: '#E53E3E',
                fontSize: '13px',
              }}>
                {error}
              </div>
            )}

            {/* 统计信息 */}
            {graph && (
              <div style={{
                marginTop: '16px',
                background: '#fff',
                borderRadius: '8px',
                border: '1px solid #E0E0E0',
                padding: '16px',
              }}>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>抽取结果</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                  <div style={{ textAlign: 'center', padding: '12px', background: '#F5F5F5', borderRadius: '6px' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#004E89' }}>{graph.metadata.entityCount}</div>
                    <div style={{ fontSize: '11px', color: '#999' }}>实体</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '12px', background: '#F5F5F5', borderRadius: '6px' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#FF6B35' }}>{graph.metadata.relationCount}</div>
                    <div style={{ fontSize: '11px', color: '#999' }}>关系</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '12px', background: '#F5F5F5', borderRadius: '6px' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#7B2D8E' }}>{graph.metadata.communityCount}</div>
                    <div style={{ fontSize: '11px', color: '#999' }}>社区</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右侧：图谱展示 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {/* 工具栏 */}
          <div style={{
            height: '48px',
            borderBottom: '1px solid #EAEAEA',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            background: '#FAFAFA',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600 }}>知识图谱</span>
              {graph && (
                <>
                  <span style={{ color: '#E0E0E0' }}>|</span>
                  <span style={{ fontSize: '12px', color: '#666' }}>{graph.metadata.entityCount} 实体</span>
                  <span style={{ color: '#E0E0E0' }}>|</span>
                  <span style={{ fontSize: '12px', color: '#666' }}>{graph.metadata.relationCount} 关系</span>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={loadGraph}
                style={{
                  padding: '6px 12px',
                  border: '1px solid #E0E0E0',
                  background: '#fff',
                  borderRadius: '4px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                刷新
              </button>
              <button
                onClick={() => setIsFullScreen(!isFullScreen)}
                style={{
                  padding: '6px 12px',
                  border: '1px solid #E0E0E0',
                  background: '#fff',
                  borderRadius: '4px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                {isFullScreen ? '退出全屏' : '全屏'}
              </button>
            </div>
          </div>

          {/* 图谱容器 */}
          <div ref={graphContainerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            {graph ? (
              <>
                <svg ref={graphSvgRef} style={{ width: '100%', height: '100%' }} />

                {/* 实体详情面板 */}
                {selectedEntity && (
                  <div style={{
                    position: 'absolute',
                    top: '16px',
                    right: '16px',
                    width: '280px',
                    background: '#fff',
                    border: '1px solid #E0E0E0',
                    borderRadius: '8px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  }}>
                    <div style={{
                      padding: '12px 16px',
                      borderBottom: '1px solid #E0E0E0',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#666' }}>实体详情</span>
                      <button onClick={() => setSelectedEntity(null)} style={{
                        border: 'none',
                        background: 'none',
                        fontSize: '18px',
                        cursor: 'pointer',
                        color: '#999',
                      }}>×</button>
                    </div>
                    <div style={{ padding: '16px' }}>
                      <div style={{ marginBottom: '8px' }}>
                        <div style={{ fontSize: '11px', color: '#999' }}>名称</div>
                        <div style={{ fontSize: '14px', fontWeight: 600 }}>{selectedEntity.name}</div>
                      </div>
                      <div style={{ marginBottom: '8px' }}>
                        <div style={{ fontSize: '11px', color: '#999' }}>类型</div>
                        <span style={{
                          padding: '2px 8px',
                          background: '#E3F2FD',
                          color: '#1976D2',
                          borderRadius: '4px',
                          fontSize: '11px',
                        }}>
                          {selectedEntity.type}
                        </span>
                      </div>
                      {selectedEntity.description && (
                        <div>
                          <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>描述</div>
                          <p style={{ fontSize: '12px', color: '#666', margin: 0 }}>{selectedEntity.description}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#999',
              }}>
                <svg viewBox="0 0 100 100" style={{ width: '80px', height: '80px', marginBottom: '16px' }}>
                  <circle cx="50" cy="20" r="8" fill="none" stroke="#000" strokeWidth="1.5" />
                  <circle cx="20" cy="60" r="8" fill="none" stroke="#000" strokeWidth="1.5" />
                  <circle cx="80" cy="60" r="8" fill="none" stroke="#000" strokeWidth="1.5" />
                  <circle cx="50" cy="80" r="8" fill="none" stroke="#000" strokeWidth="1.5" />
                  <line x1="50" y1="28" x2="25" y2="54" stroke="#000" strokeWidth="1" />
                  <line x1="50" y1="28" x2="75" y2="54" stroke="#000" strokeWidth="1" />
                  <line x1="28" y1="60" x2="72" y2="60" stroke="#000" strokeWidth="1" />
                  <line x1="50" y1="72" x2="26" y2="66" stroke="#000" strokeWidth="1" />
                  <line x1="50" y1="72" x2="74" y2="66" stroke="#000" strokeWidth="1" />
                </svg>
                <p>输入文本并点击开始抽取</p>
              </div>
            )}
          </div>

          {/* 图例 */}
          {graph && entityTypes.length > 0 && (
            <div style={{
              height: '40px',
              borderTop: '1px solid #EAEAEA',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
              padding: '0 16px',
              background: '#FAFAFA',
            }}>
              {entityTypes.map((type, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: type.color }} />
                  <span style={{ fontSize: '12px', color: '#666' }}>{type.name}</span>
                  <span style={{ fontSize: '11px', color: '#999' }}>({type.count})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 动画 */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
