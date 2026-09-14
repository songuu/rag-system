import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentUrl = new URL('./KnowledgeRetrievalFlow.tsx', import.meta.url);
const templateUrl = new URL('../app/template.tsx', import.meta.url);
const diagramUrl = new URL('../../public/diagrams/knowledge-retrieval-flow.svg', import.meta.url);

test('home page opens the accessible knowledge retrieval flow diagram in a new tab', async () => {
  const [component, template, diagram] = await Promise.all([
    readFile(componentUrl, 'utf8'),
    readFile(templateUrl, 'utf8'),
    readFile(diagramUrl, 'utf8'),
  ]);

  assert.match(template, /import KnowledgeRetrievalFlow from '@\/components\/KnowledgeRetrievalFlow';/);
  assert.match(template, /<KnowledgeRetrievalFlow\s*\/>/);
  assert.match(component, /\/diagrams\/knowledge-retrieval-flow\.svg/);
  assert.match(component, /href=\{DIAGRAM_PATH\}/);
  assert.match(component, /target="_blank"/);
  assert.match(component, /rel="noopener noreferrer"/);
  assert.match(component, /aria-label="在新标签页查看知识库检索流程图"/);
  assert.doesNotMatch(component, /role="dialog"/);

  for (const label of [
    '安全范围校验',
    '检索路由',
    '问题向量化',
    'Milvus Dense 检索',
    '证据归一化',
    '阈值与拒答判断',
    '上下文编排',
    '模型生成回答',
    'Hybrid 混合检索',
    '顺序全文读取',
    'PDF 视觉检索',
  ]) {
    assert.match(diagram, new RegExp(label));
  }

  assert.match(diagram, /<title>/);
  assert.match(diagram, /<desc>/);
});
