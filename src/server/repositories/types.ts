import type {
  ApprovalLifecycleState,
  AuditLogEntry,
  ChatMessage,
  ConversationSummary,
  HierarchicalMemoryScope,
  MemoryEntry,
  MemoryLifecycleStatus,
  PermissionRecord,
  PersonalityPreferences,
  ResponseStyle,
  RiskLevel,
  RuntimeCapabilityId,
  RuntimeErrorCode,
  RuntimeState,
  RuntimeVerificationStatus,
  TaskType,
} from '@/core/types';

export interface ListMemoriesFilter {
  includeSuperseded?: boolean;
  includeExpired?: boolean;
  scope?: HierarchicalMemoryScope;
  projectId?: string | null;
}

export interface MemoryUpdatePatch {
  memoryStatus?: MemoryLifecycleStatus;
  supersededById?: string | null;
  recallCount?: number;
  lastRecalledAt?: string | null;
  importance?: 1 | 2 | 3 | 4 | 5;
  confidence?: number;
  tags?: string[];
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UserProfileRecord {
  id: string;
  displayName: string;
  callsign: string;
  timezone: string;
  onboardingCompleted?: boolean;
}

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  description?: string;
  status: 'active' | 'paused' | 'archived';
}

export interface AgentTaskRecord {
  id: string;
  conversationId: string;
  projectId?: string | null;
  specialistAgent: string;
  objective: string;
  lifecycleStage: string;
  permissionTier: string;
  statusSummary: string;
  taskType?: TaskType;
  riskLevel?: RiskLevel;
  selectedCapability?: RuntimeCapabilityId;
  executionState?: RuntimeState;
  approvalState?: ApprovalLifecycleState;
  verificationStatus?: RuntimeVerificationStatus;
  errorStatus?: RuntimeErrorCode | null;
  startedAt?: string;
  completedAt?: string | null;
  resultPayload?: Record<string, unknown>;
  createdAt: string;
}

export interface ConnectedToolRecord {
  id: string;
  toolSlug: string;
  displayName: string;
  category:
    | 'internal'
    | 'web_research'
    | 'file_analysis'
    | 'computer_use'
    | 'code_execution'
    | 'external_api'
    | 'smart_device'
    | 'notifications'
    | 'sync';
  connectionStatus: 'connected' | 'not_connected' | 'degraded' | 'revoked';
  defaultPermissionTier: 'SAFE_READ' | 'CONFIRMATION_REQUIRED' | 'SENSITIVE_AUTH_REQUIRED';
  scopes: string[];
  updatedAt: string;
}

export interface IngestedDocumentRecord {
  id: string;
  projectId: string | null;
  fileName: string;
  mimeType: string;
  formatKind: 'markdown' | 'text' | 'csv' | 'json' | 'code';
  sizeBytes: number;
  chunkCount: number;
  injectionFlagged: boolean;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ProactiveWorkflowRecord {
  id: string;
  projectId: string | null;
  title: string;
  description: string;
  directivePrompt: string;
  triggerKind: 'manual' | 'session_start' | 'interval_advisory' | 'event_watch';
  scheduleHint: string | null;
  riskLevel: 'READ_ONLY' | 'LOW_RISK' | 'CONFIRMATION_REQUIRED' | 'SENSITIVE';
  enabled: boolean;
  runCount: number;
  lastRunAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DataRepository {
  readonly mode: 'ephemeral_session' | 'supabase_cloud' | 'degraded_fallback';

  getProfile(userId: string): Promise<UserProfileRecord>;
  updateProfile(
    userId: string,
    patch: Partial<Omit<UserProfileRecord, 'id'>>
  ): Promise<UserProfileRecord>;

  listProjects(userId: string): Promise<ProjectRecord[]>;
  createProject(
    userId: string,
    project: { name: string; slug: string; description?: string }
  ): Promise<ProjectRecord>;

  listConversations(userId: string, limit?: number): Promise<ConversationSummary[]>;
  getConversation(userId: string, conversationId: string): Promise<ConversationSummary | null>;
  createConversation(
    userId: string,
    input?: { id?: string; title?: string; projectId?: string | null; style?: ResponseStyle }
  ): Promise<ConversationSummary>;

  getMessages(userId: string, conversationId: string): Promise<ChatMessage[]>;
  appendMessage(userId: string, message: ChatMessage): Promise<void>;

  listMemories(userId: string, filter?: ListMemoriesFilter): Promise<MemoryEntry[]>;
  addMemory(
    userId: string,
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'persistenceLayer'> & {
      embedding?: number[];
    }
  ): Promise<MemoryEntry>;
  updateMemory(
    userId: string,
    memoryId: string,
    patch: MemoryUpdatePatch
  ): Promise<MemoryEntry | null>;
  deleteMemory(userId: string, memoryId: string): Promise<boolean>;
  searchMemoriesByVector(
    userId: string,
    queryEmbedding: number[],
    matchThreshold?: number,
    matchCount?: number
  ): Promise<MemoryEntry[]>;

  getPreferences(userId: string): Promise<PersonalityPreferences>;
  updatePreferences(
    userId: string,
    patch: Partial<PersonalityPreferences>
  ): Promise<PersonalityPreferences>;

  listConnectedTools(userId: string): Promise<ConnectedToolRecord[]>;
  upsertConnectedTool(
    userId: string,
    tool: Omit<ConnectedToolRecord, 'id' | 'updatedAt'>
  ): Promise<ConnectedToolRecord>;

  recordAgentTask(
    userId: string,
    task: Omit<AgentTaskRecord, 'id' | 'createdAt'> & { id?: string }
  ): Promise<AgentTaskRecord>;
  updateAgentTask(
    userId: string,
    taskId: string,
    patch: Partial<Omit<AgentTaskRecord, 'id' | 'createdAt'>>
  ): Promise<AgentTaskRecord | null>;
  listAgentTasks(userId: string, limit?: number): Promise<AgentTaskRecord[]>;

  recordPermission(userId: string, record: PermissionRecord): Promise<void>;
  updatePermissionDecision(
    userId: string,
    recordId: string,
    decision: PermissionRecord['decision'],
    verifiedAuthMethod?: string
  ): Promise<PermissionRecord | null>;
  listPermissionRecords(userId: string, limit?: number): Promise<PermissionRecord[]>;

  appendAuditLog(
    userId: string,
    entry: Omit<AuditLogEntry, 'id' | 'createdAt'>
  ): Promise<AuditLogEntry>;
  listAuditLogs(userId: string, limit?: number): Promise<AuditLogEntry[]>;

  recordIngestedDocument?(
    userId: string,
    doc: Omit<IngestedDocumentRecord, 'id' | 'createdAt'>
  ): Promise<IngestedDocumentRecord>;
  listIngestedDocuments?(
    userId: string,
    limit?: number
  ): Promise<IngestedDocumentRecord[]>;

  listProactiveWorkflows?(userId: string): Promise<ProactiveWorkflowRecord[]>;
  createProactiveWorkflow?(
    userId: string,
    workflow: Omit<
      ProactiveWorkflowRecord,
      'id' | 'runCount' | 'lastRunAt' | 'createdAt' | 'updatedAt'
    >
  ): Promise<ProactiveWorkflowRecord>;
  updateProactiveWorkflow?(
    userId: string,
    workflowId: string,
    patch: Partial<
      Pick<
        ProactiveWorkflowRecord,
        'title' | 'description' | 'directivePrompt' | 'enabled' | 'runCount' | 'lastRunAt' | 'metadata'
      >
    >
  ): Promise<ProactiveWorkflowRecord | null>;
  deleteProactiveWorkflow?(userId: string, workflowId: string): Promise<boolean>;
}
