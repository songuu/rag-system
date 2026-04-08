/**
 * 项目存储服务
 *
 * 内存存储项目数据，支持 CRUD 操作
 */

import type { Project, CreateProjectRequest, ProjectStatus } from './types';

class ProjectStore {
  private projects: Map<string, Project> = new Map();

  /** 创建项目 */
  create(request: CreateProjectRequest): Project {
    const id = `proj_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    const project: Project = {
      id,
      name: request.name,
      description: request.description || '',
      status: 'created',
      current_step: 0,
      simulation_requirement: request.simulation_requirement,
      texts: [],
      created_at: now,
      updated_at: now,
    };

    this.projects.set(id, project);
    return project;
  }

  /** 获取项目 */
  get(id: string): Project | null {
    return this.projects.get(id) || null;
  }

  /** 获取所有项目 */
  list(): Project[] {
    return Array.from(this.projects.values()).sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  }

  /** 更新项目 */
  update(id: string, updates: Partial<Omit<Project, 'id' | 'created_at'>>): Project | null {
    const project = this.projects.get(id);
    if (!project) return null;

    const updated: Project = {
      ...project,
      ...updates,
      id: project.id,
      created_at: project.created_at,
      updated_at: new Date().toISOString(),
    };

    this.projects.set(id, updated);
    return updated;
  }

  /** 更新项目状态 */
  updateStatus(id: string, status: ProjectStatus, step?: number): Project | null {
    return this.update(id, {
      status,
      ...(step !== undefined ? { current_step: step } : {}),
    });
  }

  /** 删除项目 */
  delete(id: string): boolean {
    return this.projects.delete(id);
  }

  /** 重置项目 */
  reset(id: string): Project | null {
    const project = this.projects.get(id);
    if (!project) return null;

    return this.update(id, {
      status: 'created',
      current_step: 0,
      ontology: undefined,
      graph_id: undefined,
      simulation_id: undefined,
      report_id: undefined,
    });
  }
}

let storeInstance: ProjectStore | null = null;

export function getProjectStore(): ProjectStore {
  if (!storeInstance) {
    storeInstance = new ProjectStore();
  }
  return storeInstance;
}
