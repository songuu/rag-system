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
  animations?: PPTAnimation[];
  turning_mode?: TurningMode;
}

// ==================== OpenMAIC/PPTist 动画兼容层 ====================

export type AnimationType = 'in' | 'out' | 'attention';
export type AnimationTrigger = 'click' | 'meantime' | 'auto';
export type FocusHoldMode = 'none' | 'until_next_focus' | 'until_slide_change' | 'duration';
export type FocusSource = 'model' | 'fallback';

export interface PPTAnimation {
  id: string;
  elId: string;
  effect: string;
  type: AnimationType;
  duration: number;
  trigger: AnimationTrigger;
}

export type TurningMode =
  | 'no'
  | 'fade'
  | 'slideX'
  | 'slideY'
  | 'random'
  | 'slideX3D'
  | 'slideY3D'
  | 'rotate'
  | 'scaleY'
  | 'scaleX'
  | 'scale'
  | 'scaleReverse';

export interface SlideFocusTarget {
  kind: 'description' | 'key_point';
  elementId: string;
  text: string;
  index?: number;
  label?: string;
  reason?: string;
  confidence?: number;
}

export interface SlideFocusPlan {
  slide_index: number;
  source: FocusSource;
  primary: SlideFocusTarget;
  secondary?: SlideFocusTarget;
  focusHold?: FocusHoldMode;
  dimOpacity?: number;
  rationale?: string;
  confidence?: number;
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

// ==================== OpenMAIC 风格 Stage / Scene ====================

export type CourseSceneType =
  | 'slide'
  | 'quiz'
  | 'interactive'
  | 'pbl'
  | 'mindmap'
  | 'code';

export type SceneActionType =
  | 'speech'
  | 'spotlight'
  | 'highlight'
  | 'laser'
  | 'play_video'
  | 'whiteboard'
  | 'wb_open'
  | 'wb_draw_text'
  | 'wb_draw_shape'
  | 'wb_draw_chart'
  | 'wb_draw_latex'
  | 'wb_draw_table'
  | 'wb_draw_line'
  | 'wb_draw_code'
  | 'wb_clear'
  | 'wb_delete'
  | 'wb_close'
  | 'discussion'
  | 'quiz'
  | 'widget_highlight'
  | 'widget_setState'
  | 'widget_annotation'
  | 'widget_reveal';

export interface SceneAction {
  id: string;
  type: SceneActionType;
  title: string;
  content?: string;
  target?: string;
  elementId?: string;
  dimOpacity?: number;
  color?: string;
  duration?: number;
  trigger?: AnimationTrigger;
  focusHold?: FocusHoldMode;
  focusSource?: FocusSource;
  focusReason?: string;
  focusConfidence?: number;
  animation?: PPTAnimation;
  state?: Record<string, unknown>;
}

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  answer_index: number;
  explanation: string;
}

export interface CourseScene {
  id: string;
  order: number;
  type: CourseSceneType;
  title: string;
  description: string;
  page_refs: number[];
  key_points: string[];
  actions: SceneAction[];
  quiz?: QuizQuestion[];
  interactive?: {
    kind: 'simulation' | 'game' | 'mindmap' | 'code';
    prompt: string;
    controls: string[];
  };
  pbl?: {
    challenge: string;
    roles: string[];
    milestones: string[];
    deliverable: string;
  };
}

export interface CourseStage {
  title: string;
  summary: string;
  objectives: string[];
  scene_count: number;
  estimated_minutes: number;
}

export interface CoursePrepared {
  pages: SlidePage[];
  knowledge_tree: KnowledgeNode;
  lecture_script: ScriptEntry[];
  active_questions: string[];
  focus_plans?: SlideFocusPlan[];
  stage?: CourseStage;
  scenes?: CourseScene[];
}

export type CourseGenerationLanguage = 'zh-CN' | 'en-US';

export interface CourseSceneCapabilities {
  quiz?: boolean;
  interactive?: boolean;
  pbl?: boolean;
  whiteboard?: boolean;
  spotlight?: boolean;
  laser?: boolean;
  animations?: boolean;
  focusHover?: boolean;
}

export interface CourseGenerationOptions {
  language?: CourseGenerationLanguage;
  capabilities?: CourseSceneCapabilities;
  focusPlans?: SlideFocusPlan[];
}

export interface MaicRagAsset {
  source_hash: string;
  parsed_filename: string;
  manifest_id: string;
  mirrored_at: string;
}

// ==================== 课程 ====================

export type CourseStatus = 'uploaded' | 'preparing' | 'ready' | 'failed';

export interface Course {
  course_id: string;
  title: string;
  source_filename: string;
  source_text: string;
  source_pages?: SlidePage[];
  source_hash?: string;
  rag_asset?: MaicRagAsset;
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
    | 'prepare:cache'
    | 'prepare:read_raw'
    | 'prepare:describe'
    | 'prepare:tree'
    | 'prepare:script'
    | 'prepare:questions'
    | 'prepare:focus'
    | 'prepare:scenes'
    | 'prepare:done'
    | 'prepare:error';
  data: {
    progress?: number;
    page_index?: number;
    total_pages?: number;
    message?: string;
    course_id?: string;
    error?: string;
    cache_status?: 'hit' | 'miss' | 'stored';
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
