import type { AgentActivityStep, SpecialistDomain } from './agent';
import type { ProactiveAdvisory, ToolCapabilityDescriptor } from './capability';
import type {
  ContextSignals,
  PersonalityPreferences,
  ResponseStyle,
  VoiceProsodyHint,
} from './emotion-style';
import type { MemoryEntry, MemoryStatusSummary } from './memory';
import type {
  ModelDescriptor,
  ModelExecutionTelemetry,
  ModelRouteDecision,
  ProviderHealthSummary,
  RegisteredModelMetadata,
  RoutingPolicyMode,
} from './model-router';
import type {
  AuditLogEntry,
  PermissionRecord,
  PermissionRequest,
} from './permission';
import type {
  CapabilityDefinition,
  RuntimeExecutionLimits,
  RuntimeExecutionResult,
  RuntimeTaskMetadata,
  SpecialistContractDescriptor,
} from './runtime';

export type VerificationOutcome = 'verified' | 'caution' | 'blocked' | 'pending';

export interface VerificationSummary {
  outcome: VerificationOutcome;
  checksPassed: string[];
  warnings: string[];
  noFabricatedCapabilitiesConfirmed: boolean;
  permissionPolicyVerified: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  projectId?: string | null;
  activeModelId: string;
  lastResponseStyle: ResponseStyle;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  responseStyle?: ResponseStyle;
  prosodyHint?: VoiceProsodyHint;
  modelId?: string;
  specialistAgent?: SpecialistDomain;
  verification?: VerificationSummary;
  pendingPermission?: PermissionRequest;
  activityTrace?: AgentActivityStep[];
  taskId?: string;
}

export interface TurnRequest {
  conversationId?: string;
  projectId?: string | null;
  message: string;
  modality?: 'text' | 'voice_transcript' | 'vision_multimodal';
  voiceMeta?: {
    transcriptConfidence?: number;
    languageCode?: string;
    durationMs?: number;
    bargeInTriggered?: boolean;
  };
  visionAttachment?: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    width?: number;
    height?: number;
    base64Data?: string;
    source?: 'upload' | 'camera_preview';
  };
  documentAttachment?: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    textContent: string;
    ingestToKnowledge?: boolean;
  };
  limits?: Partial<RuntimeExecutionLimits>;
  signal?: AbortSignal;
}

export interface TurnResponse {
  taskId: string;
  conversationId: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  activitySteps: AgentActivityStep[];
  contextSignals: ContextSignals;
  routeDecision: ModelRouteDecision;
  verification: VerificationSummary;
  memoryStatus: MemoryStatusSummary;
  pendingPermission?: PermissionRequest;
  runtime: RuntimeExecutionResult;
}

export interface ArchitectureModuleStatus {
  id: string;
  name: string;
  layer: 'core' | 'cognitive' | 'multimodal' | 'execution' | 'governance';
  state: 'online' | 'interface_ready';
  summary: string;
}

export interface AuthSessionStatus {
  authenticated: boolean;
  userId: string;
  email?: string;
  displayName: string;
  callsign: string;
  verificationMode:
    | 'supabase_jwt'
    | 'degraded_offline_jwt'
    | 'anonymous_ephemeral';
}

export interface JarvisSystemSnapshot {
  version: string;
  coreState: 'online' | 'degraded';
  serverTimestamp: string;
  auth: AuthSessionStatus;
  supabase: {
    configured: boolean;
    projectRef: string | null;
    serverReachability: 'connected' | 'degraded_unreachable' | 'not_configured';
    authReady: boolean;
    pgvectorEnabled: boolean;
    rlsForced: boolean;
    persistenceMode: 'supabase_cloud' | 'degraded_fallback' | 'ephemeral_session';
    domainsPrepared: string[];
    migrationPath: string;
    migrationPaths: string[];
    statusDetail: string;
  };
  activeModel: ModelDescriptor;
  registeredModels: ModelDescriptor[];
  modelSystem?: {
    routingPolicy: RoutingPolicyMode;
    manualModelId: string | null;
    activeProviderId: string;
    activeModelId: string;
    automaticMultiModelRoutingActive: boolean;
    fallbackActive: boolean;
    catalog: RegisteredModelMetadata[];
    providerHealth: ProviderHealthSummary[];
    recentTelemetry: ModelExecutionTelemetry[];
  };
  modules: ArchitectureModuleStatus[];
  specialists: Array<{
    id: SpecialistDomain;
    name: string;
    roleSummary: string;
    readiness: 'operational_local' | 'interface_ready';
    defaultPermissionTier: string;
    missingDependencies: string[];
  }>;
  specialistContracts?: SpecialistContractDescriptor[];
  runtimeCapabilities?: CapabilityDefinition[];
  recentTasks?: RuntimeTaskMetadata[];
  capabilities: ToolCapabilityDescriptor[];
  conversations: ConversationSummary[];
  memory: MemoryStatusSummary;
  recentMemories: MemoryEntry[];
  preferences: PersonalityPreferences;
  permissionAudit: PermissionRecord[];
  auditLogs: AuditLogEntry[];
  proactiveAdvisories: ProactiveAdvisory[];
}
