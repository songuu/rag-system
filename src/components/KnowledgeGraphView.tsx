'use client';

import { useMemo, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3';

export type GraphViewData = {
  nodes: Array<{ uuid: string; name: string; labels: string[]; summary: string }>;
  edges: Array<{ uuid: string; name: string; fact: string; source_node_uuid: string; target_node_uuid: string }>;
  node_count: number;
  edge_count: number;
};
type LayoutNode = GraphViewData['nodes'][number] & SimulationNodeDatum;
type LayoutLink = GraphViewData['edges'][number] & SimulationLinkDatum<LayoutNode>;

export default function KnowledgeGraphView({ graph }: { graph: GraphViewData }) {
  const [selectedId, setSelectedId] = useState('');
  const [scale, setScale] = useState(1);
  const layout = useMemo(() => {
    const nodes: LayoutNode[] = graph.nodes.map(node => ({ ...node }));
    const ids = new Set(nodes.map(node => node.uuid));
    const links: LayoutLink[] = graph.edges.filter(edge => ids.has(edge.source_node_uuid) && ids.has(edge.target_node_uuid))
      .map(edge => ({ ...edge, source: edge.source_node_uuid, target: edge.target_node_uuid }));
    const simulation = forceSimulation(nodes)
      .force('link', forceLink<LayoutNode, LayoutLink>(links).id(node => node.uuid).distance(95))
      .force('charge', forceManyBody().strength(-180))
      .force('collision', forceCollide(32))
      .force('center', forceCenter(500, 300)).stop();
    simulation.tick(160);
    return { nodes, links };
  }, [graph]);
  const selected = graph.nodes.find(node => node.uuid === selectedId);
  return <div>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
      <span>{graph.node_count} 个实体 · {graph.edge_count} 条关系</span>
      <div className="flex gap-2"><button type="button" aria-label="缩小图谱" onClick={() => setScale(value => Math.max(.5, value - .2))} className="rounded border border-slate-700 px-3 py-1 hover:bg-slate-800">−</button><button type="button" aria-label="放大图谱" onClick={() => setScale(value => Math.min(3, value + .2))} className="rounded border border-slate-700 px-3 py-1 hover:bg-slate-800">＋</button><button type="button" onClick={() => setScale(1)} className="rounded border border-slate-700 px-3 py-1 hover:bg-slate-800">重置</button></div>
    </div>
    <div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950" style={{ maxHeight: 540 }}>
      <svg role="img" aria-label="知识图谱，选择实体查看详情" viewBox="0 0 1000 600" style={{ width: `${scale * 100}%`, minWidth: 500 }}>
        {layout.links.map(link => { const source = link.source as typeof layout.nodes[number]; const target = link.target as typeof layout.nodes[number]; return <line key={link.uuid} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="#475569" strokeWidth="1.5"><title>{link.name || link.fact}</title></line>; })}
        {layout.nodes.map(node => <g key={node.uuid} transform={`translate(${node.x},${node.y})`} role="button" tabIndex={0} aria-label={node.name} onClick={() => setSelectedId(node.uuid)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(node.uuid); } }} className="cursor-pointer"><circle r="13" fill={node.uuid === selectedId ? '#fbbf24' : '#06b6d4'} stroke="#cffafe" strokeWidth="1.5" /><text y="28" textAnchor="middle" fill="#cbd5e1" fontSize="11">{node.name.length > 15 ? node.name.slice(0, 15) + '…' : node.name}</text><title>{node.name}</title></g>)}
      </svg>
    </div>
    {selected && <div className="mt-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3"><strong className="text-sm text-cyan-100">{selected.name}</strong><span className="ml-2 text-xs text-slate-400">{selected.labels.join(' · ')}</span><p className="mt-1 text-xs leading-5 text-slate-300">{selected.summary || '暂无摘要'}</p></div>}
  </div>;
}
