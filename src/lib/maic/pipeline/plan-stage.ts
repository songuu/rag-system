/**
 * Plan Stage: f4/f5
 *
 * - f4: 为每页生成带动作标记的讲座脚本
 * - f5: 生成课堂主动提问池
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  SlidePage,
  KnowledgeNode,
  ScriptEntry,
  TeachingAction,
} from '../types';

const SCRIPT_PROMPT = `你是一位资深讲师。请为下面这页幻灯片生成讲述脚本,输出 JSON 数组,每个元素是一个教学动作。

<slide index="{INDEX}">
描述: {DESCRIPTION}
要点: {POINTS}
原文: {TEXT}
</slide>

教学动作格式 (严格 JSON 数组):
\`\`\`json
[
  { "type": "ShowFile", "value": { "slide_index": {INDEX} } },
  { "type": "ReadScript", "value": { "script": "老师讲的话(中文,3-6 句,面向学生)" } },
  { "type": "AskQuestion", "value": { "question": "引导性问题" } }
]
\`\`\`
必须以 ShowFile 开头。ReadScript 可有 1-2 个。AskQuestion 可选。只输出 JSON 数组。`;

const QUESTIONS_PROMPT = `基于以下课程知识树,生成 6 个高质量的课堂主动提问(覆盖不同层次):

<tree>
{TREE}
</tree>

输出 JSON 数组:
\`\`\`json
["问题1", "问题2", "问题3", "问题4", "问题5", "问题6"]
\`\`\`
只输出 JSON。`;

export async function generateLectureScript(
  llm: BaseChatModel,
  pages: SlidePage[],
  onPage?: (index: number) => void
): Promise<ScriptEntry[]> {
  const entries: ScriptEntry[] = new Array(pages.length);
  const concurrency = 4;

  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async page => {
        const prompt = SCRIPT_PROMPT
          .replaceAll('{INDEX}', String(page.index))
          .replace('{DESCRIPTION}', page.description || '(无)')
          .replace('{POINTS}', page.key_points.join('; ') || '(无)')
          .replace('{TEXT}', truncate(page.raw_text, 1500));
        let actions: TeachingAction[] = [];
        try {
          const resp = await llm.invoke([{ role: 'user', content: prompt }]);
          const parsed = parseJson<TeachingAction[]>(String(resp.content));
          if (Array.isArray(parsed)) actions = parsed.filter(isValidAction);
        } catch {
          /* fallthrough */
        }
        if (actions.length === 0) {
          actions = [
            { type: 'ShowFile', value: { slide_index: page.index } },
            {
              type: 'ReadScript',
              value: {
                script:
                  page.description ||
                  `我们来看第 ${page.index + 1} 页。${page.raw_text.slice(0, 200)}`,
              },
            },
          ];
        }
        entries[page.index] = { slide_index: page.index, actions };
        onPage?.(page.index);
      })
    );
  }

  return entries;
}

export async function generateActiveQuestions(
  llm: BaseChatModel,
  tree: KnowledgeNode
): Promise<string[]> {
  const treeText = JSON.stringify(tree, null, 2);
  const prompt = QUESTIONS_PROMPT.replace('{TREE}', truncate(treeText, 3000));
  try {
    const resp = await llm.invoke([{ role: 'user', content: prompt }]);
    const parsed = parseJson<string[]>(String(resp.content));
    if (Array.isArray(parsed)) return parsed.slice(0, 10).map(String);
  } catch {
    /* fallthrough */
  }
  return [
    '这一节的核心思想是什么?',
    '能举一个生活中的例子吗?',
    '它和你已知的什么概念相关?',
    '如果我们换一个假设会发生什么?',
    '还有没有反例?',
    '下一步我们最应该学什么?',
  ];
}

function isValidAction(a: unknown): a is TeachingAction {
  if (!a || typeof a !== 'object') return false;
  const obj = a as { type?: unknown; value?: unknown };
  return typeof obj.type === 'string' && typeof obj.value === 'object';
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
