import type {
  NormalizedSimulationConfig,
  PlatformType,
  SimulationConfig,
  SimulationConfigDraft,
} from './types';

const VALID_PLATFORMS = new Set<PlatformType>(['twitter', 'reddit']);

export const SIMULATION_CONFIG_LIMITS = {
  MIN_ROUNDS: 1,
  MAX_ROUNDS: 30,
  MIN_POSTS_PER_ROUND: 1,
  MAX_POSTS_PER_ROUND: 50,
  MIN_AGENTS_PER_ROUND: 1,
  MAX_AGENTS_PER_ROUND: 20,
  MAX_SEED_TOPICS: 20,
  MIN_TEMPERATURE: 0,
  MAX_TEMPERATURE: 2,
  MIN_TIME_INTERVAL: 0,
  MAX_TIME_INTERVAL: 60,
} as const;

export interface NormalizeSimulationConfigOptions {
  profileCount: number;
  defaults?: Partial<NormalizedSimulationConfig>;
}

export interface BuildSimulationConfigOptions extends NormalizeSimulationConfigOptions {
  projectId: string;
  simulationId: string;
}

export function normalizeSimulationConfig(
  draft: SimulationConfigDraft | NormalizedSimulationConfig | undefined,
  options: NormalizeSimulationConfigOptions
): NormalizedSimulationConfig {
  const defaults = options.defaults ?? {};
  const safeProfileCount = Math.max(0, Math.floor(options.profileCount));

  const platforms = normalizePlatforms(draft?.platforms, defaults.platforms);
  const seedTopics = normalizeSeedTopics(draft?.seed_topics, defaults.seed_topics);

  return {
    platforms,
    round_count: clampInteger(
      draft?.round_count ?? defaults.round_count ?? 10,
      SIMULATION_CONFIG_LIMITS.MIN_ROUNDS,
      SIMULATION_CONFIG_LIMITS.MAX_ROUNDS
    ),
    posts_per_round: clampInteger(
      draft?.posts_per_round ?? defaults.posts_per_round ?? 5,
      SIMULATION_CONFIG_LIMITS.MIN_POSTS_PER_ROUND,
      SIMULATION_CONFIG_LIMITS.MAX_POSTS_PER_ROUND
    ),
    agents_per_round: clampInteger(
      draft?.agents_per_round ?? defaults.agents_per_round ?? 5,
      SIMULATION_CONFIG_LIMITS.MIN_AGENTS_PER_ROUND,
      Math.max(SIMULATION_CONFIG_LIMITS.MIN_AGENTS_PER_ROUND, Math.min(SIMULATION_CONFIG_LIMITS.MAX_AGENTS_PER_ROUND, safeProfileCount || 1))
    ),
    temperature: clampNumber(
      draft?.temperature ?? defaults.temperature ?? 0.8,
      SIMULATION_CONFIG_LIMITS.MIN_TEMPERATURE,
      SIMULATION_CONFIG_LIMITS.MAX_TEMPERATURE
    ),
    seed_topics: seedTopics,
    time_interval: clampInteger(
      draft?.time_interval ?? defaults.time_interval ?? 2,
      SIMULATION_CONFIG_LIMITS.MIN_TIME_INTERVAL,
      SIMULATION_CONFIG_LIMITS.MAX_TIME_INTERVAL
    ),
  };
}

export function buildSimulationConfig(
  draft: SimulationConfigDraft | NormalizedSimulationConfig | undefined,
  options: BuildSimulationConfigOptions
): SimulationConfig {
  return {
    ...normalizeSimulationConfig(draft, options),
    project_id: options.projectId,
    simulation_id: options.simulationId,
  };
}

export function getRoundPostLimit(
  config: Pick<NormalizedSimulationConfig, 'posts_per_round'>,
  activeAgentCount: number
): number {
  return Math.min(
    Math.max(0, Math.floor(activeAgentCount)),
    clampInteger(
      config.posts_per_round,
      SIMULATION_CONFIG_LIMITS.MIN_POSTS_PER_ROUND,
      SIMULATION_CONFIG_LIMITS.MAX_POSTS_PER_ROUND
    )
  );
}

function normalizePlatforms(input?: PlatformType[], defaults?: PlatformType[]): PlatformType[] {
  const source = input?.length ? input : defaults;
  const platforms = (source ?? ['twitter'])
    .filter((platform): platform is PlatformType => VALID_PLATFORMS.has(platform));

  return Array.from(new Set(platforms)).length > 0
    ? Array.from(new Set(platforms))
    : ['twitter'];
}

function normalizeSeedTopics(input?: string[], defaults?: string[]): string[] {
  const source = input?.length ? input : defaults;
  const topics = (source ?? [])
    .map(topic => topic.trim())
    .filter(Boolean);

  const uniqueTopics = Array.from(new Set(topics)).slice(0, SIMULATION_CONFIG_LIMITS.MAX_SEED_TOPICS);
  return uniqueTopics.length > 0 ? uniqueTopics : ['当前话题'];
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
