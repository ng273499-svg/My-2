import {
  DEFAULT_CONVERSATION_ID,
  generateUuid,
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

const DEFAULT_PREFERENCES: PersonalityPreferences = {
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

interface UserPartition {
  profile: UserProfileRecord;
  projects: ProjectRecord[];
  conversations: Map<string, ConversationSummary>;
  messages: Map<string, ChatMessage[]>;
  memories: Array<MemoryEntry & { embedding?: number[] }>;
  preferences: PersonalityPreferences;
  connectedTools: Map<string, ConnectedToolRecord>;
  tasks: AgentTaskRecord[];
  permissionRecords: PermissionRecord[];
  auditLogs: AuditLogEntry[];
  ingestedDocuments: IngestedDocumentRecord[];
  documentChunks: DocumentChunkRecord[];
  researchSessions: ResearchSessionRecord[];
  researchSources: ResearchSourceRecord[];
  researchClaims: ResearchClaimRecord[];
  proactiveWorkflows: ProactiveWorkflowRecord[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Per-user partitioned in-memory repository used for:
 * 1. Unauthenticated Guest Ephemeral sessions
 * 2. Degraded fallback when Supabase network egress is temporarily unavailable
 * Guarantees strict per-userId partition isolation even in memory.
 */
export class InMemorySessionRepository implements DataRepository {
  public mode: 'ephemeral_session' | 'degraded_fallback';
  private partitions = new Map<string, UserPartition>();

  constructor(mode: 'ephemeral_session' | 'degraded_fallback' = 'ephemeral_session') {
    this.mode = mode;
  }

  private getPartition(userId: string): UserPartition {
    let part = this.partitions.get(userId);
    if (!part) {
      const now = new Date().toISOString();
      const defaultConv: ConversationSummary = {
        id: DEFAULT_CONVERSATION_ID,
        title: 'Primary Command Session',
        activeModelId: 'foundation-local-v1',
        lastResponseStyle: 'calm',
        createdAt: now,
        updatedAt: now,
      };
      const convMap = new Map<string, ConversationSummary>();
      convMap.set(defaultConv.id, defaultConv);

      part = {
        profile: {
          id: userId,
          displayName: 'Operator',
          callsign: `OP-${userId.slice(0, 4).toUpperCase()}`,
          timezone: 'UTC',
          onboardingCompleted: false,
        },
        projects: [
          {
            id: generateUuid(),
            name: 'JARVIS-X Core Architecture',
            slug: 'jarvis-x-core',
            description: 'Default personal AI command workspace.',
            status: 'active',
          },
        ],
        conversations: convMap,
        messages: new Map<string, ChatMessage[]>(),
        memories: [
          {
            id: generateUuid(),
            category: 'project_context',
            memoryScope: 'project',
            memoryStatus: 'active',
            projectId: null,
            content:
              'JARVIS-X persistence layer initialized with strict Row-Level Security, pgvector readiness, and 3-tier permission governance.',
            tags: ['architecture', 'jarvis-x', 'supabase'],
            importance: 5,
            confidence: 0.98,
            recallCount: 0,
            provenance: 'system_seed',
            verified: true,
            persistenceLayer: this.mode,
            createdAt: now,
          },
          {
            id: generateUuid(),
            category: 'preference',
            memoryScope: 'semantic',
            memoryStatus: 'active',
            projectId: null,
            content:
              'Default persona calibrated to calm, concise delivery with subtle wit and Aria v1 female vocal prosody hints.',
            tags: ['persona', 'voice'],
            importance: 4,
            confidence: 0.95,
            recallCount: 0,
            provenance: 'system_seed',
            verified: true,
            persistenceLayer: this.mode,
            createdAt: now,
          },
        ],
        preferences: { ...DEFAULT_PREFERENCES },
        connectedTools: new Map<string, ConnectedToolRecord>(),
        tasks: [],
        permissionRecords: [],
        ingestedDocuments: [],
        documentChunks: [],
        researchSessions: [],
        researchSources: [],
        researchClaims: [],
        proactiveWorkflows: [],
        auditLogs: [
          {
            id: generateUuid(),
            eventType: 'session.partition_initialized',
            entityType: 'auth',
            entityId: userId,
            severity: 'info',
            summary: `Initialized isolated ${this.mode} partition for operator.`,
            createdAt: now,
          },
        ],
      };
      this.partitions.set(userId, part);
    }
    return part;
  }

  async getProfile(userId: string): Promise<UserProfileRecord> {
    return { ...this.getPartition(userId).profile };
  }

  async updateProfile(
    userId: string,
    patch: Partial<Omit<UserProfileRecord, 'id'>>
  ): Promise<UserProfileRecord> {
    const part = this.getPartition(userId);
    part.profile = { ...part.profile, ...patch };
    return { ...part.profile };
  }

  async listProjects(userId: string): Promise<ProjectRecord[]> {
    return [...this.getPartition(userId).projects];
  }

  async createProject(
    userId: string,
    project: { name: string; slug: string; description?: string }
  ): Promise<ProjectRecord> {
    const part = this.getPartition(userId);
    const created: ProjectRecord = {
      id: generateUuid(),
      name: project.name,
      slug: project.slug,
      description: project.description,
      status: 'active',
    };
    part.projects.unshift(created);
    await this.appendAuditLog(userId, {
      eventType: 'project.created',
      entityType: 'project',
      entityId: created.id,
      severity: 'info',
      summary: `Created workspace project "${created.name}".`,
    });
    return created;
  }

  async listConversations(userId: string, limit = 25): Promise<ConversationSummary[]> {
    const part = this.getPartition(userId);
    return Array.from(part.conversations.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async getConversation(
    userId: string,
    conversationId: string
  ): Promise<ConversationSummary | null> {
    const normId = normalizeConversationId(conversationId);
    const part = this.getPartition(userId);
    const found = part.conversations.get(normId);
    return found ? { ...found } : null;
  }

  async createConversation(
    userId: string,
    input?: { id?: string; title?: string; projectId?: string | null; style?: ResponseStyle }
  ): Promise<ConversationSummary> {
    const part = this.getPartition(userId);
    const now = new Date().toISOString();
    const id = input?.id ? normalizeConversationId(input.id) : generateUuid();
    const created: ConversationSummary = {
      id,
      title: input?.title?.trim() || 'New Command Session',
      projectId: input?.projectId ?? null,
      activeModelId: 'foundation-local-v1',
      lastResponseStyle: input?.style ?? 'calm',
      createdAt: now,
      updatedAt: now,
    };
    part.conversations.set(id, created);
    await this.appendAuditLog(userId, {
      eventType: 'conversation.created',
      entityType: 'conversation',
      entityId: id,
      severity: 'info',
      summary: `Created conversation "${created.title}".`,
    });
    return { ...created };
  }

  async getMessages(userId: string, conversationId: string): Promise<ChatMessage[]> {
    const normId = normalizeConversationId(conversationId);
    const part = this.getPartition(userId);
    return [...(part.messages.get(normId) ?? [])];
  }

  async appendMessage(userId: string, message: ChatMessage): Promise<void> {
    const normId = normalizeConversationId(message.conversationId);
    const part = this.getPartition(userId);
    const now = new Date().toISOString();

    const existingConv = part.conversations.get(normId);
    if (!existingConv) {
      part.conversations.set(normId, {
        id: normId,
        title:
          message.role === 'user'
            ? message.content.slice(0, 48) || 'Command Session'
            : 'Command Session',
        activeModelId: message.modelId ?? 'foundation-local-v1',
        lastResponseStyle: message.responseStyle ?? 'calm',
        createdAt: now,
        updatedAt: now,
      });
    } else {
      existingConv.updatedAt = now;
      if (message.responseStyle) {
        existingConv.lastResponseStyle = message.responseStyle;
      }
      if (
        existingConv.title === 'Primary Command Session' &&
        message.role === 'user' &&
        (part.messages.get(normId)?.length ?? 0) === 0
      ) {
        existingConv.title = message.content.slice(0, 48);
      }
    }

    const list = part.messages.get(normId) ?? [];
    list.push({ ...message, conversationId: normId });
    part.messages.set(normId, list);
  }

  async listMemories(
    userId: string,
    filter?: ListMemoriesFilter
  ): Promise<MemoryEntry[]> {
    const part = this.getPartition(userId);
    const nowMs = Date.now();
    return [...part.memories]
      .filter((m) => {
        const status = m.memoryStatus ?? 'active';
        if (!filter?.includeSuperseded && status !== 'active') return false;
        if (
          !filter?.includeExpired &&
          m.expiresAt &&
          new Date(m.expiresAt).getTime() <= nowMs
        ) {
          return false;
        }
        if (filter?.scope && (m.memoryScope ?? 'semantic') !== filter.scope) {
          return false;
        }
        if (filter?.projectId !== undefined) {
          if (filter.projectId === null) {
            if (m.projectId) return false;
          } else if (m.projectId !== filter.projectId) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ embedding: _emb, ...entry }) => ({
        ...entry,
        memoryScope: entry.memoryScope ?? 'semantic',
        memoryStatus: entry.memoryStatus ?? 'active',
        confidence: entry.confidence ?? 0.9,
        recallCount: entry.recallCount ?? 0,
        provenance: entry.provenance ?? 'user_explicit',
        persistenceLayer: this.mode,
      }));
  }

  async addMemory(
    userId: string,
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'persistenceLayer'> & {
      embedding?: number[];
    }
  ): Promise<MemoryEntry> {
    const part = this.getPartition(userId);
    const defaultScope =
      entry.memoryScope ??
      (entry.projectId || entry.category === 'project_context'
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

    const created: MemoryEntry & { embedding?: number[] } = {
      ...entry,
      id: generateUuid(),
      memoryScope: defaultScope,
      memoryStatus: entry.memoryStatus ?? 'active',
      projectId: entry.projectId ?? null,
      confidence: entry.confidence ?? 0.92,
      recallCount: entry.recallCount ?? 0,
      provenance: entry.provenance ?? 'user_explicit',
      supersededById: entry.supersededById ?? null,
      lastRecalledAt: entry.lastRecalledAt ?? null,
      expiresAt: entry.expiresAt ?? null,
      metadata: entry.metadata ?? {},
      persistenceLayer: this.mode,
      createdAt: new Date().toISOString(),
    };
    part.memories.unshift(created);
    await this.appendAuditLog(userId, {
      eventType: 'memory.stored',
      entityType: 'memory',
      entityId: created.id,
      severity: 'info',
      summary: `Stored ${created.memoryScope}/${created.category} memory record.`,
    });
    const { embedding: _emb, ...clean } = created;
    return clean;
  }

  async updateMemory(
    userId: string,
    memoryId: string,
    patch: MemoryUpdatePatch
  ): Promise<MemoryEntry | null> {
    const part = this.getPartition(userId);
    const target = part.memories.find((m) => m.id === memoryId);
    if (!target) return null;

    if (patch.supersededById) {
      if (patch.supersededById === memoryId) {
        throw new Error('Memory entry cannot supersede itself.');
      }
      const ownerMatch = part.memories.some((m) => m.id === patch.supersededById);
      if (!ownerMatch) {
        throw new Error('Cross-tenant or missing supersededById reference denied.');
      }
    }

    if (patch.memoryStatus !== undefined) target.memoryStatus = patch.memoryStatus;
    if (patch.supersededById !== undefined) target.supersededById = patch.supersededById;
    if (patch.recallCount !== undefined) target.recallCount = patch.recallCount;
    if (patch.lastRecalledAt !== undefined) target.lastRecalledAt = patch.lastRecalledAt;
    if (patch.importance !== undefined) target.importance = patch.importance;
    if (patch.confidence !== undefined) target.confidence = patch.confidence;
    if (patch.tags !== undefined) target.tags = [...patch.tags];
    if (patch.expiresAt !== undefined) target.expiresAt = patch.expiresAt;
    if (patch.metadata !== undefined) {
      target.metadata = { ...(target.metadata ?? {}), ...patch.metadata };
    }

    const { embedding: _emb, ...clean } = target;
    return { ...clean, persistenceLayer: this.mode };
  }

  async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    const part = this.getPartition(userId);
    const before = part.memories.length;
    part.memories = part.memories.filter((m) => m.id !== memoryId);
    const deleted = part.memories.length < before;
    if (deleted) {
      await this.appendAuditLog(userId, {
        eventType: 'memory.deleted',
        entityType: 'memory',
        entityId: memoryId,
        severity: 'warning',
        summary: `Deleted memory record ${memoryId}.`,
      });
    }
    return deleted;
  }

  async searchMemoriesByVector(
    userId: string,
    queryEmbedding: number[],
    matchThreshold = 0.72,
    matchCount = 8
  ): Promise<MemoryEntry[]> {
    const part = this.getPartition(userId);
    const nowMs = Date.now();
    return part.memories
      .filter((m) => {
        if ((m.memoryStatus ?? 'active') !== 'active') return false;
        if (m.expiresAt && new Date(m.expiresAt).getTime() <= nowMs) return false;
        return (
          Array.isArray(m.embedding) && m.embedding.length === queryEmbedding.length
        );
      })
      .map((m) => ({
        entry: m,
        similarity: cosineSimilarity(m.embedding!, queryEmbedding),
      }))
      .filter((x) => x.similarity >= matchThreshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, matchCount)
      .map(({ entry: { embedding: _e, ...rest }, similarity }) => ({
        ...rest,
        similarity,
      }));
  }

  async getPreferences(userId: string): Promise<PersonalityPreferences> {
    return { ...this.getPartition(userId).preferences };
  }

  async updatePreferences(
    userId: string,
    patch: Partial<PersonalityPreferences>
  ): Promise<PersonalityPreferences> {
    const part = this.getPartition(userId);
    part.preferences = { ...part.preferences, ...patch };
    await this.appendAuditLog(userId, {
      eventType: 'preferences.updated',
      entityType: 'preference',
      entityId: userId,
      severity: 'info',
      summary: `Updated operator preferences (${Object.keys(patch).join(', ')}).`,
    });
    return { ...part.preferences };
  }

  async listConnectedTools(userId: string): Promise<ConnectedToolRecord[]> {
    return Array.from(this.getPartition(userId).connectedTools.values());
  }

  async upsertConnectedTool(
    userId: string,
    tool: Omit<ConnectedToolRecord, 'id' | 'updatedAt'>
  ): Promise<ConnectedToolRecord> {
    const part = this.getPartition(userId);
    const existing = part.connectedTools.get(tool.toolSlug);
    const record: ConnectedToolRecord = {
      ...tool,
      id: existing?.id ?? generateUuid(),
      updatedAt: new Date().toISOString(),
    };
    part.connectedTools.set(tool.toolSlug, record);
    await this.appendAuditLog(userId, {
      eventType: 'connected_tool.upserted',
      entityType: 'connected_tool',
      entityId: record.toolSlug,
      severity: 'info',
      summary: `Updated metadata for tool "${record.displayName}" (${record.connectionStatus}).`,
    });
    return { ...record };
  }

  async recordAgentTask(
    userId: string,
    task: Omit<AgentTaskRecord, 'id' | 'createdAt'> & { id?: string }
  ): Promise<AgentTaskRecord> {
    const part = this.getPartition(userId);
    const id = task.id ?? generateUuid();
    const existingIdx = part.tasks.findIndex((t) => t.id === id);
    const record: AgentTaskRecord = {
      ...task,
      conversationId: normalizeConversationId(task.conversationId),
      id,
      createdAt:
        existingIdx >= 0
          ? part.tasks[existingIdx].createdAt
          : new Date().toISOString(),
    };
    if (existingIdx >= 0) {
      part.tasks[existingIdx] = record;
    } else {
      part.tasks.unshift(record);
    }
    return { ...record };
  }

  async updateAgentTask(
    userId: string,
    taskId: string,
    patch: Partial<Omit<AgentTaskRecord, 'id' | 'createdAt'>>
  ): Promise<AgentTaskRecord | null> {
    const part = this.getPartition(userId);
    const found = part.tasks.find((t) => t.id === taskId);
    if (!found) return null;
    Object.assign(found, patch);
    return { ...found };
  }

  async listAgentTasks(userId: string, limit = 20): Promise<AgentTaskRecord[]> {
    return this.getPartition(userId).tasks.slice(0, limit);
  }

  async recordPermission(userId: string, record: PermissionRecord): Promise<void> {
    const part = this.getPartition(userId);
    part.permissionRecords.unshift(record);
    await this.appendAuditLog(userId, {
      eventType: `permission.${record.decision}`,
      entityType: 'permission',
      entityId: record.id,
      severity: record.tier === 'SENSITIVE_AUTH_REQUIRED' ? 'warning' : 'info',
      summary: `Evaluated ${record.actionCode} (${record.tier}) -> ${record.decision}.`,
    });
  }

  async updatePermissionDecision(
    userId: string,
    recordId: string,
    decision: PermissionRecord['decision'],
    verifiedAuthMethod?: string
  ): Promise<PermissionRecord | null> {
    const part = this.getPartition(userId);
    const found = part.permissionRecords.find((r) => r.id === recordId);
    if (!found) return null;
    found.decision = decision;
    found.verifiedAuthMethod = verifiedAuthMethod;
    found.resolvedAt = new Date().toISOString();

    await this.appendAuditLog(userId, {
      eventType: `permission.resolved.${decision}`,
      entityType: 'permission',
      entityId: recordId,
      severity: decision === 'blocked_unauthenticated' ? 'critical' : 'info',
      summary: `Permission ${found.actionCode} resolved as ${decision}.`,
    });
    return { ...found };
  }

  async listPermissionRecords(userId: string, limit = 25): Promise<PermissionRecord[]> {
    return this.getPartition(userId).permissionRecords.slice(0, limit);
  }

  async appendAuditLog(
    userId: string,
    entry: Omit<AuditLogEntry, 'id' | 'createdAt'>
  ): Promise<AuditLogEntry> {
    const part = this.getPartition(userId);
    const created: AuditLogEntry = {
      ...entry,
      id: generateUuid(),
      createdAt: new Date().toISOString(),
    };
    part.auditLogs.unshift(created);
    return created;
  }

  async listAuditLogs(userId: string, limit = 30): Promise<AuditLogEntry[]> {
    return this.getPartition(userId).auditLogs.slice(0, limit);
  }

  async recordIngestedDocument(
    userId: string,
    doc: Omit<IngestedDocumentRecord, 'id' | 'createdAt'>
  ): Promise<IngestedDocumentRecord> {
    const part = this.getPartition(userId);
    const created: IngestedDocumentRecord = {
      ...doc,
      id: generateUuid(),
      createdAt: new Date().toISOString(),
    };
    part.ingestedDocuments.unshift(created);
    await this.appendAuditLog(userId, {
      eventType: 'file_intelligence.ingested',
      entityType: 'memory',
      entityId: created.id,
      severity: created.injectionFlagged ? 'warning' : 'info',
      summary: `Analyzed document "${created.fileName}" (${created.formatKind}, ${created.chunkCount} chunk(s)).`,
    });
    return { ...created };
  }

  async listIngestedDocuments(
    userId: string,
    limit = 20
  ): Promise<IngestedDocumentRecord[]> {
    return this.getPartition(userId).ingestedDocuments.slice(0, limit);
  }

  async getIngestedDocument(
    userId: string,
    documentId: string
  ): Promise<IngestedDocumentRecord | null> {
    const found = this.getPartition(userId).ingestedDocuments.find((d) => d.id === documentId);
    return found ? { ...found } : null;
  }

  async deleteIngestedDocument(userId: string, documentId: string): Promise<boolean> {
    const part = this.getPartition(userId);
    const index = part.ingestedDocuments.findIndex((d) => d.id === documentId);
    if (index === -1) return false;
    const [removed] = part.ingestedDocuments.splice(index, 1);
    // Revoke retrievable chunks in the same transaction-like step.
    part.documentChunks = part.documentChunks.filter((c) => c.documentId !== documentId);
    await this.appendAuditLog(userId, {
      eventType: 'file_intelligence.removed',
      entityType: 'memory',
      entityId: documentId,
      severity: 'info',
      summary: `Removed document "${removed.fileName}" and revoked its retrievable chunks.`,
    });
    return true;
  }

  async recordDocumentChunks(
    userId: string,
    documentId: string,
    chunks: Array<Omit<DocumentChunkRecord, 'id' | 'documentId' | 'createdAt'>>
  ): Promise<number> {
    const part = this.getPartition(userId);
    let inserted = 0;
    for (const chunk of chunks) {
      part.documentChunks.push({
        ...chunk,
        id: generateUuid(),
        documentId,
        createdAt: new Date().toISOString(),
      });
      inserted += 1;
    }
    return inserted;
  }

  async listDocumentChunks(
    userId: string,
    documentId: string,
    limit = 500
  ): Promise<DocumentChunkRecord[]> {
    return this.getPartition(userId)
      .documentChunks.filter((c) => c.documentId === documentId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }

  async deleteDocumentChunks(userId: string, documentId: string): Promise<number> {
    const part = this.getPartition(userId);
    const before = part.documentChunks.length;
    part.documentChunks = part.documentChunks.filter((c) => c.documentId !== documentId);
    return before - part.documentChunks.length;
  }

  async listProactiveWorkflows(userId: string): Promise<ProactiveWorkflowRecord[]> {
    return [...this.getPartition(userId).proactiveWorkflows];
  }

  async createProactiveWorkflow(
    userId: string,
    workflow: Omit<
      ProactiveWorkflowRecord,
      'id' | 'runCount' | 'lastRunAt' | 'createdAt' | 'updatedAt'
    >
  ): Promise<ProactiveWorkflowRecord> {
    const part = this.getPartition(userId);
    const now = new Date().toISOString();
    const created: ProactiveWorkflowRecord = {
      ...workflow,
      id: generateUuid(),
      runCount: 0,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    part.proactiveWorkflows.unshift(created);
    await this.appendAuditLog(userId, {
      eventType: 'workflow.created',
      entityType: 'agent_task',
      entityId: created.id,
      severity: 'info',
      summary: `Registered governed proactive workflow "${created.title}" (${created.riskLevel}).`,
    });
    return { ...created };
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
    const part = this.getPartition(userId);
    const target = part.proactiveWorkflows.find((w) => w.id === workflowId);
    if (!target) return null;
    if (patch.title !== undefined) target.title = patch.title;
    if (patch.description !== undefined) target.description = patch.description;
    if (patch.directivePrompt !== undefined)
      target.directivePrompt = patch.directivePrompt;
    if (patch.enabled !== undefined) target.enabled = patch.enabled;
    if (patch.runCount !== undefined) target.runCount = patch.runCount;
    if (patch.lastRunAt !== undefined) target.lastRunAt = patch.lastRunAt;
    if (patch.metadata !== undefined) target.metadata = patch.metadata;
    target.updatedAt = new Date().toISOString();
    return { ...target };
  }

  async deleteProactiveWorkflow(userId: string, workflowId: string): Promise<boolean> {
    const part = this.getPartition(userId);
    const idx = part.proactiveWorkflows.findIndex((w) => w.id === workflowId);
    if (idx === -1) return false;
    part.proactiveWorkflows.splice(idx, 1);
    return true;
  }

  /* ======================================================================
   * v1.3 Research persistence (owner-partitioned)
   * ==================================================================== */

  async recordResearchSession(
    userId: string,
    session: Omit<ResearchSessionRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ResearchSessionRecord> {
    const part = this.getPartition(userId);
    const now = new Date().toISOString();
    const existing = part.researchSessions.find((s) => s.taskId === session.taskId);
    if (existing) {
      Object.assign(existing, session, { updatedAt: now });
      return { ...existing };
    }
    const created: ResearchSessionRecord = {
      ...session,
      id: generateUuid(),
      createdAt: now,
      updatedAt: now,
    };
    part.researchSessions.unshift(created);
    return { ...created };
  }

  async listResearchSessions(userId: string, limit = 20): Promise<ResearchSessionRecord[]> {
    return this.getPartition(userId).researchSessions.slice(0, Math.max(1, limit)).map((s) => ({ ...s }));
  }

  async getResearchSession(userId: string, taskId: string): Promise<ResearchSessionRecord | null> {
    const found = this.getPartition(userId).researchSessions.find((s) => s.taskId === taskId);
    return found ? { ...found } : null;
  }

  async recordResearchSources(
    userId: string,
    sessionId: string,
    sources: Array<Omit<ResearchSourceRecord, 'id' | 'sessionId' | 'createdAt'>>
  ): Promise<number> {
    const part = this.getPartition(userId);
    const now = new Date().toISOString();
    let written = 0;
    for (const source of sources.slice(0, 200)) {
      part.researchSources.push({
        ...source,
        // Copyright-safe: hard-bound whatever a caller passes.
        snippet: (source.snippet ?? '').slice(0, 4000),
        id: generateUuid(),
        sessionId,
        createdAt: now,
      });
      written += 1;
    }
    return written;
  }

  async listResearchSources(userId: string, sessionId: string, limit = 50): Promise<ResearchSourceRecord[]> {
    return this.getPartition(userId)
      .researchSources.filter((s) => s.sessionId === sessionId)
      .slice(0, Math.max(1, limit))
      .map((s) => ({ ...s }));
  }

  async recordResearchClaims(
    userId: string,
    sessionId: string,
    claims: Array<Omit<ResearchClaimRecord, 'id' | 'sessionId' | 'createdAt'>>
  ): Promise<number> {
    const part = this.getPartition(userId);
    const now = new Date().toISOString();
    let written = 0;
    for (const claim of claims.slice(0, 200)) {
      part.researchClaims.push({
        ...claim,
        id: generateUuid(),
        sessionId,
        createdAt: now,
      });
      written += 1;
    }
    return written;
  }

  async listResearchClaims(userId: string, sessionId: string): Promise<ResearchClaimRecord[]> {
    return this.getPartition(userId)
      .researchClaims.filter((c) => c.sessionId === sessionId)
      .map((c) => ({ ...c }));
  }
}
