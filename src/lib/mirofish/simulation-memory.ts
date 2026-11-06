import { getNeo4jClient } from '../neo4j/driver';
import { getNeo4jRuntimeConfig } from '../neo4j/config';
import type { MiroFishRuntimeScope } from './runtime-store';
import type { AgentMemory, SimulationActionEvent } from './simulation-policy';

export interface SimulationMemoryPort {
  project(scope: MiroFishRuntimeScope, simulationId: string, events: SimulationActionEvent[], runId?:string): Promise<number>;
}

export function rememberSimulationAction(memory: Record<string, AgentMemory>, event: SimulationActionEvent): void {
  const current = Object.hasOwn(memory, event.agentId) ? memory[event.agentId] : { observations: [], recentActionIds: [] };
  const outcome = event.success ? event.observation || event.content || event.action : `[${event.errorCode || 'action_failed'}]`;
  memory[event.agentId] = {
    observations: [...current.observations, `[${event.platform} round ${event.round}] ${event.action}: ${outcome}`.slice(0, 4000)].slice(-30),
    recentActionIds: [...current.recentActionIds, event.id].slice(-50),
  };
}

/** Simulation output uses its own labels; it can never become a RAG DocumentVersion/Claim. */
export function createNeo4jSimulationMemoryPort(): SimulationMemoryPort {
  return { async project(scope, simulationId, events, runId='legacy') {
    if (!events.length) return 0;
    const client = getNeo4jClient(getNeo4jRuntimeConfig());
    if (!client) throw new Error('SIMULATION_MEMORY_UNAVAILABLE');
    const facts = events.filter(event => event.success && event.action !== 'do_nothing').map(event => ({
      sequence: event.sequence, eventId: event.id, round: event.round, platform: event.platform,
      agentId: event.agentId,targetId:event.targetId??'', action: event.action, content: event.content.slice(0, 8000),
      observation: (event.observation || '').slice(0, 8000), timestamp: event.timestamp,
    }));
    await client.executeWrite('project isolated MiroFish simulation memory', async tx => {
      await tx.run(`MERGE (run:MiroFishSimulationRun {tenantId: $tenantId, corpusId: $corpusId, simulationId: $simulationId, runId: $runId})
        SET run.lastEventSequence = CASE WHEN coalesce(run.lastEventSequence,0) < $lastSequence THEN $lastSequence ELSE run.lastEventSequence END, run.updatedAt = $updatedAt
        WITH run UNWIND $events AS event
        MERGE (fact:MiroFishSimulationFact {tenantId: $tenantId, corpusId: $corpusId, simulationId: $simulationId, runId: $runId, eventSequence: event.sequence})
        SET fact.eventId=event.eventId, fact.round=event.round, fact.platform=event.platform, fact.agentId=event.agentId,fact.targetId=event.targetId,
            fact.action=event.action, fact.content=event.content, fact.observation=event.observation, fact.timestamp=event.timestamp,
            fact.provenance='simulation', fact.canonical=false
        MERGE (run)-[:HAS_SIMULATION_FACT]->(fact)`,
      { ...scope, simulationId, runId, events: facts, lastSequence: events.at(-1)!.sequence, updatedAt: new Date().toISOString() });
    });
    return events.at(-1)!.sequence;
  } };
}
