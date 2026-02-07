'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';

// ==================== 类型定义 ====================

type EntityType = 'PERSON' | 'ORGANIZATION' | 'LOCATION' | 'EVENT' | 'CONCEPT' | 'PRODUCT' | 'DATE' | 'OTHER';

interface Entity {
  id: string;
  name: string;
  type: EntityType;
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
  metadata: {
    documentId: string;
    createdAt: string;
    entityCount: number;
    relationCount: number;
    communityCount: number;
  };
}

interface GraphNode {
  id: string;
  name: string;
  type: EntityType;
  description: string;
  mentions: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  communityId?: string;
  fixed?: boolean;
}

interface GraphLink {
  id: string;
  source: string;
  target: string;
  type: string;
  description: string;
  weight: number;
}

// ==================== 常量 ====================

const ENTITY_COLORS: Record<EntityType, string> = {
  PERSON: '#F472B6',      // 粉色
  ORGANIZATION: '#A78BFA', // 紫色
  LOCATION: '#34D399',     // 绿色
  EVENT: '#FBBF24',        // 黄色
  CONCEPT: '#60A5FA',      // 蓝色
  PRODUCT: '#F87171',      // 红色
  DATE: '#2DD4BF',         // 青色
  OTHER: '#9CA3AF',        // 灰色
};

const ENTITY_LABELS: Record<EntityType, string> = {
  PERSON: '人物',
  ORGANIZATION: '组织',
  LOCATION: '地点',
  EVENT: '事件',
  CONCEPT: '概念',
  PRODUCT: '产品',
  DATE: '日期',
  OTHER: '其他',
};

// ==================== 组件 ====================

interface KnowledgeGraphViewerProps {
  graph: KnowledgeGraph | null;
  className?: string;
  onNodeClick?: (entity: Entity) => void;
  onLinkClick?: (relation: Relation) => void;
}

export default function KnowledgeGraphViewer({
  graph,
  className = '',
  onNodeClick,
  onLinkClick,
}: KnowledgeGraphViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedLink, setSelectedLink] = useState<GraphLink | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'community' | 'list'>('graph');
  const [filterType, setFilterType] = useState<EntityType | 'ALL'>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 900, height: 650 });

  // 动画相关
  const animationRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const isPanningRef = useRef(false);
  const dragNodeRef = useRef<GraphNode | null>(null);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const simulationRunning = useRef(true);

  // 监听容器尺寸
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      setCanvasSize({
        width: Math.max(800, rect.width),
        height: 650,
      });
    };

    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // 初始化图数据
  useEffect(() => {
    if (!graph) {
      setNodes([]);
      setLinks([]);
      return;
    }

    const entityMap = new Map(graph.entities.map(e => [e.id, e]));
    
    // 为每个实体找到它所属的社区
    const entityCommunityMap = new Map<string, string>();
    for (const community of graph.communities) {
      for (const entityId of community.entities) {
        entityCommunityMap.set(entityId, community.id);
      }
    }

    // 计算社区中心位置
    const communityCount = graph.communities.length || 1;
    const communityPositions = new Map<string, { x: number; y: number }>();
    graph.communities.forEach((community, index) => {
      const angle = (2 * Math.PI * index) / communityCount;
      const radius = Math.min(canvasSize.width, canvasSize.height) * 0.25;
      communityPositions.set(community.id, {
        x: canvasSize.width / 2 + Math.cos(angle) * radius,
        y: canvasSize.height / 2 + Math.sin(angle) * radius,
      });
    });

    // 创建节点，按社区分布
    const newNodes: GraphNode[] = graph.entities.map((entity, index) => {
      const communityId = entityCommunityMap.get(entity.id);
      const communityPos = communityId 
        ? communityPositions.get(communityId) 
        : { x: canvasSize.width / 2, y: canvasSize.height / 2 };
      
      const angle = Math.random() * 2 * Math.PI;
      const radius = 50 + Math.random() * 80;
      
      return {
        id: entity.id,
        name: entity.name,
        type: entity.type as EntityType,
        description: entity.description,
        mentions: entity.mentions,
        x: (communityPos?.x || canvasSize.width / 2) + Math.cos(angle) * radius,
        y: (communityPos?.y || canvasSize.height / 2) + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        communityId,
      };
    });

    // 创建边
    const newLinks: GraphLink[] = graph.relations
      .filter(r => entityMap.has(r.source) && entityMap.has(r.target))
      .map(relation => ({
        id: relation.id,
        source: relation.source,
        target: relation.target,
        type: relation.type,
        description: relation.description,
        weight: relation.weight,
      }));

    setNodes(newNodes);
    setLinks(newLinks);
    simulationRunning.current = true;
  }, [graph, canvasSize.width, canvasSize.height]);

  // 力导向模拟
  useEffect(() => {
    if (nodes.length === 0 || viewMode !== 'graph') {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      return;
    }

    let iterationCount = 0;
    const maxIterations = 300;
    
    const simulate = () => {
      if (!simulationRunning.current || iterationCount > maxIterations) {
        return;
      }
      
      iterationCount++;
      const alpha = Math.max(0.01, 1 - iterationCount / maxIterations);

      const updatedNodes = nodes.map(node => ({ ...node }));
      const updatedNodeMap = new Map(updatedNodes.map(n => [n.id, n]));

      // 斥力（节点间）- 增强距离
      for (let i = 0; i < updatedNodes.length; i++) {
        for (let j = i + 1; j < updatedNodes.length; j++) {
          const node1 = updatedNodes[i];
          const node2 = updatedNodes[j];
          
          const dx = node2.x - node1.x;
          const dy = node2.y - node1.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          // 增强斥力，确保节点间有足够距离
          const minDist = 120;
          const force = (minDist * minDist) / (dist * dist) * alpha * 2;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          
          if (!node1.fixed) {
            node1.vx -= fx;
            node1.vy -= fy;
          }
          if (!node2.fixed) {
            node2.vx += fx;
            node2.vy += fy;
          }
        }
      }

      // 引力（边连接的节点）
      for (const link of links) {
        const source = updatedNodeMap.get(link.source);
        const target = updatedNodeMap.get(link.target);
        
        if (source && target) {
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          const idealDist = 150;
          const force = (dist - idealDist) * 0.03 * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          
          if (!source.fixed) {
            source.vx += fx;
            source.vy += fy;
          }
          if (!target.fixed) {
            target.vx -= fx;
            target.vy -= fy;
          }
        }
      }

      // 中心引力
      const centerX = canvasSize.width / 2;
      const centerY = canvasSize.height / 2;
      for (const node of updatedNodes) {
        if (node.fixed) continue;
        const dx = centerX - node.x;
        const dy = centerY - node.y;
        node.vx += dx * 0.001 * alpha;
        node.vy += dy * 0.001 * alpha;
      }

      // 应用速度和阻尼
      for (const node of updatedNodes) {
        if (node.fixed || (dragNodeRef.current?.id === node.id)) continue;
        
        node.vx *= 0.85;
        node.vy *= 0.85;
        node.x += node.vx;
        node.y += node.vy;

        // 边界约束
        const padding = 60;
        node.x = Math.max(padding, Math.min(canvasSize.width - padding, node.x));
        node.y = Math.max(padding, Math.min(canvasSize.height - padding, node.y));
      }

      setNodes(updatedNodes);
      animationRef.current = requestAnimationFrame(simulate);
    };

    animationRef.current = requestAnimationFrame(simulate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [nodes.length, links, viewMode, canvasSize]);

  // 绘制画布
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置高清渲染
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    canvas.style.width = `${canvasSize.width}px`;
    canvas.style.height = `${canvasSize.height}px`;
    ctx.scale(dpr, dpr);

    // 清空画布 - 深色背景
    ctx.fillStyle = '#0c1222';
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

    // 绘制网格背景
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < canvasSize.width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasSize.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvasSize.height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvasSize.width, y);
      ctx.stroke();
    }

    // 应用缩放和平移
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const filteredNodes = filterType === 'ALL' 
      ? nodes 
      : nodes.filter(n => n.type === filterType);
    const filteredNodeIds = new Set(filteredNodes.map(n => n.id));

    // 搜索过滤
    const searchLower = searchTerm.toLowerCase();
    const matchingNodes = searchTerm 
      ? filteredNodes.filter(n => 
          n.name.toLowerCase().includes(searchLower) || 
          n.description.toLowerCase().includes(searchLower)
        )
      : filteredNodes;
    const matchingNodeIds = new Set(matchingNodes.map(n => n.id));

    // 绘制边
    for (const link of links) {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      
      if (!source || !target) continue;
      if (!filteredNodeIds.has(source.id) || !filteredNodeIds.has(target.id)) continue;
      
      const isHighlighted = 
        (selectedNode && (link.source === selectedNode.id || link.target === selectedNode.id)) ||
        (hoveredNode && (link.source === hoveredNode.id || link.target === hoveredNode.id));
      const isSelected = selectedLink?.id === link.id;
      const isDimmed = searchTerm && !(matchingNodeIds.has(source.id) && matchingNodeIds.has(target.id));

      // 计算线的角度
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const angle = Math.atan2(dy, dx);
      const dist = Math.sqrt(dx * dx + dy * dy);

      // 节点半径
      const sourceRadius = getNodeRadius(source);
      const targetRadius = getNodeRadius(target);

      // 起点和终点（从节点边缘开始）
      const startX = source.x + Math.cos(angle) * sourceRadius;
      const startY = source.y + Math.sin(angle) * sourceRadius;
      const endX = target.x - Math.cos(angle) * (targetRadius + 12);
      const endY = target.y - Math.sin(angle) * (targetRadius + 12);

      // 绘制边线
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      
      if (isSelected) {
        ctx.strokeStyle = '#FBBF24';
        ctx.lineWidth = 3;
      } else if (isHighlighted) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 2.5;
      } else if (isDimmed) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = 1.5;
      }
      ctx.stroke();

      // 绘制箭头
      const arrowSize = isHighlighted || isSelected ? 12 : 10;
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(
        endX - arrowSize * Math.cos(angle - Math.PI / 7),
        endY - arrowSize * Math.sin(angle - Math.PI / 7)
      );
      ctx.lineTo(
        endX - arrowSize * Math.cos(angle + Math.PI / 7),
        endY - arrowSize * Math.sin(angle + Math.PI / 7)
      );
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();

      // 绘制关系标签（高亮或选中时显示）
      if ((isHighlighted || isSelected) && link.type) {
        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;
        
        ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
        const textWidth = ctx.measureText(link.type).width;
        
        // 背景
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        const padding = 6;
        const bgHeight = 20;
        ctx.beginPath();
        ctx.roundRect(midX - textWidth / 2 - padding, midY - bgHeight / 2, textWidth + padding * 2, bgHeight, 4);
        ctx.fill();
        
        // 边框
        ctx.strokeStyle = '#FBBF24';
        ctx.lineWidth = 1;
        ctx.stroke();
        
        // 文字
        ctx.fillStyle = '#FBBF24';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(link.type, midX, midY);
      }
    }

    // 绘制节点
    for (const node of filteredNodes) {
      const isSelected = selectedNode?.id === node.id;
      const isHovered = hoveredNode?.id === node.id;
      const isSearchMatch = searchTerm && matchingNodeIds.has(node.id);
      const isDimmed = searchTerm && !matchingNodeIds.has(node.id);
      
      const radius = getNodeRadius(node);
      const color = ENTITY_COLORS[node.type] || ENTITY_COLORS.OTHER;

      // 选中/悬停光晕
      if (isSelected || isHovered || isSearchMatch) {
        const gradient = ctx.createRadialGradient(node.x, node.y, radius, node.x, node.y, radius + 20);
        gradient.addColorStop(0, isSelected ? 'rgba(251, 191, 36, 0.4)' : `${color}40`);
        gradient.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 20, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // 节点外圈
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 3, 0, Math.PI * 2);
      ctx.fillStyle = isDimmed ? 'rgba(255, 255, 255, 0.05)' : `${color}30`;
      ctx.fill();

      // 节点主体
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      
      // 渐变填充
      const nodeGradient = ctx.createRadialGradient(
        node.x - radius * 0.3, node.y - radius * 0.3, 0,
        node.x, node.y, radius
      );
      nodeGradient.addColorStop(0, isDimmed ? '#2a2a2a' : lightenColor(color, 20));
      nodeGradient.addColorStop(1, isDimmed ? '#1a1a1a' : color);
      ctx.fillStyle = nodeGradient;
      ctx.fill();
      
      // 边框
      ctx.strokeStyle = isSelected ? '#FBBF24' : isDimmed ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.stroke();

      // 节点标签背景
      ctx.font = `${isSelected || isHovered ? 'bold ' : ''}12px system-ui, -apple-system, sans-serif`;
      const displayName = truncateText(ctx, node.name, 100);
      const textWidth = ctx.measureText(displayName).width;
      
      const labelY = node.y + radius + 18;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.beginPath();
      ctx.roundRect(node.x - textWidth / 2 - 6, labelY - 10, textWidth + 12, 20, 4);
      ctx.fill();

      // 节点标签文字
      ctx.fillStyle = isDimmed ? 'rgba(255, 255, 255, 0.3)' : '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(displayName, node.x, labelY);
    }

    ctx.restore();
  }, [nodes, links, selectedNode, selectedLink, hoveredNode, filterType, searchTerm, zoom, pan, canvasSize]);

  // 辅助函数
  function getNodeRadius(node: GraphNode): number {
    return Math.min(35, Math.max(22, 18 + (node.mentions || 1) * 2));
  }

  function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let truncated = text;
    while (ctx.measureText(truncated + '...').width > maxWidth && truncated.length > 0) {
      truncated = truncated.slice(0, -1);
    }
    return truncated + '...';
  }

  function lightenColor(color: string, percent: number): string {
    const num = parseInt(color.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.min(255, (num >> 16) + amt);
    const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
    const B = Math.min(255, (num & 0x0000FF) + amt);
    return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
  }

  // 鼠标事件处理
  const getMousePos = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - pan.x) / zoom,
      y: (e.clientY - rect.top - pan.y) / zoom,
    };
  }, [pan, zoom]);

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getMousePos(e);

    // 检查节点点击
    for (const node of nodes) {
      const radius = getNodeRadius(node);
      const dist = Math.sqrt((x - node.x) ** 2 + (y - node.y) ** 2);
      
      if (dist <= radius) {
        setSelectedNode(node);
        setSelectedLink(null);
        if (onNodeClick && graph) {
          const entity = graph.entities.find(e => e.id === node.id);
          if (entity) onNodeClick(entity);
        }
        return;
      }
    }

    // 检查边点击
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    for (const link of links) {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      if (!source || !target) continue;

      const lineLen = Math.sqrt((target.x - source.x) ** 2 + (target.y - source.y) ** 2);
      const t = Math.max(0, Math.min(1, 
        ((x - source.x) * (target.x - source.x) + (y - source.y) * (target.y - source.y)) / (lineLen * lineLen)
      ));
      const nearestX = source.x + t * (target.x - source.x);
      const nearestY = source.y + t * (target.y - source.y);
      const dist = Math.sqrt((x - nearestX) ** 2 + (y - nearestY) ** 2);

      if (dist <= 15) {
        setSelectedLink(link);
        setSelectedNode(null);
        if (onLinkClick && graph) {
          const relation = graph.relations.find(r => r.id === link.id);
          if (relation) onLinkClick(relation);
        }
        return;
      }
    }

    setSelectedNode(null);
    setSelectedLink(null);
  }, [nodes, links, graph, onNodeClick, onLinkClick, getMousePos]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { x, y } = getMousePos(e);

    // 拖拽节点
    if (isDraggingRef.current && dragNodeRef.current) {
      setNodes(prev => prev.map(n => 
        n.id === dragNodeRef.current?.id 
          ? { ...n, x, y, vx: 0, vy: 0 }
          : n
      ));
      return;
    }

    // 平移画布
    if (isPanningRef.current) {
      const dx = e.clientX - lastMousePosRef.current.x;
      const dy = e.clientY - lastMousePosRef.current.y;
      setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    }
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };

    // 悬停检测
    for (const node of nodes) {
      const radius = getNodeRadius(node);
      const dist = Math.sqrt((x - node.x) ** 2 + (y - node.y) ** 2);
      
      if (dist <= radius) {
        setHoveredNode(node);
        canvas.style.cursor = 'pointer';
        return;
      }
    }

    setHoveredNode(null);
    canvas.style.cursor = isPanningRef.current ? 'grabbing' : 'default';
  }, [nodes, getMousePos]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getMousePos(e);
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };

    // 右键或 Alt + 左键 = 平移
    if (e.button === 2 || (e.button === 0 && e.altKey)) {
      isPanningRef.current = true;
      return;
    }

    // 检查节点拖拽
    for (const node of nodes) {
      const radius = getNodeRadius(node);
      const dist = Math.sqrt((x - node.x) ** 2 + (y - node.y) ** 2);
      
      if (dist <= radius) {
        isDraggingRef.current = true;
        dragNodeRef.current = node;
        simulationRunning.current = false;
        return;
      }
    }
  }, [nodes, getMousePos]);

  const handleCanvasMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    isPanningRef.current = false;
    dragNodeRef.current = null;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(prev => Math.max(0.3, Math.min(3, prev * delta)));
  }, []);

  // 获取选中节点的详细信息
  const getSelectedNodeInfo = () => {
    if (!selectedNode || !graph) return null;
    const entity = graph.entities.find(e => e.id === selectedNode.id);
    if (!entity) return null;

    const relatedRelations = graph.relations.filter(
      r => r.source === entity.id || r.target === entity.id
    );
    const community = graph.communities.find(c => c.entities.includes(entity.id));

    return { entity, relatedRelations, community };
  };

  const selectedNodeInfo = getSelectedNodeInfo();

  // 统计
  const entityTypeStats = graph?.entities.reduce((acc, entity) => {
    acc[entity.type] = (acc[entity.type] || 0) + 1;
    return acc;
  }, {} as Record<EntityType, number>) || {};

  if (!graph) {
    return (
      <div className={`bg-slate-900 rounded-xl border border-slate-700 p-12 ${className}`}>
        <div className="text-center text-slate-400">
          <div className="text-7xl mb-6">🕸️</div>
          <h3 className="text-2xl font-bold text-white mb-3">暂无知识图谱</h3>
          <p className="text-slate-400">请先上传文档并执行实体抽取</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-slate-900 rounded-xl border border-slate-700 overflow-hidden ${className}`}>
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-slate-700 bg-slate-800/50">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="text-xl">🕸️</span> 知识图谱
          </h3>
          <div className="flex bg-slate-700/50 rounded-lg p-0.5">
            {(['graph', 'community', 'list'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-4 py-1.5 text-sm rounded-md transition-all ${
                  viewMode === mode 
                    ? 'bg-purple-600 text-white shadow-lg' 
                    : 'text-slate-400 hover:text-white hover:bg-slate-600/50'
                }`}
              >
                {mode === 'graph' ? '图谱' : mode === 'community' ? '社区' : '列表'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* 搜索 */}
          <div className="relative">
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="搜索实体..."
              className="w-44 px-3 py-1.5 pl-9 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">🔍</span>
          </div>

          {/* 类型过滤 */}
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value as EntityType | 'ALL')}
            className="px-3 py-1.5 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            <option value="ALL">全部类型</option>
            {Object.entries(entityTypeStats).map(([type, count]) => (
              <option key={type} value={type}>
                {ENTITY_LABELS[type as EntityType] || type} ({count as number})
              </option>
            ))}
          </select>

          {/* 缩放 */}
          <div className="flex items-center bg-slate-700/50 rounded-lg border border-slate-600">
            <button
              onClick={() => setZoom(z => Math.max(0.3, z - 0.2))}
              className="px-3 py-1.5 text-white hover:bg-slate-600 rounded-l-lg transition-colors"
            >
              −
            </button>
            <span className="px-3 text-sm text-slate-300 min-w-[50px] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom(z => Math.min(3, z + 0.2))}
              className="px-3 py-1.5 text-white hover:bg-slate-600 rounded-r-lg transition-colors"
            >
              +
            </button>
          </div>

          {/* 重置 */}
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            className="px-3 py-1.5 bg-slate-700/50 text-slate-300 rounded-lg text-sm hover:bg-slate-600 border border-slate-600 transition-colors"
          >
            重置
          </button>
        </div>
      </div>

      {/* 统计栏 */}
      <div className="flex items-center gap-6 px-4 py-2.5 bg-gradient-to-r from-slate-800/50 to-transparent border-b border-slate-700/50">
        <span className="text-slate-400 text-sm">
          <span className="text-lg font-bold text-blue-400">{graph.metadata.entityCount}</span> 实体
        </span>
        <span className="text-slate-400 text-sm">
          <span className="text-lg font-bold text-purple-400">{graph.metadata.relationCount}</span> 关系
        </span>
        <span className="text-slate-400 text-sm">
          <span className="text-lg font-bold text-pink-400">{graph.metadata.communityCount}</span> 社区
        </span>
      </div>

      <div className="flex">
        {/* 主内容区 */}
        <div className="flex-1 relative" ref={containerRef}>
          {viewMode === 'graph' ? (
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              onMouseMove={handleCanvasMouseMove}
              onMouseDown={handleCanvasMouseDown}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
              onWheel={handleWheel}
              onContextMenu={e => e.preventDefault()}
              style={{ width: canvasSize.width, height: canvasSize.height }}
              className="block"
            />
          ) : viewMode === 'community' ? (
            <div className="h-[650px] overflow-auto p-4 space-y-4">
              {graph.communities.map(community => (
                <div
                  key={community.id}
                  className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-xl p-5 border border-slate-700 hover:border-slate-600 transition-colors"
                >
                  <div className="flex items-start justify-between mb-3">
                    <h4 className="text-lg font-bold text-white">{community.name}</h4>
                    <div className="flex items-center gap-3 text-xs text-slate-400">
                      <span className="px-2 py-1 bg-blue-500/20 text-blue-300 rounded">
                        {community.entities.length} 实体
                      </span>
                      <span className="px-2 py-1 bg-purple-500/20 text-purple-300 rounded">
                        {community.relations.length} 关系
                      </span>
                    </div>
                  </div>
                  <p className="text-slate-300 text-sm leading-relaxed mb-4">{community.summary}</p>
                  {community.keywords.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-4">
                      {community.keywords.map((keyword, i) => (
                        <span key={i} className="px-2.5 py-1 bg-yellow-500/15 text-yellow-300 text-xs rounded-full border border-yellow-500/30">
                          {keyword}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="pt-3 border-t border-slate-700/50">
                    <div className="flex flex-wrap gap-1.5">
                      {community.entities.slice(0, 12).map(entityId => {
                        const entity = graph.entities.find(e => e.id === entityId);
                        return entity ? (
                          <span
                            key={entityId}
                            className="px-2 py-1 rounded text-xs font-medium"
                            style={{ 
                              backgroundColor: `${ENTITY_COLORS[entity.type as EntityType]}20`,
                              color: ENTITY_COLORS[entity.type as EntityType],
                              border: `1px solid ${ENTITY_COLORS[entity.type as EntityType]}40`
                            }}
                          >
                            {entity.name}
                          </span>
                        ) : null;
                      })}
                      {community.entities.length > 12 && (
                        <span className="px-2 py-1 text-xs text-slate-500">
                          +{community.entities.length - 12} 更多
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="h-[650px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-800 z-10">
                  <tr className="text-left text-slate-400 border-b border-slate-700">
                    <th className="px-4 py-3 font-medium">类型</th>
                    <th className="px-4 py-3 font-medium">名称</th>
                    <th className="px-4 py-3 font-medium">描述</th>
                    <th className="px-4 py-3 font-medium text-center">出现</th>
                    <th className="px-4 py-3 font-medium text-center">关联</th>
                  </tr>
                </thead>
                <tbody>
                  {graph.entities
                    .filter(e => filterType === 'ALL' || e.type === filterType)
                    .filter(e => !searchTerm || 
                      e.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                      e.description.toLowerCase().includes(searchTerm.toLowerCase())
                    )
                    .map(entity => {
                      const relationCount = graph.relations.filter(
                        r => r.source === entity.id || r.target === entity.id
                      ).length;
                      return (
                        <tr
                          key={entity.id}
                          className="border-b border-slate-700/50 hover:bg-slate-800/70 cursor-pointer transition-colors"
                          onClick={() => {
                            const node = nodes.find(n => n.id === entity.id);
                            if (node) {
                              setSelectedNode(node);
                              setViewMode('graph');
                            }
                          }}
                        >
                          <td className="px-4 py-3">
                            <span
                              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
                              style={{ 
                                backgroundColor: `${ENTITY_COLORS[entity.type as EntityType]}20`,
                                color: ENTITY_COLORS[entity.type as EntityType]
                              }}
                            >
                              {ENTITY_LABELS[entity.type as EntityType] || entity.type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-white font-medium">{entity.name}</td>
                          <td className="px-4 py-3 text-slate-400 max-w-xs truncate">{entity.description}</td>
                          <td className="px-4 py-3 text-slate-300 text-center">{entity.mentions}</td>
                          <td className="px-4 py-3 text-slate-300 text-center">{relationCount}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 详情面板 */}
        {(selectedNodeInfo || selectedLink) && (
          <div className="w-80 border-l border-slate-700 bg-gradient-to-b from-slate-800/80 to-slate-900/80 p-4 overflow-auto h-[650px]">
            {selectedNodeInfo && (
              <div className="space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <span
                      className="inline-block px-2.5 py-1 rounded-full text-xs font-medium mb-2"
                      style={{ 
                        backgroundColor: `${ENTITY_COLORS[selectedNodeInfo.entity.type as EntityType]}20`,
                        color: ENTITY_COLORS[selectedNodeInfo.entity.type as EntityType],
                        border: `1px solid ${ENTITY_COLORS[selectedNodeInfo.entity.type as EntityType]}40`
                      }}
                    >
                      {ENTITY_LABELS[selectedNodeInfo.entity.type as EntityType] || selectedNodeInfo.entity.type}
                    </span>
                    <h4 className="text-xl font-bold text-white">
                      {selectedNodeInfo.entity.name}
                    </h4>
                  </div>
                  <button
                    onClick={() => setSelectedNode(null)}
                    className="text-slate-400 hover:text-white p-1 hover:bg-slate-700 rounded transition-colors"
                  >
                    ✕
                  </button>
                </div>

                <div className="bg-slate-800/50 rounded-lg p-3">
                  <h5 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">描述</h5>
                  <p className="text-slate-300 text-sm leading-relaxed">{selectedNodeInfo.entity.description || '暂无描述'}</p>
                </div>

                {selectedNodeInfo.entity.aliases.length > 0 && (
                  <div>
                    <h5 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">别名</h5>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedNodeInfo.entity.aliases.map((alias, i) => (
                        <span key={i} className="px-2 py-1 bg-slate-700 text-slate-300 text-xs rounded">
                          {alias}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-blue-400">{selectedNodeInfo.entity.mentions}</div>
                    <div className="text-xs text-slate-500">出现次数</div>
                  </div>
                  <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-purple-400">{selectedNodeInfo.relatedRelations.length}</div>
                    <div className="text-xs text-slate-500">关联数量</div>
                  </div>
                </div>

                {selectedNodeInfo.community && (
                  <div>
                    <h5 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">所属社区</h5>
                    <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-3">
                      <div className="font-medium text-purple-300 mb-1">{selectedNodeInfo.community.name}</div>
                      <p className="text-xs text-slate-400 line-clamp-2">{selectedNodeInfo.community.summary}</p>
                    </div>
                  </div>
                )}

                {selectedNodeInfo.relatedRelations.length > 0 && (
                  <div>
                    <h5 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">相关关系</h5>
                    <div className="space-y-2 max-h-52 overflow-auto pr-1">
                      {selectedNodeInfo.relatedRelations.map(relation => {
                        const isSource = relation.source === selectedNodeInfo.entity.id;
                        const otherEntityId = isSource ? relation.target : relation.source;
                        const otherEntity = graph.entities.find(e => e.id === otherEntityId);
                        
                        return (
                          <div
                            key={relation.id}
                            className="bg-slate-800/50 rounded-lg p-2.5 cursor-pointer hover:bg-slate-700/50 transition-colors border border-transparent hover:border-slate-600"
                            onClick={() => {
                              const node = nodes.find(n => n.id === otherEntityId);
                              if (node) setSelectedNode(node);
                            }}
                          >
                            <div className="flex items-center gap-2 text-sm">
                              {isSource ? (
                                <>
                                  <span className="text-slate-500">→</span>
                                  <span className="px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded text-xs font-medium">
                                    {relation.type}
                                  </span>
                                  <span className="text-slate-500">→</span>
                                  <span className="text-white font-medium truncate">{otherEntity?.name}</span>
                                </>
                              ) : (
                                <>
                                  <span className="text-white font-medium truncate">{otherEntity?.name}</span>
                                  <span className="text-slate-500">→</span>
                                  <span className="px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded text-xs font-medium">
                                    {relation.type}
                                  </span>
                                  <span className="text-slate-500">→</span>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {selectedLink && (
              <div className="space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-xs text-slate-500">关系类型</span>
                    <h4 className="text-xl font-bold text-yellow-400">{selectedLink.type}</h4>
                  </div>
                  <button
                    onClick={() => setSelectedLink(null)}
                    className="text-slate-400 hover:text-white p-1 hover:bg-slate-700 rounded transition-colors"
                  >
                    ✕
                  </button>
                </div>

                <div className="bg-slate-800/50 rounded-lg p-3">
                  <h5 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">描述</h5>
                  <p className="text-slate-300 text-sm">{selectedLink.description || '暂无描述'}</p>
                </div>

                <div className="space-y-2">
                  <div
                    className="bg-slate-800/50 rounded-lg p-3 cursor-pointer hover:bg-slate-700/50 transition-colors"
                    onClick={() => {
                      const node = nodes.find(n => n.id === selectedLink.source);
                      if (node) { setSelectedNode(node); setSelectedLink(null); }
                    }}
                  >
                    <div className="text-xs text-slate-500 mb-1">源实体</div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const entity = graph.entities.find(e => e.id === selectedLink.source);
                        return entity ? (
                          <span className="text-white font-medium">{entity.name}</span>
                        ) : null;
                      })()}
                    </div>
                  </div>
                  
                  <div className="flex justify-center text-yellow-500 text-lg">↓</div>
                  
                  <div
                    className="bg-slate-800/50 rounded-lg p-3 cursor-pointer hover:bg-slate-700/50 transition-colors"
                    onClick={() => {
                      const node = nodes.find(n => n.id === selectedLink.target);
                      if (node) { setSelectedNode(node); setSelectedLink(null); }
                    }}
                  >
                    <div className="text-xs text-slate-500 mb-1">目标实体</div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const entity = graph.entities.find(e => e.id === selectedLink.target);
                        return entity ? (
                          <span className="text-white font-medium">{entity.name}</span>
                        ) : null;
                      })()}
                    </div>
                  </div>
                </div>

                <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                  <div className="text-xs text-slate-500 mb-1">权重</div>
                  <div className="text-2xl font-bold text-white">{selectedLink.weight.toFixed(2)}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 图例 */}
      <div className="px-4 py-3 bg-slate-800/30 border-t border-slate-700/50 flex flex-wrap items-center gap-4">
        {Object.entries(ENTITY_COLORS).map(([type, color]) => (
          <button
            key={type}
            onClick={() => setFilterType(filterType === type ? 'ALL' : type as EntityType)}
            className={`flex items-center gap-2 text-xs px-2 py-1 rounded transition-all ${
              filterType === 'ALL' || filterType === type 
                ? 'opacity-100' 
                : 'opacity-40 hover:opacity-70'
            }`}
          >
            <div
              className="w-3 h-3 rounded-full ring-2 ring-white/20"
              style={{ backgroundColor: color }}
            />
            <span className="text-slate-300">{ENTITY_LABELS[type as EntityType] || type}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
