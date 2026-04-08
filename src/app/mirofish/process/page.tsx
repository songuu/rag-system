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

  // 当前步骤: 0=本体生成, 1=图谱构建, 2=Profile生成, 3=模拟
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [statusText, setStatusText] = useState<string>('初始化中');
  const [statusClass, setStatusClass] = useState<string>('processing');

  // 数据状态
  const [simulationRequirement, setSimulationRequirement] = useState<string>('');
  const [inputText, setInputText] = useState<string>('');
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState<boolean>(false);
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

  // 步骤名称
  const stepNames = ['Ontology', 'Graph Building', 'Profile Generation', 'Simulation'];

  // ==================== 计算属性 ====================

  // 根据步骤更新状态
  useEffect(() => {
    if (error) {
      setStatusClass('error');
      setStatusText('构建失败');
    } else if (currentStep >= 3) {
      setStatusClass('completed');
      setStatusText('构建完成');
    } else if (currentStep === 2) {
      setStatusClass('processing');
      setStatusText('Profile生成中');
    } else if (currentStep === 1) {
      setStatusClass('processing');
      setStatusText('图谱构建中');
    } else if (currentStep === 0) {
      setStatusClass('processing');
      setStatusText('本体生成中');
    } else {
      setStatusClass('processing');
      setStatusText('初始化中');
    }
  }, [currentStep, error]);

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

  // 文件上传处理
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const newFiles: File[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // 读取文件内容
        const text = await file.text();
        newFiles.push(file);

        // 将文件内容添加到输入文本
        setInputText(prev => prev + (prev ? '\n\n' : '') + text);
      }
      setUploadedFiles(prev => [...prev, ...newFiles]);
    } catch (err) {
      setError('文件读取失败');
    } finally {
      setUploading(false);
    }
  };

  // 移除已上传文件
  const removeFile = (index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

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
    setCurrentStep(0);

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
      setCurrentStep(1);
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
      setError('请输入分析文本');
      return;
    }

    setGraphBuilding(true);
    setBuildProgress({ progress: 0, message: '开始构建图谱...' });
    setCurrentStep(1);

    try {
      const response = await fetch('/api/mirofish/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: inputText,
          ontology: ontology,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '图谱构建失败');
      }

      // 启动轮询获取图谱数据
      if (data.taskId) {
        setCurrentTaskId(data.taskId);
      } else if (data.graph) {
        setGraphData(data.graph);
        setCurrentStep(2);
      }

      setBuildProgress({ progress: 100, message: '图谱构建完成' });
    } catch (err) {
      setError(err instanceof Error ? err.message : '图谱构建失败');
    } finally {
      setGraphBuilding(false);
    }
  };

  // 获取步骤状态类名
  const getStepStatusClass = (step: number): string => {
    if (error) return 'error';
    if (step < currentStep) return 'completed';
    if (step === currentStep) return 'active';
    return 'waiting';
  };

  // 获取步骤状态文本
  const getStepStatusText = (step: number): string => {
    if (error) return '失败';
    if (step < currentStep) return '完成';
    if (step === currentStep) {
      if (step === 0 && ontologyLoading) return '生成中';
      if (step === 1 && graphBuilding) return '构建中';
      return '进行中';
    }
    return '待开始';
  };

  // 返回首页
  const goHome = () => {
    router.push('/mirofish');
  };

  // 刷新图谱
  const refreshGraph = useCallback(() => {
    if (graphData) {
      // 触发重新渲染
      setGraphData({ ...graphData });
    }
  }, [graphData]);

  // 切换全屏
  const toggleFullScreen = () => {
    setIsFullScreen(!isFullScreen);
  };

  // D3 图谱渲染
  useEffect(() => {
    if (!graphData?.nodes?.length || !graphSvgRef.current || !graphContainerRef.current) return;

    const svg = d3.select(graphSvgRef.current);
    svg.selectAll('*').remove();

    const container = graphContainerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width === 0 || height === 0) return;

    const nodes = graphData.nodes.map((node, idx) => ({
      ...node,
      // 分配颜色
      color: colors[idx % colors.length],
    }));

    const nodeMap = new Map(nodes.map(n => [n.name, n]));

    const links = graphData.edges
      .filter(edge => nodeMap.has(edge.source_node_name) && nodeMap.has(edge.target_node_name))
      .map(edge => ({
        source: edge.source_node_name,
        target: edge.target_node_name,
        name: edge.name,
        data: edge,
      }));

    const simulation = d3.forceSimulation(nodes as d3.SimulationNodeDatum[])
      .force('link', d3.forceLink(links).id((d: any) => d.name).distance(100))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(30));

    const link = svg.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#999')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.6);

    const node = svg.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(d3.drag<SVGGElement, any>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }));

    node.append('circle')
      .attr('r', 12)
      .attr('fill', (d: any) => d.color || '#004E89')
      .attr('stroke', '#fff')
      .attr('stroke-width', 2);

    node.append('text')
      .text((d: any) => d.name)
      .attr('x', 16)
      .attr('y', 4)
      .attr('font-size', '11px')
      .attr('fill', '#333');

    node.on('click', (event, d) => {
      event.stopPropagation();
      setSelectedItem({ type: 'node', data: d });
    });

    link.on('click', (event, d) => {
      event.stopPropagation();
      setSelectedItem({ type: 'edge', data: d.data });
    });

    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);

      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    return () => {
      simulation.stop();
    };
  }, [graphData]);

  // ==================== 渲染 ====================

  return (
    <div className="process-page" style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: "'Space Grotesk', 'Noto Sans SC', system-ui, sans-serif", background: '#F5F5F5' }}>
      {/* 顶部导航栏 */}
      <nav className="navbar" style={{
        height: '60px',
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        position: 'relative',
        zIndex: 100,
      }}>
        {/* 左侧品牌 + 项目选择 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          {/* 品牌 */}
          <div className="nav-brand" onClick={goHome} style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 800,
            fontSize: '16px',
            letterSpacing: '1px',
            cursor: 'pointer',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-label="MiroFish Logo">
              <circle cx="12" cy="8" r="4" fill="#7C3AED"/>
              <path d="M4 20C4 16 7.5 13 12 13C16.5 13 20 16 20 20" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="8" cy="18" r="2" fill="#7C3AED"/>
              <circle cx="16" cy="18" r="2" fill="#7C3AED"/>
            </svg>
            <span style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #A855F7 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>MIROFISH</span>
          </div>

          {/* 项目选择 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(255,255,255,0.1)',
            padding: '8px 14px',
            borderRadius: '8px',
            cursor: 'pointer',
            border: '1px solid rgba(255,255,255,0.15)',
            transition: 'all 0.2s',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="2" aria-label="项目列表">
              <path d="M3 7h18M3 12h18M3 17h18"/>
            </svg>
            <span style={{ fontSize: '13px', color: '#fff', fontWeight: 500 }}>proj_f95898d38529</span>
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="#9CA3AF" strokeWidth="1.5" aria-label="下拉">
              <path d="M3 4.5L6 7.5L9 4.5"/>
            </svg>
          </div>
        </div>

        {/* 中间步骤指示器 */}
        <div className="nav-center" style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <div style={{
            background: '#7C3AED',
            color: '#fff',
            padding: '5px 12px',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.5px',
          }}>
            STEP {String(currentStep + 1).padStart(2, '0')}
          </div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff', letterSpacing: '0.5px' }}>
            {stepNames[currentStep]}
          </div>
        </div>

        {/* 右侧状态 */}
        <div className="nav-status" style={{
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
        }}>
          {/* 菜单图标 */}
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '8px',
            background: 'rgba(255,255,255,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'background 0.2s',
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
          </div>

          {/* 头像 */}
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(102, 126, 234, 0.4)',
          }}>
            U
          </div>
        </div>
      </nav>

      {/* 主内容区 */}
      <div className="main-content" style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
      }}>
        {/* 左侧: 流程控制区 */}
        <div className="left-panel" style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: '#fff',
          margin: '16px',
          marginRight: '8px',
          borderRadius: '12px',
          overflow: 'hidden',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        }}>
          {/* 流程内容 */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>

            {/* STEP 1: Ontology */}
            <div style={{
              background: currentStep === 0 ? '#F0F9FF' : '#fff',
              border: `1px solid ${currentStep === 0 ? '#7C3AED' : '#E5E7EB'}`,
              borderRadius: '10px',
              marginBottom: '16px',
              overflow: 'hidden',
              transition: 'all 0.2s',
            }}>
              <div style={{
                padding: '14px 18px',
                borderBottom: '1px solid #E5E7EB',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
              }}>
                <span style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  background: getStepStatusClass(0) === 'completed' ? '#10B981' : getStepStatusClass(0) === 'error' ? '#EF4444' : getStepStatusClass(0) === 'active' ? '#7C3AED' : '#9CA3AF',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                }}>
                  {getStepStatusClass(0) === 'completed' ? '✓' : '1'}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: '#111' }}>STEP 1 Ontology</div>
                  <div style={{ fontSize: '11px', color: '#6B7280' }}>上传文档 & 生成 Ontology</div>
                </div>
                <span style={{
                  fontSize: '11px',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  background: getStepStatusClass(0) === 'completed' ? '#D1FAE5' : getStepStatusClass(0) === 'error' ? '#FEE2E2' : getStepStatusClass(0) === 'active' ? '#EDE9FE' : '#F3F4F6',
                  color: getStepStatusClass(0) === 'completed' ? '#059669' : getStepStatusClass(0) === 'error' ? '#DC2626' : getStepStatusClass(0) === 'active' ? '#7C3AED' : '#6B7280',
                  fontWeight: 500,
                }}>
                  {getStepStatusText(0)}
                </span>
              </div>

              <div style={{ padding: '18px' }}>
                {/* 输入表单 */}
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '12px', color: '#6B7280', marginBottom: '6px', fontWeight: 500 }}>模拟需求描述</div>
                  <textarea
                    value={simulationRequirement}
                    onChange={e => setSimulationRequirement(e.target.value)}
                    placeholder="例如：模拟一个关于某品牌产品争议的社交媒体舆论场..."
                    disabled={currentStep > 0}
                    style={{
                      width: '100%',
                      height: '56px',
                      padding: '10px 12px',
                      border: '1px solid #D1D5DB',
                      borderRadius: '6px',
                      fontSize: '13px',
                      resize: 'none',
                      fontFamily: 'inherit',
                      background: currentStep > 0 ? '#F9FAFB' : '#fff',
                    }}
                  />
                </div>

                {/* 文件上传区域 */}
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '12px', color: '#6B7280', marginBottom: '6px', fontWeight: 500 }}>上传文档</div>
                  <div style={{
                    border: '2px dashed #D1D5DB',
                    borderRadius: '8px',
                    padding: '20px',
                    textAlign: 'center',
                    background: currentStep > 0 ? '#F9FAFB' : '#fff',
                    cursor: currentStep > 0 ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s',
                  }}>
                    <input
                      type="file"
                      multiple
                      accept=".txt,.md,.json,.doc,.docx,.pdf"
                      onChange={handleFileUpload}
                      disabled={currentStep > 0}
                      style={{
                        display: 'none',
                      }}
                      id="file-upload"
                    />
                    <label htmlFor="file-upload" style={{
                      cursor: currentStep > 0 ? 'not-allowed' : 'pointer',
                      display: 'block',
                    }}>
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="1.5" style={{ margin: '0 auto 8px' }} aria-label="上传文件">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                      </svg>
                      <div style={{ fontSize: '13px', color: '#6B7280', marginBottom: '4px' }}>
                        {uploading ? '上传中...' : '点击或拖拽文件到此处上传'}
                      </div>
                      <div style={{ fontSize: '11px', color: '#9CA3AF' }}>
                        支持 TXT, MD, JSON, DOC, DOCX, PDF
                      </div>
                    </label>
                  </div>
                  {/* 已上传文件列表 */}
                  {uploadedFiles.length > 0 && (
                    <div style={{ marginTop: '10px' }}>
                      {uploadedFiles.map((file, index) => (
                        <div key={index} style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 12px',
                          background: '#F3F4F6',
                          borderRadius: '6px',
                          marginBottom: '6px',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, overflow: 'hidden' }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="2" aria-label="文件">
                              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                              <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
                            </svg>
                            <span style={{ fontSize: '12px', color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {file.name}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeFile(index)}
                            disabled={currentStep > 0}
                            style={{
                              border: 'none',
                              background: 'none',
                              color: '#9CA3AF',
                              cursor: currentStep > 0 ? 'not-allowed' : 'pointer',
                              padding: '2px',
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '12px', color: '#6B7280', marginBottom: '6px', fontWeight: 500 }}>分析文本</div>
                  <textarea
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    placeholder="输入要分析的文本内容，用于提取实体类型..."
                    disabled={currentStep > 0}
                    style={{
                      width: '100%',
                      height: '72px',
                      padding: '10px 12px',
                      border: '1px solid #D1D5DB',
                      borderRadius: '6px',
                      fontSize: '13px',
                      resize: 'none',
                      fontFamily: 'inherit',
                      background: currentStep > 0 ? '#F9FAFB' : '#fff',
                    }}
                  />
                </div>

                <button
                  type="button"
                  onClick={generateOntology}
                  disabled={ontologyLoading || currentStep > 0}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: ontologyLoading || currentStep > 0 ? '#E5E7EB' : '#7C3AED',
                    color: ontologyLoading || currentStep > 0 ? '#9CA3AF' : '#fff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: ontologyLoading || currentStep > 0 ? 'not-allowed' : 'pointer',
                    transition: 'background 0.2s',
                  }}
                >
                  {ontologyLoading ? '生成本体中...' : '开始生成'}
                </button>

                {/* 本体生成进度 */}
                {ontologyProgress && currentStep === 0 && (
                  <div style={{
                    marginTop: '12px',
                    padding: '10px',
                    background: '#F3F4F6',
                    borderRadius: '6px',
                    fontSize: '12px',
                    color: '#6B7280',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                  }}>
                    <div style={{
                      width: '16px',
                      height: '16px',
                      border: '2px solid #7C3AED',
                      borderTopColor: 'transparent',
                      borderRadius: '50%',
                      animation: 'spin 1s linear infinite',
                    }} />
                    {ontologyProgress.message}
                  </div>
                )}

                {/* 已生成的本体信息 */}
                {ontology && currentStep > 0 && (
                  <>
                    <div style={{ marginTop: '14px' }}>
                      <div style={{ fontSize: '12px', color: '#6B7280', marginBottom: '8px' }}>
                        生成的实体类型 ({ontology.entity_types?.length || 0})
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {ontology.entity_types?.slice(0, 8).map((entity, i) => (
                          <span key={i} style={{
                            padding: '3px 10px',
                            background: '#EDE9FE',
                            color: '#7C3AED',
                            borderRadius: '4px',
                            fontSize: '12px',
                            fontWeight: 500,
                          }}>
                            {entity.name}
                          </span>
                        ))}
                        {(ontology.entity_types?.length || 0) > 8 && (
                          <span style={{ fontSize: '12px', color: '#9CA3AF' }}>
                            +{ontology.entity_types.length - 8} 更多
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* STEP 2: Graph Building */}
            <div style={{
              background: currentStep === 1 ? '#F0F9FF' : '#fff',
              border: `1px solid ${currentStep === 1 ? '#7C3AED' : '#E5E7EB'}`,
              borderRadius: '10px',
              marginBottom: '16px',
              overflow: 'hidden',
              transition: 'all 0.2s',
            }}>
              <div style={{
                padding: '14px 18px',
                borderBottom: '1px solid #E5E7EB',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
              }}>
                <span style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  background: getStepStatusClass(1) === 'completed' ? '#10B981' : getStepStatusClass(1) === 'error' ? '#EF4444' : getStepStatusClass(1) === 'active' ? '#7C3AED' : '#9CA3AF',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                }}>
                  {getStepStatusClass(1) === 'completed' ? '✓' : '2'}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: '#111' }}>STEP 2 Graph Building</div>
                  <div style={{ fontSize: '11px', color: '#6B7280' }}>构建知识图谱</div>
                </div>
                <span style={{
                  fontSize: '11px',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  background: getStepStatusClass(1) === 'completed' ? '#D1FAE5' : getStepStatusClass(1) === 'error' ? '#FEE2E2' : getStepStatusClass(1) === 'active' ? '#EDE9FE' : '#F3F4F6',
                  color: getStepStatusClass(1) === 'completed' ? '#059669' : getStepStatusClass(1) === 'error' ? '#DC2626' : getStepStatusClass(1) === 'active' ? '#7C3AED' : '#6B7280',
                  fontWeight: 500,
                }}>
                  {getStepStatusText(1)}
                </span>
              </div>

              <div style={{ padding: '18px' }}>
                {currentStep < 1 ? (
                  <div style={{
                    padding: '20px',
                    background: '#F9FAFB',
                    borderRadius: '6px',
                    textAlign: 'center',
                    color: '#9CA3AF',
                    fontSize: '13px',
                  }}>
                    等待本体生成完成...
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={buildGraph}
                      disabled={graphBuilding || currentStep > 1}
                      style={{
                        width: '100%',
                        padding: '10px',
                        background: graphBuilding || currentStep > 1 ? '#E5E7EB' : '#7C3AED',
                        color: graphBuilding || currentStep > 1 ? '#9CA3AF' : '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '13px',
                        fontWeight: 600,
                        cursor: graphBuilding || currentStep > 1 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {graphBuilding ? '构建中...' : '开始构建'}
                    </button>

                    {/* 构建进度 */}
                    {buildProgress && currentStep >= 1 && (
                      <div style={{ marginTop: '14px' }}>
                        <div style={{
                          height: '6px',
                          background: '#E5E7EB',
                          borderRadius: '3px',
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            height: '100%',
                            width: `${buildProgress.progress}%`,
                            background: buildProgress.progress === 100 ? '#10B981' : '#7C3AED',
                            borderRadius: '3px',
                            transition: 'width 0.3s',
                          }} />
                        </div>
                        <div style={{
                          marginTop: '8px',
                          fontSize: '12px',
                          color: '#6B7280',
                          display: 'flex',
                          justifyContent: 'space-between',
                        }}>
                          <span>{buildProgress.message}</span>
                          <span>{buildProgress.progress}%</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* STEP 3: Profile Generation */}
            <div style={{
              background: currentStep === 2 ? '#F0F9FF' : '#fff',
              border: `1px solid ${currentStep === 2 ? '#7C3AED' : '#E5E7EB'}`,
              borderRadius: '10px',
              marginBottom: '16px',
              overflow: 'hidden',
              transition: 'all 0.2s',
            }}>
              <div style={{
                padding: '14px 18px',
                borderBottom: '1px solid #E5E7EB',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
              }}>
                <span style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  background: getStepStatusClass(2) === 'completed' ? '#10B981' : getStepStatusClass(2) === 'error' ? '#EF4444' : getStepStatusClass(2) === 'active' ? '#7C3AED' : '#9CA3AF',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                }}>
                  {getStepStatusClass(2) === 'completed' ? '✓' : '3'}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: '#111' }}>STEP 3 Profile Generation</div>
                  <div style={{ fontSize: '11px', color: '#6B7280' }}>生成 Profile</div>
                </div>
                <span style={{
                  fontSize: '11px',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  background: getStepStatusClass(2) === 'completed' ? '#D1FAE5' : getStepStatusClass(2) === 'error' ? '#FEE2E2' : getStepStatusClass(2) === 'active' ? '#EDE9FE' : '#F3F4F6',
                  color: getStepStatusClass(2) === 'completed' ? '#059669' : getStepStatusClass(2) === 'error' ? '#DC2626' : getStepStatusClass(2) === 'active' ? '#7C3AED' : '#6B7280',
                  fontWeight: 500,
                }}>
                  {getStepStatusText(2)}
                </span>
              </div>

              <div style={{ padding: '18px' }}>
                {currentStep < 2 ? (
                  <div style={{
                    padding: '20px',
                    background: '#F9FAFB',
                    borderRadius: '6px',
                    textAlign: 'center',
                    color: '#9CA3AF',
                    fontSize: '13px',
                  }}>
                    等待图谱构建完成...
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled
                    style={{
                      width: '100%',
                      padding: '10px',
                      background: '#E5E7EB',
                      color: '#9CA3AF',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      cursor: 'not-allowed',
                    }}
                  >
                    开始生成
                  </button>
                )}
              </div>
            </div>

            {/* STEP 4: Simulation */}
            <div style={{
              background: currentStep === 3 ? '#F0F9FF' : '#fff',
              border: `1px solid ${currentStep === 3 ? '#7C3AED' : '#E5E7EB'}`,
              borderRadius: '10px',
              marginBottom: '16px',
              overflow: 'hidden',
              transition: 'all 0.2s',
            }}>
              <div style={{
                padding: '14px 18px',
                borderBottom: '1px solid #E5E7EB',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
              }}>
                <span style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  background: getStepStatusClass(3) === 'completed' ? '#10B981' : getStepStatusClass(3) === 'error' ? '#EF4444' : getStepStatusClass(3) === 'active' ? '#7C3AED' : '#9CA3AF',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                }}>
                  {getStepStatusClass(3) === 'completed' ? '✓' : '4'}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: '#111' }}>STEP 4 Simulation</div>
                  <div style={{ fontSize: '11px', color: '#6B7280' }}>启动模拟</div>
                </div>
                <span style={{
                  fontSize: '11px',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  background: getStepStatusClass(3) === 'completed' ? '#D1FAE5' : getStepStatusClass(3) === 'error' ? '#FEE2E2' : getStepStatusClass(3) === 'active' ? '#EDE9FE' : '#F3F4F6',
                  color: getStepStatusClass(3) === 'completed' ? '#059669' : getStepStatusClass(3) === 'error' ? '#DC2626' : getStepStatusClass(3) === 'active' ? '#7C3AED' : '#6B7280',
                  fontWeight: 500,
                }}>
                  {getStepStatusText(3)}
                </span>
              </div>

              <div style={{ padding: '18px' }}>
                {currentStep < 3 ? (
                  <div style={{
                    padding: '20px',
                    background: '#F9FAFB',
                    borderRadius: '6px',
                    textAlign: 'center',
                    color: '#9CA3AF',
                    fontSize: '13px',
                  }}>
                    等待 Profile 生成完成...
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled
                    style={{
                      width: '100%',
                      padding: '10px',
                      background: '#E5E7EB',
                      color: '#9CA3AF',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      cursor: 'not-allowed',
                    }}
                  >
                    开始模拟
                  </button>
                )}
              </div>
            </div>

          </div>
        </div>

        {/* 右侧: 图谱数据展示 */}
        <div className="right-panel" style={{
          width: '320px',
          display: 'flex',
          flexDirection: 'column',
          background: '#fff',
          margin: '16px',
          marginLeft: '8px',
          borderRadius: '12px',
          overflow: 'hidden',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        }}>
          {/* 面板头部 */}
          <div style={{
            height: '48px',
            borderBottom: '1px solid #E5E7EB',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '0 16px',
            background: '#F9FAFB',
          }}>
            <span style={{ fontSize: '14px', color: '#7C3AED' }}>◆</span>
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#111' }}>图谱数据</span>
          </div>

          {/* 统计数据 */}
          <div style={{
            display: 'flex',
            borderBottom: '1px solid #E5E7EB',
          }}>
            <div style={{
              flex: 1,
              padding: '16px',
              textAlign: 'center',
              borderRight: '1px solid #E5E7EB',
            }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#7C3AED' }}>
                {graphData?.node_count || 0}
              </div>
              <div style={{ fontSize: '12px', color: '#6B7280', marginTop: '4px' }}>Nodes</div>
            </div>
            <div style={{
              flex: 1,
              padding: '16px',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#7C3AED' }}>
                {graphData?.edge_count || 0}
              </div>
              <div style={{ fontSize: '12px', color: '#6B7280', marginTop: '4px' }}>Edges</div>
            </div>
          </div>

          {/* 图谱容器 */}
          <div className="graph-container" ref={graphContainerRef} style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            minHeight: '300px',
          }}>
            {graphData ? (
              <>
                <svg ref={graphSvgRef} style={{ width: '100%', height: '100%' }} />
                {/* 构建中提示 */}
                {currentStep === 1 && graphBuilding && (
                  <div style={{
                    position: 'absolute',
                    top: '12px',
                    left: '12px',
                    background: 'rgba(124, 58, 237, 0.9)',
                    color: '#fff',
                    padding: '6px 12px',
                    borderRadius: '16px',
                    fontSize: '11px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}>
                    <span style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: '#fff',
                      animation: 'pulse 1s infinite',
                    }} />
                    实时更新中...
                  </div>
                )}

                {/* 节点/边详情面板 */}
                {selectedItem && (
                  <div style={{
                    position: 'absolute',
                    top: '12px',
                    right: '12px',
                    width: '240px',
                    background: '#fff',
                    border: '1px solid #E5E7EB',
                    borderRadius: '8px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                    maxHeight: 'calc(100% - 24px)',
                    overflow: 'auto',
                  }}>
                    <div style={{
                      padding: '10px 14px',
                      borderBottom: '1px solid #E5E7EB',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#6B7280' }}>
                        {selectedItem.type === 'node' ? 'Node Details' : 'Relationship'}
                      </span>
                      <button type="button" onClick={() => setSelectedItem(null)} style={{
                        border: 'none',
                        background: 'none',
                        fontSize: '18px',
                        cursor: 'pointer',
                        color: '#9CA3AF',
                      }}>×</button>
                    </div>
                    <div style={{ padding: '14px' }}>
                      {selectedItem.type === 'node' ? (
                        <>
                          <div style={{ marginBottom: '10px' }}>
                            <div style={{ fontSize: '10px', color: '#9CA3AF', marginBottom: '3px' }}>Name</div>
                            <div style={{ fontSize: '13px', fontWeight: 600, color: '#111' }}>
                              {(selectedItem.data as GraphNode).name}
                            </div>
                          </div>
                          {(selectedItem.data as GraphNode).labels?.length > 0 && (
                            <div style={{ marginBottom: '10px' }}>
                              <div style={{ fontSize: '10px', color: '#9CA3AF', marginBottom: '3px' }}>Labels</div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                {(selectedItem.data as GraphNode).labels?.map((label, i) => (
                                  <span key={i} style={{
                                    padding: '2px 6px',
                                    background: '#F3F4F6',
                                    borderRadius: '4px',
                                    fontSize: '10px',
                                  }}>
                                    {label}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {(selectedItem.data as GraphNode).summary && (
                            <div>
                              <div style={{ fontSize: '10px', color: '#9CA3AF', marginBottom: '3px' }}>Summary</div>
                              <p style={{ fontSize: '11px', color: '#6B7280', lineHeight: 1.5 }}>
                                {(selectedItem.data as GraphNode).summary}
                              </p>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div style={{ marginBottom: '10px' }}>
                            <div style={{ fontSize: '10px', color: '#9CA3AF', marginBottom: '3px' }}>Relationship</div>
                            <div style={{ fontSize: '12px', color: '#111' }}>
                              <span style={{ color: '#7C3AED' }}>{(selectedItem.data as GraphEdge).source_node_name}</span>
                              <span style={{ margin: '0 6px' }}>→</span>
                              <span style={{ color: '#7C3AED' }}>{(selectedItem.data as GraphEdge).name}</span>
                              <span style={{ margin: '0 6px' }}>→</span>
                              <span style={{ color: '#7C3AED' }}>{(selectedItem.data as GraphEdge).target_node_name}</span>
                            </div>
                          </div>
                          {(selectedItem.data as GraphEdge).fact && (
                            <div>
                              <div style={{ fontSize: '10px', color: '#9CA3AF', marginBottom: '3px' }}>Fact</div>
                              <p style={{ fontSize: '11px', color: '#6B7280', lineHeight: 1.5 }}>
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
                color: '#9CA3AF',
              }}>
                <div style={{
                  width: '36px',
                  height: '36px',
                  border: '3px solid #F3F4F6',
                  borderTop: '3px solid #7C3AED',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  marginBottom: '12px',
                }} />
                <p style={{ fontSize: '13px' }}>图谱数据加载中...</p>
              </div>
            ) : (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#9CA3AF',
              }}>
                <svg viewBox="0 0 100 100" style={{ width: '60px', height: '60px', marginBottom: '12px' }}>
                  <circle cx="50" cy="20" r="8" fill="none" stroke="#9CA3AF" strokeWidth="1.5" />
                  <circle cx="20" cy="60" r="8" fill="none" stroke="#9CA3AF" strokeWidth="1.5" />
                  <circle cx="80" cy="60" r="8" fill="none" stroke="#9CA3AF" strokeWidth="1.5" />
                  <circle cx="50" cy="80" r="8" fill="none" stroke="#9CA3AF" strokeWidth="1.5" />
                  <line x1="50" y1="28" x2="25" y2="54" stroke="#9CA3AF" strokeWidth="1" />
                  <line x1="50" y1="28" x2="75" y2="54" stroke="#9CA3AF" strokeWidth="1" />
                  <line x1="28" y1="60" x2="72" y2="60" stroke="#9CA3AF" strokeWidth="1" strokeDasharray="4" />
                  <line x1="50" y1="72" x2="26" y2="66" stroke="#9CA3AF" strokeWidth="1" />
                  <line x1="50" y1="72" x2="74" y2="66" stroke="#9CA3AF" strokeWidth="1" />
                </svg>
                <p style={{ fontSize: '13px' }}>暂无图谱数据</p>
              </div>
            )}

            {error && (
              <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                background: '#FEF2F2',
                border: '1px solid #FECACA',
                borderRadius: '8px',
                padding: '20px',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: '20px', marginBottom: '8px' }}>⚠</div>
                <p style={{ color: '#DC2626', margin: 0, fontSize: '13px' }}>{error}</p>
              </div>
            )}
          </div>

          {/* 图谱图例 */}
          {graphData && entityTypes.length > 0 && (
            <div style={{
              height: '36px',
              borderTop: '1px solid #E5E7EB',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              padding: '0 12px',
              background: '#F9FAFB',
            }}>
              {entityTypes.slice(0, 5).map((type, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: type.color,
                  }} />
                  <span style={{ fontSize: '11px', color: '#6B7280' }}>{type.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 动画样式 */}
      <style jsx global>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
