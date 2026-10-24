'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuditLogEntry,
  ChatMessage,
  ConversationSummary,
  MemoryEntry,
  PermissionRecord,
  PersonalityPreferences,
  ResponseStyle,
  TurnResponse,
} from '@/core/types';
import { isValidUuid, normalizeConversationId } from '@/core/utils/uuid';
import type { Database } from '@/server/supabase/database.types';

let browserClientPromise: Promise<SupabaseClient<Database> | null> | null = null;

export interface BrowserOperatorSession {
  userId: string;
  email: string;
  displayName: string;
  accessToken: string;
}

export async function getBrowserSupabaseClient(): Promise<SupabaseClient<Database> | null> {
  if (typeof window === 'undefined') return null;

  if (!browserClientPromise) {
    browserClientPromise = (async () => {
      try {
        const res = await fetch('/api/jarvis/auth/public-config');
        const data = await res.json();
        if (!data?.ok || !data.configured || !data.url || !data.anonKey) {
          return null;
        }
        return createClient<Database>(data.url, data.anonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            storageKey: 'jarvis-x-supabase-auth',
          },
        });
      } catch {
        return null;
      }
    })();
  }

  return browserClientPromise;
}

export async function getActiveBrowserSession(): Promise<BrowserOperatorSession | null> {
  const client = await getBrowserSupabaseClient();
  if (!client) return null;

  try {
    const { data } = await client.auth.getSession();
    const session = data?.session;
    if (!session?.user) return null;

    const email = session.user.email ?? 'operator@jarvis-x';
    const displayName =
      (session.user.user_metadata?.display_name as string | undefined) ||
      email.split('@')[0] ||
      'Operator';

    return {
      userId: session.user.id,
      email,
      displayName,
      accessToken: session.access_token,
    };
  } catch {
    return null;
  }
}

export async function signUpOperatorBrowser(input: {
  email: string;
  password: string;
  displayName?: string;
}): Promise<{ ok: boolean; session: BrowserOperatorSession | null; error?: string }> {
  const client = await getBrowserSupabaseClient();
  if (!client) {
    return {
      ok: false,
      session: null,
      error: 'Supabase public configuration is unavailable.',
    };
  }

  try {
    const { data, error } = await client.auth.signUp({
      email: input.email.trim(),
      password: input.password,
      options: {
        data: {
          display_name: input.displayName?.trim() || input.email.split('@')[0],
        },
      },
    });

    if (error) {
      return { ok: false, session: null, error: error.message };
    }

    if (!data.session || !data.user) {
      return {
        ok: true,
        session: null,
        error: 'Account registered. Check your email confirmation link if required before signing in.',
      };
    }

    const email = data.user.email ?? input.email;
    return {
      ok: true,
      session: {
        userId: data.user.id,
        email,
        displayName:
          (data.user.user_metadata?.display_name as string | undefined) ||
          email.split('@')[0],
        accessToken: data.session.access_token,
      },
    };
  } catch (err) {
    return {
      ok: false,
      session: null,
      error:
        err instanceof Error
          ? `Supabase Auth unreachable: ${err.message}`
          : 'Supabase Auth connection failed.',
    };
  }
}

export async function signInOperatorBrowser(input: {
  email: string;
  password: string;
}): Promise<{ ok: boolean; session: BrowserOperatorSession | null; error?: string }> {
  const client = await getBrowserSupabaseClient();
  if (!client) {
    return {
      ok: false,
      session: null,
      error: 'Supabase public configuration is unavailable.',
    };
  }

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: input.email.trim(),
      password: input.password,
    });

    if (error || !data.session || !data.user) {
      return {
        ok: false,
        session: null,
        error: error?.message || 'Invalid email or password.',
      };
    }

    const email = data.user.email ?? input.email;
    return {
      ok: true,
      session: {
        userId: data.user.id,
        email,
        displayName:
          (data.user.user_metadata?.display_name as string | undefined) ||
          email.split('@')[0],
        accessToken: data.session.access_token,
      },
    };
  } catch (err) {
    return {
      ok: false,
      session: null,
      error:
        err instanceof Error
          ? `Supabase Auth unreachable: ${err.message}`
          : 'Supabase Auth connection failed.',
    };
  }
}

export async function signOutOperatorBrowser(): Promise<void> {
  const client = await getBrowserSupabaseClient();
  if (!client) return;
  try {
    await client.auth.signOut();
  } catch {
    // Ignore transient signout transport errors
  }
}

/**
 * Direct Browser RLS Cloud Workspace Loader
 * Used when the operator is authenticated in the browser and server-side container
 * egress to *.supabase.co is firewalled (`degraded_fallback`). Every query executes
 * under PostgreSQL FORCE ROW LEVEL SECURITY (`auth.uid() = user_id`).
 */
export async function loadCloudRlsWorkspace(
  userId: string,
  conversationId: string
): Promise<{
  synced: boolean;
  conversations?: ConversationSummary[];
  messages?: ChatMessage[];
  memories?: MemoryEntry[];
  preferences?: PersonalityPreferences;
  permissionAudit?: PermissionRecord[];
  auditLogs?: AuditLogEntry[];
  error?: string;
}> {
  const client = await getBrowserSupabaseClient();
  if (!client) return { synced: false, error: 'Browser Supabase client not initialized.' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;
  const normConvId = normalizeConversationId(conversationId);

  try {
    const [convRes, msgRes, memRes, prefRes, permRes, auditRes] = await Promise.all([
      db
        .from('conversations')
        .select('*')
        .eq('user_id', userId)
        .eq('archived', false)
        .order('updated_at', { ascending: false })
        .limit(20),
      db
        .from('conversation_messages')
        .select('*')
        .eq('conversation_id', normConvId)
        .eq('user_id', userId)
        .order('created_at', { ascending: true }),
      db
        .from('long_term_memories')
        .select('id, category, content, tags, importance, source_conversation_id, verified, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(25),
      db.from('preferences').select('*').eq('user_id', userId).maybeSingle(),
      db
        .from('permission_records')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20),
      db
        .from('audit_logs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(25),
    ]);

    if (convRes.error) {
      return { synced: false, error: convRes.error.message };
    }

    const conversations: ConversationSummary[] = (convRes.data ?? []).map(
      (r: Database['public']['Tables']['conversations']['Row']) => ({
        id: r.id,
        title: r.title,
        projectId: r.project_id,
        activeModelId: r.active_model_id,
        lastResponseStyle: (r.last_response_style as ResponseStyle) || 'calm',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })
    );

    const messages: ChatMessage[] = (msgRes.data ?? []).map(
      (r: Database['public']['Tables']['conversation_messages']['Row']) => {
        const meta =
          typeof r.metadata === 'object' && r.metadata !== null
            ? (r.metadata as Record<string, unknown>)
            : {};
        return {
          id: r.id,
          conversationId: r.conversation_id,
          role: r.role === 'tool' ? 'system' : r.role,
          content: r.content,
          createdAt: r.created_at,
          responseStyle: (r.response_style as ResponseStyle) ?? undefined,
          modelId: r.model_id ?? undefined,
          specialistAgent:
            (r.specialist_agent_id as ChatMessage['specialistAgent']) ?? undefined,
          pendingPermission:
            (meta.pendingPermission as ChatMessage['pendingPermission']) ?? undefined,
          verification:
            (meta.verification as ChatMessage['verification']) ?? undefined,
        };
      }
    );

    const memories: MemoryEntry[] = (memRes.data ?? []).map(
      (r: Database['public']['Tables']['long_term_memories']['Row']) => ({
        id: r.id,
        projectId: r.project_id,
        category: r.category,
        memoryScope: r.memory_scope ?? 'semantic',
        memoryStatus: r.memory_status ?? 'active',
        content: r.content,
        tags: r.tags ?? [],
        importance: Math.min(5, Math.max(1, r.importance)) as 1 | 2 | 3 | 4 | 5,
        confidence: r.confidence ?? 0.9,
        recallCount: r.recall_count ?? 0,
        provenance: r.provenance ?? 'user_explicit',
        supersededById: r.superseded_by_id,
        sourceConversationId: r.source_conversation_id ?? undefined,
        verified: r.verified,
        lastRecalledAt: r.last_recalled_at,
        expiresAt: r.expires_at,
        persistenceLayer: 'supabase_cloud' as const,
        createdAt: r.created_at,
      })
    );

    const preferences: PersonalityPreferences | undefined = prefRes.data
      ? {
          preferredResponseStyle: prefRes.data.preferred_response_style as ResponseStyle,
          voiceProfileId: prefRes.data.voice_profile_id,
          preferredBrowserVoiceUri: prefRes.data.preferred_browser_voice_uri ?? null,
          voiceMuted: Boolean(prefRes.data.voice_muted),
          voiceAutoSpeak: prefRes.data.voice_auto_speak,
          voiceBargeInEnabled: prefRes.data.voice_barge_in_enabled,
          witLevel: prefRes.data.wit_level,
          conciseness: prefRes.data.conciseness,
          preferredModelProvider: prefRes.data.preferred_model_provider,
          routingPolicy: prefRes.data.routing_policy ?? 'AUTO_BALANCED',
          manualModelId: prefRes.data.manual_model_id ?? null,
          proactiveAssistanceEnabled: prefRes.data.proactive_assistance_enabled,
          crossDeviceSyncEnabled: prefRes.data.cross_device_sync_enabled,
        }
      : undefined;

    const permissionAudit: PermissionRecord[] = (permRes.data ?? []).map(
      (r: Database['public']['Tables']['permission_records']['Row']) => ({
        id: r.id,
        conversationId: r.conversation_id ?? '',
        actionCode: r.action_code,
        targetResource: r.target_resource,
        tier: r.permission_tier as PermissionRecord['tier'],
        decision: r.decision as PermissionRecord['decision'],
        verifiedAuthMethod: r.verified_auth_method ?? undefined,
        rationale: r.rationale ?? '',
        createdAt: r.created_at,
        resolvedAt: r.resolved_at ?? undefined,
      })
    );

    const auditLogs: AuditLogEntry[] = (auditRes.data ?? []).map(
      (r: Database['public']['Tables']['audit_logs']['Row']) => ({
        id: r.id,
        eventType: r.event_type,
        entityType: r.entity_type as AuditLogEntry['entityType'],
        entityId: r.entity_id ?? undefined,
        severity: r.severity,
        summary: r.summary,
        createdAt: r.created_at,
      })
    );

    return {
      synced: true,
      conversations,
      messages,
      memories,
      preferences,
      permissionAudit,
      auditLogs,
    };
  } catch (err) {
    return {
      synced: false,
      error: err instanceof Error ? err.message : 'Browser RLS sync failed.',
    };
  }
}

export async function mirrorTurnToCloudRls(
  userId: string,
  turn: TurnResponse
): Promise<boolean> {
  const client = await getBrowserSupabaseClient();
  if (!client) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;

  try {
    const convId = normalizeConversationId(turn.conversationId);
    await db.from('conversations').upsert(
      {
        id: convId,
        user_id: userId,
        title: turn.userMessage.content.slice(0, 56) || 'Command Session',
        last_response_style: turn.contextSignals.recommendedStyle,
      },
      { onConflict: 'id' }
    );

    await db.from('conversation_messages').upsert(
      [
        {
          id: turn.userMessage.id,
          conversation_id: convId,
          user_id: userId,
          role: 'user',
          content: turn.userMessage.content,
          created_at: turn.userMessage.createdAt,
        },
        {
          id: turn.assistantMessage.id,
          conversation_id: convId,
          user_id: userId,
          role: 'assistant',
          content: turn.assistantMessage.content,
          response_style: turn.assistantMessage.responseStyle ?? null,
          model_id: turn.assistantMessage.modelId ?? null,
          specialist_agent_id: turn.assistantMessage.specialistAgent ?? null,
          verification_status: turn.verification.outcome,
          metadata: {
            ...(turn.pendingPermission ? { pendingPermission: turn.pendingPermission } : {}),
            verification: turn.verification,
          },
          created_at: turn.assistantMessage.createdAt,
        },
      ],
      { onConflict: 'id' }
    );

    if (turn.pendingPermission && isValidUuid(turn.pendingPermission.id)) {
      await db.from('permission_records').upsert(
        {
          id: turn.pendingPermission.id,
          user_id: userId,
          conversation_id: convId,
          action_code: turn.pendingPermission.actionCode,
          target_resource: turn.pendingPermission.targetResource,
          permission_tier: turn.pendingPermission.tier,
          decision: 'pending',
          rationale: turn.pendingPermission.impactDescription,
        },
        { onConflict: 'id' }
      );
    }

    if (turn.runtime?.metadata && isValidUuid(turn.runtime.metadata.taskId)) {
      const m = turn.runtime.metadata;
      await db.from('agent_tasks').upsert(
        {
          id: m.taskId,
          user_id: userId,
          conversation_id: convId,
          project_id: m.projectId,
          specialist_agent: m.selectedSpecialist ?? 'direct_core',
          objective: turn.runtime.plan.conciseSummary,
          lifecycle_stage: m.executionState,
          permission_tier: turn.runtime.riskClassification.mappedPermissionTier,
          status_summary: turn.runtime.verification.summary.slice(0, 260),
          task_type: m.taskType,
          risk_level: m.riskLevel,
          selected_capability: m.selectedCapability,
          execution_state: m.executionState,
          approval_state: m.approvalState,
          verification_status: m.verificationStatus,
          error_status: m.errorStatus,
          started_at: m.startedAt,
          completed_at: m.completedAt,
        },
        { onConflict: 'id' }
      );
    }

    return true;
  } catch {
    return false;
  }
}

export async function mirrorPreferencesToCloudRls(
  userId: string,
  prefs: PersonalityPreferences
): Promise<boolean> {
  const client = await getBrowserSupabaseClient();
  if (!client) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;

  try {
    const { error } = await db.from('preferences').upsert(
      {
        user_id: userId,
        preferred_response_style: prefs.preferredResponseStyle,
        voice_profile_id: prefs.voiceProfileId,
        preferred_browser_voice_uri: prefs.preferredBrowserVoiceUri ?? null,
        voice_muted: Boolean(prefs.voiceMuted),
        voice_auto_speak: prefs.voiceAutoSpeak,
        voice_barge_in_enabled: prefs.voiceBargeInEnabled,
        wit_level: prefs.witLevel,
        conciseness: prefs.conciseness,
        preferred_model_provider: prefs.preferredModelProvider,
        routing_policy: prefs.routingPolicy ?? 'AUTO_BALANCED',
        manual_model_id: prefs.manualModelId ?? null,
        proactive_assistance_enabled: prefs.proactiveAssistanceEnabled,
        cross_device_sync_enabled: prefs.crossDeviceSyncEnabled,
      },
      { onConflict: 'user_id' }
    );
    if (error) return false;

    await db.from('audit_logs').insert({
      user_id: userId,
      event_type: 'preferences.updated',
      entity_type: 'preference',
      entity_id: userId,
      severity: 'info',
      summary: 'Updated operator preferences under RLS.',
    });
    return true;
  } catch {
    return false;
  }
}

export async function mirrorMemoryToCloudRls(
  userId: string,
  entry: MemoryEntry
): Promise<boolean> {
  const client = await getBrowserSupabaseClient();
  if (!client) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;

  try {
    const { error } = await db.from('long_term_memories').upsert(
      {
        id: isValidUuid(entry.id) ? entry.id : undefined,
        user_id: userId,
        project_id: entry.projectId && isValidUuid(entry.projectId) ? entry.projectId : null,
        category: entry.category,
        memory_scope: entry.memoryScope ?? 'semantic',
        memory_status: entry.memoryStatus ?? 'active',
        content: entry.content,
        tags: entry.tags,
        importance: entry.importance,
        confidence: entry.confidence ?? 0.92,
        provenance: entry.provenance ?? 'user_explicit',
        verified: entry.verified,
      },
      { onConflict: 'id' }
    );
    if (error) return false;

    await db.from('audit_logs').insert({
      user_id: userId,
      event_type: 'memory.stored',
      entity_type: 'memory',
      entity_id: entry.id,
      severity: 'info',
      summary: `Persisted ${entry.category} memory under RLS.`,
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteMemoryFromCloudRls(
  userId: string,
  memoryId: string
): Promise<boolean> {
  if (!isValidUuid(memoryId)) return false;
  const client = await getBrowserSupabaseClient();
  if (!client) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;

  try {
    const { error } = await db
      .from('long_term_memories')
      .delete()
      .eq('id', memoryId)
      .eq('user_id', userId);
    return !error;
  } catch {
    return false;
  }
}

export async function createConversationCloudRls(
  userId: string,
  conversation: ConversationSummary
): Promise<boolean> {
  const client = await getBrowserSupabaseClient();
  if (!client) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;

  try {
    const { error } = await db.from('conversations').upsert(
      {
        id: conversation.id,
        user_id: userId,
        title: conversation.title,
        last_response_style: conversation.lastResponseStyle,
      },
      { onConflict: 'id' }
    );
    if (error) return false;

    await db.from('audit_logs').insert({
      user_id: userId,
      event_type: 'conversation.created',
      entity_type: 'conversation',
      entity_id: conversation.id,
      severity: 'info',
      summary: `Created conversation "${conversation.title}".`,
    });
    return true;
  } catch {
    return false;
  }
}
