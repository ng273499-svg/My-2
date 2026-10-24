export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      user_profiles: {
        Row: {
          id: string;
          display_name: string;
          callsign: string;
          avatar_url: string | null;
          timezone: string;
          locale: string;
          onboarding_completed: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name?: string;
          callsign?: string;
          avatar_url?: string | null;
          timezone?: string;
          locale?: string;
          onboarding_completed?: boolean;
        };
        Update: Partial<Database['public']['Tables']['user_profiles']['Insert']>;
      };
      projects: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          slug: string;
          description: string | null;
          status: 'active' | 'paused' | 'archived';
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          slug: string;
          description?: string | null;
          status?: 'active' | 'paused' | 'archived';
          metadata?: Json;
        };
        Update: Partial<Database['public']['Tables']['projects']['Insert']>;
      };
      conversations: {
        Row: {
          id: string;
          user_id: string;
          project_id: string | null;
          title: string;
          summary: string | null;
          active_model_id: string;
          last_response_style: string;
          archived: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          project_id?: string | null;
          title?: string;
          summary?: string | null;
          active_model_id?: string;
          last_response_style?: string;
          archived?: boolean;
        };
        Update: Partial<Database['public']['Tables']['conversations']['Insert']>;
      };
      conversation_messages: {
        Row: {
          id: string;
          conversation_id: string;
          user_id: string;
          role: 'user' | 'assistant' | 'system' | 'tool';
          content: string;
          response_style: string | null;
          model_id: string | null;
          specialist_agent_id: string | null;
          verification_status: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          user_id: string;
          role: 'user' | 'assistant' | 'system' | 'tool';
          content: string;
          response_style?: string | null;
          model_id?: string | null;
          specialist_agent_id?: string | null;
          verification_status?: string | null;
          metadata?: Json;
        };
        Update: Partial<Database['public']['Tables']['conversation_messages']['Insert']>;
      };
      long_term_memories: {
        Row: {
          id: string;
          user_id: string;
          project_id: string | null;
          category:
            | 'preference'
            | 'fact'
            | 'project_context'
            | 'episodic_summary'
            | 'workflow'
            | 'knowledge_chunk'
            | 'event_record';
          memory_scope:
            | 'working'
            | 'episodic'
            | 'semantic'
            | 'project'
            | 'knowledge'
            | 'procedural'
            | 'event';
          memory_status: 'active' | 'superseded' | 'archived';
          content: string;
          tags: string[];
          importance: number;
          confidence: number;
          recall_count: number;
          provenance:
            | 'user_explicit'
            | 'operator_manual'
            | 'episodic_consolidation'
            | 'system_seed'
            | 'untrusted_external';
          superseded_by_id: string | null;
          source_conversation_id: string | null;
          embedding: string | number[] | null;
          verified: boolean;
          last_recalled_at: string | null;
          expires_at: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          project_id?: string | null;
          category?:
            | 'preference'
            | 'fact'
            | 'project_context'
            | 'episodic_summary'
            | 'workflow'
            | 'knowledge_chunk'
            | 'event_record';
          memory_scope?:
            | 'working'
            | 'episodic'
            | 'semantic'
            | 'project'
            | 'knowledge'
            | 'procedural'
            | 'event';
          memory_status?: 'active' | 'superseded' | 'archived';
          content: string;
          tags?: string[];
          importance?: number;
          confidence?: number;
          recall_count?: number;
          provenance?:
            | 'user_explicit'
            | 'operator_manual'
            | 'episodic_consolidation'
            | 'system_seed'
            | 'untrusted_external';
          superseded_by_id?: string | null;
          source_conversation_id?: string | null;
          embedding?: string | number[] | null;
          verified?: boolean;
          last_recalled_at?: string | null;
          expires_at?: string | null;
          metadata?: Json;
        };
        Update: Partial<Database['public']['Tables']['long_term_memories']['Insert']>;
      };
      agent_tasks: {
        Row: {
          id: string;
          user_id: string;
          conversation_id: string | null;
          project_id: string | null;
          specialist_agent: string;
          objective: string;
          lifecycle_stage: string;
          permission_tier: string;
          status_summary: string;
          result_payload: Json;
          task_type: string;
          risk_level: string;
          selected_capability: string;
          execution_state: string;
          approval_state: string;
          verification_status: string;
          error_status: string | null;
          started_at: string;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          conversation_id?: string | null;
          project_id?: string | null;
          specialist_agent: string;
          objective: string;
          lifecycle_stage?: string;
          permission_tier?: string;
          status_summary: string;
          result_payload?: Json;
          task_type?: string;
          risk_level?: string;
          selected_capability?: string;
          execution_state?: string;
          approval_state?: string;
          verification_status?: string;
          error_status?: string | null;
          started_at?: string;
          completed_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['agent_tasks']['Insert']>;
      };
      connected_tools: {
        Row: {
          id: string;
          user_id: string;
          tool_slug: string;
          display_name: string;
          category: string;
          connection_status: 'connected' | 'not_connected' | 'degraded' | 'revoked';
          default_permission_tier: string;
          vault_secret_ref: string | null;
          scopes: string[];
          metadata: Json;
          last_checked_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          tool_slug: string;
          display_name: string;
          category: string;
          connection_status?: 'connected' | 'not_connected' | 'degraded' | 'revoked';
          default_permission_tier?: string;
          vault_secret_ref?: string | null;
          scopes?: string[];
          metadata?: Json;
          last_checked_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['connected_tools']['Insert']>;
      };
      preferences: {
        Row: {
          user_id: string;
          preferred_response_style: string;
          voice_profile_id: string;
          preferred_browser_voice_uri: string | null;
          voice_muted: boolean;
          voice_auto_speak: boolean;
          voice_barge_in_enabled: boolean;
          wit_level: 'minimal' | 'subtle' | 'moderate';
          conciseness: 'brief' | 'balanced' | 'detailed';
          preferred_model_provider: string;
          routing_policy:
            | 'AUTO_BALANCED'
            | 'QUALITY_FIRST'
            | 'SPEED_FIRST'
            | 'COST_AWARE'
            | 'MANUAL';
          manual_model_id: string | null;
          proactive_assistance_enabled: boolean;
          cross_device_sync_enabled: boolean;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          preferred_response_style?: string;
          voice_profile_id?: string;
          preferred_browser_voice_uri?: string | null;
          voice_muted?: boolean;
          voice_auto_speak?: boolean;
          voice_barge_in_enabled?: boolean;
          wit_level?: 'minimal' | 'subtle' | 'moderate';
          conciseness?: 'brief' | 'balanced' | 'detailed';
          preferred_model_provider?: string;
          routing_policy?:
            | 'AUTO_BALANCED'
            | 'QUALITY_FIRST'
            | 'SPEED_FIRST'
            | 'COST_AWARE'
            | 'MANUAL';
          manual_model_id?: string | null;
          proactive_assistance_enabled?: boolean;
          cross_device_sync_enabled?: boolean;
        };
        Update: Partial<Database['public']['Tables']['preferences']['Insert']>;
      };
      permission_records: {
        Row: {
          id: string;
          user_id: string;
          conversation_id: string | null;
          action_code: string;
          target_resource: string;
          permission_tier: string;
          decision: string;
          verified_auth_method: string | null;
          rationale: string | null;
          created_at: string;
          resolved_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          conversation_id?: string | null;
          action_code: string;
          target_resource: string;
          permission_tier: string;
          decision: string;
          verified_auth_method?: string | null;
          rationale?: string | null;
          resolved_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['permission_records']['Insert']>;
      };
      audit_logs: {
        Row: {
          id: string;
          user_id: string;
          event_type: string;
          entity_type: string;
          entity_id: string | null;
          severity: 'info' | 'warning' | 'critical';
          summary: string;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          event_type: string;
          entity_type: string;
          entity_id?: string | null;
          severity?: 'info' | 'warning' | 'critical';
          summary: string;
          metadata?: Json;
          created_at?: string;
        };
        Update: never;
      };
      ingested_documents: {
        Row: {
          id: string;
          user_id: string;
          project_id: string | null;
          file_name: string;
          mime_type: string;
          size_bytes: number;
          format_kind: 'markdown' | 'text' | 'csv' | 'json' | 'code' | 'pdf' | 'docx' | 'html' | 'xml' | 'yaml' | 'toml';
          chunk_count: number;
          injection_flagged: boolean;
          summary: string;
          metadata: Json;
          created_at: string;
          updated_at: string;
          content_hash: string | null;
          page_count: number;
          lifecycle: string;
          parser: string | null;
          parser_version: string | null;
          embedding_mode: string | null;
          ocr_required: boolean;
          page_provenance_available: boolean;
          trust_level: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          project_id?: string | null;
          file_name: string;
          mime_type?: string;
          size_bytes?: number;
          format_kind?: 'markdown' | 'text' | 'csv' | 'json' | 'code' | 'pdf' | 'docx' | 'html' | 'xml' | 'yaml' | 'toml';
          chunk_count?: number;
          injection_flagged?: boolean;
          summary?: string;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
          content_hash?: string | null;
          page_count?: number;
          lifecycle?: string;
          parser?: string | null;
          parser_version?: string | null;
          embedding_mode?: string | null;
          ocr_required?: boolean;
          page_provenance_available?: boolean;
          trust_level?: string;
          deleted_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['ingested_documents']['Insert']>;
      };
      document_chunks: {
        Row: {
          id: string;
          document_id: string;
          user_id: string;
          project_id: string | null;
          chunk_index: number;
          chunk_key: string;
          section: string | null;
          heading_path: string[];
          page: number | null;
          page_start: number | null;
          page_end: number | null;
          text_content: string;
          char_count: number;
          token_estimate: number;
          content_hash: string;
          trust_level: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          document_id: string;
          user_id: string;
          project_id?: string | null;
          chunk_index?: number;
          chunk_key: string;
          section?: string | null;
          heading_path?: string[];
          page?: number | null;
          page_start?: number | null;
          page_end?: number | null;
          text_content: string;
          char_count?: number;
          token_estimate?: number;
          content_hash: string;
          trust_level?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['document_chunks']['Insert']>;
      };
      proactive_workflows: {
        Row: {
          id: string;
          user_id: string;
          project_id: string | null;
          title: string;
          description: string;
          trigger_kind: 'manual' | 'session_start' | 'interval_advisory' | 'event_watch';
          schedule_hint: string | null;
          directive_prompt: string;
          risk_level: 'READ_ONLY' | 'LOW_RISK' | 'CONFIRMATION_REQUIRED' | 'SENSITIVE';
          enabled: boolean;
          run_count: number;
          last_run_at: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          project_id?: string | null;
          title: string;
          description?: string;
          trigger_kind?: 'manual' | 'session_start' | 'interval_advisory' | 'event_watch';
          schedule_hint?: string | null;
          directive_prompt: string;
          risk_level?: 'READ_ONLY' | 'LOW_RISK' | 'CONFIRMATION_REQUIRED' | 'SENSITIVE';
          enabled?: boolean;
          run_count?: number;
          last_run_at?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['proactive_workflows']['Insert']>;
      };
    };
    Functions: {
      match_long_term_memories: {
        Args: {
          query_embedding: number[] | string;
          match_threshold?: number;
          match_count?: number;
          filter_project_id?: string | null;
        };
        Returns: Array<{
          id: string;
          category:
            | 'preference'
            | 'fact'
            | 'project_context'
            | 'episodic_summary'
            | 'workflow'
            | 'knowledge_chunk'
            | 'event_record';
          content: string;
          tags: string[];
          importance: number;
          verified: boolean;
          similarity: number;
          created_at: string;
        }>;
      };
      match_hierarchical_memories: {
        Args: {
          query_embedding: number[] | string;
          match_threshold?: number;
          match_count?: number;
          filter_project_id?: string | null;
          filter_scope?: string | null;
        };
        Returns: Array<{
          id: string;
          project_id: string | null;
          category:
            | 'preference'
            | 'fact'
            | 'project_context'
            | 'episodic_summary'
            | 'workflow'
            | 'knowledge_chunk'
            | 'event_record';
          memory_scope:
            | 'working'
            | 'episodic'
            | 'semantic'
            | 'project'
            | 'knowledge'
            | 'procedural'
            | 'event';
          memory_status: 'active' | 'superseded' | 'archived';
          content: string;
          tags: string[];
          importance: number;
          confidence: number;
          recall_count: number;
          provenance:
            | 'user_explicit'
            | 'operator_manual'
            | 'episodic_consolidation'
            | 'system_seed'
            | 'untrusted_external';
          verified: boolean;
          similarity: number;
          last_recalled_at: string | null;
          expires_at: string | null;
          metadata: Json;
          created_at: string;
        }>;
      };
    };
  };
}
