import type { PermissionRequest, PermissionTier } from './permission';
import type { MemoryCategory, MemoryEntry } from './memory';
import type {
  CostClass,
  FallbackAttemptRecord,
  ModelCapability,
  ModelExecutionTelemetry,
  ModelModality,
  ModelStreamChunk,
  ModelToolCallProposal,
  ModelToolDefinition,
  ProviderAvailability,
  ProviderConfigState,
  ProviderRuntimeHealthState,
  RegisteredModelMetadata,
  RoutingPolicyMode,
} from './model-router';
import type { ResponseStyle } from './emotion-style';

/**
 * =============================================================================
 * JARVIS-X CORE RUNTIME TYPE CONTRACTS
 * Central server-side orchestration types independent from UI presentation.
 * =============================================================================
 */

// -----------------------------------------------------------------------------
// 1. Input Modalities & Runtime Request
// -----------------------------------------------------------------------------
export type InputModality = 'text' | 'voice_transcript' | 'vision_multimodal';

export interface VoiceInputEnvelope {
  transcriptConfidence?: number;
  languageCode?: string;
  durationMs?: number;
  bargeInTriggered?: boolean;
}

export interface VisionInputEnvelope {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  base64Data?: string;
  source?: 'upload' | 'camera_preview';
}

export interface DocumentInputEnvelope {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  textContent: string;
  ingestToKnowledge?: boolean;
}

export interface UntrustedExternalSource {
  sourceType: 'web' | 'file' | 'retrieved_document' | 'tool_output' | 'external_api';
  label: string;
  rawContent: string;
}

export interface RuntimeExecutionLimits {
  maxSteps: number;
  maxStateTransitions: number;
  maxRetriesPerStep: number;
  executionTimeoutMs: number;
  maxToolCalls: number;
  maxModelFallbacks?: number;
}

export interface RuntimeRequest {
  taskId?: string;
  conversationId?: string;
  projectId?: string | null;
  modality?: InputModality;
  message: string;
  voiceInput?: VoiceInputEnvelope;
  voiceMeta?: VoiceInputEnvelope;
  visionAttachment?: VisionInputEnvelope;
  documentAttachment?: DocumentInputEnvelope;
  untrustedSources?: UntrustedExternalSource[];
  routingPolicyOverride?: RoutingPolicyMode;
  manualModelIdOverride?: string | null;
  requireStructuredOutput?: boolean;
  limits?: Partial<RuntimeExecutionLimits>;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// 2. Bounded Agent State Machine
// -----------------------------------------------------------------------------
export type RuntimeState =
  | 'RECEIVED'
  | 'UNDERSTANDING'
  | 'CONTEXT_LOADING'
  | 'PLANNING'
  | 'SELECTING_CAPABILITY'
  | 'EXECUTING'
  | 'OBSERVING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'WAITING_FOR_USER_APPROVAL'
  | 'FAILED'
  | 'CANCELLED';

export interface RuntimeStateTransition {
  from: RuntimeState | null;
  to: RuntimeState;
  reason: string;
  timestamp: string;
  elapsedMs: number;
}

// -----------------------------------------------------------------------------
// 3. Extensible Task Classification
// -----------------------------------------------------------------------------
export type CoreTaskType =
  | 'conversation'
  | 'research'
  | 'coding'
  | 'planning'
  | 'file_task'
  | 'knowledge_retrieval'
  | 'automation'
  | 'vision_task'
  | 'cybersecurity'
  | 'external_action';

export type TaskType = CoreTaskType | (string & {});

export type ExecutionStrategy =
  | 'direct_response'
  | 'capability_tool'
  | 'specialist_agent'
  | 'multi_step_plan';

export interface TaskClassification {
  taskType: TaskType;
  secondaryTaskTypes: TaskType[];
  intent: string;
  strategy: ExecutionStrategy;
  modality: InputModality;
  complexity: 'simple' | 'moderate' | 'complex';
  confidence: number;
  summary: string;
  extractedMemoryFact?: string;
}

// -----------------------------------------------------------------------------
// 4. Risk Classification
// -----------------------------------------------------------------------------
export type RiskLevel =
  | 'READ_ONLY'
  | 'LOW_RISK'
  | 'CONFIRMATION_REQUIRED'
  | 'SENSITIVE';

export interface RiskClassification {
  riskLevel: RiskLevel;
  mappedPermissionTier: PermissionTier;
  requiresApprovalPause: boolean;
  requiresStepUpVerification: boolean;
  actionCode: string;
  targetResource: string;
  rationale: string;
  blockedOffensiveRequest?: boolean;
}

// -----------------------------------------------------------------------------
// 5. Structured Planner (Zero Private Chain-of-Thought)
// -----------------------------------------------------------------------------
export type PlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'waiting_approval'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface TaskPlanStep {
  stepId: string;
  order: number;
  objective: string;
  requiredCapability: RuntimeCapabilityId;
  specialistId?: RuntimeSpecialistId;
  dependencies: string[];
  riskLevel: RiskLevel;
  status: PlanStepStatus;
  expectedResult: string;
  observationSummary?: string;
  attempts: number;
}

export interface TaskPlan {
  planId: string;
  taskId: string;
  strategy: ExecutionStrategy;
  conciseSummary: string;
  steps: TaskPlanStep[];
  createdAt: string;
}

// -----------------------------------------------------------------------------
// 6. Capability Registry
// -----------------------------------------------------------------------------
export type CoreCapabilityId =
  | 'direct_conversation'
  | 'memory'
  | 'research'
  | 'coding'
  | 'vision'
  | 'file_intelligence'
  | 'automation'
  | 'verification'
  | 'cybersecurity'
  | 'external_tools';

export type RuntimeCapabilityId = CoreCapabilityId | (string & {});

export type CapabilityAvailabilityStatus =
  | 'AVAILABLE'
  | 'PARTIAL_LOCAL'
  | 'NOT_AVAILABLE';

export interface CapabilityDefinition {
  id: RuntimeCapabilityId;
  name: string;
  description: string;
  availability: CapabilityAvailabilityStatus;
  defaultRiskLevel: RiskLevel;
  countsAsToolCall: boolean;
  supportsModalities: InputModality[];
  missingDependencyNote?: string;
}

export interface CapabilityExecutionContext {
  taskId: string;
  userId: string;
  conversationId: string;
  projectId?: string | null;
  step: TaskPlanStep;
  userMessage: string;
  taskClassification: TaskClassification;
  memorySnippets: string[];
  visionAttachment?: VisionInputEnvelope;
  documentAttachment?: DocumentInputEnvelope;
  signal?: AbortSignal;
}

export interface CapabilityExecutionResult {
  capabilityId: RuntimeCapabilityId;
  status: 'EXECUTED' | 'PARTIAL_LOCAL' | 'NOT_AVAILABLE';
  summary: string;
  data?: Record<string, unknown>;
  untrustedExternalContent?: boolean;
  honestLimitationNote?: string;
}

// -----------------------------------------------------------------------------
// 7. Specialist Agent Contract (All 10 Specialist Agents)
// -----------------------------------------------------------------------------
export type RuntimeSpecialistId =
  | 'research'
  | 'coding'
  | 'planning'
  | 'vision'
  | 'memory'
  | 'automation'
  | 'verification'
  | 'cybersecurity'
  | 'data'
  | 'design';

export type SpecialistImplementationStatus =
  | 'OPERATIONAL_LOCAL'
  | 'CONTRACT_ONLY_NOT_AVAILABLE';

export interface SpecialistContractDescriptor {
  id: RuntimeSpecialistId;
  agentClassName:
    | 'ResearchAgent'
    | 'CodingAgent'
    | 'PlanningAgent'
    | 'VisionAgent'
    | 'MemoryAgent'
    | 'AutomationAgent'
    | 'VerificationAgent'
    | 'CybersecurityAgent'
    | 'DataAgent'
    | 'DesignAgent';
  displayName: string;
  roleSummary: string;
  status: SpecialistImplementationStatus;
  primaryCapability: RuntimeCapabilityId;
  defaultRiskLevel: RiskLevel;
  missingDependencies: string[];
}

// -----------------------------------------------------------------------------
// 8. Memory Integration Contract (7 Future Memory Scopes)
// -----------------------------------------------------------------------------
export type MemoryScopeKind =
  | 'working'
  | 'episodic'
  | 'semantic'
  | 'project'
  | 'knowledge'
  | 'procedural'
  | 'event';

export interface MemoryScopeDescriptor {
  scope: MemoryScopeKind;
  implementedNow: boolean;
  backingStore: string;
  notes: string;
}

export interface LoadedRuntimeContext {
  userId: string;
  authenticated: boolean;
  conversationId: string;
  projectId: string | null;
  workingMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  relevantMemories: MemoryEntry[];
  untrustedMemorySources?: UntrustedExternalSource[];
  memoryRetrievalSummary?: {
    totalTokensEstimated: number;
    untrustedItemsQuarantined: number;
    expiredFilteredOut: number;
    supersededFilteredOut: number;
  };
  preferredStyle: ResponseStyle;
  preferredProviderId: string;
  routingPolicy: RoutingPolicyMode;
  manualModelId: string | null;
  voiceProfileId: string;
  witLevel: 'minimal' | 'subtle' | 'moderate';
  conciseness: 'brief' | 'balanced' | 'detailed';
  proactiveEnabled: boolean;
  memoryScopesAvailable: MemoryScopeDescriptor[];
}

export interface DurableMemoryCandidate {
  shouldPersist: boolean;
  category?: MemoryCategory;
  content?: string;
  reason: string;
}

// -----------------------------------------------------------------------------
// 9 & 10. Production Provider Adapter & Multi-Model Router Contracts
// -----------------------------------------------------------------------------
export type ModelTaskDomain =
  | 'reasoning'
  | 'conversation'
  | 'coding'
  | 'vision'
  | 'research'
  | 'realtime_voice';

export interface ProviderHealth {
  providerId: string;
  providerName: string;
  status: ProviderAvailability;
  runtimeHealth?: ProviderRuntimeHealthState;
  configurationState?: ProviderConfigState;
  latencyEstimateMs?: number;
  requiresPaidKey: boolean;
  checkedAt: string;
  detail: string;
}

export interface ModelRequest {
  taskId: string;
  modelId?: string;
  taskDomain: ModelTaskDomain;
  systemPrompt: string;
  userPrompt: string;
  untrustedDataContext?: string;
  workingHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  responseStyle: ResponseStyle;
  capabilityContext?: string;
  memoryContext?: string[];
  systemSummary?: string;
  availableTools?: ModelToolDefinition[];
  structuredOutputSchemaName?: string;
  expectStructuredJson?: boolean;
  visionAttachment?: VisionInputEnvelope;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  providerId: string;
  modelId: string;
  content: string;
  structuredData?: unknown;
  toolCallProposals?: ModelToolCallProposal[];
  tokensUsedEstimate: number;
  latencyMs: number;
  isDeterministicFallback: boolean;
}

export interface AIProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly supportedDomains: ModelTaskDomain[];
  readonly capabilities: ModelCapability[];
  getHealth(): Promise<ProviderHealth> | ProviderHealth;
  isAvailable(): boolean;
  listRegisteredModels?(): RegisteredModelMetadata[];
  generate(request: ModelRequest): Promise<ModelResponse>;
  streamGenerate?(
    request: ModelRequest
  ): AsyncGenerator<ModelStreamChunk, ModelResponse, void>;
}

export interface ModelRoutingCriteria {
  taskId?: string;
  taskType: TaskType;
  taskDomain: ModelTaskDomain;
  requiredCapabilities: ModelCapability[];
  requiredModality?: ModelModality;
  requireToolUse?: boolean;
  requireStructuredOutput?: boolean;
  routingPolicy?: RoutingPolicyMode;
  manualModelId?: string | null;
  preferredProviderId?: string;
  latencyPreference: 'ultra-low' | 'balanced' | 'deep-reasoning';
  costConstraint: 'free_only' | 'standard' | 'unrestricted';
  maxAllowedCostClass?: CostClass;
  estimatedContextTokens: number;
  minimumReliability: number; // 0..1
  maxFallbackAttempts?: number;
  allowDeterministicFallback?: boolean;
}

export interface ModelRoutingResult {
  selectedProviderId: string;
  selectedModelId: string;
  selectedDisplayName: string;
  routingPolicy: RoutingPolicyMode;
  automaticMultiModelRoutingActive: boolean;
  fallbackUsed: boolean;
  fallbackCount: number;
  fallbackReasons: string[];
  attempts?: FallbackAttemptRecord[];
  rationale: string;
  telemetry?: ModelExecutionTelemetry;
}

// -----------------------------------------------------------------------------
// 11. Verification Contract
// -----------------------------------------------------------------------------
export type RuntimeVerificationStatus =
  | 'VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'FAILED_VERIFICATION'
  | 'NOT_VERIFIABLE';

export interface RuntimeVerificationReport {
  executionCompleted: boolean;
  verificationStatus: RuntimeVerificationStatus;
  checksPassed: string[];
  checksFailed: string[];
  warnings: string[];
  unavailableCapabilitiesReportedHonestly: boolean;
  approvalGateRespected: boolean;
  summary: string;
}

// -----------------------------------------------------------------------------
// 12, 13 & 16. Structured Errors, Audit Metadata & Traceability
// -----------------------------------------------------------------------------
export type RuntimeErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED_ACCESS'
  | 'CAPABILITY_NOT_AVAILABLE'
  | 'PROVIDER_UNAVAILABLE'
  | 'NO_COMPATIBLE_MODEL'
  | 'MALFORMED_STRUCTURED_OUTPUT'
  | 'EXECUTION_TIMEOUT'
  | 'RETRY_LIMIT_EXCEEDED'
  | 'STEP_LIMIT_EXCEEDED'
  | 'STATE_TRANSITION_LIMIT_EXCEEDED'
  | 'INVALID_STATE_TRANSITION'
  | 'PLAN_DEPENDENCY_CYCLE'
  | 'TOOL_CALL_LIMIT_EXCEEDED'
  | 'TASK_CANCELLED'
  | 'VERIFICATION_FAILED'
  | 'STEP_EXECUTION_FAILED';

export interface StructuredRuntimeError {
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
  failedState: RuntimeState;
  attemptsMade: number;
  timestamp: string;
}

export type ApprovalLifecycleState =
  | 'not_required'
  | 'pending'
  | 'approved'
  | 'denied'
  | 'blocked_unauthenticated';

export interface RuntimeTaskMetadata {
  taskId: string;
  userId: string;
  conversationId: string;
  projectId: string | null;
  taskType: TaskType;
  riskLevel: RiskLevel;
  selectedCapability: RuntimeCapabilityId;
  selectedSpecialist?: RuntimeSpecialistId;
  selectedProviderId?: string;
  selectedModelId?: string;
  routingPolicy?: RoutingPolicyMode;
  fallbackCount?: number;
  executionState: RuntimeState;
  approvalState: ApprovalLifecycleState;
  verificationStatus: RuntimeVerificationStatus;
  errorStatus: RuntimeErrorCode | null;
  retryCount: number;
  toolCallsCount: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
}

export interface TaskTraceEvent {
  traceId: string;
  taskId: string;
  phase:
    | 'request'
    | 'understanding'
    | 'context_loading'
    | 'planning'
    | 'capability_selection'
    | 'model_routing'
    | 'execution'
    | 'observation'
    | 'verification'
    | 'completion'
    | 'error';
  state: RuntimeState;
  summary: string;
  attributes?: Record<string, string | number | boolean | null>;
  timestamp: string;
  durationMs?: number;
}

export interface RuntimeExecutionResult {
  taskId: string;
  conversationId: string;
  finalState: RuntimeState;
  responseContent: string;
  responseStyle: ResponseStyle;
  taskClassification: TaskClassification;
  riskClassification: RiskClassification;
  plan: TaskPlan;
  capabilityResults: CapabilityExecutionResult[];
  routing: ModelRoutingResult;
  modelTelemetry?: ModelExecutionTelemetry;
  promptInjectionDetected?: boolean;
  verification: RuntimeVerificationReport;
  metadata: RuntimeTaskMetadata;
  stateHistory: RuntimeStateTransition[];
  trace: TaskTraceEvent[];
  pendingApproval?: PermissionRequest;
  error?: StructuredRuntimeError;
  partialResultsPreserved: boolean;
}
