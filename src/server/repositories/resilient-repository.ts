import type {
  AuditLogEntry,
  ChatMessage,
  ConversationSummary,
  MemoryEntry,
  PermissionRecord,
  PersonalityPreferences,
  ResponseStyle,
} from '@/core/types';
import { InMemorySessionRepository } from './in-memory-repository';
import { SupabaseConnectivityError } from './supabase-repository';
import type {
  AgentTaskRecord,
  ConnectedToolRecord,
  DataRepository,
  DocumentChunkRecord,
  ResearchClaimRecord,
  ResearchSessionRecord,
  ResearchSourceRecord,
  IngestedDocumentRecord,
  ListMemoriesFilter,
  MemoryUpdatePatch,
  ProactiveWorkflowRecord,
  ProjectRecord,
  UserProfileRecord,
} from './types';

/**
 * Resilient Data Repository
 * Wraps a primary `SupabaseDataRepository` (when an authenticated user session is present)
 * with graceful fallback to a per-user isolated `InMemorySessionRepository` if Supabase is
 * temporarily unreachable, offline, or firewalled.
 *
 * Security invariant: Non-connectivity errors (e.g. RLS violations or invalid data) are NOT
 * silently swallowed — only genuine network/availability errors trigger degraded fallback.
 */
export class ResilientDataRepository implements DataRepository {
  private degraded = false;
  public lastFallbackReason: string | null = null;

  constructor(
    private readonly primary: DataRepository | null,
    private readonly fallback: InMemorySessionRepository,
    private readonly supabaseConfigured: boolean,
    initialDegradedReason?: string | null
  ) {
    if (initialDegradedReason) {
      this.degraded = true;
      this.lastFallbackReason = initialDegradedReason;
    }
  }

  get mode(): 'ephemeral_session' | 'supabase_cloud' | 'degraded_fallback' {
    if (!this.primary) {
      return this.supabaseConfigured && this.degraded
        ? 'degraded_fallback'
        : 'ephemeral_session';
    }
    if (this.degraded) {
      return 'degraded_fallback';
    }
    return this.primary.mode;
  }

  private async run<T>(op: (repo: DataRepository) => Promise<T>): Promise<T> {
    if (!this.primary) {
      this.fallback.mode = this.supabaseConfigured
        ? this.degraded
          ? 'degraded_fallback'
          : 'ephemeral_session'
        : 'ephemeral_session';
      return op(this.fallback);
    }

    if (this.degraded) {
      this.fallback.mode = 'degraded_fallback';
      return op(this.fallback);
    }

    try {
      const result = await op(this.primary);
      this.degraded = false;
      this.lastFallbackReason = null;
      return result;
    } catch (err) {
      if (err instanceof SupabaseConnectivityError) {
        this.degraded = true;
        this.lastFallbackReason = err.message;
        this.fallback.mode = 'degraded_fallback';
        return op(this.fallback);
      }
      throw err;
    }
  }

  getProfile(userId: string): Promise<UserProfileRecord> {
    return this.run((r) => r.getProfile(userId));
  }

  updateProfile(
    userId: string,
    patch: Partial<Omit<UserProfileRecord, 'id'>>
  ): Promise<UserProfileRecord> {
    return this.run((r) => r.updateProfile(userId, patch));
  }

  listProjects(userId: string): Promise<ProjectRecord[]> {
    return this.run((r) => r.listProjects(userId));
  }

  createProject(
    userId: string,
    project: { name: string; slug: string; description?: string }
  ): Promise<ProjectRecord> {
    return this.run((r) => r.createProject(userId, project));
  }

  listConversations(userId: string, limit?: number): Promise<ConversationSummary[]> {
    return this.run((r) => r.listConversations(userId, limit));
  }

  getConversation(
    userId: string,
    conversationId: string
  ): Promise<ConversationSummary | null> {
    return this.run((r) => r.getConversation(userId, conversationId));
  }

  createConversation(
    userId: string,
    input?: { id?: string; title?: string; projectId?: string | null; style?: ResponseStyle }
  ): Promise<ConversationSummary> {
    return this.run((r) => r.createConversation(userId, input));
  }

  getMessages(userId: string, conversationId: string): Promise<ChatMessage[]> {
    return this.run((r) => r.getMessages(userId, conversationId));
  }

  appendMessage(userId: string, message: ChatMessage): Promise<void> {
    return this.run((r) => r.appendMessage(userId, message));
  }

  listMemories(userId: string, filter?: ListMemoriesFilter): Promise<MemoryEntry[]> {
    return this.run((r) => r.listMemories(userId, filter));
  }

  addMemory(
    userId: string,
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'persistenceLayer'> & {
      embedding?: number[];
    }
  ): Promise<MemoryEntry> {
    return this.run((r) => r.addMemory(userId, entry));
  }

  updateMemory(
    userId: string,
    memoryId: string,
    patch: MemoryUpdatePatch
  ): Promise<MemoryEntry | null> {
    return this.run((r) => r.updateMemory(userId, memoryId, patch));
  }

  deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    return this.run((r) => r.deleteMemory(userId, memoryId));
  }

  searchMemoriesByVector(
    userId: string,
    queryEmbedding: number[],
    matchThreshold?: number,
    matchCount?: number
  ): Promise<MemoryEntry[]> {
    return this.run((r) =>
      r.searchMemoriesByVector(userId, queryEmbedding, matchThreshold, matchCount)
    );
  }

  getPreferences(userId: string): Promise<PersonalityPreferences> {
    return this.run((r) => r.getPreferences(userId));
  }

  updatePreferences(
    userId: string,
    patch: Partial<PersonalityPreferences>
  ): Promise<PersonalityPreferences> {
    return this.run((r) => r.updatePreferences(userId, patch));
  }

  listConnectedTools(userId: string): Promise<ConnectedToolRecord[]> {
    return this.run((r) => r.listConnectedTools(userId));
  }

  upsertConnectedTool(
    userId: string,
    tool: Omit<ConnectedToolRecord, 'id' | 'updatedAt'>
  ): Promise<ConnectedToolRecord> {
    return this.run((r) => r.upsertConnectedTool(userId, tool));
  }

  recordAgentTask(
    userId: string,
    task: Omit<AgentTaskRecord, 'id' | 'createdAt'> & { id?: string }
  ): Promise<AgentTaskRecord> {
    return this.run((r) => r.recordAgentTask(userId, task));
  }

  updateAgentTask(
    userId: string,
    taskId: string,
    patch: Partial<Omit<AgentTaskRecord, 'id' | 'createdAt'>>
  ): Promise<AgentTaskRecord | null> {
    return this.run((r) => r.updateAgentTask(userId, taskId, patch));
  }

  listAgentTasks(userId: string, limit?: number): Promise<AgentTaskRecord[]> {
    return this.run((r) => r.listAgentTasks(userId, limit));
  }

  recordPermission(userId: string, record: PermissionRecord): Promise<void> {
    return this.run((r) => r.recordPermission(userId, record));
  }

  updatePermissionDecision(
    userId: string,
    recordId: string,
    decision: PermissionRecord['decision'],
    verifiedAuthMethod?: string
  ): Promise<PermissionRecord | null> {
    return this.run((r) =>
      r.updatePermissionDecision(userId, recordId, decision, verifiedAuthMethod)
    );
  }

  listPermissionRecords(userId: string, limit?: number): Promise<PermissionRecord[]> {
    return this.run((r) => r.listPermissionRecords(userId, limit));
  }

  appendAuditLog(
    userId: string,
    entry: Omit<AuditLogEntry, 'id' | 'createdAt'>
  ): Promise<AuditLogEntry> {
    return this.run((r) => r.appendAuditLog(userId, entry));
  }

  listAuditLogs(userId: string, limit?: number): Promise<AuditLogEntry[]> {
    return this.run((r) => r.listAuditLogs(userId, limit));
  }

  recordIngestedDocument(
    userId: string,
    doc: Omit<IngestedDocumentRecord, 'id' | 'createdAt'>
  ): Promise<IngestedDocumentRecord> {
    return this.run((r) => {
      if (!r.recordIngestedDocument) {
        return this.fallback.recordIngestedDocument(userId, doc);
      }
      return r.recordIngestedDocument(userId, doc);
    });
  }

  listIngestedDocuments(
    userId: string,
    limit?: number
  ): Promise<IngestedDocumentRecord[]> {
    return this.run((r) => {
      if (!r.listIngestedDocuments) {
        return this.fallback.listIngestedDocuments(userId, limit);
      }
      return r.listIngestedDocuments(userId, limit);
    });
  }

  getIngestedDocument(
    userId: string,
    documentId: string
  ): Promise<IngestedDocumentRecord | null> {
    return this.run((r) => {
      if (!r.getIngestedDocument) {
        return this.fallback.getIngestedDocument!(userId, documentId);
      }
      return r.getIngestedDocument(userId, documentId);
    });
  }

  deleteIngestedDocument(userId: string, documentId: string): Promise<boolean> {
    return this.run((r) => {
      if (!r.deleteIngestedDocument) {
        return this.fallback.deleteIngestedDocument!(userId, documentId);
      }
      return r.deleteIngestedDocument(userId, documentId);
    });
  }

  recordDocumentChunks(
    userId: string,
    documentId: string,
    chunks: Array<Omit<DocumentChunkRecord, 'id' | 'documentId' | 'createdAt'>>
  ): Promise<number> {
    return this.run((r) => {
      if (!r.recordDocumentChunks) {
        return this.fallback.recordDocumentChunks!(userId, documentId, chunks);
      }
      return r.recordDocumentChunks(userId, documentId, chunks);
    });
  }

  listDocumentChunks(
    userId: string,
    documentId: string,
    limit?: number
  ): Promise<DocumentChunkRecord[]> {
    return this.run((r) => {
      if (!r.listDocumentChunks) {
        return this.fallback.listDocumentChunks!(userId, documentId, limit);
      }
      return r.listDocumentChunks(userId, documentId, limit);
    });
  }

  deleteDocumentChunks(userId: string, documentId: string): Promise<number> {
    return this.run((r) => {
      if (!r.deleteDocumentChunks) {
        return this.fallback.deleteDocumentChunks!(userId, documentId);
      }
      return r.deleteDocumentChunks(userId, documentId);
    });
  }

  listProactiveWorkflows(userId: string): Promise<ProactiveWorkflowRecord[]> {
    return this.run((r) => {
      if (!r.listProactiveWorkflows) {
        return this.fallback.listProactiveWorkflows(userId);
      }
      return r.listProactiveWorkflows(userId);
    });
  }

  createProactiveWorkflow(
    userId: string,
    workflow: Omit<
      ProactiveWorkflowRecord,
      'id' | 'runCount' | 'lastRunAt' | 'createdAt' | 'updatedAt'
    >
  ): Promise<ProactiveWorkflowRecord> {
    return this.run((r) => {
      if (!r.createProactiveWorkflow) {
        return this.fallback.createProactiveWorkflow(userId, workflow);
      }
      return r.createProactiveWorkflow(userId, workflow);
    });
  }

  updateProactiveWorkflow(
    userId: string,
    workflowId: string,
    patch: Partial<
      Pick<
        ProactiveWorkflowRecord,
        'title' | 'description' | 'directivePrompt' | 'enabled' | 'runCount' | 'lastRunAt' | 'metadata'
      >
    >
  ): Promise<ProactiveWorkflowRecord | null> {
    return this.run((r) => {
      if (!r.updateProactiveWorkflow) {
        return this.fallback.updateProactiveWorkflow(userId, workflowId, patch);
      }
      return r.updateProactiveWorkflow(userId, workflowId, patch);
    });
  }

  deleteProactiveWorkflow(userId: string, workflowId: string): Promise<boolean> {
    return this.run((r) => {
      if (!r.deleteProactiveWorkflow) {
        return this.fallback.deleteProactiveWorkflow(userId, workflowId);
      }
      return r.deleteProactiveWorkflow(userId, workflowId);
    });
  }

  /* ======================================================================
   * v1.3 Research (delegated; falls back safely when a method is absent)
   * ==================================================================== */

  recordResearchSession(
    userId: string,
    session: Omit<ResearchSessionRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ResearchSessionRecord> {
    return this.run((r) =>
      r.recordResearchSession
        ? r.recordResearchSession(userId, session)
        : this.fallback.recordResearchSession(userId, session)
    );
  }

  listResearchSessions(userId: string, limit?: number): Promise<ResearchSessionRecord[]> {
    return this.run((r) =>
      r.listResearchSessions
        ? r.listResearchSessions(userId, limit)
        : this.fallback.listResearchSessions(userId, limit)
    );
  }

  getResearchSession(userId: string, taskId: string): Promise<ResearchSessionRecord | null> {
    return this.run((r) =>
      r.getResearchSession
        ? r.getResearchSession(userId, taskId)
        : this.fallback.getResearchSession(userId, taskId)
    );
  }

  recordResearchSources(
    userId: string,
    sessionId: string,
    sources: Array<Omit<ResearchSourceRecord, 'id' | 'sessionId' | 'createdAt'>>
  ): Promise<number> {
    return this.run((r) =>
      r.recordResearchSources
        ? r.recordResearchSources(userId, sessionId, sources)
        : this.fallback.recordResearchSources(userId, sessionId, sources)
    );
  }

  listResearchSources(userId: string, sessionId: string, limit?: number): Promise<ResearchSourceRecord[]> {
    return this.run((r) =>
      r.listResearchSources
        ? r.listResearchSources(userId, sessionId, limit)
        : this.fallback.listResearchSources(userId, sessionId, limit)
    );
  }

  recordResearchClaims(
    userId: string,
    sessionId: string,
    claims: Array<Omit<ResearchClaimRecord, 'id' | 'sessionId' | 'createdAt'>>
  ): Promise<number> {
    return this.run((r) =>
      r.recordResearchClaims
        ? r.recordResearchClaims(userId, sessionId, claims)
        : this.fallback.recordResearchClaims(userId, sessionId, claims)
    );
  }

  listResearchClaims(userId: string, sessionId: string): Promise<ResearchClaimRecord[]> {
    return this.run((r) =>
      r.listResearchClaims
        ? r.listResearchClaims(userId, sessionId)
        : this.fallback.listResearchClaims(userId, sessionId)
    );
  }
}
