import { randomUUID } from 'node:crypto';
import { SimulationEngine } from './simulation-engine';
import { buildSimulationConfig } from './config-normalizer';
import { getMiroFishRuntimeStore, type MiroFishRuntimeScope, type MiroFishRuntimeStore } from './runtime-store';
import { getPostgresRuntimeConfig,shouldUsePostgresPersistence } from '../postgres/env';
import { summarizeSimulationSnapshot } from './simulation-context';
import { validatePersistedModelOverride } from './model-override';
import { createNeo4jSimulationMemoryPort, rememberSimulationAction, type SimulationMemoryPort } from './simulation-memory';
import { applySimulationAction, createPlatformState, type NativeSimulationConfig, type NativeSimulationPost, type NativeSimulationSnapshot, type SimulationActionEvent } from './simulation-policy';
import type { AgentStats, EntityProfile, ModelOverride, ProjectGraphIdentity, SimulationConfig, SimulationInfo, SimulationPost, SimulationSnapshotSummary, TimelineEntry } from './types';

export interface SimulationEvent {
  type: 'round_start' | 'round_end' | 'post_created' | 'simulation_complete' | 'simulation_error' | 'state_changed' | 'action_executed';
  data: { round?: number; total_rounds?: number; posts?: SimulationPost[]; post?: SimulationPost; stats?: TimelineEntry['stats']; snapshot?: SimulationSnapshotSummary; error?: string; status?: SimulationInfo['status']; action?: SimulationActionEvent };
}
type Listener = (event: SimulationEvent) => void;
type Engine = Pick<SimulationEngine, 'executeRound'>;
interface Instance {
  data: NativeSimulationSnapshot; engine: Engine; listeners: Set<Listener>; controller: AbortController;
  saveQueue: Promise<void>; projectionQueue: Promise<void>; stopMode?: 'pause' | 'stop';
}
export interface SimulationRunnerDependencies {
  store?: MiroFishRuntimeStore; scope?: MiroFishRuntimeScope;
  createEngine?: (temperature: number, selector?: ModelOverride) => Engine;
  memoryPort?: SimulationMemoryPort;
  validateSource?: (snapshot:NativeSimulationSnapshot,scope:MiroFishRuntimeScope)=>Promise<boolean>;
}

/** A process owns execution. Persisted blobs are snapshots, never distributed leases. */
export class SimulationRunner {
  private simulations = new Map<string, Instance>();
  private running = new Map<string, Promise<void>>();
  private starting = new Set<string>();
  private loading = new Map<string, Promise<boolean>>();
  private store: MiroFishRuntimeStore;
  private scope: MiroFishRuntimeScope;
  private createEngine: NonNullable<SimulationRunnerDependencies['createEngine']>;
  private memoryPort: SimulationMemoryPort;
  private validateSource:NonNullable<SimulationRunnerDependencies['validateSource']>;
  constructor(dependencies: SimulationRunnerDependencies = {}) {
    this.scope = dependencies.scope ?? defaultSimulationScope();
    this.store = dependencies.store ?? getMiroFishRuntimeStore(this.scope);
    this.createEngine = dependencies.createEngine ?? ((temperature, selector) => new SimulationEngine(temperature, selector));
    this.memoryPort = dependencies.memoryPort ?? createNeo4jSimulationMemoryPort();
    this.validateSource=dependencies.validateSource??isSimulationSnapshotSourceAuthorized;
  }
  async create(config: SimulationConfig, profiles: EntityProfile[], modelOverride?: ModelOverride, sourceGraphIdentity?: NativeSimulationSnapshot['sourceGraphIdentity'],scenario?:NativeSimulationSnapshot['scenario']): Promise<SimulationInfo> {
    if (!profiles.length || profiles.length > 50 || new Set(profiles.map(profile => profile.entity_id)).size !== profiles.length) throw new Error('SIMULATION_INVALID_PROFILES');
    if (this.simulations.has(config.simulation_id) || await this.store.read('simulation', config.simulation_id)) throw new Error('SIMULATION_ALREADY_EXISTS');
    profiles=sanitizeProfiles(profiles);
    const normalized = buildSimulationConfig(config, { profileCount: profiles.length, projectId: config.project_id, simulationId: config.simulation_id });
    const now = new Date().toISOString();
    const selector = modelOverride ? { provider: modelOverride.provider, modelName: modelOverride.modelName, ...(modelOverride.temperature === undefined ? {} : { temperature: modelOverride.temperature }) } : undefined;
    const data: NativeSimulationSnapshot = {
      schemaVersion: 1, engine: 'local-native', info: { simulation_id: config.simulation_id, project_id: config.project_id, status: 'ready', config: normalized,
        current_round: 0, total_posts: 0, total_comments: 0, total_likes: 0, participants: profiles.map(profile => profile.entity_id), agent_profiles: structuredClone(profiles), created_at: now, updated_at: now },
      posts: [], timeline: [], stats: [], actions: [], memory: Object.create(null), platformState: { twitter: createPlatformState(), reddit: createPlatformState() },
      projection: { enabled: normalized.policy.graph_memory_enabled,runId:randomUUID(), committedEventSequence: 0, projectedEventSequence: 0, status: normalized.policy.graph_memory_enabled ? 'pending' : 'idle' },
      ...(selector ? { modelSelection: selector } : {}), ...(sourceGraphIdentity ? { sourceGraphIdentity: structuredClone(sourceGraphIdentity) } : {}),
      ...(scenario?{scenario:structuredClone(scenario)}:{}),
    };
    const instance = this.instance(data, modelOverride); this.simulations.set(config.simulation_id, instance);
    try { await this.persist(instance); } catch (error) { this.simulations.delete(config.simulation_id); throw error; }
    return this.get(config.simulation_id)!;
  }
  async ensureLoaded(id: string): Promise<boolean> {
    if (this.simulations.has(id)) return true;
    if (this.loading.has(id)) return this.loading.get(id)!;
    const work = (async () => {
      const data = await this.store.read<NativeSimulationSnapshot>('simulation', id);
      if (!data) return false;
      if (data.schemaVersion !== 1 || data.info.simulation_id !== id || !Array.isArray(data.posts) || !Array.isArray(data.actions)) throw new Error('SIMULATION_SNAPSHOT_INVALID');
      data.info.config = buildSimulationConfig(data.info.config, { projectId: data.info.project_id, simulationId: id, profileCount: data.info.agent_profiles.length });
      if (['running','stopping','finalizing'].includes(data.info.status)) { data.info.status = 'paused'; data.recoverable = true; }
      data.info.agent_profiles=sanitizeProfiles(data.info.agent_profiles);
      data.modelSelection=validatePersistedModelOverride(data.modelSelection)??undefined;
      const instance = this.instance(data, data.modelSelection); this.simulations.set(id, instance);
      if (data.recoverable) await this.persist(instance);
      return true;
    })();
    this.loading.set(id, work);
    try { return await work; } finally { this.loading.delete(id); }
  }
  private instance(data: NativeSimulationSnapshot, selector?: ModelOverride): Instance {
    return { data, engine: this.createEngine(data.info.config.temperature, selector), listeners: new Set(), controller: new AbortController(), saveQueue: Promise.resolve(), projectionQueue: Promise.resolve() };
  }
  get(id: string): SimulationInfo | null { const info = this.simulations.get(id)?.data.info; return info ? structuredClone(info) : null; }
  getPosts(id: string, platform?: string, limit?: number): SimulationPost[] {
    let posts = this.simulations.get(id)?.data.posts ?? []; if (platform) posts = posts.filter(post => post.platform === platform);
    return structuredClone(limit ? posts.slice(-Math.max(1,Math.min(10000,limit))) : posts);
  }
  getTimeline(id: string): TimelineEntry[] { return structuredClone(this.simulations.get(id)?.data.timeline ?? []); }
  getSnapshot(id: string): NativeSimulationSnapshot | null { const data = this.simulations.get(id)?.data; return data ? structuredClone({ ...data, stats: this.getAgentStats(id) }) : null; }
  getSnapshotSummary(id: string): SimulationSnapshotSummary | null { const snapshot = this.getSnapshot(id); return snapshot ? summarizeSimulationSnapshot(snapshot) : null; }
  getActions(id: string, filter: { platform?: string; agentId?: string; round?: number; offset?: number; limit?: number } = {}): SimulationActionEvent[] {
    const actions = (this.simulations.get(id)?.data.actions ?? []).filter(event => (!filter.platform || event.platform === filter.platform)
      && (!filter.agentId || event.agentId === filter.agentId) && (filter.round === undefined || event.round === filter.round));
    return structuredClone(actions.slice(Math.max(0,filter.offset ?? 0), Math.max(0,filter.offset ?? 0) + Math.min(10000,Math.max(1,filter.limit ?? 100))));
  }
  getAgentStats(id: string): AgentStats[] {
    const data = this.simulations.get(id)?.data; if (!data) return [];
    return data.info.agent_profiles.map(profile => {
      const events = data.actions.filter(event => event.agentId === profile.entity_id && event.success);
      const posts = data.posts.filter(post => post.author_id === profile.entity_id);
      return { agent_id: profile.entity_id, agent_name: profile.entity_name, agent_type: profile.entity_type,
        post_count: events.filter(event => ['post','quote'].includes(event.action)).length,
        comment_count: events.filter(event => ['comment','debate'].includes(event.action)).length,
        like_count: events.filter(event => ['like','upvote','like_comment'].includes(event.action)).length,
        repost_count: events.filter(event => event.action === 'repost').length,
        avg_sentiment: posts.length ? posts.reduce((sum,post) => sum + (post.sentiment === 'positive' ? 1 : post.sentiment === 'negative' ? -1 : 0),0) / posts.length : 0,
        top_topics: [...new Set(posts.flatMap(post => post.topics))].slice(0,5) };
    });
  }
  addListener(id: string, listener: Listener): void { this.simulations.get(id)?.listeners.add(listener); }
  removeListener(id: string, listener: Listener): void { this.simulations.get(id)?.listeners.delete(listener); }
  list(): SimulationInfo[] { return [...this.simulations.values()].map(instance => structuredClone(instance.data.info)); }
  async listPersisted(projectId?: string): Promise<NativeSimulationSnapshot[]> { return this.store.list('simulation', { projectId, limit: 200 }); }
  async launch(id: string, mode: 'resume' | 'restart' = 'resume'): Promise<SimulationInfo> {
    if (/^(true|1)$/i.test(process.env.RAG_MIROFISH_SIMULATION_MULTI_INSTANCE || '')) throw new Error('SIMULATION_MULTI_INSTANCE_UNSUPPORTED');
    if (!await this.ensureLoaded(id)) throw new Error('SIMULATION_NOT_FOUND');
    if (this.starting.has(id) || this.running.has(id)) throw new Error('SIMULATION_ALREADY_RUNNING');
    const instance = this.simulations.get(id)!;
    if(!await this.validateSource(instance.data,this.scope))throw new Error('SIMULATION_SOURCE_UNAVAILABLE');
    if (['completed','stopped'].includes(instance.data.info.status) && mode !== 'restart') throw new Error('SIMULATION_RESTART_REQUIRED');
    this.starting.add(id);
    try {
      if (mode === 'restart') {
        instance.data.posts = []; instance.data.actions = []; instance.data.timeline = []; instance.data.memory = Object.create(null);
        instance.data.platformState = { twitter: createPlatformState(), reddit: createPlatformState() }; instance.data.info.current_round = 0;
        instance.data.projection.committedEventSequence = 0; instance.data.projection.projectedEventSequence = 0;
        instance.data.projection.runId=randomUUID();
      }
      instance.stopMode = undefined; instance.controller = new AbortController(); instance.data.recoverable = false;
      instance.data.info.status = 'running'; instance.data.info.started_at ??= new Date().toISOString();
      instance.data.info.completed_at = undefined; instance.data.projection.errorCode = undefined;
      instance.data.projection.status = instance.data.projection.enabled ? 'pending' : 'idle';
      await this.persist(instance);
      this.scheduleProjection(instance);
      const work = this.execute(instance).finally(() => this.running.delete(id)); this.running.set(id,work);
      // A detached worker must not create an unhandled rejection when storage fails.
      void work.catch(()=>{instance.data.info.status='failed';this.emit(instance,{type:'simulation_error',data:{error:'SIMULATION_PERSISTENCE_FAILED'}});});
      return this.get(id)!;
    } finally { this.starting.delete(id); }
  }
  async start(id: string, mode: 'resume' | 'restart' = 'resume'): Promise<void> { await this.launch(id,mode); await this.running.get(id); }
  private async execute(instance: Instance): Promise<void> {
    const { data } = instance; const id = data.info.simulation_id; const config = data.info.config as NativeSimulationConfig;
    try {
      if (!data.actions.length) await this.injectEvents(instance, 0);
      for (let round = data.info.current_round + 1; round <= config.round_count; round++) {
        if(!await this.validateSource(data,this.scope))throw new Error('SIMULATION_SOURCE_UNAVAILABLE');
        instance.controller.signal.throwIfAborted(); this.emit(instance,{ type:'round_start', data:{ round,total_rounds:config.round_count } });
        await this.injectEvents(instance,round);
        const actions = await instance.engine.executeRound(data.info.agent_profiles, config, round, data.posts,
          { signal: instance.controller.signal, memory: data.memory, platformState: data.platformState });
        instance.controller.signal.throwIfAborted();
        if(!await this.validateSource(data,this.scope))throw new Error('SIMULATION_SOURCE_UNAVAILABLE');
        for (const action of actions) this.acceptAction(instance,action);
        if (actions.length && actions.every(action => action.degraded)){await this.persist(instance);this.scheduleProjection(instance);throw new Error('SIMULATION_MODEL_UNAVAILABLE');}
        data.info.current_round = round;
        const roundPosts = data.posts.filter(post => post.round === round); const stats = this.roundStats(roundPosts);
        data.timeline.push({ round,timestamp:new Date().toISOString(),posts:structuredClone(roundPosts),stats });
        await this.persist(instance); this.scheduleProjection(instance);
        this.emit(instance,{ type:'round_end',data:{ round,total_rounds:config.round_count,posts:roundPosts,stats } });
        if (round < config.round_count && config.time_interval > 0) await this.delay(config.time_interval * 1000, instance.controller.signal);
      }
      data.info.status = 'finalizing'; await this.persist(instance); await instance.projectionQueue;
      instance.controller.signal.throwIfAborted();
      if (data.projection.status === 'failed') throw new Error(data.projection.errorCode || 'SIMULATION_MEMORY_FAILED');
      if (data.projection.enabled && data.projection.projectedEventSequence !== data.actions.length) throw new Error('SIMULATION_MEMORY_INCOMPLETE');
      data.projection.status = data.projection.enabled ? 'complete' : 'idle'; data.info.status = 'completed'; data.info.completed_at = new Date().toISOString();
      await this.persist(instance); this.emit(instance,{ type:'simulation_complete',data:{snapshot:this.getSnapshotSummary(id) ?? undefined} });
    } catch (error) {
      if (instance.controller.signal.aborted) { await instance.projectionQueue;this.finishProjection(instance);data.info.status = data.projection.status === 'failed' ? 'failed' : instance.stopMode === 'stop' ? 'stopped' : 'paused'; }
      else { data.info.status = 'failed'; this.emit(instance,{type:'simulation_error',data:{error:error instanceof Error && /^SIMULATION_[A-Z_]+$/.test(error.message) ? error.message : 'SIMULATION_EXECUTION_FAILED'}}); }
      await this.persist(instance); this.emit(instance,{type:'state_changed',data:{status:data.info.status}});
    }
  }
  private async injectEvents(instance: Instance, round: number): Promise<void> {
    const config = instance.data.info.config as NativeSimulationConfig;
    for (const event of config.policy.events.filter(event => event.round === round)) {
      const profile = instance.data.info.agent_profiles.find(profile => profile.entity_id === event.agent_id); if (!profile) throw new Error('SIMULATION_EVENT_AGENT_NOT_FOUND');
      for (const platform of event.platform ? [event.platform] : config.platforms) {
        if (!config.platforms.includes(platform)) continue;
        const id = `seed_${event.id}_${platform}`; if (instance.data.actions.some(action => action.id === id)) continue;
        this.acceptAction(instance,{ id,simulation_id:instance.data.info.simulation_id,platform,round,author_id:profile.entity_id,author_name:profile.entity_name,author_type:profile.entity_type,
          action:'post',content:platform === 'twitter' ? event.content.slice(0,280) : event.content,likes:0,replies_count:0,reposts:0,sentiment:'neutral',topics:event.topics,timestamp:new Date().toISOString() });
      }
    }
    if (round === 0 && instance.data.actions.length) { await this.persist(instance); this.scheduleProjection(instance); }
  }
  private acceptAction(instance: Instance, action: NativeSimulationPost): void {
    const data = instance.data; const reduced = action.degraded ? { posts:data.posts,success:false,errorCode:action.errorCode || 'SIMULATION_MODEL_FALLBACK' }
      : applySimulationAction(data.posts,action,data.platformState[action.platform],data.info.participants,data.info.agent_profiles);
    data.posts = reduced.posts;
    const event: SimulationActionEvent = { id:action.id || `action_${randomUUID()}`,sequence:data.actions.length+1,round:action.round,
      simulatedMinute:action.round * (data.info.config as NativeSimulationConfig).policy.minutes_per_round,platform:action.platform,agentId:action.author_id,action:action.action,
      content:action.content,timestamp:action.timestamp,success:reduced.success,...(action.target_id ? {targetId:action.target_id}:{}),
      ...(reduced.errorCode ? {errorCode:reduced.errorCode}:{}),...('observation' in reduced && reduced.observation ? {observation:reduced.observation}:{}), };
    data.actions.push(event); data.projection.committedEventSequence = event.sequence;
    if ((data.info.config as NativeSimulationConfig).policy.memory_enabled) rememberSimulationAction(data.memory,event);
    if (reduced.success && data.posts.some(post => post.id === action.id)) this.emit(instance,{type:'post_created',data:{post:action,round:action.round}});
    this.emit(instance,{type:'action_executed',data:{action:event}});
  }
  private scheduleProjection(instance: Instance): void {
    if (!instance.data.projection.enabled) return;
    instance.data.projection.status = 'pending';
    instance.projectionQueue = instance.projectionQueue.then(async () => {
      if (instance.data.projection.status === 'failed') return;
      const pending = instance.data.actions.filter(event => event.sequence > instance.data.projection.projectedEventSequence); if (!pending.length) return;
      const sequence = await this.memoryPort.project(this.scope,instance.data.info.simulation_id,structuredClone(pending),instance.data.projection.runId);
      if (sequence !== pending.at(-1)!.sequence) throw new Error('SIMULATION_MEMORY_INCOMPLETE');
      instance.data.projection.projectedEventSequence = sequence; await this.persist(instance);
    }).catch(async () => { instance.data.projection.status='failed'; instance.data.projection.errorCode='SIMULATION_MEMORY_FAILED'; await this.persist(instance); });
  }
  async pause(id: string): Promise<SimulationInfo | null> { return this.stop(id,'pause'); }
  async stop(id: string, mode: 'pause' | 'stop' = 'stop'): Promise<SimulationInfo | null> {
    if (!await this.ensureLoaded(id)) return null; const instance=this.simulations.get(id)!; const work=this.running.get(id); instance.stopMode=mode;
    if (work) {
      instance.data.info.status='stopping'; instance.controller.abort(new DOMException('Simulation stopped','AbortError')); await this.persist(instance);
      let timer:ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([work,new Promise<void>(resolve => {timer=setTimeout(resolve,5000);})]); } finally {if(timer)clearTimeout(timer);}
    } else {this.scheduleProjection(instance);await instance.projectionQueue;this.finishProjection(instance);instance.data.info.status=instance.data.projection.status==='failed'?'failed':mode === 'stop' ? 'stopped' : 'paused'; await this.persist(instance); }
    this.emit(instance,{type:'state_changed',data:{status:instance.data.info.status}}); return this.get(id);
  }
  async delete(id:string):Promise<boolean> {
    if (!await this.ensureLoaded(id)) return false; await this.stop(id); if (this.running.has(id)) throw new Error('SIMULATION_STOP_PENDING');
    this.simulations.get(id)?.listeners.clear(); const deleted=await this.store.delete('simulation',id); this.simulations.delete(id); return deleted;
  }
  private async persist(instance:Instance):Promise<void> {
    const data=instance.data; data.info.updated_at=new Date().toISOString(); const stats=this.getAgentStats(data.info.simulation_id); data.stats=stats;
    data.info.total_posts=stats.reduce((n,item)=>n+item.post_count,0); data.info.total_comments=stats.reduce((n,item)=>n+item.comment_count,0); data.info.total_likes=stats.reduce((n,item)=>n+item.like_count,0);
    const snapshot=structuredClone(data); const write=instance.saveQueue.catch(()=>{}).then(()=>this.store.write('simulation',data.info.simulation_id,snapshot,{projectId:data.info.project_id})); instance.saveQueue=write; await write;
  }
  private emit(instance:Instance,event:SimulationEvent):void {for(const listener of instance.listeners){try{listener(event);}catch{/* A disconnected viewer cannot invalidate committed work. */}}}
  private finishProjection(instance:Instance):void{const {projection,actions}=instance.data;if(!projection.enabled){projection.status='idle';return;}if(projection.status!=='failed'&&projection.projectedEventSequence===actions.length)projection.status='complete';else{projection.status='failed';projection.errorCode??='SIMULATION_MEMORY_INCOMPLETE';}}
  private roundStats(posts:SimulationPost[]):TimelineEntry['stats'] {const sentiment={positive:0,neutral:0,negative:0};for(const post of posts)sentiment[post.sentiment]++;return {total_posts:posts.length,sentiment_distribution:sentiment,hot_topics:[...new Set(posts.flatMap(post=>post.topics))].slice(0,5),active_agents:new Set(posts.map(post=>post.author_id)).size};}
  private delay(ms:number,signal:AbortSignal):Promise<void> {return new Promise((resolve,reject)=>{signal.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});}
}
export async function isSimulationSnapshotSourceAuthorized(snapshot:NativeSimulationSnapshot,scope:MiroFishRuntimeScope):Promise<boolean>{
  // Internal unit fixtures may omit a source; public creation always supplies an authorized identity.
  if(!snapshot.sourceGraphIdentity)return true;
  const [{getScopedMiroFishProjectStore},{loadAuthorizedProjectGraph}]=await Promise.all([import('./request-scope'),import('./project-graph')]);
  const project=await getScopedMiroFishProjectStore(scope).get(snapshot.info.project_id);if(!project)return false;
  const identity=snapshot.sourceGraphIdentity;const claimed=identity as unknown as Record<string,unknown>;
  if(('tenantId' in claimed&&claimed.tenantId!==scope.tenantId)||('corpusId' in claimed&&claimed.corpusId!==scope.corpusId))return false;
  // History pins its immutable original source; a newer project graph does not rewrite old runs.
  const source=await loadAuthorizedProjectGraph({...project,graph_id:identity.documentId,graph_identity:identity as ProjectGraphIdentity},scope);
  return !!source&&source.identity.documentId===identity.documentId&&source.identity.documentVersion===identity.documentVersion&&source.identity.trustLevel===identity.trustLevel&&source.identity.graphGeneration===identity.graphGeneration;
}
const processRunners=globalThis as typeof globalThis & {__miroFishNativeRunnersV1?:Map<string,SimulationRunner>};
function defaultSimulationScope():MiroFishRuntimeScope{const config=getPostgresRuntimeConfig();return {tenantId:config.defaultTenantId||(!shouldUsePostgresPersistence()?'local-dev-tenant':''),corpusId:config.defaultCorpusId||(!shouldUsePostgresPersistence()?'local-dev-corpus':'')};}
function sanitizeProfiles(profiles:EntityProfile[]):EntityProfile[]{
 const fields=new Set(['entity_id','entity_name','entity_type','full_name','age','gender','occupation','position','personality_traits','speaking_style','social_media_style','typical_posts','viewpoints','background','expertise','generated_at','model']);
 return profiles.map(profile=>{if(!profile||typeof profile.entity_id!=='string'||typeof profile.entity_name!=='string')throw new Error('SIMULATION_INVALID_PROFILES');
  const safe=Object.fromEntries(Object.entries(profile).filter(([key])=>fields.has(key))) as unknown as EntityProfile;
  for(const name of ['personality_traits','typical_posts'] as const)if(!Array.isArray(safe[name])||!safe[name].every(value=>typeof value==='string'))throw new Error('SIMULATION_INVALID_PROFILES');
  if(!safe.viewpoints||typeof safe.viewpoints!=='object'||Array.isArray(safe.viewpoints)||!Object.values(safe.viewpoints).every(value=>typeof value==='string'))throw new Error('SIMULATION_INVALID_PROFILES');
  if(profile.behavioral_anchors){const anchor=profile.behavioral_anchors;safe.behavioral_anchors={posting_style:anchor.posting_style,active_hours:anchor.active_hours,stance:anchor.stance,opinion_drift_rate:anchor.opinion_drift_rate,influence_weight:anchor.influence_weight};}
  return structuredClone(safe);
 });
}
export function getSimulationRunner(scope?:MiroFishRuntimeScope):SimulationRunner {const effective=scope??defaultSimulationScope();const key=JSON.stringify(effective);const runners=processRunners.__miroFishNativeRunnersV1??=new Map();let runner=runners.get(key);if(!runner){runner=new SimulationRunner({scope:effective});runners.set(key,runner);}return runner;}
export async function loadSimulationSnapshot(id:string,scope?:MiroFishRuntimeScope):Promise<NativeSimulationSnapshot|null> {const runner=getSimulationRunner(scope);return await runner.ensureLoaded(id)?runner.getSnapshot(id):null;}
