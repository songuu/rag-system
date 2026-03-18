'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import * as d3 from 'd3';

// ==================== 类型定义 ====================

interface Ontology {
  entity_types: Array<{
    name: string;
    description: string;
    attributes: Array<{ name: string; type: string; description: string }>;
    examples: string[];
  }>;
  relation_types: Array<{
    name: string;
    description: string;
    source_type: string;
    target_type: string;
  }>;
  analysis_summary: string;
}

interface GraphNode {
  uuid: string;
  name: string;
  labels: string[];
  summary: string;
  attributes: Record<string, unknown>;
}

interface GraphEdge {
  uuid: string;
  name: string;
  fact: string;
  source_node_name: string;
  target_node_name: string;
}

interface GraphData {
  graph_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  node_count: number;
  edge_count: number;
}

// ==================== 组件 ====================

export default function GraphRagPage() {
  const router = useRouter();

  // 状态
  const [text, setText] = useState<string>('');
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [building, setBuilding] = useState<boolean>(false);
  const [progress, setProgress] = useState<{ progress: number; message: string } | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 展示状态
  const [selectedItem, setSelectedItem] = useState<{ type: 'node' | 'edge'; data: GraphNode | GraphEdge } | null>(null);
  const [isFullScreen, setIsFullScreen] = useState<boolean>(false);
  const [entityTypes, setEntityTypes] = useState<Array<{ name: string; count: number; color: string }>>([]);

  // DOM引用
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const graphSvgRef = useRef<SVGSVGElement>(null);

  // 颜色
  const colors = ['#FF6B35', '#004E89', '#7B2D8E', '#1A936F', '#C5283D', '#E9724C'];

  // ==================== 构建图谱 ====================

  const buildGraph = async () => {
    if (!text.trim()) {
      setError('请输入要构建图谱的文本');
      return;
    }

    setBuilding(true);
    setError(null);
    setProgress({ progress: 0, message: '正在创建构建任务...' });

    try {
      const response = await fetch('/api/mirofish/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          ontology: ontology,
          graphName: 'GraphRag Graph',
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '图谱构建失败');
      }

      setCurrentTaskId(data.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '图谱构建失败');
      setBuilding(false);
    }
  };

  // 轮询状态
  useEffect(() => {
    if (!currentTaskId || !building) return;

    const pollStatus = async () => {
      try {
        const response = await fetch(
          `/api/mirofish/graph?action=status&taskId=${currentTaskId}`
        );
        const data = await response.json();

        if (data.success) {
          setProgress({
            progress: data.progress || 0,
            message: data.message || '',
          });

          if (data.status === 'completed' && data.graphId) {
            const graphResponse = await fetch(
              `/api/mirofish/graph?action=data&graphId=${data.graphId}`
            );
            const graphResult = await graphResponse.json();

            if (graphResult.success) {
              setGraphData(graphResult.graph);
            }

            setBuilding(false);
            setCurrentTaskId(null);
          } else if (data.status === 'failed') {
            setError(data.error || '图谱构建失败');
            setBuilding(false);
          }
        }
      } catch (err) {
        console.error('获取状态失败:', err);
      }
    };

    const interval = setInterval(pollStatus, 2000);
    return () => clearInterval(interval);
  }, [currentTaskId, building]);

  // 提取实体类型
  useEffect(() => {
    if (!graphData?.nodes) {
      setEntityTypes([]);
      return;
    }

    const typeMap: Record<string, number> = {};
    graphData.nodes.forEach(node => {
      const type = node.labels?.find(l => l !== 'Entity') || 'Entity';
      typeMap[type] = (typeMap[type] || 0) + 1;
    });

    const types = Object.entries(typeMap).map(([name, count], index) => ({
      name,
      count,
      color: colors[index % colors.length],
    }));
    setEntityTypes(types);
  }, [graphData]);

  // 渲染图谱
  const renderGraph = useCallback(() => {
    if (!graphData || !graphSvgRef.current || !graphContainerRef.current) return;

    const svg = d3.select(graphSvgRef.current);
    svg.selectAll('*').remove();

    const container = graphContainerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    svg.attr('width', width).attr('height', height);

    const nodes = graphData.nodes.map(n => ({
      id: n.uuid,
      name: n.name,
      labels: n.labels,
      ...n,
    }));

    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const links = graphData.edges
      .filter(e => nodeMap.has(e.source_node_name) && nodeMap.has(e.target_node_name))
      .map(e => ({
        source: e.source_node_name,
        target: e.target_node_name,
        ...e,
      }));

    const simulation = d3.forceSimulation(nodes as d3.SimulationNodeDatum[])
      .force('link', d3.forceLink(links).id((d: any) => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(40));

    const link = svg.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#999')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.6);

    const node = svg.append('g')
      .selectAll('circle')
      .data(nodes)
      .join('circle')
      .attr('r', 12)
      .attr('fill', (d, i) => colors[i % colors.length])
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
        setSelectedItem({ type: 'node', data: d });
      });

    const label = svg.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .text(d => d.name)
      .attr('font-size', 10)
      .attr('fill', '#333')
      .attr('text-anchor', 'middle')
      .attr('dy', 25);

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
  }, [graphData]);

  // 初始化渲染
  useEffect(() => {
    if (graphData && !isFullScreen) {
      setTimeout(renderGraph, 100);
    }
  }, [graphData, renderGraph, isFullScreen]);

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
          <h1 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>GraphRag 构建</h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{
            fontSize: '12px',
            padding: '4px 12px',
            borderRadius: '12px',
            background: building ? '#FFF3E0' : graphData ? '#E8F5E9' : '#F5F5F5',
            color: building ? '#FF9800' : graphData ? '#4CAF50' : '#999',
          }}>
            {building ? '构建中...' : graphData ? '已完成' : '待构建'}
          </span>
        </div>
      </nav>

      {/* 主内容 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* 左侧：配置 */}
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
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>输入文本</div>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="输入要构建图谱的文本内容..."
                style={{
                  width: '100%',
                  height: '200px',
                  padding: '12px',
                  border: '1px solid #E0E0E0',
                  borderRadius: '6px',
                  fontSize: '13px',
                  resize: 'none',
                  fontFamily: 'inherit',
                }}
              />
            </div>

            {/* 本体配置 */}
            <div style={{
              background: '#fff',
              borderRadius: '8px',
              border: '1px solid #E0E0E0',
              padding: '16px',
              marginBottom: '16px',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>本体定义（可选）</div>
              <p style={{ fontSize: '12px', color: '#666', marginBottom: '12px' }}>
                如果已有本体定义，可以在此输入以约束实体抽取
              </p>
              <textarea
                value={ontology ? JSON.stringify(ontology, null, 2) : ''}
                onChange={e => {
                  try {
                    setOntology(JSON.parse(e.target.value));
                  } catch {}
                }}
                placeholder='{"entity_types": [...], "relation_types": [...]}'
                style={{
                  width: '100%',
                  height: '150px',
                  padding: '12px',
                  border: '1px solid #E0E0E0',
                  borderRadius: '6px',
                  fontSize: '12px',
                  resize: 'none',
                  fontFamily: 'monospace',
                }}
              />
            </div>

            {/* 构建按钮 */}
            <button
              onClick={buildGraph}
              disabled={building || !text.trim()}
              style={{
                width: '100%',
                padding: '12px',
                background: building || !text.trim() ? '#F0F0F0' : '#000',
                color: building || !text.trim() ? '#999' : '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: building || !text.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {building ? '构建中...' : '构建图谱'}
            </button>

            {/* 进度条 */}
            {progress && building && (
              <div style={{ marginTop: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                  <span>{progress.message}</span>
                  <span>{Math.round(progress.progress)}%</span>
                </div>
                <div style={{ height: '4px', background: '#F0F0F0', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    background: 'linear-gradient(90deg, #004E89, #FF6B35)',
                    width: `${progress.progress}%`,
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

            {/* 统计 */}
            {graphData && (
              <div style={{
                marginTop: '16px',
                background: '#fff',
                borderRadius: '8px',
                border: '1px solid #E0E0E0',
                padding: '16px',
              }}>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>构建结果</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                  <div style={{ textAlign: 'center', padding: '12px', background: '#F5F5F5', borderRadius: '6px' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#004E89' }}>{graphData.node_count}</div>
                    <div style={{ fontSize: '11px', color: '#999' }}>实体</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '12px', background: '#F5F5F5', borderRadius: '6px' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#FF6B35' }}>{graphData.edge_count}</div>
                    <div style={{ fontSize: '11px', color: '#999' }}>关系</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '12px', background: '#F5F5F5', borderRadius: '6px' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#7B2D8E' }}>{entityTypes.length}</div>
                    <div style={{ fontSize: '11px', color: '#999' }}>类型</div>
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
              {graphData && (
                <>
                  <span style={{ color: '#E0E0E0' }}>|</span>
                  <span style={{ fontSize: '12px', color: '#666' }}>{graphData.node_count} 实体</span>
                  <span style={{ color: '#E0E0E0' }}>|</span>
                  <span style={{ fontSize: '12px', color: '#666' }}>{graphData.edge_count} 关系</span>
                </>
              )}
            </div>
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

          {/* 图谱容器 */}
          <div ref={graphContainerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            {graphData ? (
              <>
                <svg ref={graphSvgRef} style={{ width: '100%', height: '100%' }} />

                {/* 详情面板 */}
                {selectedItem && (
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
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#666' }}>
                        {selectedItem.type === 'node' ? '实体详情' : '关系详情'}
                      </span>
                      <button onClick={() => setSelectedItem(null)} style={{
                        border: 'none',
                        background: 'none',
                        fontSize: '18px',
                        cursor: 'pointer',
                        color: '#999',
                      }}>×</button>
                    </div>
                    <div style={{ padding: '16px' }}>
                      {selectedItem.type === 'node' ? (
                        <>
                          <div style={{ marginBottom: '8px' }}>
                            <div style={{ fontSize: '11px', color: '#999' }}>名称</div>
                            <div style={{ fontSize: '14px', fontWeight: 600 }}>{(selectedItem.data as GraphNode).name}</div>
                          </div>
                          <div style={{ marginBottom: '8px' }}>
                            <div style={{ fontSize: '11px', color: '#999' }}>类型</div>
                            <span style={{ padding: '2px 8px', background: '#E3F2FD', color: '#1976D2', borderRadius: '4px', fontSize: '11px' }}>
                              {(selectedItem.data as GraphNode).labels?.[0]}
                            </span>
                          </div>
                          {(selectedItem.data as GraphNode).summary && (
                            <div>
                              <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>描述</div>
                              <p style={{ fontSize: '12px', color: '#666', margin: 0 }}>{(selectedItem.data as GraphNode).summary}</p>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div>
                            <div style={{ fontSize: '11px', color: '#999', marginBottom: '8px' }}>关系</div>
                            <div style={{ fontSize: '13px' }}>
                              <span style={{ color: '#004E89' }}>{(selectedItem.data as GraphEdge).source_node_name}</span>
                              <span style={{ margin: '0 8px' }}>→</span>
                              <span style={{ color: '#FF6B35' }}>{(selectedItem.data as GraphEdge).name}</span>
                              <span style={{ margin: '0 8px' }}>→</span>
                              <span style={{ color: '#004E89' }}>{(selectedItem.data as GraphEdge).target_node_name}</span>
                            </div>
                          </div>
                          {(selectedItem.data as GraphEdge).fact && (
                            <div style={{ marginTop: '8px' }}>
                              <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>事实</div>
                              <p style={{ fontSize: '12px', color: '#666', margin: 0 }}>{(selectedItem.data as GraphEdge).fact}</p>
                            </div>
                          )}
                        </>
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
                <p>输入文本并构建图谱</p>
              </div>
            )}
          </div>

          {/* 图例 */}
          {graphData && entityTypes.length > 0 && (
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
    </div>
  );
}
