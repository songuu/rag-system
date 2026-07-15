export interface SupabaseRestClientConfig {
  url: string;
  /**
   * Legacy credential used by the admin client. When provided on its own it is
   * sent as both the apikey and bearer credential, preserving existing service-role behavior.
   */
  key?: string;
  /** Public/anon project key used for Supabase gateway authentication. */
  apiKey?: string;
  /** Request-scoped user JWT used for PostgREST RLS and Auth user lookup. */
  accessToken?: string;
  /** Injectable transport keeps security/auth tests hermetic. */
  fetchImpl?: typeof fetch;
}

export interface SupabaseAuthUser {
  id: string;
  email?: string;
  [key: string]: unknown;
}

export interface SelectRowsOptions {
  select?: string;
  filters?: Record<string, string | number | boolean>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function toPostgrestValue(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

export class SupabaseRestError extends Error {
  readonly status: number;
  readonly context: string;

  constructor(context: string, response: Response, body: string) {
    super(
      `${context} failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`
    );
    this.name = 'SupabaseRestError';
    this.status = response.status;
    this.context = context;
  }
}

function ensureOk(response: Response, context: string): Promise<Response> {
  if (response.ok) return Promise.resolve(response);

  return response.text().then((body) => {
    throw new SupabaseRestError(context, response, body);
  });
}

export class SupabaseRestClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SupabaseRestClientConfig) {
    this.baseUrl = trimTrailingSlash(config.url);
    this.apiKey = config.apiKey || config.key || '';
    this.accessToken = config.accessToken || config.key || this.apiKey;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.apiKey && this.accessToken && this.fetchImpl);
  }

  private headers(extra?: HeadersInit): HeadersInit {
    return {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.accessToken}`,
      ...extra,
    };
  }

  async getAuthUser<T extends SupabaseAuthUser = SupabaseAuthUser>(): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: this.headers({ Accept: 'application/json' }),
    });
    await ensureOk(response, 'get auth user');
    return await response.json() as T;
  }

  private restUrl(table: string, options: SelectRowsOptions = {}): URL {
    const url = new URL(`${this.baseUrl}/rest/v1/${table}`);
    url.searchParams.set('select', options.select ?? '*');

    for (const [column, value] of Object.entries(options.filters ?? {})) {
      url.searchParams.set(column, `eq.${toPostgrestValue(value)}`);
    }

    if (options.order) {
      const direction = options.order.ascending === false ? 'desc' : 'asc';
      url.searchParams.set('order', `${options.order.column}.${direction}`);
    }

    if (options.limit !== undefined) {
      url.searchParams.set('limit', String(options.limit));
    }

    return url;
  }

  async selectRows<T>(table: string, options: SelectRowsOptions = {}): Promise<T[]> {
    const response = await this.fetchImpl(this.restUrl(table, options), {
      method: 'GET',
      headers: this.headers({ Accept: 'application/json' }),
    });
    await ensureOk(response, `select ${table}`);
    return await response.json() as T[];
  }

  async selectSingle<T>(table: string, options: SelectRowsOptions = {}): Promise<T | null> {
    const rows = await this.selectRows<T>(table, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async insertRows(
    table: string,
    rows: Record<string, unknown> | Array<Record<string, unknown>>
  ): Promise<unknown[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Prefer: 'return=representation',
      }),
      body: JSON.stringify(rows),
    });
    await ensureOk(response, `insert ${table}`);
    return await response.json() as unknown[];
  }

  async upsertRows(
    table: string,
    rows: Record<string, unknown> | Array<Record<string, unknown>>,
    options: { onConflict?: string } = {}
  ): Promise<unknown[]> {
    const url = new URL(`${this.baseUrl}/rest/v1/${table}`);
    if (options.onConflict) {
      url.searchParams.set('on_conflict', options.onConflict);
    }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      }),
      body: JSON.stringify(rows),
    });
    await ensureOk(response, `upsert ${table}`);
    return await response.json() as unknown[];
  }

  async updateRows(
    table: string,
    filters: Record<string, string | number | boolean>,
    updates: Record<string, unknown>
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}/rest/v1/${table}`);
    for (const [column, value] of Object.entries(filters)) {
      url.searchParams.set(column, `eq.${toPostgrestValue(value)}`);
    }

    const response = await this.fetchImpl(url, {
      method: 'PATCH',
      headers: this.headers({
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      }),
      body: JSON.stringify(updates),
    });
    await ensureOk(response, `update ${table}`);
  }

  async deleteRows(table: string, filters: Record<string, string | number | boolean>): Promise<void> {
    const url = new URL(`${this.baseUrl}/rest/v1/${table}`);
    for (const [column, value] of Object.entries(filters)) {
      url.searchParams.set(column, `eq.${toPostgrestValue(value)}`);
    }

    const response = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: this.headers({ Prefer: 'return=minimal' }),
    });
    await ensureOk(response, `delete ${table}`);
  }

  async uploadObject(input: {
    bucket: string;
    path: string;
    body: string | Uint8Array;
    contentType?: string;
    upsert?: boolean;
  }): Promise<void> {
    const body: BodyInit = typeof input.body === 'string'
      ? input.body
      : input.body as unknown as BodyInit;
    const response = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/${encodeURIComponent(input.bucket)}/${input.path}`,
      {
        method: 'POST',
        headers: this.headers({
          'Content-Type': input.contentType ?? 'application/octet-stream',
          'x-upsert': input.upsert === false ? 'false' : 'true',
        }),
        body,
      }
    );
    await ensureOk(response, `upload ${input.bucket}/${input.path}`);
  }

  async objectExists(bucket: string, path: string): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`, {
      method: 'HEAD',
      headers: this.headers(),
    });
    if (response.status === 404) return false;
    await ensureOk(response, `check object ${bucket}/${path}`);
    return true;
  }

  async downloadText(bucket: string, path: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`, {
      method: 'GET',
      headers: this.headers(),
    });
    await ensureOk(response, `download ${bucket}/${path}`);
    return await response.text();
  }

  async removeObjects(bucket: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const response = await this.fetchImpl(`${this.baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: 'DELETE',
      headers: this.headers({
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      }),
      body: JSON.stringify({ prefixes: paths }),
    });
    await ensureOk(response, `remove objects from ${bucket}`);
  }
}
