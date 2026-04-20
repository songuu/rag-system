/**
 * Session Controller
 *
 * 负责课堂运行时:
 * - 维护 session 生命周期
 * - 循环驱动 ManagerAgent → 执行动作 → 追加 utterance
 * - 发布 ClassroomEvent 供 SSE 订阅
 * - 学生输入入队后立即 abort 当前 wait,触发重新决策
 * - 同 session 串行 (Mutex),跨 session 并发
 */

import { getMaicStore } from '../course-store';
import { getAgentRegistry } from '../agents/agent-registry';
import { getManagerAgent } from '../agents/manager-agent';
import { applyAction } from './action-executor';
import type {
  ClassroomEvent,
  ClassroomMode,
  ClassroomSession,
  Utterance,
  AgentRole,
} from '../types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AgentRoleRef = AgentRole;

type Listener = (event: ClassroomEvent) => void;

interface RuntimeSlot {
  session_id: string;
  listeners: Set<Listener>;
  pendingStudent: string[];
  waitAbort: AbortController | null;
  running: boolean;
  loopPromise: Promise<void> | null;
}

const TURN_DELAY_MS = 1200;
const MAX_LOOP_STEPS = 200;

class SessionController {
  private slots: Map<string, RuntimeSlot> = new Map();

  /** 订阅事件;首次订阅会自动启动循环 */
  subscribe(sessionId: string, listener: Listener): () => void {
    const slot = this.ensureSlot(sessionId);
    slot.listeners.add(listener);

    // 推送初始 state
    const sess = getMaicStore().getSession(sessionId);
    if (sess) {
      listener({ type: 'state', data: sess.state });
    }

    this.ensureLoop(sessionId);

    return () => {
      slot.listeners.delete(listener);
      if (slot.listeners.size === 0) {
        this.pauseSession(sessionId);
      }
    };
  }

  /** 学生输入入队 + 打断当前 wait */
  submitStudentMessage(sessionId: string, content: string): Utterance | null {
    const store = getMaicStore();
    const sess = store.getSession(sessionId);
    if (!sess) return null;

    const utterance: Utterance = {
      id: `utt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      speaker: 'student',
      speaker_name: '我',
      content: content.trim(),
      timestamp: new Date().toISOString(),
    };
    store.appendUtterance(sessionId, utterance);

    const slot = this.ensureSlot(sessionId);
    slot.pendingStudent.push(utterance.content);
    slot.waitAbort?.abort();

    this.emit(sessionId, { type: 'utterance', data: utterance });

    // 若当前 paused/ended,重新 running
    if (sess.state.status !== 'running') {
      store.updateSessionState(sessionId, { status: 'running' });
    }

    this.ensureLoop(sessionId);
    return utterance;
  }

  setMode(sessionId: string, mode: ClassroomMode): void {
    const store = getMaicStore();
    const updated = store.setSessionMode(sessionId, mode);
    if (updated) {
      this.emit(sessionId, { type: 'mode', data: { mode } });
      this.emit(sessionId, { type: 'state', data: updated.state });
    }
  }

  // ---------- 内部 ----------

  private ensureSlot(sessionId: string): RuntimeSlot {
    let slot = this.slots.get(sessionId);
    if (!slot) {
      slot = {
        session_id: sessionId,
        listeners: new Set(),
        pendingStudent: [],
        waitAbort: null,
        running: false,
        loopPromise: null,
      };
      this.slots.set(sessionId, slot);
    }
    return slot;
  }

  private emit(sessionId: string, event: ClassroomEvent): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    for (const l of slot.listeners) {
      try {
        l(event);
      } catch {
        /* ignore */
      }
    }
  }

  private pauseSession(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    slot.running = false;
    slot.waitAbort?.abort();
  }

  private ensureLoop(sessionId: string): void {
    const slot = this.ensureSlot(sessionId);
    if (slot.loopPromise) return;
    slot.running = true;
    slot.loopPromise = this.runLoop(sessionId).finally(() => {
      const s = this.slots.get(sessionId);
      if (s) s.loopPromise = null;
    });
  }

  private async runLoop(sessionId: string): Promise<void> {
    const store = getMaicStore();
    const registry = getAgentRegistry();
    const manager = getManagerAgent();

    const sess = store.getSession(sessionId);
    if (!sess) return;
    const course = store.getCourse(sess.course_id);
    if (!course) return;
    const prepared = course.prepared;

    const afterStart = store.updateSessionState(sessionId, { status: 'running' });
    if (afterStart) {
      this.emit(sessionId, { type: 'state', data: afterStart.state });
    }

    let steps = 0;

    while (steps < MAX_LOOP_STEPS) {
      const slot = this.slots.get(sessionId);
      if (!slot || !slot.running || slot.listeners.size === 0) break;

      const current = store.getSession(sessionId);
      if (!current) break;
      if (current.state.status === 'ended') break;

      const studentMsg: string | null = slot.pendingStudent.shift() ?? null;

      let decision;
      try {
        decision = await manager.decide(current.state, prepared, studentMsg);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'manager failed';
        this.emit(sessionId, { type: 'error', data: { message } });
        break;
      }

      // 执行
      try {
        const agent = registry.get(decision.next_agent);
        const utterance = await agent.respond(current.state, decision.action, prepared);
        store.appendUtterance(sessionId, utterance);
        this.emit(sessionId, { type: 'utterance', data: utterance });

        const patch = applyAction(current.state, decision.action, prepared);
        const updated = store.updateSessionState(sessionId, patch);
        if (updated) {
          if (patch.P_t !== undefined) {
            this.emit(sessionId, {
              type: 'slide_change',
              data: { slide_index: patch.P_t },
            });
          }
          this.emit(sessionId, { type: 'state', data: updated.state });
        }

        if (decision.action.type === 'EndClass') {
          this.emit(sessionId, { type: 'end', data: { reason: '课堂结束' } });
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'agent failed';
        this.emit(sessionId, { type: 'error', data: { message } });
        break;
      }

      steps += 1;

      // Wait with abort
      const mode = store.getSession(sessionId)?.state.mode ?? 'continuous';
      const delay = mode === 'continuous' ? TURN_DELAY_MS : TURN_DELAY_MS * 1.5;
      await this.waitOrAbort(sessionId, delay);
    }
  }

  private waitOrAbort(sessionId: string, ms: number): Promise<void> {
    return new Promise(resolve => {
      const slot = this.slots.get(sessionId);
      if (!slot) {
        resolve();
        return;
      }
      const ctrl = new AbortController();
      slot.waitAbort = ctrl;
      const timer = setTimeout(() => {
        slot.waitAbort = null;
        resolve();
      }, ms);
      ctrl.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        slot.waitAbort = null;
        resolve();
      });
    });
  }
}

let instance: SessionController | null = null;

export function getSessionController(): SessionController {
  if (!instance) instance = new SessionController();
  return instance;
}

export function ensureSessionForCourse(
  courseId: string,
  roles: AgentRole[]
): ClassroomSession {
  return getMaicStore().getOrCreateSession(courseId, roles);
}
