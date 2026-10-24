import type {
  AIProvider,
  LatencyClass,
  ModelCapability,
  ModelDescriptor,
  ModelProviderAdapter,
  ProviderAvailability,
  RegisteredModelMetadata,
} from '@/core/types';
import { ProviderHealthTracker } from './health-circuit-breaker';

function expandCapabilities(caps: ModelCapability[]): ModelCapability[] {
  const set = new Set<ModelCapability>(caps);
  if (set.has('chat') || set.has('conversation')) {
    set.add('chat');
    set.add('conversation');
  }
  return Array.from(set);
}

function mapLatencyClassToLegacyProfile(
  latencyClass: LatencyClass
): ModelDescriptor['latencyProfile'] {
  if (latencyClass === 'ULTRA_LOW' || latencyClass === 'FAST') return 'ultra-low';
  if (latencyClass === 'DEEP') return 'deep-reasoning';
  return 'balanced';
}

/**
 * Dynamic Model Registry.
 * Stores structured capability, modality, context, latency, cost, reliability, and
 * live health metadata for all registered models across all providers without
 * fabricating unknown specifications (`UNKNOWN` is preserved explicitly).
 */
export class ModelRegistry {
  private readonly providers = new Map<string, AIProvider>();
  private readonly models = new Map<string, RegisteredModelMetadata>();
  private readonly disabledModelIds = new Set<string>();

  constructor(private readonly healthTracker: ProviderHealthTracker) {}

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.providerId, provider);

    const declaredModels = provider.listRegisteredModels?.() ?? [];
    const isConfigured = provider.isAvailable();

    this.healthTracker.registerProvider({
      providerId: provider.providerId,
      providerName: provider.providerName,
      configurationState: isConfigured ? 'CONFIGURED' : 'UNCONFIGURED',
      baseReliability: declaredModels[0]?.reliabilityScore ?? 0.95,
    });

    if (declaredModels.length > 0) {
      for (const meta of declaredModels) {
        this.registerModel({
          ...meta,
          capabilities: expandCapabilities(meta.capabilities),
          enabled: meta.enabled && !this.disabledModelIds.has(meta.modelId),
        });
      }
      return;
    }

    // Synthesize safe metadata for custom/mock AIProvider implementations that do not
    // override `listRegisteredModels()`, preserving `UNKNOWN` for unspecified attributes.
    const normalizedCaps = expandCapabilities(provider.capabilities);
    const synthesizedModelId = `${provider.providerId}-default`;
    this.registerModel({
      modelId: synthesizedModelId,
      providerId: provider.providerId,
      providerName: provider.providerName,
      displayName: provider.providerName,
      capabilities: normalizedCaps,
      supportedModalities: normalizedCaps.includes('vision')
        ? ['text', 'image']
        : ['text'],
      configurationState: isConfigured ? 'CONFIGURED' : 'UNCONFIGURED',
      enabled: !this.disabledModelIds.has(synthesizedModelId),
      contextWindowTokens: 'UNKNOWN',
      maxOutputTokens: 'UNKNOWN',
      latencyClass: 'BALANCED',
      costClass: 'UNKNOWN',
      qualityTier: 85,
      reliabilityScore: 0.95,
      supportsToolUse: normalizedCaps.includes('tool_calling'),
      supportsStructuredOutput: normalizedCaps.includes('structured_output'),
      supportsStreaming: normalizedCaps.includes('streaming'),
      healthStatus: isConfigured ? 'AVAILABLE' : 'UNAVAILABLE',
      isDeterministicFallback: false,
      statusNote: isConfigured
        ? 'Registered custom AIProvider.'
        : 'UNCONFIGURED custom AIProvider.',
    });
  }

  /**
   * Bridges legacy `ModelProviderAdapter` plugins registered on `AIModelRouter`
   * into the unified `ModelRegistry` + `AIProvider` system so zero core rewrites
   * are required when adding custom providers.
   */
  registerLegacyAdapter(adapter: ModelProviderAdapter): void {
    const legacyModels = adapter.listModels();
    const allCaps = new Set<ModelCapability>();
    for (const m of legacyModels) {
      for (const c of expandCapabilities(m.capabilities)) {
        allCaps.add(c);
      }
    }

    const bridgedProvider: AIProvider = {
      providerId: adapter.providerId,
      providerName: adapter.providerName,
      supportedDomains: ['conversation', 'reasoning', 'coding'],
      capabilities: Array.from(allCaps),
      isAvailable: () => adapter.isConfigured(),
      getHealth: () => ({
        providerId: adapter.providerId,
        providerName: adapter.providerName,
        status: adapter.isConfigured() ? 'ready' : 'not_configured',
        runtimeHealth: adapter.isConfigured() ? 'AVAILABLE' : 'UNAVAILABLE',
        configurationState: adapter.isConfigured() ? 'CONFIGURED' : 'UNCONFIGURED',
        requiresPaidKey: legacyModels.some((m) => m.isPaidExternal),
        checkedAt: new Date().toISOString(),
        detail: legacyModels[0]?.statusNote ?? adapter.providerName,
      }),
      listRegisteredModels: () =>
        legacyModels.map((lm) => {
          const caps = expandCapabilities(lm.capabilities);
          const configured = adapter.isConfigured() && lm.availability === 'ready';
          return {
            modelId: lm.id,
            providerId: adapter.providerId,
            providerName: adapter.providerName,
            displayName: lm.displayName,
            capabilities: caps,
            supportedModalities: caps.includes('vision') ? ['text', 'image'] : ['text'],
            configurationState: configured ? 'CONFIGURED' : 'UNCONFIGURED',
            enabled: !this.disabledModelIds.has(lm.id),
            contextWindowTokens: 'UNKNOWN',
            maxOutputTokens: 'UNKNOWN',
            latencyClass:
              lm.latencyProfile === 'ultra-low'
                ? 'ULTRA_LOW'
                : lm.latencyProfile === 'deep-reasoning'
                  ? 'DEEP'
                  : 'BALANCED',
            costClass: lm.isPaidExternal ? 'UNKNOWN' : 'ZERO_COST',
            qualityTier: 'UNKNOWN',
            reliabilityScore: 0.95,
            supportsToolUse: caps.includes('tool_calling'),
            supportsStructuredOutput: caps.includes('structured_output'),
            supportsStreaming: caps.includes('streaming'),
            healthStatus: configured ? 'AVAILABLE' : 'UNAVAILABLE',
            isDeterministicFallback: adapter.providerId === 'jarvis-foundation',
            statusNote: lm.statusNote,
          };
        }),
      generate: async (req) => {
        const out = await adapter.generate({
          systemDirective: req.systemPrompt,
          userMessage: req.userPrompt,
          conversationContext: req.workingHistory,
          responseStyle: req.responseStyle,
          specialistSummary: req.capabilityContext,
          memorySnippets: req.memoryContext,
          systemCapabilitiesSummary: req.systemSummary ?? '',
        });
        return {
          providerId: out.providerId,
          modelId: out.modelId,
          content: out.content,
          tokensUsedEstimate: out.tokensEstimated,
          latencyMs: out.latencyMs,
          isDeterministicFallback: out.usedFallbackFoundation,
        };
      },
    };

    this.registerProvider(bridgedProvider);
  }

  registerModel(metadata: RegisteredModelMetadata): void {
    const normalized: RegisteredModelMetadata = {
      ...metadata,
      capabilities: expandCapabilities(metadata.capabilities),
      enabled: metadata.enabled && !this.disabledModelIds.has(metadata.modelId),
    };
    this.models.set(normalized.modelId, normalized);
  }

  setModelEnabled(modelId: string, enabled: boolean): boolean {
    const existing = this.models.get(modelId);
    if (!existing) return false;
    if (enabled) {
      this.disabledModelIds.delete(modelId);
    } else {
      this.disabledModelIds.add(modelId);
    }
    this.models.set(modelId, { ...existing, enabled });
    return true;
  }

  getProvider(providerId: string): AIProvider | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  getModel(modelId: string): RegisteredModelMetadata | undefined {
    const raw = this.models.get(modelId);
    if (!raw) return undefined;
    return this.hydrateLiveMetadata(raw);
  }

  listModels(): RegisteredModelMetadata[] {
    // Refresh dynamic configuration state from providers that read env vars lazily
    for (const provider of this.providers.values()) {
      const freshModels = provider.listRegisteredModels?.();
      if (freshModels && freshModels.length > 0) {
        const providerConfigured = provider.isAvailable();
        const existingSummary = this.healthTracker.getSummary(provider.providerId);
        if (
          existingSummary &&
          existingSummary.configurationState !==
            (providerConfigured ? 'CONFIGURED' : 'UNCONFIGURED')
        ) {
          this.healthTracker.registerProvider({
            providerId: provider.providerId,
            providerName: provider.providerName,
            configurationState: providerConfigured ? 'CONFIGURED' : 'UNCONFIGURED',
          });
        }
        for (const fm of freshModels) {
          const prev = this.models.get(fm.modelId);
          this.models.set(fm.modelId, {
            ...fm,
            capabilities: expandCapabilities(fm.capabilities),
            enabled:
              (prev?.enabled ?? fm.enabled) && !this.disabledModelIds.has(fm.modelId),
          });
        }
      }
    }

    return Array.from(this.models.values()).map((m) => this.hydrateLiveMetadata(m));
  }

  private hydrateLiveMetadata(model: RegisteredModelMetadata): RegisteredModelMetadata {
    const providerSummary = this.healthTracker.getSummary(model.providerId);
    const configurationState =
      providerSummary?.configurationState ?? model.configurationState;
    const healthStatus =
      configurationState === 'UNCONFIGURED'
        ? 'UNAVAILABLE'
        : providerSummary?.healthState ?? model.healthStatus;

    return {
      ...model,
      enabled: model.enabled && !this.disabledModelIds.has(model.modelId),
      configurationState,
      healthStatus,
      reliabilityScore:
        configurationState === 'CONFIGURED' ? model.reliabilityScore : 0,
    };
  }

  toLegacyDescriptors(): ModelDescriptor[] {
    return this.listModels().map((m) => {
      let availability: ProviderAvailability = 'not_configured';
      if (m.configurationState === 'CONFIGURED' && m.enabled) {
        if (m.healthStatus === 'AVAILABLE') availability = 'ready';
        else if (m.healthStatus === 'DEGRADED' || m.healthStatus === 'UNKNOWN')
          availability = 'degraded';
        else availability = 'degraded';
      }

      return {
        id: m.modelId,
        providerId: m.providerId,
        providerName: m.providerName,
        displayName: m.displayName,
        availability,
        isPaidExternal: m.costClass !== 'ZERO_COST',
        capabilities: m.capabilities,
        latencyProfile: mapLatencyClassToLegacyProfile(m.latencyClass),
        statusNote: m.statusNote,
      };
    });
  }
}
