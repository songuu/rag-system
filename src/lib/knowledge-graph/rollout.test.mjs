import assert from 'node:assert/strict';
import test from 'node:test';

const { resolveKnowledgeGraphRolloutMode } = await import('./rollout.ts');

test('prefers the canonical graph mode and keeps the MiroFish key as a fallback', () => {
  assert.equal(resolveKnowledgeGraphRolloutMode({}), 'off');
  assert.equal(resolveKnowledgeGraphRolloutMode({ RAG_MIROFISH_GRAPH_MODE: 'active' }), 'active');
  assert.equal(resolveKnowledgeGraphRolloutMode({
    RAG_GRAPH_MODE: 'shadow',
    RAG_MIROFISH_GRAPH_MODE: 'active',
  }), 'shadow');
});

test('rejects unsupported graph modes', () => {
  assert.throws(
    () => resolveKnowledgeGraphRolloutMode({ RAG_GRAPH_MODE: 'enabled' }),
    /RAG_GRAPH_MODE/
  );
});
