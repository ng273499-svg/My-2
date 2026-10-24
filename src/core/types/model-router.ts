import type { ResponseStyle } from './emotion-style';

export type ModelCapability =
  | 'conversation'
  | 'chat'
  | 'streaming'
  | 'reasoning'
  | 'coding'
  | 'vision'
  | 'structured_output'
  | 'tool_calling'
  | 'audio_in'
  | 'audio_out'
  | 'embeddings';

export type ModelModality = 'text' | 'image' | 'audio';

export type RoutingPolicyMode =
  | 'AUTO_BALANCED'
  | 'QUALITY_FIRST'
  | 'SPEED_FIRST'
  | 'COST_AWARE'
  | 'MANUAL';

export type ProviderAvailability = 'ready' | 'not_configured' | 'degraded';

export type ProviderConfigState = 'CONFIGURED' | 'UNCONFIGURED';

export type ProviderRuntimeHealthState =
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type LatencyClass =
  | 'ULTRA_LOW'
  | 'FAST'
  | 'BALANCED'
  | 'DEEP'
  | 'UNKNOWN';

export type CostClass =
  | 'ZERO_COST'
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'UNKNOWN';

export type ProviderFailureKind =
  | 'TEMPORARY_PROVIDER_FAILURE'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'MALFORMED_STRUCTURED_OUTPUT'
  | 'AUTH_OR_CONFIG_ERROR';

export interface RegisteredModelMetadata {
  modelId: string;
  providerId: string;
  providerName: string;
  displayName: string;
  capabilities: ModelCapability[];
  supportedModalities: ModelModality[];
  configurationState: ProviderConfigState;
  enabled: boolean;
  contextWindowTokens: number | 'UNKNOWN';
  maxOutputTokens: number | 'UNKNOWN';
  latencyClass: LatencyClass;
  costClass: CostClass;
  qualityTier: number | 'UNKNOWN'; // 1..100 relative capability tier when empirically known, else UNKNOWN
  reliabilityScore: number; // 0..1 baseline reliability
  supportsToolUse: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
  healthStatus: ProviderRuntimeHealthState;
  isDeterministicFallback?: boolean;
  statusNote: string;
}

export interface ProviderHealthSummary {
  providerId: string;
  providerName: string;
  configurationState: ProviderConfigState;
  healthState: ProviderRuntimeHealthState;
  circuitState: CircuitBreakerState;
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
  effectiveReliability: number;
  cooldownUntilIso: string | null;
  lastErrorSummary: string | null;
  lastCheckedAt: string;
}

export interface ModelToolDefinition {
  name: string;
  capabilityId: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface ModelToolCallProposal {
  callId: string;
  toolName: string;
  capabilityId: string;
  arguments: Record<string, unknown>;
  reason?: string;
}

export type ModelStreamChunk =
  | {
      type: 'delta';
      textDelta: string;
      modelId: string;
      providerId: string;
    }
  | {
      type: 'tool_call_proposal';
      proposal: ModelToolCallProposal;
      modelId: string;
      providerId: string;
    }
  | {
      type: 'done';
      latencyMs: number;
      tokensUsedEstimate: number;
      modelId: string;
      providerId: string;
    };

export interface FallbackAttemptRecord {
  providerId: string;
  modelId: string;
  failureKind: ProviderFailureKind;
  reason: string;
  durationMs: number;
}

export interface ModelExecutionTelemetry {
  taskId: string;
  providerId: string;
  modelId: string;
  routingPolicy: RoutingPolicyMode;
  selectionReason: string;
  requiredCapabilities: ModelCapability[];
  latencyMs: number;
  succeeded: boolean;
  fallbackCount: number;
  fallbackReasons: string[];
  attempts: FallbackAttemptRecord[];
  verificationResult?: string;
}

// Legacy descriptor interface retained for backward compatibility
export interface ModelDescriptor {
  id: string;
  providerId: string;
  providerName: string;
  displayName: string;
  availability: ProviderAvailability;
  isPaidExternal: boolean;
  requiredEnvVar?: string;
  capabilities: ModelCapability[];
  latencyProfile: 'ultra-low' | 'balanced' | 'deep-reasoning';
  statusNote: string;
}

export interface ModelGenerationInput {
  systemDirective: string;
  userMessage: string;
  conversationContext: Array<{ role: 'user' | 'assistant'; content: string }>;
  responseStyle: ResponseStyle;
  specialistSummary?: string;
  memorySnippets?: string[];
  systemCapabilitiesSummary: string;
}

export interface ModelGenerationOutput {
  content: string;
  modelId: string;
  providerId: string;
  tokensEstimated: number;
  latencyMs: number;
  usedFallbackFoundation: boolean;
}

export interface ModelProviderAdapter {
  readonly providerId: string;
  readonly providerName: string;
  isConfigured(): boolean;
  listModels(): ModelDescriptor[];
  generate(input: ModelGenerationInput): Promise<ModelGenerationOutput>;
}

export interface ModelRouteDecision {
  selectedModel: ModelDescriptor;
  reason: string;
  fallbackUsed: boolean;
}
