import { getRoundPostLimit } from './config-normalizer';
import type {
  AgentStats,
  NormalizedSimulationConfig,
  SimulationPost,
  SimulationSnapshot,
  SimulationSnapshotSummary,
  TimelineEntry,
} from './types';

export interface RoundContext {
  recentPosts: SimulationPost[];
  hotTopics: string[];
  sentimentDistribution: TimelineEntry['stats']['sentiment_distribution'];
  agentActionCounts: Record<string, number>;
}

export function buildRoundContext(
  existingPosts: SimulationPost[],
  roundPosts: SimulationPost[] = [],
  options: { maxRecentPosts?: number } = {}
): RoundContext {
  const maxRecentPosts = options.maxRecentPosts ?? 20;
  const posts = [...existingPosts, ...roundPosts];
  const recentPosts = posts.slice(-maxRecentPosts);
  const topicCounts: Record<string, number> = {};
  const agentActionCounts: Record<string, number> = {};
  const sentimentDistribution = { positive: 0, neutral: 0, negative: 0 };

  for (const post of posts) {
    sentimentDistribution[post.sentiment] += 1;
    agentActionCounts[post.author_id] = (agentActionCounts[post.author_id] || 0) + 1;

    for (const topic of post.topics) {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }
  }

  return {
    recentPosts,
    hotTopics: Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic),
    sentimentDistribution,
    agentActionCounts,
  };
}

export function selectPostingAgents<T>(
  activeAgents: T[],
  config: Pick<NormalizedSimulationConfig, 'posts_per_round'>
): T[] {
  return activeAgents.slice(0, getRoundPostLimit(config, activeAgents.length));
}

export function summarizeSimulationSnapshot(snapshot: SimulationSnapshot): SimulationSnapshotSummary {
  const latestTimeline = snapshot.timeline.at(-1);

  return {
    total_posts: snapshot.posts.length,
    timeline_count: snapshot.timeline.length,
    agent_count: snapshot.info.agent_profiles.length,
    latest_round: latestTimeline?.round,
    latest_stats: latestTimeline?.stats,
  };
}

export function summarizeAgentStats(stats: AgentStats[]): Record<string, number> {
  return Object.fromEntries(stats.map(item => [
    item.agent_id,
    item.post_count + item.comment_count + item.like_count + item.repost_count,
  ]));
}
