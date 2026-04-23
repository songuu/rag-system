/**
 * Read Stage: f1/f2/f3
 *
 * - f1: 原始文本 (已由 slide-parser 提供)
 * - f2: 为每页生成完整的描述 + 关键点
 * - f3: 基于所有页构建树形知识分类
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { SlidePage, KnowledgeNode } from '../types';
import { mapPagesWithOrderedCallbacks } from './page-order';

const DESCRIBE_PROMPT = `你是一名课堂内容分析师。下面是课程幻灯片某一页的文本:

<slide index="{INDEX}">
{TEXT}
</slide>

请输出严格 JSON 格式,描述这页讲什么:
\`\`\`json
{
  "description": "对这页内容的完整中文描述,2-4 句",
  "key_points": ["核心要点1", "核心要点2", "核心要点3"]
}
\`\`\`
只输出 JSON,不要其他文字。`;

const TREE_PROMPT = `你是课程知识工程师。基于以下幻灯片摘要,构建一棵树形知识分类。

<slides>
{SLIDES_SUMMARY}
</slides>

请输出严格 JSON,代表一棵知识树 (至少 1 层,建议 2-3 层):
\`\`\`json
{
  "id": "root",
  "title": "课程主题",
  "summary": "整门课的主旨",
  "page_refs": [],
  "children": [
    {
      "id": "c1",
      "title": "子主题",
      "summary": "子主题概要",
      "page_refs": [0, 1],
      "children": []
    }
  ]
}
\`\`\`
只输出 JSON。`;

export async function describePages(
  llm: BaseChatModel,
  pages: SlidePage[],
  onPage?: (index: number) => void
): Promise<SlidePage[]> {
  const concurrency = 4;
  return mapPagesWithOrderedCallbacks(
    pages,
    concurrency,
    async page => {
      const prompt = DESCRIBE_PROMPT
        .replace('{INDEX}', String(page.index))
        .replace('{TEXT}', truncate(page.raw_text, 2000));
      try {
        const resp = await llm.invoke([{ role: 'user', content: prompt }]);
        const parsed = parseJson<{ description: string; key_points: string[] }>(
          String(resp.content)
        );
        return {
          ...page,
          description: parsed?.description ?? page.raw_text.slice(0, 200),
          key_points: Array.isArray(parsed?.key_points) ? parsed.key_points : [],
        };
      } catch {
        return {
          ...page,
          description: page.raw_text.slice(0, 200),
          key_points: [],
        };
      }
    },
    onPage
  );
}

export async function buildKnowledgeTree(
  llm: BaseChatModel,
  pages: SlidePage[]
): Promise<KnowledgeNode> {
  const summary = pages
    .map(p => `[p${p.index}] ${p.description || p.raw_text.slice(0, 120)}`)
    .join('\n');
  const prompt = TREE_PROMPT.replace('{SLIDES_SUMMARY}', truncate(summary, 5000));

  try {
    const resp = await llm.invoke([{ role: 'user', content: prompt }]);
    const tree = parseJson<KnowledgeNode>(String(resp.content));
    if (tree && tree.title) return normalizeTree(tree);
  } catch {
    // fallthrough
  }

  return {
    id: 'root',
    title: '课程大纲',
    summary: '由页面直接生成的默认大纲',
    page_refs: [],
    children: pages.map(p => ({
      id: `p${p.index}`,
      title: p.key_points[0] || `第 ${p.index + 1} 页`,
      summary: p.description || p.raw_text.slice(0, 100),
      page_refs: [p.index],
      children: [],
    })),
  };
}

function normalizeTree(node: KnowledgeNode): KnowledgeNode {
  return {
    id: node.id || 'node',
    title: node.title || '未命名',
    summary: node.summary || '',
    page_refs: Array.isArray(node.page_refs) ? node.page_refs : [],
    children: Array.isArray(node.children) ? node.children.map(normalizeTree) : [],
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function parseJson<T>(raw: string): T | null {
  const clean = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const match = clean.match(/[\{\[][\s\S]*[\}\]]/);
  const candidate = match ? match[0] : clean;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}
