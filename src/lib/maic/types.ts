/**
 * MAIC (Massive AI-empowered Classroom) 类型定义
 *
 * 参考: https://open.maic.chat/ 及论文 arXiv 2409.03512
 * 本模块独立于 mirofish,不共享类型。
 */

// ==================== 教学动作 ====================

export type ActionType =
  | 'ShowFile'
  | 'ReadScript'
  | 'AskQuestion'
  | 'Navigate'
  | 'AnswerStudent'
  | 'Idle'
  | 'EndClass';

export interface TeachingAction {
  type: ActionType;
  value: {
    slide_index?: number;
    script?: string;
    question?: string;
    note?: string;
    student_question?: string;
  };
}

// ==================== 课程准备产物 ====================

export interface SlidePage {
  index: number;
  raw_text: string;
  description: string;
  key_points: string[];
}

export interface KnowledgeNode {
  id: string;
  title: string;
  summary: string;
  page_refs: number[];
  children: KnowledgeNode[];
}

export interface ScriptEntry {
  slide_index: number;
  actions: TeachingAction[];
}

export interface CoursePrepared {
  pages: SlidePage[];
  knowledge_tree: KnowledgeNode;
  lecture_script: ScriptEntry[];
  active_questions: string[];
}

// ==================== 课程 ====================

export type CourseStatus = 'uploaded' | 'preparing' | 'ready' | 'failed';

export interface Course {
  course_id: string;
  title: string;
  source_filename: string;
  source_text: string;
  status: CourseStatus;
  prepared?: CoursePrepared;
  error?: string;
  created_at: string;
  updated_at: string;
}

// ==================== Agents ====================

export type AgentRole =
  | 'teacher'
  | 'ta'
  | 'clown'
  | 'thinker'
  | 'notetaker'
  | 'inquisitive'
  | 'manager';

export type SpeakingRole = Exclude<AgentRole, 'manager'>;

export interface AgentProfile {
  role: AgentRole;
  display_name: string;
  system_prompt: string;
  avatar: string;
}

// ==================== 会话/课堂状态 ====================

export type ClassroomMode = 'continuous' | 'interactive';
export type ClassroomStatus = 'idle' | 'running' | 'paused' | 'ended' | 'error';

export interface Utterance {
  id: string;
  speaker: AgentRole | 'student';
  speaker_name: string;
  content: string;
  action?: TeachingAction;
  timestamp: string;
}

export interface ClassroomState {
  P_t: number;
  H_t: Utterance[];
  R: AgentRole[];
  mode: ClassroomMode;
  status: ClassroomStatus;
  script_cursor: number;
}

export interface ClassroomSession {
  session_id: string;
  course_id: string;
  state: ClassroomState;
  created_at: string;
  updated_at: string;
}

// ==================== 事件 ====================

export interface PrepareEvent {
  type:
    | 'prepare:start'
    | 'prepare:read_raw'
    | 'prepare:describe'
    | 'prepare:tree'
    | 'prepare:script'
    | 'prepare:questions'
    | 'prepare:done'
    | 'prepare:error';
  data: {
    progress?: number;
    page_index?: number;
    total_pages?: number;
    message?: string;
    course_id?: string;
    error?: string;
  };
}

export type ClassroomEvent =
  | { type: 'utterance'; data: Utterance }
  | { type: 'slide_change'; data: { slide_index: number } }
  | { type: 'state'; data: ClassroomState }
  | { type: 'mode'; data: { mode: ClassroomMode } }
  | { type: 'end'; data: { reason: string } }
  | { type: 'error'; data: { message: string } };

// ==================== Manager 决策 ====================

export interface ManagerDecision {
  next_agent: SpeakingRole;
  action: TeachingAction;
  reason?: string;
}
