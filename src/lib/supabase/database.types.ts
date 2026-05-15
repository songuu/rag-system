export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TraceStatus = 'PENDING' | 'SUCCESS' | 'ERROR';
export type ObservationType = 'GENERATION' | 'SPAN' | 'EVENT';
export type ObservationLevel = 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR';
export type TraceScoreSource = 'USER' | 'AI' | 'SYSTEM';
export type IndexJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type IndexJobType = 'parse' | 'embed' | 'milvus_sync' | 'reindex' | 'cleanup';
export type VectorBackend = 'milvus' | 'zilliz' | 'supabase_pgvector';

export interface Database {
  public: {
    Tables: {
      tenants: {
        Row: {
          id: string;
          name: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['tenants']['Insert']>;
      };
      corpora: {
        Row: {
          id: string;
          tenant_id: string;
          name: string;
          source_kind: string;
          metadata: JsonValue;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          name: string;
          source_kind: string;
          metadata?: JsonValue;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['corpora']['Insert']>;
      };
      document_assets: {
        Row: {
          id: string;
          tenant_id: string;
          corpus_id: string;
          original_name: string;
          content_type: string;
          byte_size: number;
          source_hash: string;
          storage_bucket: string;
          storage_path: string;
          parsed_bucket: string | null;
          parsed_path: string | null;
          parse_method: string | null;
          metadata: JsonValue;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          corpus_id: string;
          original_name: string;
          content_type: string;
          byte_size?: number;
          source_hash: string;
          storage_bucket: string;
          storage_path: string;
          parsed_bucket?: string | null;
          parsed_path?: string | null;
          parse_method?: string | null;
          metadata?: JsonValue;
          created_by?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['document_assets']['Insert']>;
      };
      index_jobs: {
        Row: {
          id: string;
          tenant_id: string;
          corpus_id: string | null;
          document_id: string | null;
          job_type: IndexJobType;
          status: IndexJobStatus;
          progress: number;
          error: string | null;
          metadata: JsonValue;
          created_by: string | null;
          created_at: string;
          started_at: string | null;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          corpus_id?: string | null;
          document_id?: string | null;
          job_type: IndexJobType;
          status?: IndexJobStatus;
          progress?: number;
          error?: string | null;
          metadata?: JsonValue;
          created_by?: string | null;
          created_at?: string;
          started_at?: string | null;
          completed_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['index_jobs']['Insert']>;
      };
      traces: {
        Row: {
          id: string;
          tenant_id: string;
          user_id: string | null;
          session_id: string | null;
          name: string;
          input: JsonValue;
          output: JsonValue;
          metadata: JsonValue;
          tags: string[];
          status: TraceStatus;
          started_at: string;
          ended_at: string | null;
        };
        Insert: {
          id: string;
          tenant_id: string;
          user_id?: string | null;
          session_id?: string | null;
          name: string;
          input?: JsonValue;
          output?: JsonValue;
          metadata?: JsonValue;
          tags?: string[];
          status?: TraceStatus;
          started_at?: string;
          ended_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['traces']['Insert']>;
      };
      observations: {
        Row: {
          id: string;
          trace_id: string;
          parent_observation_id: string | null;
          type: ObservationType;
          name: string;
          input: JsonValue;
          output: JsonValue;
          model: string | null;
          usage: JsonValue;
          metadata: JsonValue;
          level: ObservationLevel;
          status_message: string | null;
          started_at: string;
          ended_at: string | null;
        };
        Insert: {
          id: string;
          trace_id: string;
          parent_observation_id?: string | null;
          type: ObservationType;
          name: string;
          input?: JsonValue;
          output?: JsonValue;
          model?: string | null;
          usage?: JsonValue;
          metadata?: JsonValue;
          level?: ObservationLevel;
          status_message?: string | null;
          started_at?: string;
          ended_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['observations']['Insert']>;
      };
      trace_scores: {
        Row: {
          id: string;
          trace_id: string;
          observation_id: string | null;
          name: string;
          value: JsonValue;
          source: TraceScoreSource;
          comment: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          trace_id: string;
          observation_id?: string | null;
          name: string;
          value: JsonValue;
          source: TraceScoreSource;
          comment?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['trace_scores']['Insert']>;
      };
    };
  };
}

export type TableName = keyof Database['public']['Tables'];
export type TableRow<T extends TableName> = Database['public']['Tables'][T]['Row'];
export type TableInsert<T extends TableName> = Database['public']['Tables'][T]['Insert'];
export type TableUpdate<T extends TableName> = Database['public']['Tables'][T]['Update'];
