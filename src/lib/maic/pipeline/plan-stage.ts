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
  CourseScene,
  CourseStage,
  QuizQuestion,
  SceneAction,
} from '../types';
import { mapPagesWithOrderedCallbacks } from './page-order';

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
  const concurrency = 4;
  return mapPagesWithOrderedCallbacks(
    pages,
    concurrency,
    async page => {
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
      return { slide_index: page.index, actions };
    },
    onPage
  );
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

export function buildCourseStage(
  pages: SlidePage[],
  tree: KnowledgeNode,
  questions: string[]
): { stage: CourseStage; scenes: CourseScene[] } {
  const objectives = collectObjectives(tree, pages);
  const scenes: CourseScene[] = [];

  for (const page of pages) {
    const order = scenes.length;
    scenes.push(buildSlideScene(page, order, questions[page.index % Math.max(questions.length, 1)]));

    if ((page.index + 1) % 2 === 0) {
      scenes.push(buildQuizScene(page, scenes.length, questions));
    }

    if (page.index === 0 || (page.index + 1) % 3 === 0) {
      scenes.push(buildInteractiveScene(page, scenes.length));
    }
  }

  if (pages.length > 0) {
    scenes.push(buildPblScene(pages, scenes.length, tree));
  }

  return {
    stage: {
      title: tree.title || 'OpenMAIC 课堂',
      summary: tree.summary || pages[0]?.description || '多智能体交互课堂',
      objectives,
      scene_count: scenes.length,
      estimated_minutes: Math.max(8, Math.ceil(scenes.length * 1.8)),
    },
    scenes,
  };
}

function buildSlideScene(
  page: SlidePage,
  order: number,
  discussionQuestion: string | undefined
): CourseScene {
  const keyPoints = normalizeKeyPoints(page);
  return {
    id: `scene_slide_${page.index}`,
    order,
    type: 'slide',
    title: keyPoints[0] || `第 ${page.index + 1} 页讲解`,
    description: page.description || page.raw_text.slice(0, 180),
    page_refs: [page.index],
    key_points: keyPoints,
    actions: [
      sceneAction('speech', page.index, '教师讲解', page.description || page.raw_text.slice(0, 240)),
      sceneAction('spotlight', page.index, '聚光重点', keyPoints[0] || page.description, 'primary-point'),
      sceneAction('laser', page.index, '激光指示', keyPoints[1] || keyPoints[0], 'secondary-point'),
      sceneAction('whiteboard', page.index, '白板推导', keyPoints.join('\n') || page.description),
      sceneAction(
        'discussion',
        page.index,
        '圆桌讨论',
        discussionQuestion || `这一页最值得追问的问题是什么?`
      ),
    ],
  };
}

function buildQuizScene(page: SlidePage, order: number, questions: string[]): CourseScene {
  const keyPoints = normalizeKeyPoints(page);
  const question = questions[(page.index + order) % Math.max(questions.length, 1)] ||
    `关于第 ${page.index + 1} 页,哪一项最接近核心观点?`;
  const quiz: QuizQuestion[] = [
    {
      id: `quiz_${page.index}_1`,
      question,
      options: [
        keyPoints[0] || '抓住当前概念的核心关系',
        '只记住定义,不需要理解使用场景',
        '跳过例子,直接进入下一个主题',
        '所有细节同等重要,无需区分主次',
      ],
      answer_index: 0,
      explanation: page.description || '核心是先建立概念关系,再用例子验证理解。',
    },
  ];

  return {
    id: `scene_quiz_${page.index}`,
    order,
    type: 'quiz',
    title: `即时测验 ${Math.floor(page.index / 2) + 1}`,
    description: '用一道题快速检查刚才的理解。',
    page_refs: [page.index],
    key_points: keyPoints,
    actions: [
      sceneAction('quiz', page.index, '展示测验', question),
      sceneAction('discussion', page.index, '讲评讨论', quiz[0].explanation),
    ],
    quiz,
  };
}

function buildInteractiveScene(page: SlidePage, order: number): CourseScene {
  const keyPoints = normalizeKeyPoints(page);
  const hasCode = /代码|函数|算法|program|code|python|javascript|typescript/i.test(page.raw_text);
  const kind = hasCode ? 'code' : 'simulation';
  return {
    id: `scene_interactive_${page.index}`,
    order,
    type: hasCode ? 'code' : 'interactive',
    title: hasCode ? '在线编程练习' : '交互式探索',
    description: hasCode
      ? '把概念转化为可运行的小实验。'
      : '通过调节条件来观察概念变化。',
    page_refs: [page.index],
    key_points: keyPoints,
    actions: [
      sceneAction('widget_setState', page.index, '设置交互参数', keyPoints[0] || page.description),
      sceneAction('widget_highlight', page.index, '高亮关键变量', keyPoints[1] || keyPoints[0]),
      sceneAction('speech', page.index, '教师引导', '请尝试改变参数,观察结果如何变化。'),
    ],
    interactive: {
      kind,
      prompt: page.description || keyPoints.join('; '),
      controls: hasCode
        ? ['运行示例', '修改变量', '查看解释']
        : ['降低难度', '提高复杂度', '重置实验'],
    },
  };
}

function buildPblScene(pages: SlidePage[], order: number, tree: KnowledgeNode): CourseScene {
  const focus = collectObjectives(tree, pages).slice(0, 3);
  return {
    id: 'scene_pbl_final',
    order,
    type: 'pbl',
    title: '项目式学习挑战',
    description: '把本节课内容迁移到一个真实任务中。',
    page_refs: pages.map(page => page.index),
    key_points: focus,
    actions: [
      sceneAction('speech', order, '任务说明', '请用本节课的知识完成一个小型项目。'),
      sceneAction('discussion', order, '角色协作', '每位同学选择一个角色,共同推进交付物。'),
      sceneAction('whiteboard', order, '里程碑拆解', focus.join('\n')),
    ],
    pbl: {
      challenge: `围绕「${tree.title || '课程主题'}」设计一个可演示的小方案。`,
      roles: ['概念解释者', '案例设计者', '质疑审查者', '总结汇报者'],
      milestones: ['明确问题', '拆解关键概念', '设计示例或实验', '汇报结论'],
      deliverable: '一页结构化方案 + 3 分钟口头说明',
    },
  };
}

function sceneAction(
  type: SceneAction['type'],
  seed: number,
  title: string,
  content?: string,
  target?: string
): SceneAction {
  return {
    id: `${type}_${seed}_${title.replace(/\s+/g, '_')}`,
    type,
    title,
    content,
    target,
  };
}

function collectObjectives(tree: KnowledgeNode, pages: SlidePage[]): string[] {
  const fromTree = tree.children
    .flatMap(child => [child.title, ...child.children.map(grandChild => grandChild.title)])
    .filter(Boolean);
  const fromPages = pages.flatMap(page => page.key_points).filter(Boolean);
  return Array.from(new Set([...fromTree, ...fromPages])).slice(0, 6);
}

function normalizeKeyPoints(page: SlidePage): string[] {
  const points = page.key_points.filter(Boolean);
  if (points.length > 0) return points.slice(0, 5);
  return page.raw_text
    .split(/[。！？.!?\n]/)
    .map(s => s.trim())
    .filter(s => s.length >= 8)
    .slice(0, 4);
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
