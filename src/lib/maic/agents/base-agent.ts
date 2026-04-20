/**
 * Agent 基类: 所有可发言角色共享的实现
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLLM } from '../../model-config';
import type {
  AgentProfile,
  AgentRole,
  CoursePrepared,
  ClassroomState,
  Utterance,
  TeachingAction,
} from '../types';
import { getProfile } from './profiles';

const MAX_HISTORY = 12;

export class BaseAgent {
  protected profile: AgentProfile;
  protected llm: BaseChatModel;

  constructor(role: AgentRole, temperature = 0.7) {
    this.profile = getProfile(role);
    this.llm = createLLM(undefined, { temperature });
  }

  async respond(
    state: ClassroomState,
    action: TeachingAction,
    prepared: CoursePrepared | undefined
  ): Promise<Utterance> {
    const context = this.buildContext(state, prepared);
    const userPrompt = this.buildUserPrompt(state, action, context);

    let content = '';
    try {
      const resp = await this.llm.invoke([
        { role: 'system', content: this.profile.system_prompt },
        { role: 'user', content: userPrompt },
      ]);
      content = this.normalize(String(resp.content));
    } catch (error) {
      content = this.fallback(action);
    }

    return {
      id: `utt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      speaker: this.profile.role,
      speaker_name: this.profile.display_name,
      content,
      action,
      timestamp: new Date().toISOString(),
    };
  }

  private buildContext(state: ClassroomState, prepared: CoursePrepared | undefined): string {
    if (!prepared) return '';
    const page = prepared.pages[state.P_t] ?? prepared.pages[0];
    if (!page) return '';
    return [
      `当前页码: ${page.index + 1} / ${prepared.pages.length}`,
      `页描述: ${page.description}`,
      `要点: ${page.key_points.join('; ')}`,
    ].join('\n');
  }

  private buildUserPrompt(
    state: ClassroomState,
    action: TeachingAction,
    context: string
  ): string {
    const history = state.H_t.slice(-MAX_HISTORY)
      .map(u => `${u.speaker_name}: ${u.content}`)
      .join('\n');

    const actionHint = this.describeAction(action);

    return [
      '## 课堂上下文',
      context || '(暂无)',
      '',
      '## 最近对话',
      history || '(课堂刚开始)',
      '',
      '## 本次你要做的动作',
      actionHint,
      '',
      '请以你的角色身份发言。只输出发言内容,不要前缀、不要 JSON、不要括号旁白。',
    ].join('\n');
  }

  private describeAction(action: TeachingAction): string {
    switch (action.type) {
      case 'ReadScript':
        return `宣读/讲述如下脚本内容 (你可以自然地口述,不必逐字):\n${action.value.script ?? ''}`;
      case 'AskQuestion':
        return `向全班提出问题: ${action.value.question ?? ''}`;
      case 'ShowFile':
        return `切到幻灯片第 ${(action.value.slide_index ?? 0) + 1} 页,简短介绍一下这一页。`;
      case 'Navigate':
        return `引导课堂走向: ${action.value.note ?? ''}`;
      case 'AnswerStudent':
        return `学生刚刚提问: "${action.value.student_question ?? ''}"
请以老师身份,结合当前幻灯片的上下文,直接、具体地回答这个问题。
- 不要重复学生的原话
- 如果问题让你换一种讲法,请真的换一种讲法
- 语气友好,2-4 句`;
      case 'Idle':
        return `简短回应,不推进主进度。`;
      case 'EndClass':
        return `为本节课收尾,简短总结。`;
      default:
        return '根据上下文做合适的发言。';
    }
  }

  private normalize(text: string): string {
    return text
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  private fallback(action: TeachingAction): string {
    if (action.type === 'ReadScript' && action.value.script) return action.value.script;
    if (action.type === 'AskQuestion' && action.value.question) return action.value.question;
    if (action.type === 'AnswerStudent') return '这是个好问题,我们换一个角度看。';
    return '(暂时无法生成发言)';
  }
}
