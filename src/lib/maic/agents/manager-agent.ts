/**
 * Manager Agent (meta)
 *
 * 决策函数 f_L: S_t → (next_agent, action)
 *
 * 实现策略:
 * 1. 硬规则优先 - 覆盖最常见的情形(学生刚提问、脚本推进、连续同角色)
 * 2. LLM JSON 兜底 - 规则无法决定时调 LLM 做路由
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLLM } from '../../model-config';
import type {
  ClassroomState,
  CoursePrepared,
  ManagerDecision,
  TeachingAction,
  SpeakingRole,
} from '../types';

const MANAGER_PROMPT = `你是课堂调度者,负责决定下一步由哪个 agent 执行什么教学动作。

## 可选 agent
- teacher: 讲课主角,回答学生问题
- ta: 助教,维护秩序
- clown: 用幽默比喻活跃气氛
- thinker: 提出深度问题
- notetaker: 总结关键点
- inquisitive: 提出代表学生的问题

## 可用 action 类型
- ReadScript: 宣读讲稿片段 (value.script)
- AskQuestion: 提问 (value.question)
- ShowFile: 切换到某页 (value.slide_index)
- Navigate: 引导话题 (value.note)
- AnswerStudent: 回答学生刚刚提出的问题 (value.student_question)
- Idle: 短暂回应
- EndClass: 结束课堂

## 当前状态
- 页码: {PAGE}/{TOTAL}
- 脚本游标: {CURSOR}
- 模式: {MODE}
- 可用角色: {ROLES}
- 最近对话:
{HISTORY}

## 刚刚的学生输入
{STUDENT_INPUT}

请输出严格 JSON (只输出 JSON,不要解释):
\`\`\`json
{
  "next_agent": "teacher",
  "action": { "type": "ReadScript", "value": { "script": "..." } },
  "reason": "简短中文理由"
}
\`\`\``;

export class ManagerAgent {
  private llm: BaseChatModel;

  constructor() {
    this.llm = createLLM(undefined, { temperature: 0.2 });
  }

  /**
   * 主决策入口。硬规则优先,失败则调 LLM。
   */
  async decide(
    state: ClassroomState,
    prepared: CoursePrepared | undefined,
    recentStudentMessage: string | null
  ): Promise<ManagerDecision> {
    // 规则 1: 有学生刚发言 → teacher 使用专门的 AnswerStudent 动作
    if (recentStudentMessage) {
      return {
        next_agent: 'teacher',
        action: {
          type: 'AnswerStudent',
          value: { student_question: recentStudentMessage },
        },
        reason: '响应学生输入',
      };
    }

    if (!prepared) {
      return {
        next_agent: 'teacher',
        action: { type: 'Idle', value: { note: '课程未就绪' } },
        reason: 'no prepared content',
      };
    }

    const script = prepared.lecture_script;
    const cursor = state.script_cursor;

    // 规则 2: 走完所有脚本 → 结课
    if (cursor >= totalScriptSteps(script)) {
      return {
        next_agent: 'teacher',
        action: { type: 'EndClass', value: { note: '本节课内容已讲完' } },
        reason: '脚本结束',
      };
    }

    // 规则 3: 取下一步脚本动作
    const scripted = pickScriptedAction(script, cursor);
    if (scripted) {
      // 随机概率让 classmate 插一句,让课堂更自然
      const classmateRole = maybeInjectClassmate(state, cursor);
      if (classmateRole) {
        return {
          next_agent: classmateRole,
          action: { type: 'Idle', value: { note: '根据上下文自然补充一句' } },
          reason: '氛围插入',
        };
      }
      return {
        next_agent: 'teacher',
        action: scripted,
        reason: '按脚本推进',
      };
    }

    // 兜底: 调 LLM
    try {
      return await this.decideWithLLM(state, prepared, recentStudentMessage);
    } catch {
      return {
        next_agent: 'teacher',
        action: { type: 'Idle', value: {} },
        reason: 'fallback idle',
      };
    }
  }

  private async decideWithLLM(
    state: ClassroomState,
    prepared: CoursePrepared,
    recentStudentMessage: string | null
  ): Promise<ManagerDecision> {
    const history = state.H_t.slice(-8)
      .map(u => `${u.speaker_name}: ${u.content}`)
      .join('\n');

    const prompt = MANAGER_PROMPT
      .replace('{PAGE}', String(state.P_t + 1))
      .replace('{TOTAL}', String(prepared.pages.length))
      .replace('{CURSOR}', String(state.script_cursor))
      .replace('{MODE}', state.mode)
      .replace('{ROLES}', state.R.join(', '))
      .replace('{HISTORY}', history || '(课堂刚开始)')
      .replace('{STUDENT_INPUT}', recentStudentMessage ?? '(无)');

    const resp = await this.llm.invoke([{ role: 'user', content: prompt }]);
    const parsed = parseJson<ManagerDecision>(String(resp.content));
    if (parsed && parsed.next_agent && parsed.action) return parsed;
    throw new Error('manager: invalid JSON');
  }
}

function totalScriptSteps(script: { actions: TeachingAction[] }[]): number {
  return script.reduce((acc, s) => acc + s.actions.length, 0);
}

function pickScriptedAction(
  script: { slide_index: number; actions: TeachingAction[] }[],
  cursor: number
): TeachingAction | null {
  let acc = 0;
  for (const entry of script) {
    if (cursor < acc + entry.actions.length) {
      return entry.actions[cursor - acc];
    }
    acc += entry.actions.length;
  }
  return null;
}

function maybeInjectClassmate(state: ClassroomState, cursor: number): SpeakingRole | null {
  const classmateList: SpeakingRole[] = ['clown', 'thinker', 'notetaker', 'inquisitive'];
  const latestSpeaker = state.H_t.at(-1)?.speaker;
  if (latestSpeaker && classmateList.includes(latestSpeaker as SpeakingRole)) return null;
  const classmates = state.R.filter((r): r is SpeakingRole =>
    classmateList.includes(r as SpeakingRole)
  );
  if (classmates.length === 0) return null;
  if (cursor < 2) return null;
  if (cursor % 5 !== 0) return null;
  const idx = Math.floor(cursor / 5) % classmates.length;
  return classmates[idx];
}

function parseJson<T>(raw: string): T | null {
  const clean = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const match = clean.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : clean;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

let instance: ManagerAgent | null = null;

export function getManagerAgent(): ManagerAgent {
  if (!instance) instance = new ManagerAgent();
  return instance;
}
