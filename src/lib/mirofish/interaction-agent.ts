/**
 * 深度交互 Agent
 *
 * 支持：
 * 1. 采访个体 Agent（基于 persona 回答）
 * 2. 变量注入（重新模拟）
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { parseMiroFishJsonObjectResponse } from './json-object-response';
import { createLLMFromOverride } from './model-override';
import type {
  EntityProfile,
  SimulationPost,
  InterviewResponse,
  ModelOverride,
} from './types';

const SAFE_INTERVIEW_ANSWER = '抱歉，我现在无法回答这个问题。';

const INTERVIEW_PROMPT = `你正在扮演以下角色接受采访。请严格按照人设回答。

## 你的人设
名称: {agent_name}
类型: {agent_type}
职业: {occupation}
性格: {personality}
说话风格: {speaking_style}
行为锚点: {behavioral_anchors}
背景: {background}
观点倾向:
{viewpoints}

## 你在模拟中的行为
{agent_posts}

## 采访问题
{question}

请以第一人称、自然口语化的方式直接回答，保持说话风格、观点和行为锚点一致。
不要调用任何工具，不要解释推理过程，不要用"作为AI"开头，直接表达你真实的想法、情绪和立场。

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
      .replace('{behavioral_anchors}', formatBehavioralAnchors(profile))
      .replace('{background}', profile.background || '')
      .replace('{viewpoints}', viewpointsText || '无特定观点')
      .replace('{agent_posts}', postsText)
      .replace('{question}', question);

    try {
      const response = await this.llm.invoke([
        { role: 'user', content: prompt },
      ]);

      const data = this.parseResponse(response.content as string);
      if (typeof data.answer !== 'string' || data.answer.trim().length === 0) {
        throw new Error('Invalid interview response.');
      }

      return {
        agent_id: profile.entity_id,
        agent_name: profile.entity_name,
        question,
        answer: data.answer,
        sentiment: this.validateSentiment(String(data.sentiment || 'neutral')),
        confidence: normalizeConfidence(data.confidence),
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        agent_id: profile.entity_id,
        agent_name: profile.entity_name,
        question,
        answer: SAFE_INTERVIEW_ANSWER,
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
    return parseMiroFishJsonObjectResponse(response);
  }

  /** 验证情感 */
  private validateSentiment(sentiment: string): string {
    const valid = ['positive', 'neutral', 'negative'];
    return valid.includes(sentiment) ? sentiment : 'neutral';
  }
}

function normalizeConfidence(value: unknown): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1
    ? value
    : 0.5;
}

export function getInteractionAgent(modelOverride?: ModelOverride): InteractionAgent {
  return new InteractionAgent(modelOverride);
}

function formatBehavioralAnchors(profile: EntityProfile): string {
  const anchors = profile.behavioral_anchors;
  if (!anchors) return '无特定行为锚点';

  return [
    `posting_style=${anchors.posting_style}`,
    `active_hours=${anchors.active_hours.join(',')}`,
    `stance=${anchors.stance}`,
    `opinion_drift_rate=${anchors.opinion_drift_rate}`,
    `influence_weight=${anchors.influence_weight}`,
  ].join('; ');
}
