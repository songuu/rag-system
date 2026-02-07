// Langfuse 风格的可观测性系统设计

import { v4 as uuidv4 } from 'uuid';

// ============= 核心数据模型 =============

// Trace: 代表一次完整的用户交互
interface Trace {
  id: string;
  userId?: string;
  sessionId?: string;
  name: string;
  startTime: Date;
  endTime?: Date;
  input?: any;
  output?: any;
  metadata?: Record<string, any>;
  tags?: string[];
  observations: Observation[];
  scores: Score[];
  status: 'PENDING' | 'SUCCESS' | 'ERROR';
}

// Observation: Trace 的子节点，包含三种类型
type Observation = Generation | Span | Event;

// Generation: 专门记录 LLM 调用
interface Generation {
  id: string;
  traceId: string;
  parentObservationId?: string;
  type: 'GENERATION';
  name: string;
  startTime: Date;
  endTime?: Date;
  input?: any;
  output?: any;
  model?: string;
  modelParameters?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metadata?: Record<string, any>;
  level: 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR';
  statusMessage?: string;
}

// Span: 记录一段逻辑操作（如检索、预处理等）
interface Span {
  id: string;
  traceId: string;
  parentObservationId?: string;
  type: 'SPAN';
  name: string;
  startTime: Date;
  endTime?: Date;
  input?: any;
  output?: any;
  metadata?: Record<string, any>;
  level: 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR';
  statusMessage?: string;
}

// Event: 记录瞬时事件
interface Event {
  id: string;
  traceId: string;
  parentObservationId?: string;
  type: 'EVENT';
  name: string;
  startTime: Date;
  input?: any;
  output?: any;
  metadata?: Record<string, any>;
  level: 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR';
  statusMessage?: string;
}

// Score: 评分数据
interface Score {
  id: string;
  traceId: string;
  observationId?: string;
  name: string;
  value: number | boolean | string;
  source: 'USER' | 'AI' | 'SYSTEM';
  comment?: string;
  timestamp: Date;
}

// ============= 可观测性引擎 =============

class ObservabilityEngine {
  private traces: Map<string, Trace> = new Map();
  private observations: Map<string, Observation> = new Map();
  private scores: Map<string, Score> = new Map();
  private callbacks: {
    onTraceUpdate?: (trace: Trace) => void;
    onObservationUpdate?: (observation: Observation) => void;
    onScoreUpdate?: (score: Score) => void;
  } = {};

  constructor(callbacks?: {
    onTraceUpdate?: (trace: Trace) => void;
    onObservationUpdate?: (observation: Observation) => void;
    onScoreUpdate?: (score: Score) => void;
  }) {
    this.callbacks = callbacks || {};
  }

  // ============= Trace 管理 =============

  createTrace(params: {
    name: string;
    userId?: string;
    sessionId?: string;
    input?: any;
    metadata?: Record<string, any>;
    tags?: string[];
  }): string {
    const traceId = uuidv4();
    const trace: Trace = {
      id: traceId,
      name: params.name,
      userId: params.userId,
      sessionId: params.sessionId,
      startTime: new Date(),
      input: params.input,
      metadata: params.metadata,
      tags: params.tags,
      observations: [],
      scores: [],
      status: 'PENDING'
    };

    this.traces.set(traceId, trace);
    this.callbacks.onTraceUpdate?.(trace);
    return traceId;
  }

  updateTrace(traceId: string, updates: {
    output?: any;
    metadata?: Record<string, any>;
    status?: 'PENDING' | 'SUCCESS' | 'ERROR';
    endTime?: Date;
  }): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    Object.assign(trace, updates);
    if (updates.endTime) {
      trace.endTime = updates.endTime;
    }

    this.callbacks.onTraceUpdate?.(trace);
  }

  // ============= Observation 管理 =============

  createGeneration(params: {
    traceId: string;
    name: string;
    parentObservationId?: string;
    input?: any;
    model?: string;
    modelParameters?: any;
    metadata?: Record<string, any>;
  }): string {
    const observationId = uuidv4();
    const generation: Generation = {
      id: observationId,
      traceId: params.traceId,
      parentObservationId: params.parentObservationId,
      type: 'GENERATION',
      name: params.name,
      startTime: new Date(),
      input: params.input,
      model: params.model,
      modelParameters: params.modelParameters,
      metadata: params.metadata,
      level: 'DEFAULT'
    };

    this.observations.set(observationId, generation);
    
    // 添加到 trace 的 observations 列表
    const trace = this.traces.get(params.traceId);
    if (trace) {
      trace.observations.push(generation);
      this.callbacks.onTraceUpdate?.(trace);
    }

    this.callbacks.onObservationUpdate?.(generation);
    return observationId;
  }

  createSpan(params: {
    traceId: string;
    name: string;
    parentObservationId?: string;
    input?: any;
    metadata?: Record<string, any>;
  }): string {
    const observationId = uuidv4();
    const span: Span = {
      id: observationId,
      traceId: params.traceId,
      parentObservationId: params.parentObservationId,
      type: 'SPAN',
      name: params.name,
      startTime: new Date(),
      input: params.input,
      metadata: params.metadata,
      level: 'DEFAULT'
    };

    this.observations.set(observationId, span);
    
    // 添加到 trace 的 observations 列表
    const trace = this.traces.get(params.traceId);
    if (trace) {
      trace.observations.push(span);
      this.callbacks.onTraceUpdate?.(trace);
    }

    this.callbacks.onObservationUpdate?.(span);
    return observationId;
  }

  createEvent(params: {
    traceId: string;
    name: string;
    parentObservationId?: string;
    input?: any;
    output?: any;
    metadata?: Record<string, any>;
    level?: 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR';
  }): string {
    const observationId = uuidv4();
    const event: Event = {
      id: observationId,
      traceId: params.traceId,
      parentObservationId: params.parentObservationId,
      type: 'EVENT',
      name: params.name,
      startTime: new Date(),
      input: params.input,
      output: params.output,
      metadata: params.metadata,
      level: params.level || 'DEFAULT'
    };

    this.observations.set(observationId, event);
    
    // 添加到 trace 的 observations 列表
    const trace = this.traces.get(params.traceId);
    if (trace) {
      trace.observations.push(event);
      this.callbacks.onTraceUpdate?.(trace);
    }

    this.callbacks.onObservationUpdate?.(event);
    return observationId;
  }

  updateObservation(observationId: string, updates: {
    output?: any;
    endTime?: Date;
    usage?: any;
    metadata?: Record<string, any>;
    level?: 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR';
    statusMessage?: string;
  }): void {
    const observation = this.observations.get(observationId);
    if (!observation) return;

    Object.assign(observation, updates);
    if (updates.endTime) {
      observation.endTime = updates.endTime;
    }

    this.callbacks.onObservationUpdate?.(observation);
    
    // 更新 trace
    const trace = this.traces.get(observation.traceId);
    if (trace) {
      this.callbacks.onTraceUpdate?.(trace);
    }
  }

  // ============= Score 管理 =============

  addScore(params: {
    traceId: string;
    observationId?: string;
    name: string;
    value: number | boolean | string;
    source: 'USER' | 'AI' | 'SYSTEM';
    comment?: string;
  }): string {
    const scoreId = uuidv4();
    const score: Score = {
      id: scoreId,
      traceId: params.traceId,
      observationId: params.observationId,
      name: params.name,
      value: params.value,
      source: params.source,
      comment: params.comment,
      timestamp: new Date()
    };

    this.scores.set(scoreId, score);
    
    // 添加到 trace 的 scores 列表
    const trace = this.traces.get(params.traceId);
    if (trace) {
      trace.scores.push(score);
      this.callbacks.onTraceUpdate?.(trace);
    }

    this.callbacks.onScoreUpdate?.(score);
    return scoreId;
  }

  // ============= 查询方法 =============

  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  getObservation(observationId: string): Observation | undefined {
    return this.observations.get(observationId);
  }

  getAllTraces(): Trace[] {
    return Array.from(this.traces.values());
  }

  getTracesByUser(userId: string): Trace[] {
    return Array.from(this.traces.values()).filter(trace => trace.userId === userId);
  }

  getTracesBySession(sessionId: string): Trace[] {
    return Array.from(this.traces.values()).filter(trace => trace.sessionId === sessionId);
  }

  // ============= 分析方法 =============

  getTraceStats(): {
    totalTraces: number;
    successRate: number;
    avgDuration: number;
    totalTokens: number;
    avgTokensPerTrace: number;
  } {
    const traces = Array.from(this.traces.values());
    const completedTraces = traces.filter(t => t.endTime);
    
    const successCount = traces.filter(t => t.status === 'SUCCESS').length;
    const successRate = traces.length > 0 ? successCount / traces.length : 0;
    
    const totalDuration = completedTraces.reduce((sum, trace) => {
      if (trace.endTime) {
        return sum + (trace.endTime.getTime() - trace.startTime.getTime());
      }
      return sum;
    }, 0);
    const avgDuration = completedTraces.length > 0 ? totalDuration / completedTraces.length : 0;
    
    const totalTokens = Array.from(this.observations.values())
      .filter(obs => obs.type === 'GENERATION')
      .reduce((sum, gen) => {
        const generation = gen as Generation;
        return sum + (generation.usage?.totalTokens || 0);
      }, 0);
    
    const avgTokensPerTrace = traces.length > 0 ? totalTokens / traces.length : 0;
    
    return {
      totalTraces: traces.length,
      successRate,
      avgDuration,
      totalTokens,
      avgTokensPerTrace
    };
  }

  // ============= 导出方法 =============

  exportTraces(): any[] {
    return Array.from(this.traces.values()).map(trace => ({
      ...trace,
      observations: trace.observations,
      scores: trace.scores
    }));
  }

  // ============= 清理方法 =============

  clear(): void {
    this.traces.clear();
    this.observations.clear();
    this.scores.clear();
  }
}

export {
  ObservabilityEngine,
  type Trace,
  type Observation,
  type Generation,
  type Span,
  type Event,
  type Score
};