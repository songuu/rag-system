/**
 * MiroFish project persistence.
 *
 * PostgreSQL is authoritative whenever the application persistence backend is
 * postgres/dual-write. The in-memory implementation remains only for explicit
 * local-memory development and isolated unit tests.
 */

import { randomUUID } from 'node:crypto';
import type { PostgresQueryClient } from '../postgres/client';
import { getPostgresClient, queryPostgres } from '../postgres/client';
import {
  assertPostgresPersistenceConfigured,
  getPostgresRuntimeConfig,
  shouldUsePostgresPersistence,
} from '../postgres/env';
import type { Project, CreateProjectRequest, ProjectStatus } from './types';

type ProjectUpdates = Partial<Omit<Project, 'id' | 'created_at'>>;
type StoreResult<T> = T | Promise<T>;

export interface MiroFishProjectStore {
  create(request: CreateProjectRequest): StoreResult<Project>;
  get(id: string): StoreResult<Project | null>;
  list(): StoreResult<Project[]>;
  update(id: string, updates: ProjectUpdates): StoreResult<Project | null>;
  updateStatus(id: string, status: ProjectStatus, step?: number): StoreResult<Project | null>;
  delete(id: string): StoreResult<boolean>;
  reset(id: string): StoreResult<Project | null>;
}

class MemoryProjectStore implements MiroFishProjectStore {
  private projects: Map<string, Project> = new Map();

  create(request: CreateProjectRequest): Project {
    const project = createProject(request);
    this.projects.set(project.id, project);
    return project;
  }

  get(id: string): Project | null {
    return this.projects.get(id) || null;
  }

  list(): Project[] {
    return Array.from(this.projects.values()).sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  }

  update(id: string, updates: ProjectUpdates): Project | null {
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

  updateStatus(id: string, status: ProjectStatus, step?: number): Project | null {
    return this.update(id, {
      status,
      ...(step !== undefined ? { current_step: step } : {}),
    });
  }

  delete(id: string): boolean {
    return this.projects.delete(id);
  }

  reset(id: string): Project | null {
    const project = this.projects.get(id);
    if (!project) return null;
    const resetProject = stripGeneratedState(project);
    this.projects.set(id, resetProject);
    return resetProject;
  }
}

interface ProjectRow {
  project_data: unknown;
}

export class PostgresMiroFishProjectStore implements MiroFishProjectStore {
  private readonly client: PostgresQueryClient;
  private readonly scope: { tenantId: string; corpusId: string };

  constructor(
    client: PostgresQueryClient,
    scope: { tenantId: string; corpusId: string }
  ) {
    this.client = client;
    this.scope = scope;
  }

  async create(request: CreateProjectRequest): Promise<Project> {
    const project = createProject(request);
    const result = await queryPostgres<ProjectRow>(
      this.client,
      `insert into public.mirofish_projects (
         tenant_id, corpus_id, project_id, project_data
       ) values ($1, $2, $3, $4::jsonb)
       returning project_data`,
      [this.scope.tenantId, this.scope.corpusId, project.id, JSON.stringify(project)],
      'create MiroFish project'
    );
    return readProjectRow(result.rows[0], 'created');
  }

  async get(id: string): Promise<Project | null> {
    const result = await queryPostgres<ProjectRow>(
      this.client,
      `select project_data
       from public.mirofish_projects
       where tenant_id = $1 and corpus_id = $2 and project_id = $3`,
      [this.scope.tenantId, this.scope.corpusId, requiredProjectId(id)],
      'read MiroFish project'
    );
    return result.rows[0] ? readProjectRow(result.rows[0], 'stored') : null;
  }

  async list(): Promise<Project[]> {
    const result = await queryPostgres<ProjectRow>(
      this.client,
      `select project_data
       from public.mirofish_projects
       where tenant_id = $1 and corpus_id = $2
       order by updated_at desc
       limit 200`,
      [this.scope.tenantId, this.scope.corpusId],
      'list MiroFish projects'
    );
    return result.rows.map(row => readProjectRow(row, 'stored'));
  }

  async update(id: string, updates: ProjectUpdates): Promise<Project | null> {
    const updatedAt = new Date().toISOString();
    const patch = { ...updates, updated_at: updatedAt };
    const result = await queryPostgres<ProjectRow>(
      this.client,
      `update public.mirofish_projects
       set project_data = project_data || $4::jsonb,
           updated_at = now()
       where tenant_id = $1 and corpus_id = $2 and project_id = $3
       returning project_data`,
      [this.scope.tenantId, this.scope.corpusId, requiredProjectId(id), JSON.stringify(patch)],
      'update MiroFish project'
    );
    return result.rows[0] ? readProjectRow(result.rows[0], 'updated') : null;
  }

  updateStatus(id: string, status: ProjectStatus, step?: number): Promise<Project | null> {
    return this.update(id, {
      status,
      ...(step !== undefined ? { current_step: step } : {}),
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = await queryPostgres(
      this.client,
      `delete from public.mirofish_projects
       where tenant_id = $1 and corpus_id = $2 and project_id = $3`,
      [this.scope.tenantId, this.scope.corpusId, requiredProjectId(id)],
      'delete MiroFish project'
    );
    return (result.rowCount ?? 0) > 0;
  }

  async reset(id: string): Promise<Project | null> {
    const patch = {
      status: 'created',
      current_step: 0,
      updated_at: new Date().toISOString(),
    };
    const result = await queryPostgres<ProjectRow>(
      this.client,
      `update public.mirofish_projects
       set project_data = (
         project_data - array[
           'ontology', 'graph_data', 'graph_id', 'agent_profiles',
           'simulation_config', 'prepare_id', 'prepare_fingerprint',
           'prepared_at', 'simulation_id', 'report_id'
         ]
       ) || $4::jsonb,
       updated_at = now()
       where tenant_id = $1 and corpus_id = $2 and project_id = $3
       returning project_data`,
      [this.scope.tenantId, this.scope.corpusId, requiredProjectId(id), JSON.stringify(patch)],
      'reset MiroFish project'
    );
    return result.rows[0] ? readProjectRow(result.rows[0], 'reset') : null;
  }
}

let memoryStore: MemoryProjectStore | null = null;

export function getProjectStore(): MiroFishProjectStore {
  const config = getPostgresRuntimeConfig();
  if (shouldUsePostgresPersistence(config)) {
    assertPostgresPersistenceConfigured(config);
    const client = getPostgresClient(config);
    if (!client) throw new Error('PostgreSQL MiroFish project persistence is unavailable.');
    return new PostgresMiroFishProjectStore(client, {
      tenantId: config.defaultTenantId,
      corpusId: config.defaultCorpusId,
    });
  }
  memoryStore ??= new MemoryProjectStore();
  return memoryStore;
}

function createProject(request: CreateProjectRequest): Project {
  const now = new Date().toISOString();
  return {
    id: `proj_${randomUUID()}`,
    name: request.name,
    description: request.description || '',
    status: 'created',
    current_step: 0,
    simulation_requirement: request.simulation_requirement,
    texts: [],
    created_at: now,
    updated_at: now,
  };
}

function stripGeneratedState(project: Project): Project {
  const retained = structuredClone(project);
  const generatedKeys = [
    'ontology',
    'graph_data',
    'graph_id',
    'agent_profiles',
    'simulation_config',
    'prepare_id',
    'prepare_fingerprint',
    'prepared_at',
    'simulation_id',
    'report_id',
  ] as const;
  for (const key of generatedKeys) delete retained[key];
  return {
    ...retained,
    status: 'created',
    current_step: 0,
    updated_at: new Date().toISOString(),
  };
}

function readProjectRow(row: ProjectRow | undefined, label: string): Project {
  if (!row) throw new Error(`PostgreSQL did not return the ${label} MiroFish project.`);
  const value = row.project_data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored MiroFish project is malformed.');
  }
  const project = value as Partial<Project>;
  if (
    typeof project.id !== 'string'
    || typeof project.name !== 'string'
    || typeof project.simulation_requirement !== 'string'
    || !isProjectStatus(project.status)
    || !Number.isInteger(project.current_step)
    || !Array.isArray(project.texts)
    || typeof project.created_at !== 'string'
    || typeof project.updated_at !== 'string'
  ) {
    throw new Error('Stored MiroFish project is malformed.');
  }
  return structuredClone(project as Project);
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return value === 'created'
    || value === 'graph_built'
    || value === 'env_setup'
    || value === 'simulating'
    || value === 'report_generated'
    || value === 'completed';
}

function requiredProjectId(value: string): string {
  const id = value.trim();
  if (!/^proj_[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('MiroFish project identifier is invalid.');
  }
  return id;
}
