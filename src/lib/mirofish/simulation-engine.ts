/**
 * 模拟引擎核心
 *
 * 基于 LLM 的多 Agent 社交模拟引擎
 * 每个 Agent 基于 persona 做出社交行为决策
 */

import { createLLM } from '../model-config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  EntityProfile,
  SimulationPost,
  PlatformType,
  AgentActionType,
  SimulationConfig,
} from './types';

/** Agent 决策结果 */
interface AgentDecision {
  action: AgentActionType;
  content: string;
  target_id?: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  topics: string[];
}

const AGENT_DECISION_PROMPT = `你是一个社交媒体用户模拟器。你需要扮演一个特定的角色，在社交媒体上做出行为。

## 你的人设
名称: {agent_name}
类型: {agent_type}
职业: {occupation}
性格: {personality}
说话风格: {speaking_style}
社交媒体风格: {social_media_style}
背景: {background}
观点倾向: {viewpoints}

## 当前平台
{platform_desc}

## 当前话题
{topics}

## 最近消息（供你参考和互动）
{recent_posts}

## 你的任务
根据你的人设，在{platform}平台上做出一个合理的社交行为。

可选行为:
- post: 发布新帖子（原创内容）
- comment: 评论他人的帖子
- like: 点赞某个帖子
- repost: 转发某个帖子
- quote: 引用转发（附带评论）

**你必须输出有效的JSON格式，不要输出其他内容。**

输出格式:
\`\`\`json
{
  "action": "post|comment|like|repost|quote",
  "content": "你要发布/评论的内容（如果是 like 则为空字符串）",
  "target_id": "如果是 comment/like/repost/quote 则填目标帖子ID，否则为null",
  "sentiment": "positive|neutral|negative",
  "topics": ["相关话题1", "相关话题2"]
}
\`\`\``;

const TWITTER_DESC = 'Twitter - 短文本社交平台，每条推文限280字。特点：快节奏、话题标签、@提及、转发文化。';
const REDDIT_DESC = 'Reddit - 论坛式社交平台，支持长文本和层级评论。特点：子版块、投票机制、深度讨论、层级回复。';

/**
 * 模拟引擎
 */
export class SimulationEngine {
  private llm: BaseChatModel;

  constructor(temperature: number = 0.8) {
    this.llm = createLLM(undefined, { temperature });
  }

  /**
   * 生成单个 Agent 的行为
   */
  async generateAgentAction(
    profile: EntityProfile,
    platform: PlatformType,
    topics: string[],
    recentPosts: SimulationPost[],
    round: number,
    simulationId: string
  ): Promise<SimulationPost> {
    const prompt = this.buildPrompt(profile, platform, topics, recentPosts);

    try {
      const response = await this.llm.invoke([
        { role: 'user', content: prompt },
      ]);

      const decision = this.parseDecision(response.content as string);

      // 如果是 Twitter 平台，截断内容到 280 字
      const content = platform === 'twitter'
        ? decision.content.substring(0, 280)
        : decision.content;

      return {
        id: `post_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        simulation_id: simulationId,
        platform,
        round,
        author_id: profile.entity_id,
        author_name: profile.entity_name,
        author_type: profile.entity_type,
        action: decision.action,
        content,
        parent_id: decision.target_id || undefined,
        target_id: decision.target_id || undefined,
        likes: 0,
        replies_count: 0,
        reposts: 0,
        sentiment: decision.sentiment,
        topics: decision.topics,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      // 失败时生成一个简单帖子
      return this.generateFallbackPost(profile, platform, topics, round, simulationId);
    }
  }

  /**
   * 执行一轮模拟
   */
  async executeRound(
    profiles: EntityProfile[],
    config: SimulationConfig,
    round: number,
    existingPosts: SimulationPost[]
  ): Promise<SimulationPost[]> {
    const roundPosts: SimulationPost[] = [];

    // 最近的帖子（用于上下文）
    const recentPosts = existingPosts.slice(-20);

    // 选择本轮活跃的 Agent（随机选择）
    const activeAgents = this.selectActiveAgents(profiles, config.agents_per_round);

    // 对每个平台、每个活跃 Agent 生成行为
    for (const platform of config.platforms) {
      // 并行处理多个 Agent
      const promises = activeAgents.map(agent =>
        this.generateAgentAction(
          agent,
          platform,
          config.seed_topics,
          [...recentPosts, ...roundPosts],
          round,
          config.simulation_id
        )
      );

      const posts = await Promise.all(promises);
      roundPosts.push(...posts);
    }

    // 模拟互动（点赞/回复计数）
    this.simulateInteractions(roundPosts, existingPosts);

    return roundPosts;
  }

  /** 构建提示词 */
  private buildPrompt(
    profile: EntityProfile,
    platform: PlatformType,
    topics: string[],
    recentPosts: SimulationPost[]
  ): string {
    const recentPostsText = recentPosts.length > 0
      ? recentPosts.slice(-10).map(p =>
          `[${p.id}] ${p.author_name}(${p.author_type}): ${p.content}`
        ).join('\n')
      : '(还没有消息)';

    const viewpointsText = Object.entries(profile.viewpoints || {})
      .map(([topic, view]) => `${topic}: ${view}`)
      .join('\n');

    return AGENT_DECISION_PROMPT
      .replace('{agent_name}', profile.entity_name)
      .replace('{agent_type}', profile.entity_type)
      .replace('{occupation}', profile.occupation || '未知')
      .replace('{personality}', (profile.personality_traits || []).join(', '))
      .replace('{speaking_style}', profile.speaking_style || '普通')
      .replace('{social_media_style}', profile.social_media_style || '普通')
      .replace('{background}', profile.background || '')
      .replace('{viewpoints}', viewpointsText || '无特定观点')
      .replace('{platform_desc}', platform === 'twitter' ? TWITTER_DESC : REDDIT_DESC)
      .replace('{platform}', platform)
      .replace('{topics}', topics.join(', '))
      .replace('{recent_posts}', recentPostsText);
  }

  /** 解析 LLM 决策 */
  private parseDecision(response: string): AgentDecision {
    const cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('无法解析Agent决策');
    }

    try {
      const data = JSON.parse(jsonMatch[0]);
      return {
        action: this.validateAction(data.action),
        content: String(data.content || ''),
        target_id: data.target_id || undefined,
        sentiment: this.validateSentiment(data.sentiment),
        topics: Array.isArray(data.topics) ? data.topics.map(String) : [],
      };
    } catch {
      throw new Error('JSON解析失败');
    }
  }

  /** 验证动作类型 */
  private validateAction(action: string): AgentActionType {
    const valid: AgentActionType[] = ['post', 'comment', 'like', 'repost', 'quote', 'follow', 'debate', 'upvote', 'downvote'];
    return valid.includes(action as AgentActionType) ? (action as AgentActionType) : 'post';
  }

  /** 验证情感 */
  private validateSentiment(sentiment: string): 'positive' | 'neutral' | 'negative' {
    const valid = ['positive', 'neutral', 'negative'];
    return valid.includes(sentiment) ? (sentiment as 'positive' | 'neutral' | 'negative') : 'neutral';
  }

  /** 选择活跃 Agent */
  private selectActiveAgents(profiles: EntityProfile[], count: number): EntityProfile[] {
    const shuffled = [...profiles].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, profiles.length));
  }

  /** 模拟互动（仅更新 newPosts 内部的计数，不修改 existingPosts） */
  private simulateInteractions(newPosts: SimulationPost[], existingPosts: SimulationPost[]): void {
    // 构建 ID → post 的查找表（仅限 newPosts，避免修改已有帖子）
    const newPostsMap = new Map(newPosts.map(p => [p.id, p]));

    for (const post of newPosts) {
      if (!post.target_id) continue;

      // 优先在 newPosts 中查找目标（允许修改本轮新帖子）
      const target = newPostsMap.get(post.target_id);
      if (!target) continue;

      if (post.action === 'comment' || post.action === 'debate') {
        target.replies_count += 1;
      } else if (post.action === 'like' || post.action === 'upvote') {
        target.likes += 1;
      } else if (post.action === 'repost') {
        target.reposts += 1;
      }
    }
  }

  /** 生成备用帖子（LLM 失败时） */
  private generateFallbackPost(
    profile: EntityProfile,
    platform: PlatformType,
    topics: string[],
    round: number,
    simulationId: string
  ): SimulationPost {
    const topic = topics[Math.floor(Math.random() * topics.length)] || '当前话题';
    const posts = profile.typical_posts || [];
    const content = posts.length > 0
      ? posts[Math.floor(Math.random() * posts.length)]
      : `关于${topic}，我认为这是一个值得关注的话题。`;

    return {
      id: `post_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      simulation_id: simulationId,
      platform,
      round,
      author_id: profile.entity_id,
      author_name: profile.entity_name,
      author_type: profile.entity_type,
      action: 'post',
      content: platform === 'twitter' ? content.substring(0, 280) : content,
      likes: 0,
      replies_count: 0,
      reposts: 0,
      sentiment: 'neutral',
      topics: [topic],
      timestamp: new Date().toISOString(),
    };
  }
}
