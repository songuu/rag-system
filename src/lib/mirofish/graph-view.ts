interface InputNode { uuid: string; name: string; labels: string[]; summary: string; attributes?: Record<string, unknown>; created_at?: string }
interface InputEdge { uuid: string; name: string; fact: string; fact_type?: string; source_node_uuid?: string; target_node_uuid?: string; source_node_name?: string; target_node_name?: string;
  attributes?: Record<string, unknown>; episodes?: string[]; created_at?: string; valid_at?: string; invalid_at?: string; expired_at?: string }
export interface MiroFishGraphViewInput { graph_id: string; nodes: InputNode[]; edges: InputEdge[]; node_count: number; edge_count: number;
  communities?: Array<{ id: string; name: string; entities: string[]; relations: string[]; summary: string; keywords: string[]; level: number }> }

export interface GraphViewEntity { id: string; name: string; type: string; labels?: string[]; description: string; aliases: string[]; mentions: number; sourceChunks: string[]; attributes?: Record<string, unknown>; createdAt?: string }
export interface GraphViewRelation { id: string; source: string; target: string; type: string; description: string; weight: number; sourceChunks: string[]; attributes?: Record<string, unknown>;
  episodes?: string[]; factType?: string; createdAt?: string; validAt?: string; invalidAt?: string; expiredAt?: string }
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** UUIDs are graph identities; names remain display labels and may be duplicated. */
export function toMiroFishViewerGraph(graph: MiroFishGraphViewInput) {
  const names = new Map<string, string[]>();
  for (const node of graph.nodes) names.set(node.name, [...(names.get(node.name) ?? []), node.uuid]);
  const legacyId = (name?: string) => name && names.get(name)?.length === 1 ? names.get(name)![0] : '';
  return {
    entities: graph.nodes.map((node): GraphViewEntity => ({ id: node.uuid, name: node.name,
      type: node.labels.find(label => label !== 'Entity') || 'OTHER', labels: [...node.labels], description: node.summary,
      aliases: strings(node.attributes?.aliases), mentions: typeof node.attributes?.mentions === 'number' ? node.attributes.mentions : 1,
      sourceChunks: strings(node.attributes?.sourceChunks), attributes: node.attributes, createdAt: node.created_at })),
    relations: graph.edges.map((edge): GraphViewRelation => ({ id: edge.uuid,
      source: edge.source_node_uuid || legacyId(edge.source_node_name), target: edge.target_node_uuid || legacyId(edge.target_node_name),
      type: edge.name, factType: edge.fact_type, description: edge.fact, weight: typeof edge.attributes?.weight === 'number' ? edge.attributes.weight : 1,
      sourceChunks: strings(edge.attributes?.sourceChunks), attributes: edge.attributes, episodes: edge.episodes ?? [],
      createdAt: edge.created_at, validAt: edge.valid_at, invalidAt: edge.invalid_at, expiredAt: edge.expired_at })),
    communities: graph.communities ?? [],
    metadata: { documentId: graph.graph_id, createdAt: graph.nodes.find(node => node.created_at)?.created_at ?? '',
      entityCount: graph.node_count, relationCount: graph.edge_count, communityCount: graph.communities?.length ?? 0 },
  };
}

export interface GraphPoint { x: number; y: number }
type PositionedNode = GraphPoint & { id: string };
export interface GraphLinkCurve { kind: 'curve' | 'loop'; start: GraphPoint; control: GraphPoint; control2?: GraphPoint; end: GraphPoint; label: GraphPoint; angle: number; points: GraphPoint[] }

export function graphLinkOffsets(links: readonly { id: string; source: string; target: string }[]): Map<string, number> {
  const groups = new Map<string, typeof links[number][]>();
  for (const link of links) {
    const key = JSON.stringify([link.source, link.target].sort());
    groups.set(key, [...(groups.get(key) ?? []), link]);
  }
  const offsets = new Map<string, number>();
  for (const group of groups.values()) group.sort((a, b) => a.id.localeCompare(b.id)).forEach((link, index) => {
    offsets.set(link.id, link.source === link.target ? index : (index - (group.length - 1) / 2) * (link.source < link.target ? 1 : -1));
  });
  return offsets;
}

export function graphLinkGeometry(source: PositionedNode, target: PositionedNode, offset = 0, sourceRadius = 22, targetRadius = 22): GraphLinkCurve {
  const loop = source.id === target.id;
  const dx = target.x - source.x, dy = target.y - source.y, length = Math.hypot(dx, dy) || 1;
  const start = loop ? { x: source.x + sourceRadius * 0.65, y: source.y - sourceRadius * 0.65 }
    : { x: source.x + dx / length * sourceRadius, y: source.y + dy / length * sourceRadius };
  const end = loop ? { x: source.x - sourceRadius * 0.65, y: source.y - sourceRadius * 0.65 }
    : { x: target.x - dx / length * (targetRadius + 10), y: target.y - dy / length * (targetRadius + 10) };
  const spread = 55 + Math.abs(offset) * 25;
  const control = loop ? { x: source.x + spread, y: source.y - spread - sourceRadius }
    : { x: (source.x + target.x) / 2 - dy / length * offset * 65, y: (source.y + target.y) / 2 + dx / length * offset * 65 };
  const control2 = loop ? { x: source.x - spread, y: source.y - spread - sourceRadius } : undefined;
  const point = (t: number): GraphPoint => {
    const k = 1 - t;
    return control2 ? { x: k ** 3 * start.x + 3 * k * k * t * control.x + 3 * k * t * t * control2.x + t ** 3 * end.x,
      y: k ** 3 * start.y + 3 * k * k * t * control.y + 3 * k * t * t * control2.y + t ** 3 * end.y }
      : { x: k * k * start.x + 2 * k * t * control.x + t * t * end.x, y: k * k * start.y + 2 * k * t * control.y + t * t * end.y };
  };
  const points = Array.from({ length: 33 }, (_, index) => point(index / 32));
  const before = point(0.98);
  return { kind: loop ? 'loop' : 'curve', start, control, control2, end, label: point(0.5), angle: Math.atan2(end.y - before.y, end.x - before.x), points };
}

export function graphLinkHitDistance(point: GraphPoint, curve: GraphLinkCurve): number {
  let distance = Infinity;
  for (let index = 1; index < curve.points.length; index++) {
    const a = curve.points[index - 1], b = curve.points[index];
    const dx = b.x - a.x, dy = b.y - a.y;
    const ratio = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    distance = Math.min(distance, Math.hypot(point.x - a.x - ratio * dx, point.y - a.y - ratio * dy));
  }
  return distance;
}
