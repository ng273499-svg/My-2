import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  generateUuid,
  isValidUuid,
  normalizeConversationId,
} from '@/core/utils/uuid';
import type {
  AuditLogEntry,
  ChatMessage,
  ConversationSummary,
  MemoryEntry,
  PermissionRecord,
  PersonalityPreferences,
  ResponseStyle,
} from '@/core/types';
import type { Database } from '@/server/supabase/database.types';
import type {
  AgentTaskRecord,
  ConnectedToolRecord,
  DataRepository,
  DocumentChunkRecord,
  IngestedDocumentRecord,
  ListMemoriesFilter,
  MemoryUpdatePatch,
  ProactiveWorkflowRecord,
  ProjectRecord,
  UserProfileRecord,
} from './types';

export class SupabaseConnectivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConnectivityError';
  }
}

function isNetworkFailureMessage(msg: string): boolean {
  return /fetch failed|network|abort|timed? ?out|econnrefused|enotfound|ssl_error|socket/i.test(
    msg
  );
}

function assertSupabaseResult<T>(
  error: { message: string; code?: string } | null,
  context: string
): void {
  if (!error) return;
  if (isNetworkFailureMessage(error.message)) {
    throw new SupabaseConnectivityError(`${context}: ${error.message}`);
  }
  throw new Error(`${context}: ${error.message}`);
}

/**
 * Production User-Scoped Supabase Repository Adapter.
 * Uses an authenticated operator's JWT client so PostgreSQL FORCE ROW LEVEL SECURITY
 * (`auth.uid() = user_id`) governs every query across all 10 tables + pgvector RPC.
 */
export class SupabaseDataRepository implements DataRepository {
  public readonly mode = 'supabase_cloud' as const;

  constructor(private readonly client: SupabaseClient<Database>) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private table(name: keyof Database['public']['Tables']): any {
    return this.client.from(name);
  }

  async getProfile(userId: string): Promise<UserProfileRecord> {
    const { data, error } = await this.table('user_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    assertSupabaseResult(error, 'getProfile');

    if (!data) {
      return {
        id: userId,
        displayName: 'Operator',
        callsign: `OP-${userId.slice(0, 4).toUpperCase()}`,
        timezone: 'UTC',
        onboardingCompleted: false,
      };
    }

    return {
      id: data.id,
      displayName: data.display_name,
      callsign: data.callsign,
      timezone: data.timezone,
      onboardingCompleted: data.onboarding_completed,
    };
  }

  async updateProfile(
    userId: string,
    patch: Partial<Omit<UserProfileRecord, 'id'>>
  ): Promise<UserProfileRecord> {
    const payload: Database['public']['Tables']['user_profiles']['Insert'] = {
      id: userId,
      ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
      ...(patch.callsign !== undefined ? { callsign: patch.callsign } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.onboardingCompleted !== undefined
        ? { onboarding_completed: patch.onboardingCompleted }
        : {}),
    };

    const { data, error } = await this.table('user_profiles')
      .upsert(payload, { onConflict: 'id' })
      .select('*')
      .single();

    assertSupabaseResult(error, 'updateProfile');

    return {
      id: data.id,
      displayName: data.display_name,
      callsign: data.callsign,
      timezone: data.timezone,
      onboardingCompleted: data.onboarding_completed,
    };
  }

  async listProjects(userId: string): Promise<ProjectRecord[]> {
    const { data, error } = await this.table('projects')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    assertSupabaseResult(error, 'listProjects');

    return (data ?? []).map((row: Database['public']['Tables']['projects']['Row']) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description ?? undefined,
      status: row.status,
    }));
  }

  async createProject(
    userId: string,
    project: { name: string; slug: string; description?: string }
  ): Promise<ProjectRecord> {
    const { data, error } = await this.table('projects')
      .insert({
        user_id: userId,
        name: project.name,
        slug: project.slug,
        description: project.description ?? null,
      })
      .select('*')
      .single();

    assertSupabaseResult(error, 'createProject');

    await this.appendAuditLog(userId, {
      eventType: 'project.created',
      entityType: 'project',
      entityId: data.id,
      severity: 'info',
      summary: `Created workspace project "${data.name}".`,
    });

    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      description: data.description ?? undefined,
      status: data.status,
    };
  }

  async listConversations(userId: string, limit = 25): Promise<ConversationSummary[]> {
    const { data, error } = await this.table('conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('archived', false)
      .order('updated_at', { ascending: false })
      .limit(limit);

    assertSupabaseResult(error, 'listConversations');

    return (data ?? []).map((row: Database['public']['Tables']['conversations']['Row']) => ({
      id: row.id,
      title: row.title,
      projectId: row.project_id,
      activeModelId: row.active_model_id,
      lastResponseStyle: (row.last_response_style as ResponseStyle) || 'calm',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getConversation(
    userId: string,
    conversationId: string
  ): Promise<ConversationSummary | null> {
    const normId = normalizeConversationId(conversationId);
    const { data, error } = await this.table('conversations')
      .select('*')
      .eq('id', normId)
      .eq('user_id', userId)
      .maybeSingle();

    assertSupabaseResult(error, 'getConversation');
    if (!data) return null;

    return {
      id: data.id,
      title: data.title,
      projectId: data.project_id,
      activeModelId: data.active_model_id,
      lastResponseStyle: (data.last_response_style as ResponseStyle) || 'calm',
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async createConversation(
    userId: string,
    input?: { id?: string; title?: string; projectId?: string | null; style?: ResponseStyle }
  ): Promise<ConversationSummary> {
    const id = input?.id && isValidUuid(input.id) ? input.id : generateUuid();
    const title = input?.title?.trim() || 'New Command Session';

    const { data, error } = await this.table('conversations')
      .upsert(
        {
          id,
          user_id: userId,
          project_id: input?.projectId ?? null,
          title,
          last_response_style: input?.style ?? 'calm',
        },
        { onConflict: 'id' }
      )
      .select('*')
      .single();

    assertSupabaseResult(error, 'createConversation');

    await this.appendAuditLog(userId, {
      eventType: 'conversation.created',
      entityType: 'conversation',
      entityId: data.id,
      severity: 'info',
      summary: `Opened conversation "${data.title}".`,
    });

    return {
      id: data.id,
      title: data.title,
      projectId: data.project_id,
      activeModelId: data.active_model_id,
      lastResponseStyle: (data.last_response_style as ResponseStyle) || 'calm',
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async getMessages(userId: string, conversationId: string): Promise<ChatMessage[]> {
    const normId = normalizeConversationId(conversationId);
    const { data, error } = await this.table('conversation_messages')
      .select('*')
      .eq('conversation_id', normId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    assertSupabaseResult(error, 'getMessages');

    return (data ?? []).map(
      (row: Database['public']['Tables']['conversation_messages']['Row']) => {
        const meta =
          typeof row.metadata === 'object' && row.metadata !== null
            ? (row.metadata as Record<string, unknown>)
            : {};

        return {
          id: row.id,
          conversationId: row.conversation_id,
          role: row.role === 'tool' ? 'system' : row.role,
          content: row.content,
          createdAt: row.created_at,
          responseStyle: (row.response_style as ResponseStyle) ?? undefined,
          modelId: row.model_id ?? undefined,
          specialistAgent:
            (row.specialist_agent_id as ChatMessage['specialistAgent']) ?? undefined,
          pendingPermission:
            (meta.pendingPermission as ChatMessage['pendingPermission']) ?? undefined,
          verification:
            (meta.verification as ChatMessage['verification']) ?? undefined,
        };
      }
    );
  }

  async appendMessage(userId: string, message: ChatMessage): Promise<void> {
    const convId = normalizeConversationId(message.conversationId);
    const msgId = isValidUuid(message.id) ? message.id : generateUuid();

    // Ensure conversation belongs to this user first
    const existingConv = await this.getConversation(userId, convId);
    if (!existingConv) {
      const autoTitle =
        message.role === 'user'
          ? message.content.slice(0, 56) || 'Command Session'
          : 'Command Session';
      const { error: convErr } = await this.table('conversations').insert({
        id: convId,
        user_id: userId,
        title: autoTitle,
        last_response_style: message.responseStyle ?? 'calm',
      });
      assertSupabaseResult(convErr, 'appendMessage.ensureConversation');
    } else if (message.responseStyle) {
      await this.table('conversations')
        .update({ last_response_style: message.responseStyle })
        .eq('id', convId)
        .eq('user_id', userId);
    }

    const { error } = await this.table('conversation_messages').insert({
      id: msgId,
      conversation_id: convId,
      user_id: userId,
      role: message.role,
      content: message.content,
      response_style: message.responseStyle ?? null,
      model_id: message.modelId ?? null,
      specialist_agent_id: message.specialistAgent ?? null,
      verification_status: message.verification?.outcome ?? null,
      metadata: {
        ...(message.pendingPermission ? { pendingPermission: message.pendingPermission } : {}),
        ...(message.verification ? { verification: message.verification } : {}),
      },
    });

    assertSupabaseResult(error, 'appendMessage.insert');
  }

  private mapMemoryRow(
    row: Database['public']['Tables']['long_term_memories']['Row']
  ): MemoryEntry {
    return {
      id: row.id,
      projectId: row.project_id,
      category: row.category,
      memoryScope: row.memory_scope,
      memoryStatus: row.memory_status,
      content: row.content,
      tags: row.tags ?? [],
      importance: Math.min(5, Math.max(1, row.importance)) as 1 | 2 | 3 | 4 | 5,
      confidence: row.confidence,
      recallCount: row.recall_count,
      provenance: row.provenance,
      supersededById: row.superseded_by_id,
      sourceConversationId: row.source_conversation_id ?? undefined,
      verified: row.verified,
      lastRecalledAt: row.last_recalled_at,
      expiresAt: row.expires_at,
      metadata:
        typeof row.metadata === 'object' && row.metadata !== null
          ? (row.metadata as Record<string, unknown>)
          : {},
      persistenceLayer: 'supabase_cloud' as const,
      createdAt: row.created_at,
    };
  }

  async listMemories(
    userId: string,
    filter?: ListMemoriesFilter
  ): Promise<MemoryEntry[]> {
    let query = this.table('long_term_memories')
      .select(
        'id, user_id, project_id, category, memory_scope, memory_status, content, tags, importance, confidence, recall_count, provenance, superseded_by_id, source_conversation_id, verified, last_recalled_at, expires_at, metadata, created_at, updated_at'
      )
      .eq('user_id', userId);

    if (!filter?.includeSuperseded) {
      query = query.eq('memory_status', 'active');
    }
    if (filter?.scope) {
      query = query.eq('memory_scope', filter.scope);
    }
    if (filter?.projectId !== undefined) {
      query =
        filter.projectId === null
          ? query.is('project_id', null)
          : query.eq('project_id', filter.projectId);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(80);

    assertSupabaseResult(error, 'listMemories');

    const nowMs = Date.now();
    return (data ?? [])
      .map((row: Database['public']['Tables']['long_term_memories']['Row']) =>
        this.mapMemoryRow(row)
      )
      .filter((entry: MemoryEntry) => {
        if (
          !filter?.includeExpired &&
          entry.expiresAt &&
          new Date(entry.expiresAt).getTime() <= nowMs
        ) {
          return false;
        }
        return true;
      });
  }

  async addMemory(
    userId: string,
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'persistenceLayer'> & {
      embedding?: number[];
    }
  ): Promise<MemoryEntry> {
    const sourceConvId =
      entry.sourceConversationId && isValidUuid(entry.sourceConversationId)
        ? entry.sourceConversationId
        : null;
    const projId =
      entry.projectId && isValidUuid(entry.projectId) ? entry.projectId : null;
    const defaultScope =
      entry.memoryScope ??
      (projId || entry.category === 'project_context'
        ? 'project'
        : entry.category === 'episodic_summary'
          ? 'episodic'
          : entry.category === 'workflow'
            ? 'procedural'
            : entry.category === 'knowledge_chunk'
              ? 'knowledge'
              : entry.category === 'event_record'
                ? 'event'
                : 'semantic');

    const { data, error } = await this.table('long_term_memories')
      .insert({
        user_id: userId,
        project_id: projId,
        category: entry.category,
        memory_scope: defaultScope,
        memory_status: entry.memoryStatus ?? 'active',
        content: entry.content,
        tags: entry.tags,
        importance: entry.importance,
        confidence: entry.confidence ?? 0.92,
        recall_count: entry.recallCount ?? 0,
        provenance: entry.provenance ?? 'user_explicit',
        superseded_by_id:
          entry.supersededById && isValidUuid(entry.supersededById)
            ? entry.supersededById
            : null,
        source_conversation_id: sourceConvId,
        embedding: entry.embedding ? `[${entry.embedding.join(',')}]` : null,
        verified: entry.verified,
        expires_at: entry.expiresAt ?? null,
        metadata:
          (entry.metadata as Database['public']['Tables']['long_term_memories']['Insert']['metadata']) ??
          {},
      })
      .select(
        'id, user_id, project_id, category, memory_scope, memory_status, content, tags, importance, confidence, recall_count, provenance, superseded_by_id, source_conversation_id, verified, last_recalled_at, expires_at, metadata, created_at, updated_at'
      )
      .single();

    assertSupabaseResult(error, 'addMemory');

    await this.appendAuditLog(userId, {
      eventType: 'memory.stored',
      entityType: 'memory',
      entityId: data.id,
      severity: 'info',
      summary: `Persisted ${data.memory_scope}/${data.category} memory in Supabase long_term_memories.`,
    });

    return this.mapMemoryRow(data);
  }

  async updateMemory(
    userId: string,
    memoryId: string,
    patch: MemoryUpdatePatch
  ): Promise<MemoryEntry | null> {
    if (!isValidUuid(memoryId)) return null;

    const dbPatch: Database['public']['Tables']['long_term_memories']['Update'] = {};
    if (patch.memoryStatus !== undefined) dbPatch.memory_status = patch.memoryStatus;
    if (patch.supersededById !== undefined) {
      dbPatch.superseded_by_id =
        patch.supersededById && isValidUuid(patch.supersededById)
          ? patch.supersededById
          : null;
    }
    if (patch.recallCount !== undefined) dbPatch.recall_count = patch.recallCount;
    if (patch.lastRecalledAt !== undefined)
      dbPatch.last_recalled_at = patch.lastRecalledAt;
    if (patch.importance !== undefined) dbPatch.importance = patch.importance;
    if (patch.confidence !== undefined) dbPatch.confidence = patch.confidence;
    if (patch.tags !== undefined) dbPatch.tags = patch.tags;
    if (patch.expiresAt !== undefined) dbPatch.expires_at = patch.expiresAt;
    if (patch.metadata !== undefined) {
      dbPatch.metadata =
        patch.metadata as Database['public']['Tables']['long_term_memories']['Update']['metadata'];
    }

    const { data, error } = await this.table('long_term_memories')
      .update(dbPatch)
      .eq('id', memoryId)
      .eq('user_id', userId)
      .select(
        'id, user_id, project_id, category, memory_scope, memory_status, content, tags, importance, confidence, recall_count, provenance, superseded_by_id, source_conversation_id, verified, last_recalled_at, expires_at, metadata, created_at, updated_at'
      )
      .maybeSingle();

    assertSupabaseResult(error, 'updateMemory');
    if (!data) return null;
    return this.mapMemoryRow(data);
  }

  async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    if (!isValidUuid(memoryId)) return false;

    const { error } = await this.table('long_term_memories')
      .delete()
      .eq('id', memoryId)
      .eq('user_id', userId);

    assertSupabaseResult(error, 'deleteMemory');

    await this.appendAuditLog(userId, {
      eventType: 'memory.deleted',
      entityType: 'memory',
      entityId: memoryId,
      severity: 'warning',
      summary: `Deleted memory record ${memoryId}.`,
    });

    return true;
  }

  async searchMemoriesByVector(
    _userId: string,
    queryEmbedding: number[],
    matchThreshold = 0.72,
    matchCount = 8
  ): Promise<MemoryEntry[]> {
    // SECURITY INVOKER RPC automatically enforces `auth.uid() = user_id` in Postgres
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.client as any).rpc(
      'match_hierarchical_memories',
      {
        query_embedding: `[${queryEmbedding.join(',')}]`,
        match_threshold: matchThreshold,
        match_count: matchCount,
        filter_project_id: null,
        filter_scopes: null,
        include_superseded: false,
      }
    );

    assertSupabaseResult(error, 'searchMemoriesByVector');

    return (data ?? []).map(
      (
        row: Database['public']['Functions']['match_hierarchical_memories']['Returns'][number]
      ) => ({
        id: row.id,
        projectId: row.project_id,
        category: row.category,
        memoryScope: row.memory_scope,
        memoryStatus: row.memory_status,
        content: row.content,
        tags: row.tags ?? [],
        importance: Math.min(5, Math.max(1, row.importance)) as 1 | 2 | 3 | 4 | 5,
        confidence: row.confidence,
        recallCount: row.recall_count,
        provenance: row.provenance,
        verified: row.verified,
        lastRecalledAt: row.last_recalled_at,
        expiresAt: row.expires_at,
        similarity: row.similarity,
        persistenceLayer: 'supabase_cloud' as const,
        createdAt: row.created_at,
      })
    );
  }

  async getPreferences(userId: string): Promise<PersonalityPreferences> {
    const { data, error } = await this.table('preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    assertSupabaseResult(error, 'getPreferences');

    if (!data) {
      return {
        preferredResponseStyle: 'calm',
        voiceProfileId: 'jarvis-x-aria-female-v1',
        preferredBrowserVoiceUri: null,
        voiceMuted: false,
        voiceAutoSpeak: false,
        voiceBargeInEnabled: true,
        witLevel: 'subtle',
        conciseness: 'balanced',
        preferredModelProvider: 'auto',
        routingPolicy: 'AUTO_BALANCED',
        manualModelId: null,
        proactiveAssistanceEnabled: false,
        crossDeviceSyncEnabled: false,
      };
    }

    return {
      preferredResponseStyle: data.preferred_response_style as ResponseStyle,
      voiceProfileId: data.voice_profile_id,
      preferredBrowserVoiceUri: data.preferred_browser_voice_uri ?? null,
      voiceMuted: Boolean(data.voice_muted),
      voiceAutoSpeak: data.voice_auto_speak,
      voiceBargeInEnabled: data.voice_barge_in_enabled,
      witLevel: data.wit_level,
      conciseness: data.conciseness,
      preferredModelProvider: data.preferred_model_provider,
      routingPolicy: data.routing_policy ?? 'AUTO_BALANCED',
      manualModelId: data.manual_model_id ?? null,
      proactiveAssistanceEnabled: data.proactive_assistance_enabled,
      crossDeviceSyncEnabled: data.cross_device_sync_enabled,
    };
  }

  async updatePreferences(
    userId: string,
    patch: Partial<PersonalityPreferences>
  ): Promise<PersonalityPreferences> {
    const current = await this.getPreferences(userId);
    const merged = { ...current, ...patch };

    const { error } = await this.table('preferences').upsert(
      {
        user_id: userId,
        preferred_response_style: merged.preferredResponseStyle,
        voice_profile_id: merged.voiceProfileId,
        preferred_browser_voice_uri: merged.preferredBrowserVoiceUri ?? null,
        voice_muted: Boolean(merged.voiceMuted),
        voice_auto_speak: merged.voiceAutoSpeak,
        voice_barge_in_enabled: merged.voiceBargeInEnabled,
        wit_level: merged.witLevel,
        conciseness: merged.conciseness,
        preferred_model_provider: merged.preferredModelProvider,
        routing_policy: merged.routingPolicy ?? 'AUTO_BALANCED',
        manual_model_id: merged.manualModelId ?? null,
        proactive_assistance_enabled: merged.proactiveAssistanceEnabled,
        cross_device_sync_enabled: merged.crossDeviceSyncEnabled,
      },
      { onConflict: 'user_id' }
    );

    assertSupabaseResult(error, 'updatePreferences');

    await this.appendAuditLog(userId, {
      eventType: 'preferences.updated',
      entityType: 'preference',
      entityId: userId,
      severity: 'info',
      summary: `Updated operator preferences (${Object.keys(patch).join(', ')}).`,
    });

    return merged;
  }

  async listConnectedTools(userId: string): Promise<ConnectedToolRecord[]> {
    const { data, error } = await this.table('connected_tools')
      .select('*')
      .eq('user_id', userId)
      .order('tool_slug', { ascending: true });

    assertSupabaseResult(error, 'listConnectedTools');

    return (data ?? []).map((row: Database['public']['Tables']['connected_tools']['Row']) => ({
      id: row.id,
      toolSlug: row.tool_slug,
      displayName: row.display_name,
      category: row.category as ConnectedToolRecord['category'],
      connectionStatus: row.connection_status,
      defaultPermissionTier:
        row.default_permission_tier as ConnectedToolRecord['defaultPermissionTier'],
      scopes: row.scopes ?? [],
      updatedAt: row.updated_at,
    }));
  }

  async upsertConnectedTool(
    userId: string,
    tool: Omit<ConnectedToolRecord, 'id' | 'updatedAt'>
  ): Promise<ConnectedToolRecord> {
    const { data, error } = await this.table('connected_tools')
      .upsert(
        {
          user_id: userId,
          tool_slug: tool.toolSlug,
          display_name: tool.displayName,
          category: tool.category,
          connection_status: tool.connectionStatus,
          default_permission_tier: tool.defaultPermissionTier,
          scopes: tool.scopes,
          last_checked_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,tool_slug' }
      )
      .select('*')
      .single();

    assertSupabaseResult(error, 'upsertConnectedTool');

    await this.appendAuditLog(userId, {
      eventType: 'connected_tool.upserted',
      entityType: 'connected_tool',
      entityId: data.tool_slug,
      severity: 'info',
      summary: `Recorded connector metadata for "${data.display_name}" (${data.connection_status}).`,
    });

    return {
      id: data.id,
      toolSlug: data.tool_slug,
      displayName: data.display_name,
      category: data.category as ConnectedToolRecord['category'],
      connectionStatus: data.connection_status,
      defaultPermissionTier:
        data.default_permission_tier as ConnectedToolRecord['defaultPermissionTier'],
      scopes: data.scopes ?? [],
      updatedAt: data.updated_at,
    };
  }

  async recordAgentTask(
    userId: string,
    task: Omit<AgentTaskRecord, 'id' | 'createdAt'> & { id?: string }
  ): Promise<AgentTaskRecord> {
    const id = task.id && isValidUuid(task.id) ? task.id : generateUuid();
    const convId = isValidUuid(task.conversationId) ? task.conversationId : null;
    const projId = task.projectId && isValidUuid(task.projectId) ? task.projectId : null;
    const { data, error } = await this.table('agent_tasks')
      .upsert(
        {
          id,
          user_id: userId,
          conversation_id: convId,
          project_id: projId,
          specialist_agent: task.specialistAgent || 'direct_core',
          objective: task.objective,
          lifecycle_stage: task.lifecycleStage,
          permission_tier: task.permissionTier,
          status_summary: task.statusSummary,
          task_type: task.taskType ?? 'conversation',
          risk_level: task.riskLevel ?? 'READ_ONLY',
          selected_capability: task.selectedCapability ?? 'direct_conversation',
          execution_state: task.executionState ?? 'COMPLETED',
          approval_state: task.approvalState ?? 'not_required',
          verification_status: task.verificationStatus ?? 'VERIFIED',
          error_status: task.errorStatus ?? null,
          started_at: task.startedAt ?? new Date().toISOString(),
          completed_at: task.completedAt ?? null,
          result_payload:
            (task.resultPayload as Database['public']['Tables']['agent_tasks']['Insert']['result_payload']) ??
            {},
        },
        { onConflict: 'id' }
      )
      .select('*')
      .single();

    assertSupabaseResult(error, 'recordAgentTask');

    return {
      id: data.id,
      conversationId: data.conversation_id ?? '',
      projectId: data.project_id,
      specialistAgent: data.specialist_agent,
      objective: data.objective,
      lifecycleStage: data.lifecycle_stage,
      permissionTier: data.permission_tier,
      statusSummary: data.status_summary,
      taskType: data.task_type,
      riskLevel: data.risk_level as AgentTaskRecord['riskLevel'],
      selectedCapability: data.selected_capability,
      executionState: data.execution_state as AgentTaskRecord['executionState'],
      approvalState: data.approval_state as AgentTaskRecord['approvalState'],
      verificationStatus:
        data.verification_status as AgentTaskRecord['verificationStatus'],
      errorStatus: (data.error_status as AgentTaskRecord['errorStatus']) ?? null,
      startedAt: data.started_at,
      completedAt: data.completed_at,
      createdAt: data.created_at,
    };
  }

  async updateAgentTask(
    userId: string,
    taskId: string,
    patch: Partial<Omit<AgentTaskRecord, 'id' | 'createdAt'>>
  ): Promise<AgentTaskRecord | null> {
    if (!isValidUuid(taskId)) return null;

    const updatePayload: Database['public']['Tables']['agent_tasks']['Update'] = {
      ...(patch.lifecycleStage !== undefined ? { lifecycle_stage: patch.lifecycleStage } : {}),
      ...(patch.statusSummary !== undefined ? { status_summary: patch.statusSummary } : {}),
      ...(patch.executionState !== undefined ? { execution_state: patch.executionState } : {}),
      ...(patch.approvalState !== undefined ? { approval_state: patch.approvalState } : {}),
      ...(patch.verificationStatus !== undefined
        ? { verification_status: patch.verificationStatus }
        : {}),
      ...(patch.errorStatus !== undefined ? { error_status: patch.errorStatus } : {}),
      ...(patch.completedAt !== undefined ? { completed_at: patch.completedAt } : {}),
      ...(patch.resultPayload !== undefined
        ? {
            result_payload:
              patch.resultPayload as Database['public']['Tables']['agent_tasks']['Update']['result_payload'],
          }
        : {}),
    };

    const { data, error } = await this.table('agent_tasks')
      .update(updatePayload)
      .eq('id', taskId)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle();

    assertSupabaseResult(error, 'updateAgentTask');
    if (!data) return null;

    return {
      id: data.id,
      conversationId: data.conversation_id ?? '',
      projectId: data.project_id,
      specialistAgent: data.specialist_agent,
      objective: data.objective,
      lifecycleStage: data.lifecycle_stage,
      permissionTier: data.permission_tier,
      statusSummary: data.status_summary,
      taskType: data.task_type,
      riskLevel: data.risk_level as AgentTaskRecord['riskLevel'],
      selectedCapability: data.selected_capability,
      executionState: data.execution_state as AgentTaskRecord['executionState'],
      approvalState: data.approval_state as AgentTaskRecord['approvalState'],
      verificationStatus:
        data.verification_status as AgentTaskRecord['verificationStatus'],
      errorStatus: (data.error_status as AgentTaskRecord['errorStatus']) ?? null,
      startedAt: data.started_at,
      completedAt: data.completed_at,
      createdAt: data.created_at,
    };
  }

  async listAgentTasks(userId: string, limit = 20): Promise<AgentTaskRecord[]> {
    const { data, error } = await this.table('agent_tasks')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    assertSupabaseResult(error, 'listAgentTasks');

    return (data ?? []).map((row: Database['public']['Tables']['agent_tasks']['Row']) => ({
      id: row.id,
      conversationId: row.conversation_id ?? '',
      projectId: row.project_id,
      specialistAgent: row.specialist_agent,
      objective: row.objective,
      lifecycleStage: row.lifecycle_stage,
      permissionTier: row.permission_tier,
      statusSummary: row.status_summary,
      taskType: row.task_type,
      riskLevel: row.risk_level as AgentTaskRecord['riskLevel'],
      selectedCapability: row.selected_capability,
      executionState: row.execution_state as AgentTaskRecord['executionState'],
      approvalState: row.approval_state as AgentTaskRecord['approvalState'],
      verificationStatus:
        row.verification_status as AgentTaskRecord['verificationStatus'],
      errorStatus: (row.error_status as AgentTaskRecord['errorStatus']) ?? null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    }));
  }

  async recordPermission(userId: string, record: PermissionRecord): Promise<void> {
    const id = isValidUuid(record.id) ? record.id : generateUuid();
    const convId = isValidUuid(record.conversationId) ? record.conversationId : null;

    const { error } = await this.table('permission_records').insert({
      id,
      user_id: userId,
      conversation_id: convId,
      action_code: record.actionCode,
      target_resource: record.targetResource,
      permission_tier: record.tier,
      decision: record.decision,
      verified_auth_method: record.verifiedAuthMethod ?? null,
      rationale: record.rationale,
      created_at: record.createdAt,
      resolved_at: record.resolvedAt ?? null,
    });

    assertSupabaseResult(error, 'recordPermission');

    await this.appendAuditLog(userId, {
      eventType: `permission.${record.decision}`,
      entityType: 'permission',
      entityId: id,
      severity: record.tier === 'SENSITIVE_AUTH_REQUIRED' ? 'warning' : 'info',
      summary: `Recorded ${record.tier} permission check (${record.actionCode} -> ${record.decision}).`,
    });
  }

  async updatePermissionDecision(
    userId: string,
    recordId: string,
    decision: PermissionRecord['decision'],
    verifiedAuthMethod?: string
  ): Promise<PermissionRecord | null> {
    if (!isValidUuid(recordId)) return null;

    const resolvedAt = new Date().toISOString();
    const { data, error } = await this.table('permission_records')
      .update({
        decision,
        verified_auth_method: verifiedAuthMethod ?? null,
        resolved_at: resolvedAt,
      })
      .eq('id', recordId)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle();

    assertSupabaseResult(error, 'updatePermissionDecision');
    if (!data) return null;

    await this.appendAuditLog(userId, {
      eventType: `permission.resolved.${decision}`,
      entityType: 'permission',
      entityId: recordId,
      severity: decision === 'blocked_unauthenticated' ? 'critical' : 'info',
      summary: `Resolved permission ${data.action_code} as ${decision}.`,
    });

    return {
      id: data.id,
      conversationId: data.conversation_id ?? '',
      actionCode: data.action_code,
      targetResource: data.target_resource,
      tier: data.permission_tier as PermissionRecord['tier'],
      decision: data.decision as PermissionRecord['decision'],
      verifiedAuthMethod: data.verified_auth_method ?? undefined,
      rationale: data.rationale ?? '',
      createdAt: data.created_at,
      resolvedAt: data.resolved_at ?? undefined,
    };
  }

  async listPermissionRecords(userId: string, limit = 25): Promise<PermissionRecord[]> {
    const { data, error } = await this.table('permission_records')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    assertSupabaseResult(error, 'listPermissionRecords');

    return (data ?? []).map(
      (row: Database['public']['Tables']['permission_records']['Row']) => ({
        id: row.id,
        conversationId: row.conversation_id ?? '',
        actionCode: row.action_code,
        targetResource: row.target_resource,
        tier: row.permission_tier as PermissionRecord['tier'],
        decision: row.decision as PermissionRecord['decision'],
        verifiedAuthMethod: row.verified_auth_method ?? undefined,
        rationale: row.rationale ?? '',
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? undefined,
      })
    );
  }

  async appendAuditLog(
    userId: string,
    entry: Omit<AuditLogEntry, 'id' | 'createdAt'>
  ): Promise<AuditLogEntry> {
    const { data, error } = await this.table('audit_logs')
      .insert({
        user_id: userId,
        event_type: entry.eventType,
        entity_type: entry.entityType,
        entity_id: entry.entityId ?? null,
        severity: entry.severity,
        summary: entry.summary,
        metadata: (entry.metadata as Database['public']['Tables']['audit_logs']['Insert']['metadata']) ?? {},
      })
      .select('*')
      .single();

    assertSupabaseResult(error, 'appendAuditLog');

    return {
      id: data.id,
      eventType: data.event_type,
      entityType: data.entity_type as AuditLogEntry['entityType'],
      entityId: data.entity_id ?? undefined,
      severity: data.severity,
      summary: data.summary,
      metadata:
        typeof data.metadata === 'object' && data.metadata !== null
          ? (data.metadata as Record<string, unknown>)
          : undefined,
      createdAt: data.created_at,
    };
  }

  async listAuditLogs(userId: string, limit = 30): Promise<AuditLogEntry[]> {
    const { data, error } = await this.table('audit_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    assertSupabaseResult(error, 'listAuditLogs');

    return (data ?? []).map((row: Database['public']['Tables']['audit_logs']['Row']) => ({
      id: row.id,
      eventType: row.event_type,
      entityType: row.entity_type as AuditLogEntry['entityType'],
      entityId: row.entity_id ?? undefined,
      severity: row.severity,
      summary: row.summary,
      metadata:
        typeof data.metadata === 'object' && data.metadata !== null
          ? (data.metadata as Record<string, unknown>)
          : undefined,
      createdAt: row.created_at,
    }));
  }

  async recordIngestedDocument(
    userId: string,
    doc: Omit<IngestedDocumentRecord, 'id' | 'createdAt'>
  ): Promise<IngestedDocumentRecord> {
    const { data, error } = await this.table('ingested_documents')
      .insert({
        user_id: userId,
        project_id: doc.projectId ?? null,
        file_name: doc.fileName,
        mime_type: doc.mimeType,
        format_kind: doc.formatKind,
        size_bytes: doc.sizeBytes,
        chunk_count: doc.chunkCount,
        injection_flagged: doc.injectionFlagged,
        summary: doc.summary,
        metadata:
          (doc.metadata as Database['public']['Tables']['ingested_documents']['Insert']['metadata']) ??
          {},
        content_hash: doc.contentHash ?? null,
        page_count: doc.pageCount ?? 0,
        lifecycle: doc.lifecycle ?? 'READY',
        parser: doc.parser ?? null,
        parser_version: doc.parserVersion ?? null,
        embedding_mode: doc.embeddingMode ?? null,
        ocr_required: doc.ocrRequired ?? false,
        page_provenance_available: doc.pageProvenanceAvailable ?? false,
        trust_level: doc.trustLevel ?? 'untrusted_external',
      })
      .select('*')
      .single();

    assertSupabaseResult(error, 'recordIngestedDocument');

    return {
      id: data.id,
      projectId: data.project_id,
      fileName: data.file_name,
      mimeType: data.mime_type,
      formatKind: data.format_kind,
      sizeBytes: data.size_bytes,
      chunkCount: data.chunk_count,
      injectionFlagged: data.injection_flagged,
      summary: data.summary,
      metadata:
        typeof data.metadata === 'object' && data.metadata !== null
          ? (data.metadata as Record<string, unknown>)
          : {},
      createdAt: data.created_at,
      contentHash: data.content_hash ?? null,
      pageCount: data.page_count ?? 0,
      lifecycle: data.lifecycle ?? 'READY',
      parser: data.parser ?? null,
      parserVersion: data.parser_version ?? null,
      embeddingMode: data.embedding_mode ?? null,
      ocrRequired: data.ocr_required ?? false,
      pageProvenanceAvailable: data.page_provenance_available ?? false,
      trustLevel: data.trust_level ?? 'untrusted_external',
    };
  }

  async listIngestedDocuments(
    userId: string,
    limit = 20
  ): Promise<IngestedDocumentRecord[]> {
    const { data, error } = await this.table('ingested_documents')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    assertSupabaseResult(error, 'listIngestedDocuments');

    return (data ?? []).map(
      (row: Database['public']['Tables']['ingested_documents']['Row']) => ({
        id: row.id,
        projectId: row.project_id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        formatKind: row.format_kind,
        sizeBytes: row.size_bytes,
        chunkCount: row.chunk_count,
        injectionFlagged: row.injection_flagged,
        summary: row.summary,
        metadata:
          typeof row.metadata === 'object' && row.metadata !== null
            ? (row.metadata as Record<string, unknown>)
            : {},
        createdAt: row.created_at,
        contentHash: row.content_hash ?? null,
        pageCount: row.page_count ?? 0,
        lifecycle: row.lifecycle ?? 'READY',
        parser: row.parser ?? null,
        parserVersion: row.parser_version ?? null,
        embeddingMode: row.embedding_mode ?? null,
        ocrRequired: row.ocr_required ?? false,
        pageProvenanceAvailable: row.page_provenance_available ?? false,
        trustLevel: row.trust_level ?? 'untrusted_external',
      })
    );
  }

  private mapDocumentRow(
    row: Database['public']['Tables']['ingested_documents']['Row']
  ): IngestedDocumentRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      formatKind: row.format_kind,
      sizeBytes: row.size_bytes,
      chunkCount: row.chunk_count,
      injectionFlagged: row.injection_flagged,
      summary: row.summary,
      metadata:
        typeof row.metadata === 'object' && row.metadata !== null
          ? (row.metadata as Record<string, unknown>)
          : {},
      createdAt: row.created_at,
      contentHash: row.content_hash ?? null,
      pageCount: row.page_count ?? 0,
      lifecycle: row.lifecycle ?? 'READY',
      parser: row.parser ?? null,
      parserVersion: row.parser_version ?? null,
      embeddingMode: row.embedding_mode ?? null,
      ocrRequired: row.ocr_required ?? false,
      pageProvenanceAvailable: row.page_provenance_available ?? false,
      trustLevel: row.trust_level ?? 'untrusted_external',
    };
  }

  async getIngestedDocument(
    userId: string,
    documentId: string
  ): Promise<IngestedDocumentRecord | null> {
    const { data, error } = await this.table('ingested_documents')
      .select('*')
      .eq('user_id', userId)
      .eq('id', documentId)
      .is('deleted_at', null)
      .maybeSingle();

    assertSupabaseResult(error, 'getIngestedDocument');
    if (!data) return null;
    return this.mapDocumentRow(data);
  }

  async deleteIngestedDocument(userId: string, documentId: string): Promise<boolean> {
    // Chunks are removed by the ON DELETE CASCADE foreign key, which is itself
    // protected by owner-scoped RLS delete policies.
    const { error, count } = await this.table('ingested_documents')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .eq('id', documentId);

    assertSupabaseResult(error, 'deleteIngestedDocument');
    return (count ?? 0) > 0;
  }

  async recordDocumentChunks(
    userId: string,
    documentId: string,
    chunks: Array<Omit<DocumentChunkRecord, 'id' | 'documentId' | 'createdAt'>>
  ): Promise<number> {
    if (chunks.length === 0) return 0;

    const rows = chunks.map((chunk) => ({
      document_id: documentId,
      user_id: userId,
      project_id: chunk.projectId ?? null,
      chunk_index: chunk.chunkIndex,
      chunk_key: chunk.chunkKey,
      section: chunk.section ?? null,
      heading_path: chunk.headingPath,
      page: chunk.page ?? null,
      page_start: chunk.pageStart ?? null,
      page_end: chunk.pageEnd ?? null,
      text_content: chunk.textContent,
      char_count: chunk.charCount,
      token_estimate: chunk.tokenEstimate,
      content_hash: chunk.contentHash,
      trust_level: chunk.trustLevel,
    }));

    // Bounded batches keep every request small.
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const { error, count } = await this.table('document_chunks').insert(batch, {
        count: 'exact',
      });
      assertSupabaseResult(error, 'recordDocumentChunks');
      inserted += count ?? batch.length;
    }
    return inserted;
  }

  async listDocumentChunks(
    userId: string,
    documentId: string,
    limit = 500
  ): Promise<DocumentChunkRecord[]> {
    const { data, error } = await this.table('document_chunks')
      .select('*')
      .eq('user_id', userId)
      .eq('document_id', documentId)
      .order('chunk_index', { ascending: true })
      .limit(limit);

    assertSupabaseResult(error, 'listDocumentChunks');

    return (data ?? []).map(
      (row: Database['public']['Tables']['document_chunks']['Row']) => ({
        id: row.id,
        documentId: row.document_id,
        projectId: row.project_id,
        chunkIndex: row.chunk_index,
        chunkKey: row.chunk_key,
        section: row.section,
        headingPath: row.heading_path ?? [],
        page: row.page,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        textContent: row.text_content,
        charCount: row.char_count,
        tokenEstimate: row.token_estimate,
        contentHash: row.content_hash,
        trustLevel: row.trust_level,
        createdAt: row.created_at,
      })
    );
  }

  async deleteDocumentChunks(userId: string, documentId: string): Promise<number> {
    const { error, count } = await this.table('document_chunks')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .eq('document_id', documentId);

    assertSupabaseResult(error, 'deleteDocumentChunks');
    return count ?? 0;
  }

  async listProactiveWorkflows(userId: string): Promise<ProactiveWorkflowRecord[]> {
    const { data, error } = await this.table('proactive_workflows')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    assertSupabaseResult(error, 'listProactiveWorkflows');

    return (data ?? []).map(
      (row: Database['public']['Tables']['proactive_workflows']['Row']) => ({
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        description: row.description,
        directivePrompt: row.directive_prompt,
        triggerKind: row.trigger_kind,
        scheduleHint: row.schedule_hint,
        riskLevel: row.risk_level,
        enabled: row.enabled,
        runCount: row.run_count,
        lastRunAt: row.last_run_at,
        metadata:
          typeof row.metadata === 'object' && row.metadata !== null
            ? (row.metadata as Record<string, unknown>)
            : {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    );
  }

  async createProactiveWorkflow(
    userId: string,
    workflow: Omit<
      ProactiveWorkflowRecord,
      'id' | 'runCount' | 'lastRunAt' | 'createdAt' | 'updatedAt'
    >
  ): Promise<ProactiveWorkflowRecord> {
    const { data, error } = await this.table('proactive_workflows')
      .insert({
        user_id: userId,
        project_id: workflow.projectId ?? null,
        title: workflow.title,
        description: workflow.description,
        directive_prompt: workflow.directivePrompt,
        trigger_kind: workflow.triggerKind,
        schedule_hint: workflow.scheduleHint ?? null,
        risk_level: workflow.riskLevel,
        enabled: workflow.enabled,
        metadata:
          (workflow.metadata as Database['public']['Tables']['proactive_workflows']['Insert']['metadata']) ??
          {},
      })
      .select('*')
      .single();

    assertSupabaseResult(error, 'createProactiveWorkflow');

    return {
      id: data.id,
      projectId: data.project_id,
      title: data.title,
      description: data.description,
      directivePrompt: data.directive_prompt,
      triggerKind: data.trigger_kind,
      scheduleHint: data.schedule_hint,
      riskLevel: data.risk_level,
      enabled: data.enabled,
      runCount: data.run_count,
      lastRunAt: data.last_run_at,
      metadata:
        typeof data.metadata === 'object' && data.metadata !== null
          ? (data.metadata as Record<string, unknown>)
          : {},
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async updateProactiveWorkflow(
    userId: string,
    workflowId: string,
    patch: Partial<
      Pick<
        ProactiveWorkflowRecord,
        'title' | 'description' | 'directivePrompt' | 'enabled' | 'runCount' | 'lastRunAt' | 'metadata'
      >
    >
  ): Promise<ProactiveWorkflowRecord | null> {
    const updatePayload: Database['public']['Tables']['proactive_workflows']['Update'] = {
      updated_at: new Date().toISOString(),
    };
    if (patch.title !== undefined) updatePayload.title = patch.title;
    if (patch.description !== undefined) updatePayload.description = patch.description;
    if (patch.directivePrompt !== undefined)
      updatePayload.directive_prompt = patch.directivePrompt;
    if (patch.enabled !== undefined) updatePayload.enabled = patch.enabled;
    if (patch.runCount !== undefined) updatePayload.run_count = patch.runCount;
    if (patch.lastRunAt !== undefined) updatePayload.last_run_at = patch.lastRunAt;
    if (patch.metadata !== undefined) {
      updatePayload.metadata =
        patch.metadata as Database['public']['Tables']['proactive_workflows']['Update']['metadata'];
    }

    const { data, error } = await this.table('proactive_workflows')
      .update(updatePayload)
      .eq('id', workflowId)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle();

    assertSupabaseResult(error, 'updateProactiveWorkflow');
    if (!data) return null;

    return {
      id: data.id,
      projectId: data.project_id,
      title: data.title,
      description: data.description,
      directivePrompt: data.directive_prompt,
      triggerKind: data.trigger_kind,
      scheduleHint: data.schedule_hint,
      riskLevel: data.risk_level,
      enabled: data.enabled,
      runCount: data.run_count,
      lastRunAt: data.last_run_at,
      metadata:
        typeof data.metadata === 'object' && data.metadata !== null
          ? (data.metadata as Record<string, unknown>)
          : {},
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async deleteProactiveWorkflow(
    userId: string,
    workflowId: string
  ): Promise<boolean> {
    const { data, error } = await this.table('proactive_workflows')
      .delete()
      .eq('id', workflowId)
      .eq('user_id', userId)
      .select('id');

    assertSupabaseResult(error, 'deleteProactiveWorkflow');
    return Array.isArray(data) && data.length > 0;
  }
}
