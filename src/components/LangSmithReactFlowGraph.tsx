'use client';

import { memo, useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';

export type LangSmithFlowStatus = 'pending' | 'running' | 'completed' | 'error' | 'skipped';

export interface LangSmithFlowStep {
  id?: string;
  parentId?: string;
  label: string;
  description?: string;
  kind?: string;
  status?: LangSmithFlowStatus;
  duration?: number;
  error?: string;
  layer?: number;
  metadata?: Record<string, unknown>;
}

interface LangSmithReactFlowGraphProps {
  steps: LangSmithFlowStep[];
  className?: string;
  emptyMessage?: string;
}

interface LangSmithNodeData extends Record<string, unknown> {
  label: string;
  description?: string;
  kind: string;
  status: LangSmithFlowStatus;
  duration?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

type LangSmithGraphNode = Node<LangSmithNodeData, 'langsmithStep'>;

const STATUS_TONE: Record<LangSmithFlowStatus, {
  border: string;
  accent: string;
  text: string;
  label: string;
}> = {
  pending: {
    border: 'border-slate-500/50',
    accent: 'bg-slate-500',
    text: 'text-slate-300',
    label: '等待',
  },
  running: {
    border: 'border-sky-400/70',
    accent: 'bg-sky-400',
    text: 'text-sky-300',
    label: '执行中',
  },
  completed: {
    border: 'border-emerald-400/70',
    accent: 'bg-emerald-400',
    text: 'text-emerald-300',
    label: '完成',
  },
  error: {
    border: 'border-rose-400/80',
    accent: 'bg-rose-400',
    text: 'text-rose-300',
    label: '错误',
  },
  skipped: {
    border: 'border-amber-400/70',
    accent: 'bg-amber-400',
    text: 'text-amber-300',
    label: '跳过',
  },
};

const nodeTypes: NodeTypes = {
  langsmithStep: memo(function LangSmithStepNode({ data }: NodeProps<LangSmithGraphNode>) {
    const tone = STATUS_TONE[data.status] ?? STATUS_TONE.pending;
    const metadataPairs = data.metadata
      ? Object.entries(data.metadata)
          .filter(([, value]) => value !== undefined && value !== null && value !== '')
          .slice(0, 3)
      : [];

    return (
      <div className={`min-w-[210px] max-w-[260px] rounded-lg border ${tone.border} bg-slate-950/95 px-3 py-2 shadow-xl shadow-black/30`}>
        <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-slate-950 !bg-slate-200" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{data.label}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${tone.text} bg-white/5`}>
                <span className={`h-1.5 w-1.5 rounded-full ${tone.accent}`} />
                {tone.label}
              </span>
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-300">
                {data.kind}
              </span>
              {typeof data.duration === 'number' && (
                <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-300">
                  {data.duration}ms
                </span>
              )}
            </div>
          </div>
        </div>

        {data.description && (
          <div className="mt-2 line-clamp-2 text-xs leading-5 text-slate-300">
            {data.description}
          </div>
        )}

        {data.error && (
          <div className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
            {data.error}
          </div>
        )}

        {metadataPairs.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
            {metadataPairs.map(([key, value]) => (
              <div key={key} className="flex items-center justify-between gap-2 text-[10px]">
                <span className="truncate text-slate-500">{key}</span>
                <span className="max-w-[130px] truncate text-slate-300">{String(value)}</span>
              </div>
            ))}
          </div>
        )}
        <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-slate-950 !bg-slate-200" />
      </div>
    );
  }),
};

export default function LangSmithReactFlowGraph({
  steps,
  className = '',
  emptyMessage = '暂无可视化步骤',
}: LangSmithReactFlowGraphProps) {
  const { nodes, edges } = useMemo(() => buildFlowElements(steps), [steps]);

  if (steps.length === 0) {
    return (
      <div className={`flex min-h-[260px] items-center justify-center rounded-lg border border-dashed border-white/15 bg-slate-950/40 text-sm text-white/50 ${className}`}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={`h-[360px] min-h-[320px] w-full overflow-hidden rounded-lg border border-white/10 bg-slate-950 ${className}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1.15 }}
        minZoom={0.35}
        maxZoom={1.6}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        defaultEdgeOptions={{
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#f97316' },
          style: { stroke: '#f97316', strokeWidth: 2 },
        }}
      >
        <Background color="#334155" gap={18} size={1} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const status = (node.data?.status as LangSmithFlowStatus | undefined) ?? 'pending';
            if (status === 'completed') return '#34d399';
            if (status === 'error') return '#fb7185';
            if (status === 'running') return '#38bdf8';
            if (status === 'skipped') return '#fbbf24';
            return '#94a3b8';
          }}
          maskColor="rgba(2, 6, 23, 0.72)"
          className="!bg-slate-900/90"
        />
        <Controls className="!border-white/10 !bg-slate-900/95 !shadow-lg" />
      </ReactFlow>
    </div>
  );
}

function buildFlowElements(steps: LangSmithFlowStep[]): {
  nodes: LangSmithGraphNode[];
  edges: Edge[];
} {
  const normalizedSteps = steps.map((step, index) => ({
    ...step,
    id: normalizeNodeId(step.id ?? `${index}-${step.label}`),
    status: step.status ?? 'pending',
    kind: step.kind ?? 'chain',
    layer: step.layer ?? index,
  }));
  const layerCounts = new Map<number, number>();
  const nodes = normalizedSteps.map((step) => {
    const siblingIndex = layerCounts.get(step.layer) ?? 0;
    layerCounts.set(step.layer, siblingIndex + 1);

    return {
      id: step.id,
      type: 'langsmithStep',
      position: {
        x: step.layer * 280,
        y: siblingIndex * 150 + (step.layer % 2 === 0 ? 20 : 80),
      },
      data: {
        label: step.label,
        description: step.description,
        kind: step.kind,
        status: step.status,
        duration: step.duration,
        error: step.error,
        metadata: step.metadata,
      },
    } satisfies LangSmithGraphNode;
  });

  const existingIds = new Set(nodes.map((node) => node.id));
  const edges: Edge[] = [];
  const edgeKeys = new Set<string>();

  normalizedSteps.forEach((step, index) => {
    const source = step.parentId && existingIds.has(normalizeNodeId(step.parentId))
      ? normalizeNodeId(step.parentId)
      : index > 0
        ? normalizedSteps[index - 1].id
        : undefined;
    if (!source) return;

    const key = `${source}->${step.id}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      id: `edge-${key}`,
      source,
      target: step.id,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color: '#f97316' },
      style: { stroke: '#f97316', strokeWidth: 2 },
    });
  });

  return { nodes, edges };
}

function normalizeNodeId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
}
