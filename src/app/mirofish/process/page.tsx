'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
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
  created_at?: string;
}

interface GraphEdge {
  uuid: string;
  name: string;
  fact: string;
  source_node_name: string;
  target_node_name: string;
  fact_type?: string;
  episodes?: string[];
  created_at?: string;
}

interface GraphData {
  graph_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  node_count: number;
  edge_count: number;
}

interface TaskStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  graphId?: string;
  error?: string;
}

interface PhaseStatus {
  phase: number;
  status: 'waiting' | 'processing' | 'completed' | 'error';
  message?: string;
}

// ==================== 组件 ====================

export default function MiroFishProcessPage() {
  const router = useRouter();

  // 工作流阶段: 0=本体生成, 1=图谱构建, 2=完成
  const [currentPhase, setCurrentPhase] = useState<number>(-1);
  const [statusText, setStatusText] = useState<string>('初始化中');
  const [statusClass, setStatusClass] = useState<string>('processing');

  // 数据状态
  const [simulationRequirement, setSimulationRequirement] = useState<string>('');
  const [inputText, setInputText] = useState<string>('');
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);

  // 加载状态
  const [ontologyLoading, setOntologyLoading] = useState<boolean>(false);
  const [graphLoading, setGraphLoading] = useState<boolean>(false);
  const [graphBuilding, setGraphBuilding] = useState<boolean>(false);
  const [ontologyProgress, setOntologyProgress] = useState<PhaseStatus | null>(null);
  const [buildProgress, setBuildProgress] = useState<{ progress: number; message: string } | null>(null);

  // 错误状态
  const [error, setError] = useState<string | null>(null);

  // 图谱展示
  const [selectedItem, setSelectedItem] = useState<{ type: 'node' | 'edge'; data: GraphNode | GraphEdge } | null>(null);
  const [isFullScreen, setIsFullScreen] = useState<boolean>(false);
  const [entityTypes, setEntityTypes] = useState<Array<{ name: string; count: number; color: string }>>([]);

  // DOM引用
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const graphSvgRef = useRef<SVGSVGElement>(null);

  // 任务轮询
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);

  // 颜色配置
  const colors = ['#FF6B35', '#004E89', '#7B2D8E', '#1A936F', '#C5283D', '#E9724C'];

  // ==================== 计算属性 ====================

  // 根据阶段更新状态
  useEffect(() => {
    if (error) {
      setStatusClass('error');
      setStatusText('构建失败');
    } else if (currentPhase >= 2) {
      setStatusClass('completed');
      setStatusText('构建完成');
    } else if (currentPhase === 1) {
      setStatusClass('processing');
      setStatusText('图谱构建中');
    } else if (currentPhase === 0) {
      setStatusClass('processing');
      setStatusText('本体生成中');
    } else {
      setStatusClass('processing');
      setStatusText('初始化中');
    }
  }, [currentPhase, error]);

  // 从图谱数据提取实体类型统计
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

  // ==================== 方法 ====================

  // 本体生成
  const generateOntology = async () => {
    if (!simulationRequirement.trim()) {
      setError('请输入模拟需求');
      return;
    }

    if (!inputText.trim() && !ontology) {
      setError('请输入分析文本');
      return;
    }

    setOntologyLoading(true);
    setError(null);
    setOntologyProgress({ phase: 0, status: 'processing', message: '正在生成本体...' });
    setCurrentPhase(0);

    try {
      const response = await fetch('/api/mirofish/ontology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texts: inputText.trim() ? [inputText] : [],
          simulationRequirement: simulationRequirement,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '本体生成失败');
      }

      setOntology(data.ontology);
      setOntologyProgress({ phase: 0, status: 'completed', message: '本体生成完成' });
      setCurrentPhase(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : '本体生成失败');
      setOntologyProgress({ phase: 0, status: 'error', message: err instanceof Error ? err.message : '本体生成失败' });
    } finally {
      setOntologyLoading(false);
    }
  };

  // 构建图谱
  const buildGraph = async () => {
    if (!inputText.trim()) {
      setError('请输入要构建图谱的文本');
      return;
    }

    if (!ontology) {
      setError('请先生成本体');
      return;
    }

    setGraphBuilding(true);
    setGraphLoading(true);
    setError(null);
    setBuildProgress({ progress: 0, message: '正在创建任务...' });
    setCurrentPhase(1);

    try {
      const response = await fetch('/api/mirofish/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: inputText,
          ontology: ontology,
          graphName: 'MiroFish Graph',
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '图谱构建失败');
      }

      setCurrentTaskId(data.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '图谱构建失败');
      setGraphBuilding(false);
      setGraphLoading(false);
    }
  };

  // 轮询图谱状态
  useEffect(() => {
    if (!currentTaskId || !graphBuilding) return;

    const pollStatus = async () => {
      try {
        const response = await fetch(
          `/api/mirofish/graph?action=status&taskId=${currentTaskId}`
        );
        const data = await response.json();

        if (data.success) {
          setBuildProgress({
            progress: data.progress || 0,
            message: data.message || '',
          });

          if (data.status === 'completed' && data.graphId) {
            // 获取图谱数据
            const graphResponse = await fetch(
              `/api/mirofish/graph?action=data&graphId=${data.graphId}`
            );
            const graphResult = await graphResponse.json();

            if (graphResult.success) {
              setGraphData(graphResult.graph);
              setCurrentPhase(2);
            }

            setGraphBuilding(false);
            setGraphLoading(false);
            setCurrentTaskId(null);
          } else if (data.status === 'failed') {
            setError(data.error || '图谱构建失败');
            setGraphBuilding(false);
            setGraphLoading(false);
          }
        }
      } catch (err) {
        console.error('获取状态失败:', err);
      }
    };

    const interval = setInterval(pollStatus, 2000);
    return () => clearInterval(interval);
  }, [currentTaskId, graphBuilding]);

  // 刷新图谱
  const refreshGraph = useCallback(() => {
    if (graphData?.graph_id) {
      setGraphLoading(true);
      fetch(`/api/mirofish/graph?action=data&graphId=${graphData.graph_id}`)
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            setGraphData(data.graph);
          }
        })
        .finally(() => setGraphLoading(false));
    }
  }, [graphData?.graph_id]);

  // 全屏切换
  const toggleFullScreen = () => {
    setIsFullScreen(!isFullScreen);
    setTimeout(() => renderGraph(), 350);
  };

  // 渲染图谱
  const renderGraph = useCallback(() => {
    if (!graphData || !graphSvgRef.current || !graphContainerRef.current) return;

    const svg = d3.select(graphSvgRef.current);
    svg.selectAll('*').remove();

    const container = graphContainerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    svg.attr('width', width).attr('height', height);

    // 创建节点和边的数据
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
        id: e.uuid,
        source: e.source_node_name,
        target: e.target_node_name,
        name: e.name,
        fact: e.fact,
        ...e,
      }));

    // 创建力导向图
    const simulation = d3.forceSimulation(nodes as d3.SimulationNodeDatum[])
      .force('link', d3.forceLink(links).id((d: any) => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(40));

    // 绘制边
    const link = svg.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#999')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.6);

    // 绘制节点
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

    // 添加标签
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
  }, [graphData]);

  // 初始化渲染图谱
  useEffect(() => {
    if (graphData && !isFullScreen) {
      setTimeout(renderGraph, 100);
    }
  }, [graphData, renderGraph, isFullScreen]);

  // 格式化日期
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  // 获取阶段状态类
  const getPhaseStatusClass = (phase: number) => {
    if (phase > currentPhase) return 'waiting';
    if (phase === currentPhase) return currentPhase === 2 && !error ? 'completed' : 'processing';
    return 'completed';
  };

  // 获取阶段状态文本
  const getPhaseStatusText = (phase: number) => {
    const status = getPhaseStatusClass(phase);
    const texts: Record<string, Record<number, string>> = {
      waiting: { 0: '等待中', 1: '等待中', 2: '等待中' },
      processing: { 0: '生成中', 1: '构建中', 2: '完成' },
      completed: { 0: '已完成', 1: '已完成', 2: '已完成' },
      error: { 0: '失败', 1: '失败', 2: '失败' },
    };
    return texts[status]?.[phase] || '等待中';
  };

  // 进入下一步
  const goToNextStep = () => {
    alert('环境搭建功能开发中...');
  };

  // 返回首页
  const goHome = () => {
    router.push('/mirofish');
  };

  // ==================== 渲染 ====================

  return (
    <div className="process-page" style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: "'Space Grotesk', 'Noto Sans SC', system-ui, sans-serif" }}>
      {/* 顶部导航栏 */}
      <nav className="navbar" style={{
        height: '60px',
        background: '#fff',
        borderBottom: '1px solid #EAEAEA',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        position: 'relative',
        zIndex: 100,
      }}>
        {/* 左侧品牌 */}
        <div className="nav-brand" onClick={goHome} style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 800,
          fontSize: '18px',
          letterSpacing: '1px',
          cursor: 'pointer',
          color: '#000',
        }}>
          MIROFISH
        </div>

        {/* 中间步骤指示器 */}
        <div className="nav-center" style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}>
          <div style={{
            background: '#000',
            color: '#fff',
            padding: '4px 12px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: 700,
          }}>
            STEP 01
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>
            图谱构建
          </div>
        </div>

        {/* 右侧状态 */}
        <div className="nav-status" style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '12px',
        }}>
          <span className="status-dot" style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: statusClass === 'error' ? '#F44336' : statusClass === 'completed' ? '#4CAF50' : '#FF5722',
            animation: statusClass === 'processing' ? 'pulse 1s infinite' : 'none',
          }} />
          <span style={{ color: '#666', fontWeight: 500 }}>{statusText}</span>
        </div>
      </nav>

      {/* 主内容区 */}
      <div className="main-content" style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
      }}>
        {/* 左侧: 实时图谱展示 */}
        <div className="left-panel" style={{
          flex: isFullScreen ? '1' : '1',
          display: 'flex',
          flexDirection: 'column',
          borderRight: isFullScreen ? 'none' : '1px solid #EAEAEA',
          background: '#fff',
          transition: 'all 0.3s ease',
        }}>
          {/* 面板头部 */}
          <div className="panel-header" style={{
            height: '48px',
            borderBottom: '1px solid #EAEAEA',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            background: '#FAFAFA',
          }}>
            <div className="header-left" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: '#000' }}>◆</span>
              <span style={{ fontSize: '14px', fontWeight: 600 }}>实时知识图谱</span>
            </div>
            <div className="header-right" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {graphData && (
                <>
                  <span style={{ fontSize: '12px', color: '#666' }}>{graphData.node_count} 节点</span>
                  <span style={{ color: '#E0E0E0' }}>|</span>
                  <span style={{ fontSize: '12px', color: '#666' }}>{graphData.edge_count} 关系</span>
                  <span style={{ color: '#E0E0E0' }}>|</span>
                </>
              )}
              <div style={{ display: 'flex', gap: '4px' }}>
                <button onClick={refreshGraph} disabled={graphLoading} style={{
                  width: '28px',
                  height: '28px',
                  border: '1px solid #E0E0E0',
                  background: '#fff',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '14px',
                  transition: 'all 0.2s',
                }} title="刷新图谱">
                  ↻
                </button>
                <button onClick={toggleFullScreen} style={{
                  width: '28px',
                  height: '28px',
                  border: '1px solid #E0E0E0',
                  background: '#fff',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '14px',
                  transition: 'all 0.2s',
                }} title={isFullScreen ? '退出全屏' : '全屏显示'}>
                  {isFullScreen ? '↙' : '↗'}
                </button>
              </div>
            </div>
          </div>

          {/* 图谱容器 */}
          <div className="graph-container" ref={graphContainerRef} style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
          }}>
            {graphData ? (
              <>
                <svg ref={graphSvgRef} style={{ width: '100%', height: '100%' }} />
                {/* 构建中提示 */}
                {currentPhase === 1 && graphBuilding && (
                  <div style={{
                    position: 'absolute',
                    top: '16px',
                    left: '16px',
                    background: 'rgba(0,0,0,0.7)',
                    color: '#fff',
                    padding: '8px 16px',
                    borderRadius: '20px',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}>
                    <span style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: '#FF5722',
                      animation: 'pulse 1s infinite',
                    }} />
                    实时更新中...
                  </div>
                )}

                {/* 节点/边详情面板 */}
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
                    maxHeight: 'calc(100% - 32px)',
                    overflow: 'auto',
                  }}>
                    <div style={{
                      padding: '12px 16px',
                      borderBottom: '1px solid #E0E0E0',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#666' }}>
                        {selectedItem.type === 'node' ? 'Node Details' : 'Relationship'}
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
                          <div style={{ marginBottom: '12px' }}>
                            <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>Name</div>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#000' }}>
                              {(selectedItem.data as GraphNode).name}
                            </div>
                          </div>
                          <div style={{ marginBottom: '12px' }}>
                            <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>UUID</div>
                            <div style={{ fontSize: '11px', color: '#666', wordBreak: 'break-all' }}>
                              {(selectedItem.data as GraphNode).uuid}
                            </div>
                          </div>
                          {(selectedItem.data as GraphNode).labels?.length > 0 && (
                            <div style={{ marginBottom: '12px' }}>
                              <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>Labels</div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                {(selectedItem.data as GraphNode).labels?.map((label, i) => (
                                  <span key={i} style={{
                                    padding: '2px 8px',
                                    background: '#F0F0F0',
                                    borderRadius: '4px',
                                    fontSize: '11px',
                                  }}>
                                    {label}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {(selectedItem.data as GraphNode).summary && (
                            <div>
                              <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>Summary</div>
                              <p style={{ fontSize: '12px', color: '#666', lineHeight: 1.5 }}>
                                {(selectedItem.data as GraphNode).summary}
                              </p>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div style={{ marginBottom: '12px' }}>
                            <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>Relationship</div>
                            <div style={{ fontSize: '13px', color: '#000' }}>
                              <span style={{ color: '#004E89' }}>{(selectedItem.data as GraphEdge).source_node_name}</span>
                              <span style={{ margin: '0 8px' }}>→</span>
                              <span style={{ color: '#FF6B35' }}>{(selectedItem.data as GraphEdge).name}</span>
                              <span style={{ margin: '0 8px' }}>→</span>
                              <span style={{ color: '#004E89' }}>{(selectedItem.data as GraphEdge).target_node_name}</span>
                            </div>
                          </div>
                          {(selectedItem.data as GraphEdge).fact && (
                            <div>
                              <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>Fact</div>
                              <p style={{ fontSize: '12px', color: '#666', lineHeight: 1.5 }}>
                                {(selectedItem.data as GraphEdge).fact}
                              </p>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : graphLoading ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#999',
              }}>
                <div className="loading-animation" style={{ marginBottom: '16px' }}>
                  <div style={{
                    width: '40px',
                    height: '40px',
                    border: '3px solid #F0F0F0',
                    borderTop: '3px solid #004E89',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                  }} />
                </div>
                <p>图谱数据加载中...</p>
              </div>
            ) : currentPhase < 1 ? (
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
                  <line x1="28" y1="60" x2="72" y2="60" stroke="#000" strokeWidth="1" strokeDasharray="4" />
                  <line x1="50" y1="72" x2="26" y2="66" stroke="#000" strokeWidth="1" />
                  <line x1="50" y1="72" x2="74" y2="66" stroke="#000" strokeWidth="1" />
                </svg>
                <p style={{ fontSize: '14px', marginBottom: '8px' }}>等待本体生成</p>
                <p style={{ fontSize: '12px', color: '#CCC' }}>生成完成后将自动开始构建图谱</p>
              </div>
            ) : (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#999',
              }}>
                <div className="loading-animation" style={{ marginBottom: '16px' }}>
                  <div style={{
                    width: '40px',
                    height: '40px',
                    border: '3px solid #F0F0F0',
                    borderTop: '3px solid #004E89',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                  }} />
                </div>
                <p>图谱构建中</p>
                <p style={{ fontSize: '12px', color: '#CCC' }}>数据即将显示...</p>
              </div>
            )}

            {error && (
              <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                background: '#FFF5F5',
                border: '1px solid #FED7D7',
                borderRadius: '8px',
                padding: '24px',
                textAlign: 'center',
                maxWidth: '400px',
              }}>
                <div style={{ fontSize: '24px', marginBottom: '12px' }}>⚠</div>
                <p style={{ color: '#E53E3E', margin: 0 }}>{error}</p>
              </div>
            )}
          </div>

          {/* 图谱图例 */}
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
                  <span style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    background: type.color,
                  }} />
                  <span style={{ fontSize: '12px', color: '#666' }}>{type.name}</span>
                  <span style={{ fontSize: '11px', color: '#999' }}>({type.count})</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右侧: 构建流程详情 */}
        <div className="right-panel" style={{
          width: isFullScreen ? '0' : '380px',
          display: 'flex',
          flexDirection: 'column',
          background: '#FAFAFA',
          overflow: 'hidden',
          transition: 'all 0.3s ease',
          opacity: isFullScreen ? 0 : 1,
        }}>
          {/* 面板头部 */}
          <div style={{
            height: '48px',
            borderBottom: '1px solid #EAEAEA',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '0 16px',
            background: '#000',
            color: '#fff',
          }}>
            <span style={{ fontSize: '14px' }}>▣</span>
            <span style={{ fontSize: '14px', fontWeight: 600 }}>构建流程</span>
          </div>

          {/* 流程内容 */}
          <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
            {/* 阶段1: 本体生成 */}
            <div style={{
              background: '#fff',
              borderRadius: '8px',
              border: '1px solid #E0E0E0',
              marginBottom: '16px',
              overflow: 'hidden',
            }}>
              <div style={{
                padding: '12px 16px',
                borderBottom: '1px solid #F0F0F0',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                background: currentPhase === 0 ? '#F0F9FF' : '#fff',
              }}>
                <span style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  background: getPhaseStatusClass(0) === 'completed' ? '#4CAF50' : getPhaseStatusClass(0) === 'error' ? '#F44336' : '#000',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                }}>
                  01
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '14px', fontWeight: 600 }}>本体生成</div>
                  <div style={{ fontSize: '11px', color: '#999' }}>/api/mirofish/ontology</div>
                </div>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  background: getPhaseStatusClass(0) === 'completed' ? '#E8F5E9' : getPhaseStatusClass(0) === 'error' ? '#FFEBEE' : '#FFF3E0',
                  color: getPhaseStatusClass(0) === 'completed' ? '#4CAF50' : getPhaseStatusClass(0) === 'error' ? '#F44336' : '#FF9800',
                }}>
                  {getPhaseStatusText(0)}
                </span>
              </div>

              <div style={{ padding: '16px' }}>
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>接口说明</div>
                  <div style={{ fontSize: '12px', color: '#666' }}>
                    上传文档后，LLM分析文档内容，自动生成适合舆论模拟的本体结构（实体类型 + 关系类型）
                  </div>
                </div>

                {/* 输入表单 */}
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>模拟需求描述</div>
                  <textarea
                    value={simulationRequirement}
                    onChange={e => setSimulationRequirement(e.target.value)}
                    placeholder="例如：模拟一个关于某品牌产品争议的社交媒体舆论场..."
                    style={{
                      width: '100%',
                      height: '60px',
                      padding: '8px',
                      border: '1px solid #E0E0E0',
                      borderRadius: '4px',
                      fontSize: '12px',
                      resize: 'none',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>

                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>分析文本</div>
                  <textarea
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    placeholder="输入要分析的文本内容，用于提取实体类型..."
                    style={{
                      width: '100%',
                      height: '80px',
                      padding: '8px',
                      border: '1px solid #E0E0E0',
                      borderRadius: '4px',
                      fontSize: '12px',
                      resize: 'none',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>

                <button
                  onClick={generateOntology}
                  disabled={ontologyLoading || currentPhase >= 1}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: ontologyLoading || currentPhase >= 1 ? '#F0F0F0' : '#000',
                    color: ontologyLoading || currentPhase >= 1 ? '#999' : '#fff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: ontologyLoading || currentPhase >= 1 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {ontologyLoading ? '生成本体中...' : '生成本体'}
                </button>

                {/* 本体生成进度 */}
                {ontologyProgress && currentPhase === 0 && (
                  <div style={{
                    marginTop: '12px',
                    padding: '8px',
                    background: '#F5F5F5',
                    borderRadius: '4px',
                    fontSize: '12px',
                    color: '#666',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}>
                    <div style={{
                      width: '16px',
                      height: '16px',
                      border: '2px solid #004E89',
                      borderTopColor: 'transparent',
                      borderRadius: '50%',
                      animation: 'spin 1s linear infinite',
                    }} />
                    {ontologyProgress.message}
                  </div>
                )}

                {/* 已生成的本体信息 */}
                {ontology && (
                  <>
                    <div style={{ marginTop: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#999', marginBottom: '6px' }}>
                        生成的实体类型 ({ontology.entity_types?.length || 0})
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {ontology.entity_types?.slice(0, 8).map((entity, i) => (
                          <span key={i} style={{
                            padding: '2px 8px',
                            background: '#E3F2FD',
                            color: '#1976D2',
                            borderRadius: '4px',
                            fontSize: '11px',
                          }}>
                            {entity.name}
                          </span>
                        ))}
                        {(ontology.entity_types?.length || 0) > 8 && (
                          <span style={{ fontSize: '11px', color: '#999' }}>
                            +{ontology.entity_types.length - 8} 更多
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ marginTop: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#999', marginBottom: '6px' }}>
                        生成的关系类型 ({ontology.relation_types?.length || 0})
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {ontology.relation_types?.slice(0, 5).map((rel, i) => (
                          <div key={i} style={{
                            padding: '4px 8px',
                            background: '#F5F5F5',
                            borderRadius: '4px',
                            fontSize: '11px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                          }}>
                            <span style={{ color: '#004E89' }}>{rel.source_type}</span>
                            <span>→</span>
                            <span style={{ color: '#FF6B35' }}>{rel.name}</span>
                            <span>→</span>
                            <span style={{ color: '#004E89' }}>{rel.target_type}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* 阶段2: 图谱构建 */}
            <div style={{
              background: '#fff',
              borderRadius: '8px',
              border: '1px solid #E0E0E0',
              marginBottom: '16px',
              overflow: 'hidden',
            }}>
              <div style={{
                padding: '12px 16px',
                borderBottom: '1px solid #F0F0F0',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                background: currentPhase === 1 ? '#F0F9FF' : '#fff',
              }}>
                <span style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  background: getPhaseStatusClass(1) === 'completed' ? '#4CAF50' : getPhaseStatusClass(1) === 'error' ? '#F44336' : '#000',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                }}>
                  02
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '14px', fontWeight: 600 }}>图谱构建</div>
                  <div style={{ fontSize: '11px', color: '#999' }}>/api/mirofish/graph</div>
                </div>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  background: getPhaseStatusClass(1) === 'completed' ? '#E8F5E9' : getPhaseStatusClass(1) === 'error' ? '#FFEBEE' : currentPhase < 1 ? '#F5F5F5' : '#FFF3E0',
                  color: getPhaseStatusClass(1) === 'completed' ? '#4CAF50' : getPhaseStatusClass(1) === 'error' ? '#F44336' : currentPhase < 1 ? '#999' : '#FF9800',
                }}>
                  {getPhaseStatusText(1)}
                </span>
              </div>

              <div style={{ padding: '16px' }}>
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>接口说明</div>
                  <div style={{ fontSize: '12px', color: '#666' }}>
                    基于生成的本体，将文档分块后调用LLM进行实体抽取，构建知识图谱
                  </div>
                </div>

                {/* 等待本体完成 */}
                {currentPhase < 1 && (
                  <div style={{
                    padding: '16px',
                    background: '#F5F5F5',
                    borderRadius: '4px',
                    textAlign: 'center',
                    color: '#999',
                    fontSize: '12px',
                  }}>
                    等待本体生成完成...
                  </div>
                )}

                {/* 构建按钮 */}
                {currentPhase >= 1 && (
                  <>
                    <button
                      onClick={buildGraph}
                      disabled={graphBuilding || currentPhase >= 2}
                      style={{
                        width: '100%',
                        padding: '10px',
                        background: graphBuilding || currentPhase >= 2 ? '#F0F0F0' : '#000',
                        color: graphBuilding || currentPhase >= 2 ? '#999' : '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '13px',
                        fontWeight: 600,
                        cursor: graphBuilding || currentPhase >= 2 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {graphBuilding ? '构建中...' : '重新构建图谱'}
                    </button>

                    {/* 构建进度 */}
                    {buildProgress && currentPhase >= 1 && (
                      <div style={{ marginTop: '12px' }}>
                        <div style={{
                          height: '4px',
                          background: '#F0F0F0',
                          borderRadius: '2px',
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            height: '100%',
                            background: 'linear-gradient(90deg, #004E89, #FF6B35)',
                            width: `${buildProgress.progress}%`,
                            transition: 'width 0.3s ease',
                          }} />
                        </div>
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginTop: '4px',
                          fontSize: '11px',
                          color: '#999',
                        }}>
                          <span>{buildProgress.message}</span>
                          <span>{Math.round(buildProgress.progress)}%</span>
                        </div>
                      </div>
                    )}

                    {/* 构建结果 */}
                    {graphData && (
                      <div style={{ marginTop: '12px' }}>
                        <div style={{ fontSize: '11px', color: '#999', marginBottom: '8px' }}>构建结果</div>
                        <div style={{ display: 'flex', gap: '12px' }}>
                          <div style={{
                            flex: 1,
                            padding: '12px',
                            background: '#F5F5F5',
                            borderRadius: '6px',
                            textAlign: 'center',
                          }}>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: '#004E89' }}>
                              {graphData.node_count}
                            </div>
                            <div style={{ fontSize: '11px', color: '#999' }}>实体节点</div>
                          </div>
                          <div style={{
                            flex: 1,
                            padding: '12px',
                            background: '#F5F5F5',
                            borderRadius: '6px',
                            textAlign: 'center',
                          }}>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: '#FF6B35' }}>
                              {graphData.edge_count}
                            </div>
                            <div style={{ fontSize: '11px', color: '#999' }}>关系边</div>
                          </div>
                          <div style={{
                            flex: 1,
                            padding: '12px',
                            background: '#F5F5F5',
                            borderRadius: '6px',
                            textAlign: 'center',
                          }}>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: '#7B2D8E' }}>
                              {entityTypes.length}
                            </div>
                            <div style={{ fontSize: '11px', color: '#999' }}>实体类型</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* 阶段3: 完成 */}
            <div style={{
              background: '#fff',
              borderRadius: '8px',
              border: '1px solid #E0E0E0',
              marginBottom: '16px',
              overflow: 'hidden',
            }}>
              <div style={{
                padding: '12px 16px',
                borderBottom: '1px solid #F0F0F0',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}>
                <span style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  background: currentPhase >= 2 && !error ? '#4CAF50' : '#000',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                }}>
                  03
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '14px', fontWeight: 600 }}>构建完成</div>
                  <div style={{ fontSize: '11px', color: '#999' }}>准备进入下一步骤</div>
                </div>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  background: currentPhase >= 2 && !error ? '#E8F5E9' : '#F5F5F5',
                  color: currentPhase >= 2 && !error ? '#4CAF50' : '#999',
                }}>
                  {currentPhase >= 2 && !error ? '已完成' : '等待中'}
                </span>
              </div>
            </div>

            {/* 下一步按钮 */}
            {currentPhase >= 2 && !error && (
              <button
                onClick={goToNextStep}
                style={{
                  width: '100%',
                  padding: '14px',
                  background: 'linear-gradient(135deg, #004E89, #7B2D8E)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
              >
                进入环境搭建
                <span>→</span>
              </button>
            )}
          </div>

          {/* 项目信息面板 */}
          <div style={{
            borderTop: '1px solid #EAEAEA',
            padding: '16px',
            background: '#fff',
          }}>
            <div style={{
              fontSize: '12px',
              fontWeight: 600,
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}>
              <span>◇</span>
              <span>项目信息</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                <span style={{ color: '#999' }}>项目名称</span>
                <span style={{ color: '#000', fontWeight: 500 }}>MiroFish Graph</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                <span style={{ color: '#999' }}>图谱ID</span>
                <span style={{ color: '#666', fontFamily: 'monospace', fontSize: '11px' }}>
                  {graphData?.graph_id || '-'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                <span style={{ color: '#999' }}>模拟需求</span>
                <span style={{ color: '#000', fontWeight: 500, maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {simulationRequirement || '-'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 动画关键帧 */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
