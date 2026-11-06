import type { EntityProfile, ModelOverride, NormalizedSimulationConfig, PlatformType, SimulationConfig, SimulationConfigDraft, SimulationPost, SimulationSnapshot } from './types';
import type {MiroFishSeedFileInfo} from './seed-file-contract';

export interface AgentActivityPolicy { active_hours: number[]; activity_level: number; influence_weight: number; posts_per_hour: number; comments_per_hour: number }
export interface PlatformPolicy { recency: number; popularity: number; relevance: number; echo_chamber: number; viral_threshold: number }
export interface SimulationSeedEvent { id: string; round: number; platform?: PlatformType; agent_id: string; content: string; topics: string[] }
export interface NativeSimulationPolicy {
  start_hour: number; minutes_per_round: number; peak_hours: number[]; off_peak_hours: number[];
  peak_multiplier: number; off_peak_multiplier: number;
  agents: Record<string, AgentActivityPolicy>; platform: Record<PlatformType, PlatformPolicy>;
  events: SimulationSeedEvent[]; memory_enabled: boolean; graph_memory_enabled: boolean; generation_reasoning: string;
}
export type NativeSimulationConfigDraft = SimulationConfigDraft & { policy?: Partial<NativeSimulationPolicy> };
export type NativeNormalizedSimulationConfig = NormalizedSimulationConfig & { policy: NativeSimulationPolicy };
export type NativeSimulationConfig = SimulationConfig & { policy: NativeSimulationPolicy };
export interface PlatformState { follows: Record<string, string[]>; mutes: Record<string, string[]>; votes: Record<string, number> }
export interface AgentMemory { observations: string[]; recentActionIds: string[] }
export type NativeSimulationPost = SimulationPost & { degraded?: boolean; success?: boolean; errorCode?: string; observation?: string; score?: number };
export interface SimulationActionEvent { id: string; sequence: number; round: number; simulatedMinute: number; platform: PlatformType; agentId: string; action: string; targetId?: string; content: string; timestamp: string; success: boolean; errorCode?: string; observation?: string }
export interface NativeSimulationSnapshot extends SimulationSnapshot {
  schemaVersion: 1; engine: 'local-native'; recoverable?: boolean;
  scenario?:{requirement:string;seedFiles?:MiroFishSeedFileInfo[]};
  modelSelection?: Pick<ModelOverride, 'provider' | 'modelName' | 'temperature'>;
  sourceGraphIdentity?: { documentId: string; documentVersion: string; trustLevel: string; graphGeneration?: string };
  actions: SimulationActionEvent[]; memory: Record<string, AgentMemory>;
  platformState: Record<PlatformType, PlatformState>;
  projection: { enabled: boolean; runId?: string; committedEventSequence: number; projectedEventSequence: number; status: 'idle' | 'pending' | 'complete' | 'failed'; errorCode?: string };
}
export const PLATFORM_ACTIONS: Record<PlatformType, readonly string[]> = {
  twitter: ['post', 'like', 'repost', 'quote', 'follow', 'do_nothing'],
  reddit: ['post', 'comment', 'like', 'upvote', 'downvote', 'like_comment', 'dislike_comment', 'follow', 'mute', 'search_posts', 'search_user', 'trend', 'refresh', 'do_nothing', 'debate'],
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const hours = (value: unknown, fallback: number[]) => Array.isArray(value) && value.every(item => Number.isInteger(item) && item >= 0 && item < 24) ? [...new Set(value)].slice(0, 24) as number[] : fallback;

export function normalizeSimulationPolicy(input: unknown = {}): NativeSimulationPolicy {
  const raw = record(input); const platforms = record(raw.platform);
  const platform = Object.fromEntries((['twitter', 'reddit'] as const).map(name => {
    const p = record(platforms[name]);
    return [name, { recency: bounded(p.recency, .4, 0, 1), popularity: bounded(p.popularity, .3, 0, 1), relevance: bounded(p.relevance, .3, 0, 1), echo_chamber: bounded(p.echo_chamber, .2, 0, 1), viral_threshold: bounded(p.viral_threshold, 10, 1, 10000) }];
  })) as Record<PlatformType, PlatformPolicy>;
  const agents = Object.fromEntries(Object.entries(record(raw.agents)).slice(0, 50).map(([id, value]) => {
    const agent = record(value);
    return [id, { active_hours: hours(agent.active_hours, Array.from({ length: 24 }, (_, hour) => hour)), activity_level: bounded(agent.activity_level, 1, 0, 1), influence_weight: bounded(agent.influence_weight, 1, .1, 5), posts_per_hour: bounded(agent.posts_per_hour, 1, 0, 20), comments_per_hour: bounded(agent.comments_per_hour, 2, 0, 50) }];
  }));
  const events = (Array.isArray(raw.events) ? raw.events : []).slice(0, 50).map((value, index):SimulationSeedEvent => {
    const event = record(value);
    return { id: typeof event.id === 'string' ? event.id.slice(0, 128) : `event_${index}`, round: Math.floor(bounded(event.round, 0, 0, 30)),
      platform: event.platform === 'twitter' || event.platform === 'reddit' ? event.platform : undefined,
      agent_id: typeof event.agent_id === 'string' ? event.agent_id.slice(0, 256) : '', content: typeof event.content === 'string' ? event.content.slice(0, 5000) : '',
      topics: Array.isArray(event.topics) ? event.topics.filter((topic): topic is string => typeof topic === 'string').slice(0, 20) : [] };
  }).filter(event => event.agent_id && event.content);
  return { start_hour: Math.floor(bounded(raw.start_hour, 8, 0, 23)), minutes_per_round: Math.floor(bounded(raw.minutes_per_round, 60, 1, 1440)),
    peak_hours: hours(raw.peak_hours, [19,20,21,22]), off_peak_hours: hours(raw.off_peak_hours, [0,1,2,3,4,5]),
    peak_multiplier: bounded(raw.peak_multiplier, 1.5, 0, 3), off_peak_multiplier: bounded(raw.off_peak_multiplier, .2, 0, 1),
    agents, platform, events, memory_enabled: raw.memory_enabled !== false, graph_memory_enabled: raw.graph_memory_enabled === true,
    generation_reasoning: typeof raw.generation_reasoning === 'string' ? raw.generation_reasoning.slice(0, 4000) : '' };
}

export function createPlatformState(): PlatformState { return { follows: Object.create(null), mutes: Object.create(null), votes: Object.create(null) }; }
function listFor(map: Record<string, string[]>, id: string): string[] { return Object.hasOwn(map, id) && Array.isArray(map[id]) ? map[id] : []; }

export function selectScheduledAgents(profiles: EntityProfile[], policy: NativeSimulationPolicy, hour: number, limit: number, random = Math.random): EntityProfile[] {
  const multiplier = policy.peak_hours.includes(hour) ? policy.peak_multiplier : policy.off_peak_hours.includes(hour) ? policy.off_peak_multiplier : 1;
  return profiles.map(profile => {
    const cfg = Object.hasOwn(policy.agents, profile.entity_id) ? policy.agents[profile.entity_id] : undefined;
    const activeHours = cfg?.active_hours ?? profile.behavioral_anchors?.active_hours;
    const allowed = !activeHours || activeHours.includes(hour);
    const frequency = cfg ? Math.min(1,(cfg.posts_per_hour + cfg.comments_per_hour) * policy.minutes_per_round / 60) : 1;
    return { profile, active: allowed && random() < Math.min(1, (cfg?.activity_level ?? 1) * multiplier * frequency), weight: random() * (cfg?.influence_weight ?? profile.behavioral_anchors?.influence_weight ?? 1) };
  }).filter(item => item.active).sort((a,b) => b.weight - a.weight).slice(0, limit).map(item => item.profile);
}

export function rankSimulationFeed(posts: SimulationPost[], platform: PlatformType, profile: Pick<EntityProfile, 'entity_id' | 'viewpoints'>, policy: NativeSimulationPolicy, state: PlatformState): SimulationPost[] {
  const muted = new Set(listFor(state.mutes, profile.entity_id)); const followed = new Set(listFor(state.follows, profile.entity_id));
  const candidates = posts.filter(post => post.platform === platform && !muted.has(post.author_id) && ['post','comment','quote','debate'].includes(post.action));
  const latest = Math.max(1, ...candidates.map(post => Date.parse(post.timestamp) || 0)); const weights = policy.platform[platform];
  const topics = new Set(Object.keys(profile.viewpoints ?? {}).map(topic => topic.toLowerCase()));
  const score = (post: SimulationPost) => {
    const recency = 1 / (1 + Math.max(0, latest - Date.parse(post.timestamp)) / 3600000);
    const popularity = Math.min(1, (post.likes + post.reposts + post.replies_count) / weights.viral_threshold);
    const relevance = post.topics.some(topic => topics.has(topic.toLowerCase())) ? 1 : 0;
    return weights.recency * recency + weights.popularity * popularity + weights.relevance * relevance + (followed.has(post.author_id) ? weights.echo_chamber : 0);
  };
  return candidates.map((post,index) => ({ post,index,score:score(post) })).sort((a,b) => b.score-a.score || a.index-b.index).slice(0, 20).map(item => item.post);
}

/** Pure post reduction plus explicit social state: old posts are never mutated in place. */
export function applySimulationAction(existing: SimulationPost[], action: NativeSimulationPost, state: PlatformState, agentIds: string[] = [],profiles:Array<Pick<EntityProfile,'entity_id'|'entity_name'|'full_name'>>=[]): { posts: SimulationPost[]; success: boolean; errorCode?: string; observation?: string } {
  const reject = (errorCode: string) => ({ posts: existing, success: false, errorCode });
  if (!PLATFORM_ACTIONS[action.platform].includes(action.action)) return reject('SIMULATION_ACTION_UNAVAILABLE');
  const target = existing.find(post => post.id === action.target_id && post.platform === action.platform);
  if (['follow','mute'].includes(action.action)) {
    if (!action.target_id || !agentIds.includes(action.target_id) || action.target_id === action.author_id) return reject('SIMULATION_TARGET_NOT_FOUND');
    const map = action.action === 'follow' ? state.follows : state.mutes;
    Object.defineProperty(map,action.author_id,{value:[...new Set([...listFor(map, action.author_id), action.target_id])],enumerable:true,writable:true,configurable:true});
    return { posts: existing, success: true };
  }
  if (['do_nothing','refresh','search_posts','search_user','trend'].includes(action.action)) {
    const query = action.content.toLowerCase().trim();
    const people=profiles.length?profiles:agentIds.map(id=>({entity_id:id,entity_name:id,full_name:id}));
    const observation = action.action === 'search_user' ? people.filter(profile=>`${profile.entity_id} ${profile.entity_name} ${profile.full_name}`.toLowerCase().includes(query)).slice(0,10).map(profile=>`[${profile.entity_id}] ${profile.entity_name}`).join('\n')
      : action.action === 'trend' ? [...new Set(existing.filter(post => post.platform === action.platform).flatMap(post => post.topics))].slice(0,10).join(', ')
      : existing.filter(post => post.platform === action.platform && (!query || post.content.toLowerCase().includes(query))).slice(-10).map(post => `[${post.id}] ${post.content}`).join('\n');
    return { posts: existing, success: true, observation: observation.slice(0,8000) };
  }
  if (action.action !== 'post' && !target) return reject('SIMULATION_TARGET_NOT_FOUND');
  const posts = existing.map(post => ({ ...post })); const updated = target ? posts.find(post => post.id === target.id)! as NativeSimulationPost : undefined;
  if (['post','comment','debate','quote'].includes(action.action)) {
    if (!action.content.trim()) return reject('SIMULATION_CONTENT_REQUIRED');
    if (updated && ['comment','debate'].includes(action.action)) updated.replies_count++;
    if (updated && action.action === 'quote') updated.reposts++;
    posts.push(action); return { posts, success: true };
  }
  if (action.action === 'repost') { if (updated) updated.reposts++; return { posts, success: true }; }
  if (['like_comment','dislike_comment'].includes(action.action) && !['comment','debate'].includes(target!.action)) return reject('SIMULATION_TARGET_NOT_COMMENT');
  const key = JSON.stringify([action.author_id, action.target_id]);
  const previous = Object.hasOwn(state.votes, key) ? state.votes[key] : 0;
  const next = ['downvote','dislike_comment'].includes(action.action) ? -1 : 1;
  state.votes[key] = next;
  if (updated) { updated.likes = Math.max(0, updated.likes + (next > 0 ? 1 : 0) - (previous > 0 ? 1 : 0)); updated.score = (updated.score ?? 0) + next - previous; }
  return { posts, success: true };
}
