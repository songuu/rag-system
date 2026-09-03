import { randomUUID } from 'node:crypto';
import { getPostgresClient, queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { getPostgresRuntimeConfig, type PostgresRuntimeConfig } from '../postgres/env';
import type { OptimizationAnalysis, PromptOptimizerMode, PromptVariables, VersionKind } from './contracts';
import type { ModelProfileRuntimeInput } from './providers';
import { decryptPromptOptimizerCredential, encryptPromptOptimizerCredential } from './credentials';

export interface StoredModelProfile extends ModelProfileRuntimeInput {
  isDefault: boolean;
  archivedAt: string | null;
  hasCredential: boolean;
}

export interface PromptVersion {
  workspaceId: string;
  versionNumber: number;
  parentVersion: number | null;
  kind: VersionKind;
  prompt: string;
  instruction: string;
  analysis: OptimizationAnalysis | Record<string, unknown>;
  variables: PromptVariables;
  modelProfileId: string | null;
  templateId: string;
  createdAt: string;
}

interface VersionRow {
  workspace_id: string; version_number: number; parent_version: number | null; kind: VersionKind;
  prompt: string; instruction: string | null; analysis: OptimizationAnalysis | Record<string, unknown>;
  variables_snapshot: PromptVariables; model_profile_id: string | null; template_id: string; created_at: Date | string;
}

export class PostgresPromptOptimizerStore {
  private readonly config: PostgresRuntimeConfig;
  private readonly client: PostgresQueryClient | null;
  private readonly scope: { tenantId: string; corpusId: string };

  constructor(
    config: PostgresRuntimeConfig = getPostgresRuntimeConfig(),
    client: PostgresQueryClient | null = getPostgresClient(config),
    scope: { tenantId: string; corpusId: string } = { tenantId: config.defaultTenantId, corpusId: config.defaultCorpusId }
  ) {
    if (!client) throw new Error('Prompt optimizer requires configured PostgreSQL persistence.');
    this.config = config;
    this.client = client;
    this.scope = scope;
  }

  async createWorkspace(input: {
    title: string; originalPrompt: string; mode: PromptOptimizerMode; variables: PromptVariables;
    selectedModelProfileId: string | null;
  }) {
    const workspaceId = randomUUID();
    const result = await this.query<Record<string, unknown>>(
      `insert into public.prompt_optimizer_workspaces
       (tenant_id, corpus_id, workspace_id, title, original_prompt, mode, variables, selected_model_profile_id)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       returning *`,
      [this.tenantId, this.corpusId, workspaceId, input.title, input.originalPrompt, input.mode,
        JSON.stringify(input.variables), input.selectedModelProfileId],
      'create prompt optimizer workspace'
    );
    return result.rows[0];
  }

  async listWorkspaces() {
    return (await this.query<Record<string, unknown>>(
      `select * from public.prompt_optimizer_workspaces
       where tenant_id = $1 and corpus_id = $2 order by updated_at desc, workspace_id limit 30`,
      [this.tenantId, this.corpusId], 'list prompt optimizer workspaces'
    )).rows;
  }

  async getWorkspace(workspaceId: string) {
    return (await this.query<Record<string, unknown>>(
      `select * from public.prompt_optimizer_workspaces
       where tenant_id = $1 and corpus_id = $2 and workspace_id = $3`,
      [this.tenantId, this.corpusId, workspaceId], 'read prompt optimizer workspace'
    )).rows[0] ?? null;
  }

  async listModelProfiles(): Promise<StoredModelProfile[]> {
    const result = await this.query<Record<string, unknown>>(
      `select profile_id, name, provider, model, base_url, settings, is_default, archived_at,
              credential_envelope is not null as has_credential
       from public.prompt_optimizer_model_profiles
       where tenant_id = $1 and corpus_id = $2 and archived_at is null
       order by is_default desc, name, profile_id`,
      [this.tenantId, this.corpusId], 'list prompt optimizer model profiles'
    );
    return result.rows.map(row => mapProfile(row, this.scope));
  }

  async getModelProfile(profileId: string): Promise<StoredModelProfile | null> {
    const result = await this.query<Record<string, unknown>>(
      `select profile_id, name, provider, model, base_url, settings, is_default, archived_at, credential_envelope
       from public.prompt_optimizer_model_profiles
       where tenant_id = $1 and corpus_id = $2 and profile_id = $3 and archived_at is null`,
      [this.tenantId, this.corpusId, profileId], 'read prompt optimizer model profile'
    );
    return result.rows[0] ? mapProfile(result.rows[0], this.scope) : null;
  }

  async getDefaultModelProfile(): Promise<StoredModelProfile | null> {
    const result = await this.query<Record<string, unknown>>(
      `select profile_id, name, provider, model, base_url, settings, is_default, archived_at, credential_envelope
       from public.prompt_optimizer_model_profiles
       where tenant_id = $1 and corpus_id = $2 and archived_at is null
       order by is_default desc, name, profile_id limit 1`,
      [this.tenantId, this.corpusId], 'read default prompt optimizer model profile'
    );
    return result.rows[0] ? mapProfile(result.rows[0], this.scope) : null;
  }

  async saveModelProfile(profile: StoredModelProfile): Promise<StoredModelProfile> {
    const result = await this.query<Record<string, unknown>>(
      `with cleared as (
         update public.prompt_optimizer_model_profiles
         set is_default = false, version = version + 1
         where tenant_id = $1 and corpus_id = $2 and profile_id <> $3 and is_default and $9::boolean
       ), saved as (
         insert into public.prompt_optimizer_model_profiles
           (tenant_id, corpus_id, profile_id, name, provider, model, base_url, settings, is_default, credential_envelope)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         on conflict (tenant_id, corpus_id, profile_id) do update
         set name = excluded.name, provider = excluded.provider, model = excluded.model,
             base_url = excluded.base_url, settings = excluded.settings, is_default = excluded.is_default,
             credential_envelope = case
               when excluded.credential_envelope is not null then excluded.credential_envelope
               when excluded.provider = public.prompt_optimizer_model_profiles.provider
                 and excluded.base_url is not distinct from public.prompt_optimizer_model_profiles.base_url
               then public.prompt_optimizer_model_profiles.credential_envelope
               else null end,
             archived_at = null, version = public.prompt_optimizer_model_profiles.version + 1
         returning profile_id, name, provider, model, base_url, settings, is_default, archived_at, credential_envelope
       ) select * from saved`,
      [this.tenantId, this.corpusId, profile.profileId, profile.name, profile.provider, profile.model,
        profile.baseUrl, JSON.stringify(profile.settings), profile.isDefault, profile.credential ? encryptPromptOptimizerCredential(profile.credential, credentialBinding(this.scope, profile)) : null],
      'save prompt optimizer model profile'
    );
    return mapProfile(result.rows[0], this.scope);
  }

  async listVersions(workspaceId: string): Promise<PromptVersion[]> {
    const result = await this.query<VersionRow>(
      `select * from public.prompt_optimizer_versions
       where tenant_id = $1 and corpus_id = $2 and workspace_id = $3
       order by version_number desc limit 200`,
      [this.tenantId, this.corpusId, workspaceId], 'list prompt optimizer versions'
    );
    return result.rows.map(mapVersion);
  }

  async appendVersion(input: {
    workspaceId: string; kind: VersionKind; prompt: string; instruction: string;
    analysis: OptimizationAnalysis | Record<string, unknown>; variables: PromptVariables;
    modelProfileId: string | null; templateId: string; expectedCurrentVersion: number;
    parentVersion?: number | null;
  }): Promise<PromptVersion> {
    const result = await this.query<VersionRow>(
      `with advanced as (
         update public.prompt_optimizer_workspaces
         set current_version = current_version + 1, version = version + 1, updated_at = now()
         where tenant_id = $1 and corpus_id = $2 and workspace_id = $3 and current_version = $4
         returning current_version
       ), inserted as (
         insert into public.prompt_optimizer_versions
           (tenant_id, corpus_id, workspace_id, version_number, parent_version, kind, prompt, instruction,
            analysis, variables_snapshot, model_profile_id, template_id)
         select $1, $2, $3, advanced.current_version, $5, $6, $7, nullif($8, ''),
                $9::jsonb, $10::jsonb, $11, $12
         from advanced
         returning *
       ) select * from inserted`,
      [this.tenantId, this.corpusId, input.workspaceId, input.expectedCurrentVersion,
        input.parentVersion ?? (input.expectedCurrentVersion > 0 ? input.expectedCurrentVersion : null), input.kind,
        input.prompt, input.instruction, JSON.stringify(input.analysis), JSON.stringify(input.variables),
        input.modelProfileId, input.templateId],
      'append prompt optimizer version'
    );
    if (!result.rows[0]) throw new Error('Prompt optimizer workspace version conflict. Refresh and retry.');
    return mapVersion(result.rows[0]);
  }

  private get tenantId() { return this.scope.tenantId; }
  private get corpusId() { return this.scope.corpusId; }

  private query<T>(text: string, values: unknown[], operation: string) {
    return queryPostgres<T>(this.client as PostgresQueryClient, text, values, operation);
  }
}

function mapVersion(row: VersionRow): PromptVersion {
  return {
    workspaceId: row.workspace_id,
    versionNumber: Number(row.version_number),
    parentVersion: row.parent_version === null ? null : Number(row.parent_version),
    kind: row.kind,
    prompt: row.prompt,
    instruction: row.instruction ?? '',
    analysis: row.analysis ?? {},
    variables: row.variables_snapshot ?? {},
    modelProfileId: row.model_profile_id,
    templateId: row.template_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
  };
}

function mapProfile(row: Record<string, unknown>, scope: { tenantId: string; corpusId: string }): StoredModelProfile {
  const envelope = typeof row.credential_envelope === 'string' ? row.credential_envelope : null;
  return {
    profileId: String(row.profile_id), name: String(row.name),
    provider: row.provider as StoredModelProfile['provider'], model: String(row.model),
    baseUrl: typeof row.base_url === 'string' ? row.base_url : null,
    settings: typeof row.settings === 'object' && row.settings !== null ? row.settings as Record<string, unknown> : {},
    isDefault: row.is_default === true,
    archivedAt: row.archived_at ? String(row.archived_at) : null,
    credential: envelope ? decryptPromptOptimizerCredential(envelope, credentialBinding(scope, { profileId: String(row.profile_id), provider: String(row.provider) })) : null,
    hasCredential: row.has_credential === true || Boolean(envelope),
  };
}

function credentialBinding(scope: { tenantId: string; corpusId: string }, profile: { profileId: string; provider: string }) {
  return [scope.tenantId, scope.corpusId, profile.profileId, profile.provider, 'v1'].join('\0');
}
