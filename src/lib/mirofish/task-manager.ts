/**
 * 任务管理模块
 *
 * 管理 MiroFish 模块中的异步任务状态
 */

import type { TaskInfo, TaskStatus } from './types';

/**
 * 任务管理器
 *
 * 用于管理长时间运行的任务（如图谱构建）的状态
 */
export class TaskManager {
  private tasks: Map<string, TaskInfo> = new Map();

  /**
   * 创建新任务
   */
  createTask(taskType: string, metadata?: Record<string, unknown>): string {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const task: TaskInfo = {
      task_id: taskId,
      task_type: taskType,
      status: 'pending',
      progress: 0,
      message: '任务已创建',
      metadata,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    this.tasks.set(taskId, task);
    return taskId;
  }

  /**
   * 更新任务状态
   */
  updateTask(
    taskId: string,
    updates: Partial<Pick<TaskInfo, 'status' | 'progress' | 'message' | 'metadata'>>
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskManager] Task ${taskId} not found`);
      return;
    }

    if (updates.status !== undefined) {
      task.status = updates.status;
    }
    if (updates.progress !== undefined) {
      task.progress = updates.progress;
    }
    if (updates.message !== undefined) {
      task.message = updates.message;
    }
    if (updates.metadata !== undefined) {
      task.metadata = { ...task.metadata, ...updates.metadata };
    }

    task.updated_at = Date.now();
    this.tasks.set(taskId, task);
  }

  /**
   * 完成任务
   */
  completeTask(taskId: string, result: Record<string, unknown>): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskManager] Task ${taskId} not found`);
      return;
    }

    task.status = 'completed';
    task.progress = 100;
    task.message = '任务完成';
    task.result = result;
    task.updated_at = Date.now();

    this.tasks.set(taskId, task);
  }

  /**
   * 标记任务失败
   */
  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskManager] Task ${taskId} not found`);
      return;
    }

    task.status = 'failed';
    task.message = '任务失败';
    task.error = error;
    task.updated_at = Date.now();

    this.tasks.set(taskId, task);
  }

  /**
   * 获取任务状态
   */
  getTask(taskId: string): TaskInfo | null {
    return this.tasks.get(taskId) || null;
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): TaskInfo[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 删除任务
   */
  deleteTask(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }

  /**
   * 清理已完成/失败的任务（保留最近 N 个）
   */
  cleanOldTasks(keepCount: number = 100): void {
    const tasks = Array.from(this.tasks.values())
      .sort((a, b) => b.updated_at - a.updated_at);

    // 保留最近的任务
    const tasksToKeep = new Set(tasks.slice(0, keepCount).map(t => t.task_id));

    // 删除旧任务
    for (const taskId of this.tasks.keys()) {
      if (!tasksToKeep.has(taskId)) {
        this.tasks.delete(taskId);
      }
    }
  }
}

// 单例实例
let taskManagerInstance: TaskManager | null = null;

/**
 * 获取任务管理器单例
 */
export function getTaskManager(): TaskManager {
  if (!taskManagerInstance) {
    taskManagerInstance = new TaskManager();
  }
  return taskManagerInstance;
}
