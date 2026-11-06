import type { EntityProfile, GraphNode, SimulationConfigDraft } from './types';
import type { NativeSimulationPolicy } from './simulation-policy';

/** Old personas used entity names as IDs. Only an unambiguous, one-to-one match is safe to upgrade. */
export function bindPreparedProfilesToGraph(profiles: EntityProfile[], nodes: Pick<GraphNode, 'uuid' | 'name'>[]): EntityProfile[] {
  const ids = new Set(nodes.map(node => node.uuid));
  const names = new Map<string, string[]>();
  for (const node of nodes) names.set(node.name, [...(names.get(node.name) ?? []), node.uuid]);
  const targets = profiles.map(profile => {
    if (ids.has(profile.entity_id)) return profile.entity_id;
    const matches = names.get(profile.entity_name);
    // A stale UUID must not silently bind to a different entity with the same display name.
    return profile.entity_id === profile.entity_name && matches?.length === 1 ? matches[0] : undefined;
  });
  const counts = new Map<string, number>();
  for (const target of targets) if (target) counts.set(target, (counts.get(target) ?? 0) + 1);
  return profiles.map((profile, index) => {
    const target = targets[index];
    return target && target !== profile.entity_id && counts.get(target) === 1 ? { ...profile, entity_id: target } : profile;
  });
}

/** Preserve saved activity settings and seed-event authors when upgrading a legacy persona ID. */
export function bindPreparedProfileConfig<T extends SimulationConfigDraft>(config: T, previous: EntityProfile[], bound: EntityProfile[]): T {
  const aliases = new Map(previous.flatMap((profile, index) => bound[index] && profile.entity_id !== bound[index].entity_id
    ? [[profile.entity_id, bound[index].entity_id] as const] : []));
  const policy = (config as T & { policy?: Partial<NativeSimulationPolicy> }).policy;
  if (!aliases.size || !policy || typeof policy !== 'object' || Array.isArray(policy)) return config;
  let changed = false;
  let agents = policy.agents;
  if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
    const current = agents;
    agents = Object.fromEntries(Object.entries(current).flatMap(([id, value]) => {
      const target = aliases.get(id);
      if (!target) return [[id, value]];
      changed = true;
      return Object.hasOwn(current, target) ? [] : [[target, value]];
    }));
  }
  const events = Array.isArray(policy.events) ? policy.events.map(event => {
    const target = event && aliases.get(event.agent_id);
    if (!target) return event;
    changed = true;
    return { ...event, agent_id: target };
  }) : policy.events;
  return changed ? { ...config, policy: { ...policy, ...(agents ? { agents } : {}), ...(events ? { events } : {}) } } : config;
}
