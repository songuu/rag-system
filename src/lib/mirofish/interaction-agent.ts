/**
 * 深度交互 Agent
 *
 * 支持：
 * 1. 采访个体 Agent（基于 persona 回答）
 * 2. 变量注入（重新模拟）
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLLMFromOverride } from './model-override';
import type {
  EntityProfile,
  SimulationPost,
  InterviewRequest,
  InterviewResponse,
  ModelOverride,
} from './types';

const INTERVIEW_PROMPT = `你正在扮演以下角色接受采访。请严格按照人设回答。

## 你的人设
名称: {agent_name}
类型: {agent_type}
职业: {occupation}
性格: {personality}
说话风格: {speaking_style}
背景: {background}
观点倾向:
{viewpoints}

## 你在模拟中的行为
{agent_posts}

## 采访问题
{question}

请以角色身份回答，保持说话风格和观点一致。回答要自然，像真人接受采访一样。

**输出JSON格式：**
\`\`\`json
{
  "answer": "你的回答",
  "sentiment": "positive|neutral|negative",
  "confidence": 0.8
}
\`\`\``;

export class InteractionAgent {
  private llm: BaseChatModel;

  constructor(modelOverride?: ModelOverride) {
    this.llm = createLLMFromOverride(modelOverride, { temperature: 0.7 });
  }

  /** 采访单个 Agent */
  async interview(
    profile: EntityProfile,
    question: string,
    agentPosts: SimulationPost[]
  ): Promise<InterviewResponse> {
    const viewpointsText = Object.entries(profile.viewpoints || {})
      .map(([topic, view]) => `- ${topic}: ${view}`)
      .join('\n');

    const postsText = agentPosts.length > 0
      ? agentPosts.slice(-10).map(p =>
          `[${p.platform}] ${p.content}`
        ).join('\n')
      : '(没有发言记录)';

    const prompt = INTERVIEW_PROMPT
      .replace('{agent_name}', profile.entity_name)
      .replace('{agent_type}', profile.entity_type)
      .replace('{occupation}', profile.occupation || '未知')
      .replace('{personality}', (profile.personality_traits || []).join(', '))
      .replace('{speaking_style}', profile.speaking_style || '普通')
      .replace('{background}', profile.background || '')
      .replace('{viewpoints}', viewpointsText || '无特定观点')
      .replace('{agent_posts}', postsText)
      .replace('{question}', question);

    try {
      const response = await this.llm.invoke([
        { role: 'user', content: prompt },
      ]);

      const data = this.parseResponse(response.content as string);

      return {
        agent_id: profile.entity_id,
        agent_name: profile.entity_name,
        question,
        answer: String(data.answer || response.content),
        sentiment: this.validateSentiment(String(data.sentiment || 'neutral')),
        confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        agent_id: profile.entity_id,
        agent_name: profile.entity_name,
        question,
        answer: '抱歉，我现在无法回答这个问题。',
        sentiment: 'neutral',
        confidence: 0,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /** 批量采访 */
  async batchInterview(
    profiles: EntityProfile[],
    question: string,
    allPosts: SimulationPost[]
  ): Promise<InterviewResponse[]> {
    const promises = profiles.map(profile => {
      const agentPosts = allPosts.filter(p => p.author_id === profile.entity_id);
      return this.interview(profile, question, agentPosts);
    });

    return Promise.all(promises);
  }

  /** 解析响应 */
  private parseResponse(response: string): Record<string, unknown> {
    const cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return { answer: response, sentiment: 'neutral', confidence: 0.5 };
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return { answer: response, sentiment: 'neutral', confidence: 0.5 };
    }
  }

  /** 验证情感 */
  private validateSentiment(sentiment: string): string {
    const valid = ['positive', 'neutral', 'negative'];
    return valid.includes(sentiment) ? sentiment : 'neutral';
  }
}

export function getInteractionAgent(modelOverride?: ModelOverride): InteractionAgent {
  return new InteractionAgent(modelOverride);
}
