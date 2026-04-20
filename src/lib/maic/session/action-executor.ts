/**
 * Action Executor: 把 TeachingAction 落到 ClassroomState
 *
 * 只产出 state patch,由调用方写回 store,保持不可变。
 */

import type { ClassroomState, TeachingAction, CoursePrepared } from '../types';

export interface StatePatch {
  P_t?: number;
  script_cursor?: number;
  status?: ClassroomState['status'];
}

export function applyAction(
  state: ClassroomState,
  action: TeachingAction,
  prepared: CoursePrepared | undefined
): StatePatch {
  const patch: StatePatch = {};

  switch (action.type) {
    case 'ShowFile': {
      const idx = Math.max(0, Math.min(
        action.value.slide_index ?? state.P_t,
        (prepared?.pages.length ?? 1) - 1
      ));
      patch.P_t = idx;
      patch.script_cursor = state.script_cursor + 1;
      break;
    }
    case 'ReadScript':
    case 'AskQuestion':
    case 'Navigate':
      patch.script_cursor = state.script_cursor + 1;
      break;
    case 'AnswerStudent':
      // 回答学生问题不推进脚本 cursor,保持课堂节奏
      break;
    case 'Idle':
      break;
    case 'EndClass':
      patch.status = 'ended';
      break;
    default:
      break;
  }

  return patch;
}
