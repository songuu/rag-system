/**
 * 模拟运行器
 *
 * 管理模拟生命周期：创建 → 准备 → 启动 → 停止
 * 支持 SSE 实时推送模拟进度
 */

import { SimulationEngine } from './simulation-engine';
import type {
  SimulationConfig,
  SimulationInfo,
  SimulationStatus,
  SimulationPost,
  EntityProfile,
  TimelineEntry,
  AgentStats,
} from './types';

/** 模拟事件监听器 */
type SimulationEventListener = (event: SimulationEvent) => void;

/** 模拟事件 */
export interface SimulationEvent {
  type: 'round_start' | 'round_end' | 'post_created' | 'simulation_complete' | 'simulation_error';
  data: {
    round?: number;
    total_rounds?: number;
    posts?: SimulationPost[];
    post?: SimulationPost;
    stats?: TimelineEntry['stats'];
    error?: string;
  };
}

/** 模拟运行实例 */
interface SimulationInstance {
  info: SimulationInfo;
  engine: SimulationEngine;
  posts: SimulationPost[];
  timeline: TimelineEntry[];
  listeners: Set<SimulationEventListener>;
  abortController: AbortController;
}

/**
 * 模拟运行器 - 管理所有模拟实例
 */
class SimulationRunner {
  private simulations: Map<string, SimulationInstance> = new Map();
  private starting: Set<string> = new Set(); // 竞态防护

  /** 创建模拟 */
  create(config: SimulationConfig, profiles: EntityProfile[]): SimulationInfo {
    const now = new Date().toISOString();

    const info: SimulationInfo = {
      simulation_id: config.simulation_id,
      project_id: config.project_id,
      status: 'created',
      config,
      current_round: 0,
      total_posts: 0,
      total_comments: 0,
      total_likes: 0,
      participants: profiles.map(p => p.entity_id),
      agent_profiles: profiles,
      created_at: now,
      updated_at: now,
    };

    const instance: SimulationInstance = {
      info,
      engine: new SimulationEngine(config.temperature),
      posts: [],
      timeline: [],
      listeners: new Set(),
      abortController: new AbortController(),
    };

    this.simulations.set(config.simulation_id, instance);
    return info;
  }

  /** 获取模拟信息 */
  get(simulationId: string): SimulationInfo | null {
    const instance = this.simulations.get(simulationId);
    return instance?.info || null;
  }

  /** 获取模拟帖子 */
  getPosts(simulationId: string, platform?: string, limit?: number): SimulationPost[] {
    const instance = this.simulations.get(simulationId);
    if (!instance) return [];

    let posts = instance.posts;
    if (platform) {
      posts = posts.filter(p => p.platform === platform);
    }
    if (limit) {
      posts = posts.slice(-limit);
    }
    return posts;
  }

  /** 获取时间线 */
  getTimeline(simulationId: string): TimelineEntry[] {
    const instance = this.simulations.get(simulationId);
    return instance?.timeline || [];
  }

  /** 获取 Agent 统计 */
  getAgentStats(simulationId: string): AgentStats[] {
    const instance = this.simulations.get(simulationId);
    if (!instance) return [];

    const statsMap = new Map<string, AgentStats>();

    for (const profile of instance.info.agent_profiles) {
      statsMap.set(profile.entity_id, {
        agent_id: profile.entity_id,
        agent_name: profile.entity_name,
        agent_type: profile.entity_type,
        post_count: 0,
        comment_count: 0,
        like_count: 0,
        repost_count: 0,
        avg_sentiment: 0,
        top_topics: [],
      });
    }

    const sentimentScores: Record<string, number[]> = {};
    const topicCounts: Record<string, Record<string, number>> = {};

    for (const post of instance.posts) {
      const stats = statsMap.get(post.author_id);
      if (!stats) continue;

      switch (post.action) {
        case 'post':
        case 'quote':
          stats.post_count += 1;
          break;
        case 'comment':
        case 'debate':
          stats.comment_count += 1;
          break;
        case 'like':
        case 'upvote':
          stats.like_count += 1;
          break;
        case 'repost':
          stats.repost_count += 1;
          break;
      }

      // 情感统计
      const score = post.sentiment === 'positive' ? 1 : post.sentiment === 'negative' ? -1 : 0;
      if (!sentimentScores[post.author_id]) sentimentScores[post.author_id] = [];
      sentimentScores[post.author_id].push(score);

      // 话题统计
      if (!topicCounts[post.author_id]) topicCounts[post.author_id] = {};
      for (const topic of post.topics) {
        topicCounts[post.author_id][topic] = (topicCounts[post.author_id][topic] || 0) + 1;
      }
    }

    // 计算平均情感和热门话题
    for (const [agentId, stats] of statsMap) {
      const scores = sentimentScores[agentId] || [];
      stats.avg_sentiment = scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0;

      const topics = topicCounts[agentId] || {};
      stats.top_topics = Object.entries(topics)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([topic]) => topic);
    }

    return Array.from(statsMap.values());
  }

  /** 添加事件监听器 */
  addListener(simulationId: string, listener: SimulationEventListener): void {
    const instance = this.simulations.get(simulationId);
    if (instance) {
      instance.listeners.add(listener);
    }
  }

  /** 移除事件监听器 */
  removeListener(simulationId: string, listener: SimulationEventListener): void {
    const instance = this.simulations.get(simulationId);
    if (instance) {
      instance.listeners.delete(listener);
    }
  }

  /** 启动模拟 */
  async start(simulationId: string): Promise<void> {
    // 竞态防护：防止并发启动
    if (this.starting.has(simulationId)) throw new Error('模拟正在启动中');
    this.starting.add(simulationId);

    const instance = this.simulations.get(simulationId);
    if (!instance) {
      this.starting.delete(simulationId);
      throw new Error('模拟不存在');
    }
    if (instance.info.status === 'running') {
      this.starting.delete(simulationId);
      throw new Error('模拟已在运行');
    }

    instance.info.status = 'running';
    instance.info.started_at = new Date().toISOString();
    instance.info.updated_at = new Date().toISOString();
    instance.abortController = new AbortController();

    const { config } = instance.info;

    try {
      for (let round = 1; round <= config.round_count; round++) {
        // 检查是否被中止
        if (instance.abortController.signal.aborted) {
          instance.info.status = 'paused';
          break;
        }

        // 通知轮次开始
        this.emit(instance, {
          type: 'round_start',
          data: { round, total_rounds: config.round_count },
        });

        // 执行一轮模拟
        const roundPosts = await instance.engine.executeRound(
          instance.info.agent_profiles,
          config,
          round,
          instance.posts
        );

        // 保存帖子
        instance.posts.push(...roundPosts);

        // 更新统计
        instance.info.current_round = round;
        instance.info.total_posts = instance.posts.filter(p =>
          ['post', 'quote'].includes(p.action)
        ).length;
        instance.info.total_comments = instance.posts.filter(p =>
          ['comment', 'debate'].includes(p.action)
        ).length;
        instance.info.total_likes = instance.posts.filter(p =>
          ['like', 'upvote'].includes(p.action)
        ).length;
        instance.info.updated_at = new Date().toISOString();

        // 生成时间线条目
        const sentimentDist = this.calculateSentiment(roundPosts);
        const hotTopics = this.calculateHotTopics(roundPosts);

        const timelineEntry: TimelineEntry = {
          round,
          timestamp: new Date().toISOString(),
          posts: roundPosts,
          stats: {
            total_posts: roundPosts.length,
            sentiment_distribution: sentimentDist,
            hot_topics: hotTopics,
            active_agents: new Set(roundPosts.map(p => p.author_id)).size,
          },
        };
        instance.timeline.push(timelineEntry);

        // 通知每个帖子
        for (const post of roundPosts) {
          this.emit(instance, { type: 'post_created', data: { post, round } });
        }

        // 通知轮次结束
        this.emit(instance, {
          type: 'round_end',
          data: {
            round,
            total_rounds: config.round_count,
            posts: roundPosts,
            stats: timelineEntry.stats,
          },
        });

        // 等待间隔
        if (round < config.round_count && config.time_interval > 0) {
          await this.delay(config.time_interval * 1000, instance.abortController.signal);
        }
      }

      // 模拟完成
      if (instance.info.status === 'running') {
        instance.info.status = 'completed';
        instance.info.completed_at = new Date().toISOString();
        instance.info.updated_at = new Date().toISOString();

        this.emit(instance, { type: 'simulation_complete', data: {} });
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        instance.info.status = 'paused';
      } else {
        instance.info.status = 'failed';
        this.emit(instance, {
          type: 'simulation_error',
          data: { error: error instanceof Error ? error.message : '未知错误' },
        });
      }
      instance.info.updated_at = new Date().toISOString();
    } finally {
      this.starting.delete(simulationId);
    }
  }

  /** 停止模拟 */
  stop(simulationId: string): void {
    const instance = this.simulations.get(simulationId);
    if (instance) {
      instance.abortController.abort();
      instance.info.status = 'paused';
      instance.info.updated_at = new Date().toISOString();
    }
  }

  /** 删除模拟 */
  delete(simulationId: string): boolean {
    const instance = this.simulations.get(simulationId);
    if (instance) {
      instance.abortController.abort();
      instance.listeners.clear();
    }
    return this.simulations.delete(simulationId);
  }

  /** 获取所有模拟列表 */
  list(): SimulationInfo[] {
    return Array.from(this.simulations.values())
      .map(i => i.info)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  /** 通知监听器 */
  private emit(instance: SimulationInstance, event: SimulationEvent): void {
    for (const listener of instance.listeners) {
      try {
        listener(event);
      } catch {
        // 忽略监听器错误
      }
    }
  }

  /** 计算情感分布 */
  private calculateSentiment(posts: SimulationPost[]): {
    positive: number;
    neutral: number;
    negative: number;
  } {
    const result = { positive: 0, neutral: 0, negative: 0 };
    for (const post of posts) {
      result[post.sentiment] += 1;
    }
    return result;
  }

  /** 计算热门话题 */
  private calculateHotTopics(posts: SimulationPost[]): string[] {
    const topicCounts: Record<string, number> = {};
    for (const post of posts) {
      for (const topic of post.topics) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }
    return Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic);
  }

  /** 可中止的延迟 */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }
}

let runnerInstance: SimulationRunner | null = null;

export function getSimulationRunner(): SimulationRunner {
  if (!runnerInstance) {
    runnerInstance = new SimulationRunner();
  }
  return runnerInstance;
}
