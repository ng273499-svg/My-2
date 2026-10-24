import type { z } from 'zod';
import { RuntimeExecutionError } from '@/core/runtime/errors';
import type {
  AIProvider,
  CostClass,
  FallbackAttemptRecord,
  LatencyClass,
  ModelCapability,
  ModelDescriptor,
  ModelExecutionTelemetry,
  ModelModality,
  ModelProviderAdapter,
  ModelRequest,
  ModelResponse,
  ModelRoutingCriteria,
  ModelRoutingResult,
  ModelStreamChunk,
  ProviderHealthSummary,
  RegisteredModelMetadata,
  RoutingPolicyMode,
} from '@/core/types';
import { normalizeProviderError, ProviderAdapterError } from './errors';
import {
  ProviderHealthTracker,
  type ProviderHealthTrackerOptions,
} from './health-circuit-breaker';
import { ModelRegistry } from './model-registry';
import { PromptInjectionBoundary } from './prompt-boundary';
import { StructuredOutputValidator } from './structured-output';
import { FoundationLocalProviderAdapter } from './adapters/foundation-local-adapter';
import { OpenAIProviderAdapter } from './adapters/openai-adapter';
import { AnthropicProviderAdapter } from './adapters/anthropic-adapter';
import { GeminiProviderAdapter } from './adapters/gemini-adapter';
import { OpenAICompatibleProviderAdapter } from './adapters/openai-compatible-adapter';

export interface IntelligentModelRouterContract {
  selectModel(criteria: ModelRoutingCriteria): Promise<ModelRoutingResult> | ModelRoutingResult;
  executeWithRouting<TStructured = unknown>(
    criteria: ModelRoutingCriteria,
    request: ModelRequest,
    structuredSchema?: z.ZodType<TStructured>
  ): Promise<{
    routing: ModelRoutingResult;
    response: ModelResponse;
    structuredOutput?: TStructured;
  }>;
  streamWithRouting(
    criteria: ModelRoutingCriteria,
    request: ModelRequest
  ): AsyncGenerator<
    ModelStreamChunk,
    { routing: ModelRoutingResult; response: ModelResponse },
    void
  >;
}

export interface RuntimeModelRouterOptions {
  registerDefaultProviders?: boolean;
  defaultMaxFallbacks?: number;
  healthOptions?: ProviderHealthTrackerOptions;
}

const COST_RANK: Record<CostClass, number> = {
  ZERO_COST: 0,
  LOW: 1,
  MEDIUM: 2,
  UNKNOWN: 3,
  HIGH: 4,
};

const COST_EFFICIENCY_SCORE: Record<CostClass, number> = {
  ZERO_COST: 100,
  LOW: 84,
  MEDIUM: 55,
  UNKNOWN: 42,
  HIGH: 18,
};

const LATENCY_SCORE: Record<LatencyClass, number> = {
  ULTRA_LOW: 100,
  FAST: 84,
  BALANCED: 58,
  UNKNOWN: 45,
  DEEP: 26,
};

interface ScoredCandidate {
  model: RegisteredModelMetadata;
  score: number;
  rationale: string;
}

function normalizeRequiredCapabilities(caps: ModelCapability[]): ModelCapability[] {
  return caps.map((c) => (c === 'chat' ? 'conversation' : c));
}

/**
 * Provider-Agnostic Intelligent Multi-Model Router (`RuntimeModelRouter`).
 * Evaluates capability, modality, context window, tool/structured-output support,
 * live provider health, circuit-breaker state, cost, quality, and latency across
 * 5 routing policies (`AUTO_BALANCED`, `QUALITY_FIRST`, `SPEED_FIRST`, `COST_AWARE`, `MANUAL`)
 * with bounded fallback chains and non-secret telemetry.
 */
export class RuntimeModelRouter implements IntelligentModelRouterContract {
  public readonly healthTracker: ProviderHealthTracker;
  public readonly registry: ModelRegistry;
  public readonly structuredValidator = new StructuredOutputValidator();
  public readonly promptBoundary = new PromptInjectionBoundary();

  private readonly defaultMaxFallbacks: number;
  private readonly telemetryRingBuffer: ModelExecutionTelemetry[] = [];
  private lastActiveSelection: { providerId: string; modelId: string; fallbackUsed: boolean } = {
    providerId: 'jarvis-foundation',
    modelId: 'foundation-local-v1',
    fallbackUsed: false,
  };

  constructor(options: RuntimeModelRouterOptions = {}) {
    this.healthTracker = new ProviderHealthTracker(options.healthOptions);
    this.registry = new ModelRegistry(this.healthTracker);
    this.defaultMaxFallbacks = Math.min(4, Math.max(0, options.defaultMaxFallbacks ?? 2));

    if (options.registerDefaultProviders !== false) {
      this.registerAIProvider(new FoundationLocalProviderAdapter());
      this.registerAIProvider(new OpenAIProviderAdapter());
      this.registerAIProvider(new AnthropicProviderAdapter());
      this.registerAIProvider(new GeminiProviderAdapter());
      this.registerAIProvider(new OpenAICompatibleProviderAdapter());
    }
  }

  registerAIProvider(provider: AIProvider): void {
    this.registry.registerProvider(provider);
  }

  registerLegacyAdapter(adapter: ModelProviderAdapter): void {
    this.registry.registerLegacyAdapter(adapter);
  }

  listRegisteredModels(): RegisteredModelMetadata[] {
    return this.registry.listModels();
  }

  listLegacyModelDescriptors(): ModelDescriptor[] {
    return this.registry.toLegacyDescriptors();
  }

  listProviderHealth(): ProviderHealthSummary[] {
    // Ensure registry refreshes lazy env configuration before summarizing health
    this.registry.listModels();
    return this.healthTracker.listSummaries();
  }

  getTelemetryHistory(limit = 25): ModelExecutionTelemetry[] {
    return this.telemetryRingBuffer.slice(-limit).reverse();
  }

  getLastActiveSelection(): {
    providerId: string;
    modelId: string;
    fallbackUsed: boolean;
  } {
    return { ...this.lastActiveSelection };
  }

  private recordTelemetry(entry: ModelExecutionTelemetry): void {
    this.telemetryRingBuffer.push(entry);
    if (this.telemetryRingBuffer.length > 100) {
      this.telemetryRingBuffer.shift();
    }
  }

  /**
   * Checks whether a single `RegisteredModelMetadata` satisfies all hard capability,
   * modality, context, tool-calling, structured-output, cost, and health constraints.
   */
  private evaluateCompatibility(
    model: RegisteredModelMetadata,
    criteria: ModelRoutingCriteria
  ): { compatible: boolean; reason?: string } {
    if (model.configurationState !== 'CONFIGURED') {
      return { compatible: false, reason: 'provider UNCONFIGURED' };
    }

    if (!model.enabled) {
      return { compatible: false, reason: 'model disabled' };
    }

    if (
      model.isDeterministicFallback &&
      criteria.allowDeterministicFallback === false
    ) {
      return { compatible: false, reason: 'deterministic fallback disallowed by criteria' };
    }

    if (!this.healthTracker.canAttempt(model.providerId)) {
      return {
        compatible: false,
        reason: `provider ${model.providerId} unavailable or circuit OPEN`,
      };
    }

    const requiredModality: ModelModality =
      criteria.requiredModality ??
      (criteria.taskDomain === 'vision' ? 'image' : 'text');

    if (!model.supportedModalities.includes(requiredModality)) {
      return {
        compatible: false,
        reason: `missing required modality "${requiredModality}"`,
      };
    }

    const reqCaps = normalizeRequiredCapabilities(criteria.requiredCapabilities);
    for (const cap of reqCaps) {
      const hasCap =
        cap === 'conversation'
          ? model.capabilities.includes('conversation') ||
            model.capabilities.includes('chat')
          : model.capabilities.includes(cap);
      if (!hasCap) {
        return { compatible: false, reason: `missing capability "${cap}"` };
      }
    }

    if (criteria.requireToolUse && !model.supportsToolUse) {
      return { compatible: false, reason: 'does not support governed tool_calling' };
    }

    if (criteria.requireStructuredOutput && !model.supportsStructuredOutput) {
      return { compatible: false, reason: 'does not support structured_output' };
    }

    // Context capacity check: UNKNOWN context windows are conservatively capped at 8,192 tokens
    const effectiveContextCap =
      model.contextWindowTokens === 'UNKNOWN' ? 8_192 : model.contextWindowTokens;
    if (criteria.estimatedContextTokens > effectiveContextCap) {
      return {
        compatible: false,
        reason: `estimated context (${criteria.estimatedContextTokens}) exceeds capacity (${model.contextWindowTokens})`,
      };
    }

    if (criteria.costConstraint === 'free_only' && model.costClass !== 'ZERO_COST') {
      return { compatible: false, reason: 'exceeds free_only cost constraint' };
    }

    if (
      criteria.maxAllowedCostClass &&
      COST_RANK[model.costClass] > COST_RANK[criteria.maxAllowedCostClass]
    ) {
      return {
        compatible: false,
        reason: `cost class ${model.costClass} exceeds max ${criteria.maxAllowedCostClass}`,
      };
    }

    const effectiveRel = this.healthTracker.getEffectiveReliability(
      model.providerId,
      model.reliabilityScore
    );
    if (effectiveRel < criteria.minimumReliability) {
      return {
        compatible: false,
        reason: `effective reliability (${effectiveRel}) below minimum (${criteria.minimumReliability})`,
      };
    }

    return { compatible: true };
  }

  private scoreCandidate(
    model: RegisteredModelMetadata,
    criteria: ModelRoutingCriteria,
    policy: RoutingPolicyMode
  ): ScoredCandidate {
    const qualityNum = model.qualityTier === 'UNKNOWN' ? 65 : model.qualityTier;
    const latencyNum = LATENCY_SCORE[model.latencyClass];
    const costNum = COST_EFFICIENCY_SCORE[model.costClass];
    const effectiveRel = this.healthTracker.getEffectiveReliability(
      model.providerId,
      model.reliabilityScore
    );
    const healthPenalty = model.healthStatus === 'DEGRADED' ? 25 : 0;

    // Task-capability affinity bonus based on metadata capabilities
    let affinityBonus = 0;
    if (criteria.taskDomain === 'coding' && model.capabilities.includes('coding')) {
      affinityBonus += qualityNum >= 90 ? 14 : 6;
    }
    if (criteria.taskDomain === 'reasoning' && model.capabilities.includes('reasoning')) {
      affinityBonus +=
        (qualityNum >= 90 ? 15 : 6) + (model.latencyClass === 'DEEP' ? 8 : 0);
    }
    if (criteria.taskDomain === 'vision' && model.capabilities.includes('vision')) {
      affinityBonus += 15;
    }

    // Honor explicit preferredProviderId when configured & not 'auto'
    const providerPrefBoost =
      criteria.preferredProviderId &&
      criteria.preferredProviderId !== 'auto' &&
      model.providerId === criteria.preferredProviderId
        ? 45
        : 0;

    let score = 0;
    let rationale = '';

    switch (policy) {
      case 'QUALITY_FIRST': {
        const deterministicPenalty = model.isDeterministicFallback ? 40 : 0;
        score =
          qualityNum * 1.1 +
          affinityBonus +
          effectiveRel * 25 +
          providerPrefBoost -
          healthPenalty -
          deterministicPenalty;
        rationale = `QUALITY_FIRST selected ${model.displayName} (qualityTier=${model.qualityTier}, reliability=${effectiveRel}).`;
        break;
      }

      case 'SPEED_FIRST': {
        const deterministicPenalty = model.isDeterministicFallback ? 22 : 0;
        score =
          latencyNum * 1.15 +
          qualityNum * 0.2 +
          effectiveRel * 20 +
          providerPrefBoost -
          healthPenalty -
          deterministicPenalty;
        rationale = `SPEED_FIRST selected ${model.displayName} (latencyClass=${model.latencyClass}, reliability=${effectiveRel}).`;
        break;
      }

      case 'COST_AWARE': {
        // Prioritize lowest cost compatible model while retaining reliability & capability fit
        const deterministicPenalty = model.isDeterministicFallback ? 8 : 0;
        score =
          costNum * 1.25 +
          qualityNum * 0.25 +
          effectiveRel * 20 +
          providerPrefBoost -
          healthPenalty -
          deterministicPenalty;
        rationale = `COST_AWARE selected ${model.displayName} (costClass=${model.costClass}, qualityTier=${model.qualityTier}).`;
        break;
      }

      case 'MANUAL': {
        if (criteria.manualModelId && model.modelId === criteria.manualModelId) {
          score = 10_000;
          rationale = `MANUAL policy selected operator-specified model ${model.displayName} (${model.modelId}).`;
        } else {
          const deterministicPenalty = model.isDeterministicFallback ? 30 : 0;
          score =
            qualityNum * 0.45 +
            latencyNum * 0.2 +
            costNum * 0.15 +
            effectiveRel * 25 -
            healthPenalty -
            deterministicPenalty;
          rationale = `Fallback candidate ${model.displayName} under MANUAL policy.`;
        }
        break;
      }

      case 'AUTO_BALANCED':
      default: {
        const deterministicPenalty = model.isDeterministicFallback ? 32 : 0;
        const latencyTargetBonus =
          (criteria.latencyPreference === 'ultra-low' &&
            (model.latencyClass === 'ULTRA_LOW' || model.latencyClass === 'FAST')) ||
          (criteria.latencyPreference === 'deep-reasoning' &&
            (model.latencyClass === 'DEEP' || qualityNum >= 92))
            ? 10
            : 0;

        score =
          qualityNum * 0.48 +
          latencyNum * 0.2 +
          costNum * 0.14 +
          effectiveRel * 25 +
          affinityBonus +
          latencyTargetBonus +
          providerPrefBoost -
          healthPenalty -
          deterministicPenalty;
        rationale = `AUTO_BALANCED selected ${model.displayName} for ${criteria.taskDomain} (quality=${model.qualityTier}, latency=${model.latencyClass}, cost=${model.costClass}, health=${model.healthStatus}).`;
        break;
      }
    }

    return { model, score, rationale };
  }

  /**
   * Builds the ranked list of compatible candidate models for a request.
   */
  rankCompatibleCandidates(criteria: ModelRoutingCriteria): {
    policy: RoutingPolicyMode;
    candidates: ScoredCandidate[];
    manualRejectionReason?: string;
    rejectionDiagnostics: string[];
  } {
    const policy: RoutingPolicyMode = criteria.routingPolicy ?? 'AUTO_BALANCED';
    const allModels = this.registry.listModels();
    const compatible: ScoredCandidate[] = [];
    const rejectionDiagnostics: string[] = [];
    let manualRejectionReason: string | undefined;

    for (const model of allModels) {
      const check = this.evaluateCompatibility(model, criteria);
      if (!check.compatible) {
        rejectionDiagnostics.push(`${model.modelId}: ${check.reason}`);
        if (policy === 'MANUAL' && criteria.manualModelId === model.modelId) {
          manualRejectionReason = `Manual model "${model.modelId}" incompatible/unavailable (${check.reason})`;
        }
        continue;
      }
      compatible.push(this.scoreCandidate(model, criteria, policy));
    }

    if (
      policy === 'MANUAL' &&
      criteria.manualModelId &&
      !allModels.some((m) => m.modelId === criteria.manualModelId)
    ) {
      manualRejectionReason = `Manual model "${criteria.manualModelId}" is not registered in ModelRegistry`;
    }

    compatible.sort((a, b) => b.score - a.score);

    return {
      policy,
      candidates: compatible,
      manualRejectionReason,
      rejectionDiagnostics,
    };
  }

  selectModel(criteria: ModelRoutingCriteria): ModelRoutingResult {
    const { policy, candidates, manualRejectionReason, rejectionDiagnostics } =
      this.rankCompatibleCandidates(criteria);

    if (candidates.length === 0) {
      throw new RuntimeExecutionError({
        code: 'NO_COMPATIBLE_MODEL',
        message: `No compatible configured model satisfies requirements (domain=${criteria.taskDomain}, capabilities=[${criteria.requiredCapabilities.join(', ')}]). Diagnostics: ${rejectionDiagnostics.slice(0, 4).join('; ')}`,
        retryable: false,
        failedState: 'SELECTING_CAPABILITY',
      });
    }

    const winner = candidates[0];
    const fallbackReasons: string[] = [];
    let fallbackUsed = Boolean(winner.model.isDeterministicFallback && candidates.length > 1);

    if (manualRejectionReason) {
      // If maxFallbackAttempts === 0 on MANUAL policy, fail strictly instead of falling back
      if (criteria.maxFallbackAttempts === 0) {
        throw new RuntimeExecutionError({
          code: 'NO_COMPATIBLE_MODEL',
          message: `${manualRejectionReason} and fallback attempts set to 0.`,
          retryable: false,
          failedState: 'SELECTING_CAPABILITY',
        });
      }
      fallbackUsed = true;
      fallbackReasons.push(
        `${manualRejectionReason}; routed to compatible fallback ${winner.model.modelId}.`
      );
    } else if (
      criteria.preferredProviderId &&
      criteria.preferredProviderId !== 'auto' &&
      winner.model.providerId !== criteria.preferredProviderId
    ) {
      fallbackUsed = true;
      fallbackReasons.push(
        `Preferred provider "${criteria.preferredProviderId}" unavailable or incompatible; selected ${winner.model.providerId}/${winner.model.modelId}.`
      );
    }

    const nonDeterministicReadyCount = this.registry
      .listModels()
      .filter(
        (m) =>
          m.configurationState === 'CONFIGURED' &&
          m.enabled &&
          !m.isDeterministicFallback
      ).length;

    return {
      selectedProviderId: winner.model.providerId,
      selectedModelId: winner.model.modelId,
      selectedDisplayName: winner.model.displayName,
      routingPolicy: policy,
      automaticMultiModelRoutingActive: nonDeterministicReadyCount > 0,
      fallbackUsed,
      fallbackCount: fallbackReasons.length,
      fallbackReasons,
      rationale: fallbackReasons.length > 0 ? fallbackReasons[0] : winner.rationale,
    };
  }

  /**
   * Orders fallback candidates so provider-wide failures (rate limit, timeout, 5xx)
   * diversify across distinct healthy providers first before trying sibling models
   * on the same degraded provider.
   */
  private orderBoundedExecutionChain(
    candidates: ScoredCandidate[],
    maxFallbacks: number
  ): ScoredCandidate[] {
    if (candidates.length <= 1) return candidates.slice(0, 1 + maxFallbacks);

    const primary = candidates[0];
    const seenProviders = new Set<string>([primary.model.providerId]);
    const firstPerProvider: ScoredCandidate[] = [];
    const remainingModels: ScoredCandidate[] = [];

    for (let i = 1; i < candidates.length; i += 1) {
      const cand = candidates[i];
      if (!seenProviders.has(cand.model.providerId)) {
        seenProviders.add(cand.model.providerId);
        firstPerProvider.push(cand);
      } else {
        remainingModels.push(cand);
      }
    }

    return [primary, ...firstPerProvider, ...remainingModels].slice(
      0,
      1 + maxFallbacks
    );
  }

  async executeWithRouting<TStructured = unknown>(
    criteria: ModelRoutingCriteria,
    request: ModelRequest,
    structuredSchema?: z.ZodType<TStructured>
  ): Promise<{
    routing: ModelRoutingResult;
    response: ModelResponse;
    structuredOutput?: TStructured;
  }> {
    const overallStart = Date.now();
    const effectiveCriteria: ModelRoutingCriteria = {
      ...criteria,
      requireStructuredOutput:
        Boolean(criteria.requireStructuredOutput) || Boolean(structuredSchema),
      requireToolUse: Boolean(criteria.requireToolUse),
    };

    const { policy, candidates, manualRejectionReason, rejectionDiagnostics } =
      this.rankCompatibleCandidates(effectiveCriteria);

    if (candidates.length === 0) {
      throw new RuntimeExecutionError({
        code: 'NO_COMPATIBLE_MODEL',
        message: `No compatible configured model satisfies requirements (domain=${effectiveCriteria.taskDomain}, capabilities=[${effectiveCriteria.requiredCapabilities.join(', ')}]). Diagnostics: ${rejectionDiagnostics.slice(0, 4).join('; ')}`,
        retryable: false,
        failedState: 'EXECUTING',
      });
    }

    if (manualRejectionReason && effectiveCriteria.maxFallbackAttempts === 0) {
      throw new RuntimeExecutionError({
        code: 'NO_COMPATIBLE_MODEL',
        message: `${manualRejectionReason} and fallback attempts set to 0.`,
        retryable: false,
        failedState: 'EXECUTING',
      });
    }

    const maxFallbacks = Math.min(
      4,
      Math.max(0, effectiveCriteria.maxFallbackAttempts ?? this.defaultMaxFallbacks)
    );
    const chain = this.orderBoundedExecutionChain(candidates, maxFallbacks);

    const attempts: FallbackAttemptRecord[] = [];
    const fallbackReasons: string[] = [];
    if (manualRejectionReason) {
      fallbackReasons.push(manualRejectionReason);
    }

    let lastProviderError: ProviderAdapterError | undefined;

    for (let idx = 0; idx < chain.length; idx += 1) {
      const candidate = chain[idx];
      const { model } = candidate;

      // Re-verify circuit breaker before each hop in case an earlier sibling model tripped it
      if (!this.healthTracker.canAttempt(model.providerId)) {
        fallbackReasons.push(
          `Skipped ${model.providerId}/${model.modelId} because circuit breaker opened.`
        );
        continue;
      }

      const provider = this.registry.getProvider(model.providerId);
      if (!provider) {
        continue;
      }

      const hopStart = Date.now();
      try {
        const response = await provider.generate({
          ...request,
          modelId: model.modelId,
          expectStructuredJson:
            request.expectStructuredJson || Boolean(structuredSchema),
        });

        let structuredOutput: TStructured | undefined;
        if (structuredSchema) {
          const schemaName = request.structuredOutputSchemaName ?? 'StructuredOutput';
          structuredOutput =
            response.structuredData !== undefined
              ? this.structuredValidator.validateData(
                  response.structuredData,
                  structuredSchema,
                  {
                    providerId: model.providerId,
                    modelId: model.modelId,
                    schemaName,
                  }
                )
              : this.structuredValidator.validateJsonText(
                  response.content,
                  structuredSchema,
                  {
                    providerId: model.providerId,
                    modelId: model.modelId,
                    schemaName,
                  }
                );
        }

        this.healthTracker.recordSuccess(model.providerId);

        const fallbackCount = attempts.length + (manualRejectionReason ? 1 : 0);
        const fallbackUsed = fallbackCount > 0;
        const nonDeterministicReadyCount = this.registry
          .listModels()
          .filter(
            (m) =>
              m.configurationState === 'CONFIGURED' &&
              m.enabled &&
              !m.isDeterministicFallback
          ).length;

        const telemetry: ModelExecutionTelemetry = {
          taskId: request.taskId,
          providerId: response.providerId,
          modelId: response.modelId,
          routingPolicy: policy,
          selectionReason:
            fallbackReasons.length > 0
              ? `${candidate.rationale} [Fallback after: ${fallbackReasons.join(' | ')}]`
              : candidate.rationale,
          requiredCapabilities: effectiveCriteria.requiredCapabilities,
          latencyMs: Math.max(1, Date.now() - overallStart),
          succeeded: true,
          fallbackCount,
          fallbackReasons: [...fallbackReasons],
          attempts: [...attempts],
        };

        this.recordTelemetry(telemetry);
        this.lastActiveSelection = {
          providerId: response.providerId,
          modelId: response.modelId,
          fallbackUsed,
        };

        const routing: ModelRoutingResult = {
          selectedProviderId: response.providerId,
          selectedModelId: response.modelId,
          selectedDisplayName: model.displayName,
          routingPolicy: policy,
          automaticMultiModelRoutingActive: nonDeterministicReadyCount > 0,
          fallbackUsed,
          fallbackCount,
          fallbackReasons: [...fallbackReasons],
          attempts: [...attempts],
          rationale: telemetry.selectionReason,
          telemetry,
        };

        return { routing, response, structuredOutput };
      } catch (err) {
        const normalized = normalizeProviderError(err, model.providerId, model.modelId);
        lastProviderError = normalized;
        const durationMs = Math.max(1, Date.now() - hopStart);

        this.healthTracker.recordFailure(
          model.providerId,
          normalized.failureKind,
          normalized.message
        );

        const reasonSummary = `${model.providerId}/${model.modelId} failed (${normalized.failureKind}): ${normalized.message}`;
        attempts.push({
          providerId: model.providerId,
          modelId: model.modelId,
          failureKind: normalized.failureKind,
          reason: normalized.message,
          durationMs,
        });
        fallbackReasons.push(reasonSummary);
      }
    }

    const terminalTelemetry: ModelExecutionTelemetry = {
      taskId: request.taskId,
      providerId: chain[chain.length - 1]?.model.providerId ?? 'none',
      modelId: chain[chain.length - 1]?.model.modelId ?? 'none',
      routingPolicy: policy,
      selectionReason: `All bounded model candidates exhausted (${attempts.length} attempts, maxFallbackAttempts=${maxFallbacks}).`,
      requiredCapabilities: effectiveCriteria.requiredCapabilities,
      latencyMs: Math.max(1, Date.now() - overallStart),
      succeeded: false,
      fallbackCount: attempts.length,
      fallbackReasons: [...fallbackReasons],
      attempts: [...attempts],
    };
    this.recordTelemetry(terminalTelemetry);

    const terminalCode =
      lastProviderError?.failureKind === 'MALFORMED_STRUCTURED_OUTPUT'
        ? 'MALFORMED_STRUCTURED_OUTPUT'
        : 'PROVIDER_UNAVAILABLE';

    throw new RuntimeExecutionError({
      code: terminalCode,
      message: `Bounded model fallback limit (${maxFallbacks}) reached without success. Reasons: ${fallbackReasons.join(' | ')}`,
      retryable: false,
      failedState: 'EXECUTING',
      attemptsMade: attempts.length,
    });
  }

  async *streamWithRouting(
    criteria: ModelRoutingCriteria,
    request: ModelRequest
  ): AsyncGenerator<
    ModelStreamChunk,
    { routing: ModelRoutingResult; response: ModelResponse },
    void
  > {
    const effectiveCriteria: ModelRoutingCriteria = {
      ...criteria,
      requiredCapabilities: Array.from(
        new Set<ModelCapability>([...criteria.requiredCapabilities, 'streaming'])
      ),
    };

    const { policy, candidates, manualRejectionReason, rejectionDiagnostics } =
      this.rankCompatibleCandidates(effectiveCriteria);

    if (candidates.length === 0) {
      throw new RuntimeExecutionError({
        code: 'NO_COMPATIBLE_MODEL',
        message: `No streaming-compatible model available (${rejectionDiagnostics.slice(0, 3).join('; ')}).`,
        retryable: false,
        failedState: 'EXECUTING',
      });
    }

    const maxFallbacks = Math.min(
      4,
      Math.max(0, effectiveCriteria.maxFallbackAttempts ?? this.defaultMaxFallbacks)
    );
    const chain = this.orderBoundedExecutionChain(candidates, maxFallbacks);
    const attempts: FallbackAttemptRecord[] = [];
    const fallbackReasons: string[] = manualRejectionReason ? [manualRejectionReason] : [];

    for (const candidate of chain) {
      const { model } = candidate;
      if (!this.healthTracker.canAttempt(model.providerId)) continue;
      const provider = this.registry.getProvider(model.providerId);
      if (!provider) continue;

      const hopStart = Date.now();
      try {
        let response: ModelResponse;
        if (provider.streamGenerate) {
          const gen = provider.streamGenerate({
            ...request,
            modelId: model.modelId,
          });
          while (true) {
            const next = await gen.next();
            if (next.done) {
              response = next.value;
              break;
            }
            yield next.value;
          }
        } else {
          response = await provider.generate({
            ...request,
            modelId: model.modelId,
          });
          yield {
            type: 'delta',
            textDelta: response.content,
            modelId: response.modelId,
            providerId: response.providerId,
          };
          yield {
            type: 'done',
            latencyMs: response.latencyMs,
            tokensUsedEstimate: response.tokensUsedEstimate,
            modelId: response.modelId,
            providerId: response.providerId,
          };
        }

        this.healthTracker.recordSuccess(model.providerId);
        const fallbackCount = attempts.length + (manualRejectionReason ? 1 : 0);
        const routing: ModelRoutingResult = {
          selectedProviderId: response.providerId,
          selectedModelId: response.modelId,
          selectedDisplayName: model.displayName,
          routingPolicy: policy,
          automaticMultiModelRoutingActive: !model.isDeterministicFallback,
          fallbackUsed: fallbackCount > 0,
          fallbackCount,
          fallbackReasons,
          attempts,
          rationale: candidate.rationale,
        };
        return { routing, response };
      } catch (err) {
        const normalized = normalizeProviderError(err, model.providerId, model.modelId);
        this.healthTracker.recordFailure(
          model.providerId,
          normalized.failureKind,
          normalized.message
        );
        attempts.push({
          providerId: model.providerId,
          modelId: model.modelId,
          failureKind: normalized.failureKind,
          reason: normalized.message,
          durationMs: Math.max(1, Date.now() - hopStart),
        });
        fallbackReasons.push(
          `${model.providerId}/${model.modelId} stream failed (${normalized.failureKind})`
        );
      }
    }

    throw new RuntimeExecutionError({
      code: 'PROVIDER_UNAVAILABLE',
      message: `All bounded streaming candidates failed: ${fallbackReasons.join(' | ')}`,
      retryable: false,
      failedState: 'EXECUTING',
      attemptsMade: attempts.length,
    });
  }
}
