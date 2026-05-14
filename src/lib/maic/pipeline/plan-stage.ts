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
  CourseGenerationLanguage,
  CourseGenerationOptions,
  CourseSceneCapabilities,
  FocusHoldMode,
  PPTAnimation,
  SlideFocusPlan,
  SlideFocusTarget,
} from '../types';
import { mapPagesWithOrderedCallbacks } from './page-order';
import { buildLanguageDirective } from './read-stage';
import {
  getSlideDescriptionElementId,
  getSlidePointAnimation,
  getSlidePointElementId,
} from '../slide-animation';

const SCRIPT_PROMPT = `你是一位资深讲师。请为下面这页幻灯片生成讲述脚本,输出 JSON 数组,每个元素是一个教学动作。

{LANGUAGE_DIRECTIVE}

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

{LANGUAGE_DIRECTIVE}

<tree>
{TREE}
</tree>

输出 JSON 数组:
\`\`\`json
["问题1", "问题2", "问题3", "问题4", "问题5", "问题6"]
\`\`\`
只输出 JSON。`;

const FOCUS_PROMPT = `你是 OpenMAIC PPT 播放策略设计师。请根据幻灯片内容判断课堂播放时最应该重点悬停的元素。

{LANGUAGE_DIRECTIVE}

判定原则:
- 不要机械选择第一个要点;必须基于教学目标、概念中心性、学生可能误解点、承上启下关系判断。
- primary_candidate_id 是必须重点悬停的元素。
- secondary_candidate_id 是可选的激光指示元素,应与 primary 不同,用于辅助解释。
- hold_mode 默认选择 until_next_focus;只有非常短暂的提示才选择 duration。
- confidence 取 0 到 1。

<course>
标题: {TREE_TITLE}
摘要: {TREE_SUMMARY}
</course>

<slide index="{INDEX}">
描述: {DESCRIPTION}
要点: {POINTS}
候选元素(JSON):
{CANDIDATES}
原文: {TEXT}
</slide>

重点策略格式 (严格 JSON 对象):
\`\`\`json
{
  "primary_candidate_id": "point_1",
  "secondary_candidate_id": "point_0",
  "focus_label": "重点名称",
  "rationale": "为什么这里是本页最该悬停的重点",
  "confidence": 0.86,
  "hold_mode": "until_next_focus"
}
\`\`\`
只输出 JSON。`;

export async function generateLectureScript(
  llm: BaseChatModel,
  pages: SlidePage[],
  onPage?: (index: number) => void,
  language: CourseGenerationLanguage = 'zh-CN'
): Promise<ScriptEntry[]> {
  const concurrency = 4;
  return mapPagesWithOrderedCallbacks(
    pages,
    concurrency,
    async page => {
      const prompt = SCRIPT_PROMPT
        .replace('{LANGUAGE_DIRECTIVE}', buildLanguageDirective(language))
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
  tree: KnowledgeNode,
  language: CourseGenerationLanguage = 'zh-CN'
): Promise<string[]> {
  const treeText = JSON.stringify(tree, null, 2);
  const prompt = QUESTIONS_PROMPT
    .replace('{LANGUAGE_DIRECTIVE}', buildLanguageDirective(language))
    .replace('{TREE}', truncate(treeText, 3000));
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

export async function generateSlideFocusPlans(
  llm: BaseChatModel,
  pages: SlidePage[],
  tree: KnowledgeNode,
  onPage?: (index: number) => void,
  language: CourseGenerationLanguage = 'zh-CN'
): Promise<SlideFocusPlan[]> {
  const concurrency = 4;
  return mapPagesWithOrderedCallbacks(
    pages,
    concurrency,
    async page => {
      const candidates = buildFocusCandidates(page);
      const prompt = FOCUS_PROMPT
        .replace('{LANGUAGE_DIRECTIVE}', buildLanguageDirective(language))
        .replace('{TREE_TITLE}', tree.title || '(无)')
        .replace('{TREE_SUMMARY}', truncate(tree.summary || '', 700) || '(无)')
        .replaceAll('{INDEX}', String(page.index))
        .replace('{DESCRIPTION}', page.description || '(无)')
        .replace('{POINTS}', page.key_points.join('; ') || '(无)')
        .replace('{CANDIDATES}', JSON.stringify(candidates, null, 2))
        .replace('{TEXT}', truncate(page.raw_text, 1600));

      try {
        const resp = await llm.invoke([{ role: 'user', content: prompt }]);
        const parsed = parseJson<Record<string, unknown>>(String(resp.content));
        const plan = normalizeModelFocusPlan(page, candidates, parsed);
        if (plan) return plan;
      } catch {
        /* fallthrough */
      }

      return buildFallbackSlideFocusPlan(page);
    },
    onPage
  );
}

export function buildCourseStage(
  pages: SlidePage[],
  tree: KnowledgeNode,
  questions: string[],
  options: CourseGenerationOptions = {}
): { stage: CourseStage; scenes: CourseScene[] } {
  const objectives = collectObjectives(tree, pages);
  const capabilities = normalizeCapabilities(options.capabilities);
  const focusPlanBySlide = new Map(
    (options.focusPlans ?? []).map(plan => [plan.slide_index, plan])
  );
  const scenes: CourseScene[] = [];

  for (const page of pages) {
    const order = scenes.length;
    scenes.push(
      buildSlideScene(
        page,
        order,
        questions[page.index % Math.max(questions.length, 1)],
        capabilities,
        focusPlanBySlide.get(page.index)
      )
    );

    if (capabilities.quiz && (page.index + 1) % 2 === 0) {
      scenes.push(buildQuizScene(page, scenes.length, questions));
    }

    if (capabilities.interactive && (page.index === 0 || (page.index + 1) % 3 === 0)) {
      scenes.push(buildInteractiveScene(page, scenes.length));
    }
  }

  if (capabilities.pbl && pages.length > 0) {
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
  discussionQuestion: string | undefined,
  capabilities: Required<CourseSceneCapabilities>,
  modelFocusPlan?: SlideFocusPlan
): CourseScene {
  const keyPoints = normalizeKeyPoints(page);
  const visiblePointCount = Math.min(keyPoints.length, 4);
  const descriptionElementId = getSlideDescriptionElementId(page.index);
  const focusPlan = modelFocusPlan ?? buildFallbackSlideFocusPlan(page);
  const actions: SceneAction[] = [
    sceneAction('speech', page.index, '教师讲解', page.description || page.raw_text.slice(0, 240), undefined, {
      elementId: descriptionElementId,
      animation: capabilities.animations
        ? {
            id: `anim_scene_${page.index}_description`,
            elId: descriptionElementId,
            effect: 'fade',
            type: 'in',
            duration: 450,
            trigger: 'auto',
          }
        : undefined,
    }),
    sceneAction(
      'discussion',
      page.index,
      '圆桌讨论',
      discussionQuestion || `这一页最值得追问的问题是什么?`
    ),
  ];
  if (capabilities.spotlight) {
    const focusTarget = focusPlan.primary;
    const targetId = focusTarget.elementId;
    const animation = actionAnimationForFocusTarget(page, focusTarget, visiblePointCount, capabilities);
    actions.splice(
      1,
      0,
      sceneAction('spotlight', page.index, focusTarget.label || '聚光重点', focusTarget.text, targetId, {
        elementId: targetId,
        dimOpacity: focusPlan.dimOpacity ?? 0.55,
        duration: animation?.duration,
        trigger: animation?.trigger,
        focusHold: capabilities.focusHover ? focusPlan.focusHold ?? 'until_next_focus' : 'duration',
        focusSource: focusPlan.source,
        focusReason: focusTarget.reason ?? focusPlan.rationale,
        focusConfidence: focusTarget.confidence ?? focusPlan.confidence,
        animation,
      })
    );
  }
  if (capabilities.laser && focusPlan.secondary) {
    const focusTarget = focusPlan.secondary;
    const targetId = focusTarget.elementId;
    const animation = actionAnimationForFocusTarget(page, focusTarget, visiblePointCount, capabilities);
    actions.splice(
      Math.min(actions.length, 2),
      0,
      sceneAction('laser', page.index, focusTarget.label || '激光指示', focusTarget.text, targetId, {
        elementId: targetId,
        color: '#ff3b30',
        duration: animation?.duration,
        trigger: animation?.trigger,
        focusSource: focusPlan.source,
        focusReason: focusTarget.reason,
        focusConfidence: focusTarget.confidence,
        animation,
      })
    );
  }
  if (capabilities.whiteboard) {
    actions.splice(
      Math.min(actions.length, 3),
      0,
      sceneAction('whiteboard', page.index, '白板推导', keyPoints.join('\n') || page.description, undefined, {
        duration: capabilities.animations ? 800 : undefined,
        trigger: capabilities.animations ? 'auto' : undefined,
      })
    );
  }

  return {
    id: `scene_slide_${page.index}`,
    order,
    type: 'slide',
    title: keyPoints[0] || `第 ${page.index + 1} 页讲解`,
    description: page.description || page.raw_text.slice(0, 180),
    page_refs: [page.index],
    key_points: keyPoints,
    actions,
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
  target?: string,
  overrides: Partial<SceneAction> = {}
): SceneAction {
  return {
    id: `${type}_${seed}_${title.replace(/\s+/g, '_')}`,
    type,
    title,
    content,
    target,
    ...overrides,
  };
}

function actionAnimationForPoint(
  page: SlidePage,
  pointIndex: number,
  pointCount: number,
  targetId: string,
  capabilities: Required<CourseSceneCapabilities>
): PPTAnimation | undefined {
  if (!capabilities.animations || pointCount <= 0) return undefined;
  const animation = getSlidePointAnimation(page, pointIndex, pointCount);
  return { ...animation, elId: targetId };
}

function actionAnimationForFocusTarget(
  page: SlidePage,
  target: SlideFocusTarget,
  pointCount: number,
  capabilities: Required<CourseSceneCapabilities>
): PPTAnimation | undefined {
  if (!capabilities.animations) return undefined;
  if (target.kind === 'description') {
    const descriptionId = getSlideDescriptionElementId(page.index);
    return (
      page.animations?.find(animation => animation.elId === descriptionId) ?? {
        id: `anim_scene_${page.index}_description_focus`,
        elId: descriptionId,
        effect: 'spotlight',
        type: 'attention',
        duration: 650,
        trigger: 'auto',
      }
    );
  }
  return actionAnimationForPoint(page, target.index ?? 0, pointCount, target.elementId, capabilities);
}

export function buildFallbackSlideFocusPlan(page: SlidePage): SlideFocusPlan {
  const candidates = buildFocusCandidates(page);
  const primary =
    candidates.find(candidate => candidate.kind === 'key_point') ??
    candidates.find(candidate => candidate.kind === 'description') ??
    fallbackDescriptionCandidate(page);
  const secondary = candidates.find(
    candidate => candidate.kind === 'key_point' && candidate.elementId !== primary.elementId
  );

  return {
    slide_index: page.index,
    source: 'fallback',
    primary,
    secondary,
    focusHold: 'until_next_focus',
    dimOpacity: 0.55,
    rationale: '模型重点解析不可用时,使用本页结构化要点作为稳定兜底。',
    confidence: 0.35,
  };
}

interface FocusCandidate extends SlideFocusTarget {
  id: string;
}

function buildFocusCandidates(page: SlidePage): FocusCandidate[] {
  const candidates: FocusCandidate[] = [];
  const description = (page.description || page.raw_text.slice(0, 220)).trim();
  if (description) {
    candidates.push({
      id: 'description',
      kind: 'description',
      elementId: getSlideDescriptionElementId(page.index),
      text: description,
      label: '悬停描述',
    });
  }

  page.key_points.slice(0, 4).forEach((point, index) => {
    const text = point.trim();
    if (!text) return;
    candidates.push({
      id: `point_${index}`,
      kind: 'key_point',
      index,
      elementId: getSlidePointElementId(page.index, index),
      text,
      label: `悬停要点 ${index + 1}`,
    });
  });

  if (candidates.length === 0) candidates.push(fallbackDescriptionCandidate(page));
  return candidates;
}

function fallbackDescriptionCandidate(page: SlidePage): FocusCandidate {
  return {
    id: 'description',
    kind: 'description',
    elementId: getSlideDescriptionElementId(page.index),
    text: page.raw_text.slice(0, 220) || `第 ${page.index + 1} 页`,
    label: '悬停描述',
  };
}

function normalizeModelFocusPlan(
  page: SlidePage,
  candidates: FocusCandidate[],
  raw: Record<string, unknown> | null
): SlideFocusPlan | null {
  if (!raw) return null;
  const primaryId = readString(raw.primary_candidate_id);
  const primary = candidates.find(candidate => candidate.id === primaryId);
  if (!primary) return null;

  const secondaryId = readString(raw.secondary_candidate_id);
  const secondary = candidates.find(
    candidate => candidate.id === secondaryId && candidate.elementId !== primary.elementId
  );
  const confidence = clampConfidence(raw.confidence);
  const rationale = readString(raw.rationale);
  const holdMode = normalizeFocusHoldMode(raw.hold_mode);
  const focusLabel = readString(raw.focus_label);

  return {
    slide_index: page.index,
    source: 'model',
    primary: {
      ...primary,
      label: focusLabel || primary.label,
      reason: rationale,
      confidence,
    },
    secondary: secondary
      ? {
          ...secondary,
          reason: secondary.text ? `辅助解释: ${secondary.text}` : undefined,
          confidence,
        }
      : undefined,
    focusHold: holdMode,
    dimOpacity: 0.55,
    rationale,
    confidence,
  };
}

function normalizeFocusHoldMode(value: unknown): FocusHoldMode {
  if (
    value === 'none' ||
    value === 'until_next_focus' ||
    value === 'until_slide_change' ||
    value === 'duration'
  ) {
    return value;
  }
  return 'until_next_focus';
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function normalizeCapabilities(
  capabilities: CourseSceneCapabilities | undefined
): Required<CourseSceneCapabilities> {
  return {
    quiz: capabilities?.quiz ?? true,
    interactive: capabilities?.interactive ?? true,
    pbl: capabilities?.pbl ?? true,
    whiteboard: capabilities?.whiteboard ?? true,
    spotlight: capabilities?.spotlight ?? true,
    laser: capabilities?.laser ?? true,
    animations: capabilities?.animations ?? true,
    focusHover: capabilities?.focusHover ?? true,
  };
}
