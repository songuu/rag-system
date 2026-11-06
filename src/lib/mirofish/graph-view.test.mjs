import assert from 'node:assert/strict';
import test from 'node:test';
const { toMiroFishViewerGraph, graphLinkOffsets, graphLinkGeometry, graphLinkHitDistance } = await import('./graph-view.ts');

test('graph adapter preserves UUID topology, evidence, attributes, communities and validity', () => {
  const graph = toMiroFishViewerGraph({ graph_id: 'g', nodes: [
    { uuid: 'uuid-a', name: 'Alice', labels: ['Entity', 'Researcher'], summary: 'A', attributes: { aliases: ['Al'], mentions: 4, sourceChunks: ['p'], department: 'Science' } },
    { uuid: 'uuid-b', name: 'Bob', labels: ['Person'], summary: 'B', attributes: {} },
  ], edges: [{ uuid: 'edge', source_node_uuid: 'uuid-a', target_node_uuid: 'uuid-b', source_node_name: 'Alice', target_node_name: 'Bob', name: 'KNOWS', fact: 'A knows B',
    fact_type: 'RELATIONSHIP', attributes: { weight: 0.7, sourceChunks: ['p'] }, episodes: ['episode'], valid_at: '2026-01-01' }],
  communities: [{ id: 'c', name: 'C', entities: ['uuid-a'], relations: ['edge'], summary: 'S', keywords: [], level: 0 }], node_count: 2, edge_count: 1 });
  assert.equal(graph.relations[0].source, 'uuid-a'); assert.equal(graph.relations[0].target, 'uuid-b');
  assert.deepEqual(graph.entities[0].aliases, ['Al']); assert.equal(graph.entities[0].mentions, 4);
  assert.equal(graph.entities[0].attributes.department, 'Science'); assert.equal(graph.entities[0].type, 'Researcher');
  assert.deepEqual(graph.entities[0].labels, ['Entity', 'Researcher']); assert.equal(graph.relations[0].factType, 'RELATIONSHIP');
  assert.deepEqual(graph.relations[0].sourceChunks, ['p']); assert.deepEqual(graph.relations[0].episodes, ['episode']);
  assert.equal(graph.relations[0].validAt, '2026-01-01'); assert.equal(graph.relations[0].weight, 0.7);
  assert.equal(graph.communities[0].id, 'c');
});

test('parallel and opposite-direction relations have distinct selectable curves', () => {
  const links = [{ id: 'one', source: 'a', target: 'b' }, { id: 'two', source: 'b', target: 'a' }];
  const offsets = graphLinkOffsets(links);
  const a = { id: 'a', x: 0, y: 0 }, b = { id: 'b', x: 200, y: 0 };
  const first = graphLinkGeometry(a, b, offsets.get('one'));
  const second = graphLinkGeometry(b, a, offsets.get('two'));
  assert.notEqual(first.label.y, second.label.y);
  assert(graphLinkHitDistance(first.label, first) < 1);
  assert(graphLinkHitDistance(first.label, second) > 10);
});

test('self relations retain a visible nonzero loop and a selectable apex', () => {
  const node = { id: 'a', x: 100, y: 100 };
  const loop = graphLinkGeometry(node, node, 0);
  assert.equal(loop.kind, 'loop'); assert(loop.label.y < node.y - 30);
  assert(graphLinkHitDistance(loop.label, loop) < 1);
  assert(loop.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
});
