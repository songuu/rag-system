/**
 * 人设生成服务
 *
 * 为实体生成模拟人设，用于社会舆论模拟
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLLMFromOverride } from './model-override';
import type {
  BehavioralAnchors,
  EntityProfile,
  ProfileGenerationOptions,
  ProfileGenerateRequest,
  ProfileBatchGenerateRequest,
  ModelOverride,
} from './types';

/** 人设生成系统提示词 */
const PROFILE_SYSTEM_PROMPT = `你是一个社交媒体人设生成专家。你的任务是根据给定的实体信息，生成适合在社交媒体模拟中使用的人设档案。

**重要：你必须输出有效的JSON格式数据，不要输出任何其他内容。**

## 人设档案要求

生成的档案需要包含以下方面：

### 1. 基本信息
- full_name: 全名
- age: 年龄（合适范围内）
- gender: 性别
- occupation: 职业
- position: 职位（如适用）

### 2. 性格特点
- personality_traits: 3-5 个性格关键词
- speaking_style: 说话风格描述

### 3. 社交媒体风格
- social_media_style: 在社交媒体上的整体风格
- typical_posts: 3-5 条典型发言示例
- behavioral_anchors: 行为锚点, 用于让模拟中的 Agent 保持差异化行动节奏
  - posting_style: terse | verbose | meme-heavy | data-driven | emotional
  - active_hours: 0-23 的整数数组, 至少 4 个
  - stance: supportive | opposing | neutral | observer | amplifier
  - opinion_drift_rate: 0.0-1.0, 越高越容易受社交压力改变立场
  - influence_weight: 0.5-3.0, 意见领袖通常 > 2.0, 潜水者通常 < 0.8

### 4. 观点倾向
- viewpoints: 对不同话题的观点（用 JSON 对象表示）
  - 例如：{"环保": "支持环保政策，但反对极端环保", "经济发展": "支持可持续发展"}

### 5. 背景信息
- background: 背景故事
- expertise: 专业领域（可选）

## 输出格式

请输出JSON格式：

\`\`\`json
{
    "full_name": "姓名",
    "age": 30,
    "gender": "男/女",
    "occupation": "职业",
    "position": "职位（可选）",
    "personality_traits": ["特质1", "特质2", "特质3"],
    "speaking_style": "说话风格描述",
    "social_media_style": "社交媒体风格描述",
    "typical_posts": ["典型发言1", "典型发言2", "典型发言3"],
    "behavioral_anchors": {
        "posting_style": "data-driven",
        "active_hours": [8, 9, 12, 20],
        "stance": "observer",
        "opinion_drift_rate": 0.3,
        "influence_weight": 1.0
    },
    "viewpoints": {
        "话题1": "观点1",
        "话题2": "观点2"
    },
    "background": "背景故事"
}
\`\`\`

## 生成原则

1. **真实性**: 人设应该真实可信，符合其职业和身份
2. **多样性**: 不同人设应该有明显的差异性
3. **一致性**: 性格特点、说话风格、观点倾向应该保持一致
4. **社交媒体化**: 发言应该符合社交媒体的表达习惯
5. **行为差异**: Agent archetypes must be diverse: include opinion leaders (high influence, low drift), lurkers (low activity, observer stance), reactors (high drift, emotional style), and amplifiers (repost-heavy, high activity). Avoid uniform parameters.`;

const PROFILE_USER_PROMPT = `## 实体信息

- 名称: {entity_name}
- 类型: {entity_type}
- 描述: {entity_description}

## 模拟场景

{simulation_context}

{additional_instructions}

请根据以上信息，生成这个实体的人设档案。`;

/**
 * 人设生成器
 */
export class ProfileGenerator {
  private llm: BaseChatModel;

  constructor(modelOverride?: ModelOverride) {
    this.llm = createLLMFromOverride(modelOverride, { temperature: 0.7 });
  }

  /**
   * 生成单个人设
   */
  async generateProfile(request: ProfileGenerateRequest): Promise<EntityProfile> {
    const { entity, simulationContext, options } = request;

    // 构建提示词
    const userPrompt = this.buildUserPrompt(entity, simulationContext, options);

    // 调用 LLM
    const response = await this.llm.invoke([
      { role: 'system', content: PROFILE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);

    // 解析响应
    const profileData = this.parseProfileResponse(response.content as string);

    // 构建完整的人设档案
    return this.buildEntityProfile(entity, profileData, options);
  }

  /**
   * 批量生成人设
   */
  async generateProfiles(request: ProfileBatchGenerateRequest): Promise<EntityProfile[]> {
    const { entities, simulationContext, options } = request;

    const profiles: EntityProfile[] = [];

    // 逐个生成（可以改为并行）
    for (const entity of entities) {
      try {
        const profile = await this.generateProfile({
          entity: {
            name: entity.name,
            type: entity.type,
            description: entity.description,
            attributes: entity.attributes,
          },
          simulationContext,
          options,
        });
        profiles.push(profile);
      } catch (error) {
        console.error(`[ProfileGenerator] 生成实体 ${entity.name} 人设失败:`, error);
        // 继续生成下一个
      }
    }

    return profiles;
  }

  /**
   * 构建用户提示词
   */
  private buildUserPrompt(
    entity: ProfileGenerateRequest['entity'],
    simulationContext: string,
    options?: ProfileGenerationOptions
  ): string {
    let prompt = PROFILE_USER_PROMPT
      .replace('{entity_name}', entity.name)
      .replace('{entity_type}', entity.type)
      .replace('{entity_description}', entity.description)
      .replace('{simulation_context}', simulationContext);

    // 添加额外指令
    let additionalInstructions = '';
    if (options?.language === 'en') {
      additionalInstructions += '\n- 请使用英文输出人设内容';
    }
    if (!options?.includePersonality) {
      additionalInstructions += '\n- 不需要生成性格特点';
    }
    if (!options?.includeViewpoints) {
      additionalInstructions += '\n- 不需要生成观点倾向';
    }
    if (!options?.includePosts) {
      additionalInstructions += '\n- 不需要生成典型发言';
    }

    prompt = prompt.replace('{additional_instructions}', additionalInstructions);

    return prompt;
  }

  /**
   * 解析 LLM 返回的人设数据
   */
  private parseProfileResponse(response: string): Record<string, unknown> {
    // 移除代码块标记
    let cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

    // 尝试提取 JSON 对象
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('无法从响应中提取 JSON');
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // 尝试修复
      cleaned = this.fixJsonIssues(jsonMatch[0]);
      try {
        return JSON.parse(cleaned);
      } catch {
        throw new Error('无法解析 JSON 响应');
      }
    }
  }

  /**
   * 修复常见 JSON 问题
   */
  private fixJsonIssues(jsonStr: string): string {
    let fixed = jsonStr;

    // 修复尾随逗号
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

    // 修复缺少逗号
    fixed = fixed.replace(/}(\s*){/g, '},$1{');

    // 修复中文冒号
    fixed = fixed.replace(/：/g, ':');

    return fixed;
  }

  /**
   * 构建完整的人设档案
   */
  private buildEntityProfile(
    entity: ProfileGenerateRequest['entity'],
    data: Record<string, unknown>,
    options?: ProfileGenerationOptions
  ): EntityProfile {
    const profile: EntityProfile = {
      entity_id: entity.name, // 使用名称作为临时 ID
      entity_name: entity.name,
      entity_type: entity.type,

      // 基本信息
      full_name: String(data.full_name || entity.name),
      age: typeof data.age === 'number' ? data.age : undefined,
      gender: String(data.gender || ''),
      occupation: String(data.occupation || ''),
      position: data.position ? String(data.position) : undefined,

      // 性格特点
      personality_traits: Array.isArray(data.personality_traits)
        ? data.personality_traits.map(String)
        : [],
      speaking_style: String(data.speaking_style || ''),

      // 社交媒体
      social_media_style: String(data.social_media_style || ''),
      typical_posts: Array.isArray(data.typical_posts)
        ? data.typical_posts.map(String)
        : [],
      behavioral_anchors: this.parseBehavioralAnchors(data.behavioral_anchors),

      // 观点倾向
      viewpoints: this.parseViewpoints(data.viewpoints),

      // 背景信息
      background: String(data.background || entity.description),
      expertise: Array.isArray(data.expertise) ? data.expertise.map(String) : undefined,

      // 元数据
      generated_at: new Date().toISOString(),
    };

    // 根据选项过滤
    if (!options?.includePersonality) {
      profile.personality_traits = [];
    }
    if (!options?.includeViewpoints) {
      profile.viewpoints = {};
    }
    if (!options?.includePosts) {
      profile.typical_posts = [];
    }

    return profile;
  }

  /**
   * 解析行为锚点；无效时返回 undefined, 确保旧数据继续按原逻辑运行。
   */
  private parseBehavioralAnchors(value: unknown): BehavioralAnchors | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const data = value as Record<string, unknown>;
    const postingStyles: BehavioralAnchors['posting_style'][] = [
      'terse',
      'verbose',
      'meme-heavy',
      'data-driven',
      'emotional',
    ];
    const stances: BehavioralAnchors['stance'][] = [
      'supportive',
      'opposing',
      'neutral',
      'observer',
      'amplifier',
    ];

    const postingStyle = postingStyles.includes(data.posting_style as BehavioralAnchors['posting_style'])
      ? data.posting_style as BehavioralAnchors['posting_style']
      : 'data-driven';
    const stance = stances.includes(data.stance as BehavioralAnchors['stance'])
      ? data.stance as BehavioralAnchors['stance']
      : 'neutral';
    const activeHours = Array.isArray(data.active_hours)
      ? data.active_hours
          .map(Number)
          .filter(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23)
          .slice(0, 12)
      : [];

    return {
      posting_style: postingStyle,
      active_hours: activeHours.length >= 4 ? activeHours : [8, 12, 18, 21],
      stance,
      opinion_drift_rate: clampNumber(data.opinion_drift_rate, 0, 1, 0.35),
      influence_weight: clampNumber(data.influence_weight, 0.5, 3, 1),
    };
  }

  /**
   * 解析观点数据
   */
  private parseViewpoints(viewpoints: unknown): Record<string, string> {
    if (!viewpoints || typeof viewpoints !== 'object') {
      return {};
    }

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(viewpoints)) {
      result[key] = String(value);
    }
    return result;
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(numberValue, min), max);
}
