import type { AIModelRouter } from '@/core/modules/ai-model-router';
import {
  RuntimeModelRouter as CoreMultiModelRouter,
  type IntelligentModelRouterContract,
  type RuntimeModelRouterOptions,
} from '@/core/models/model-router';
import type {
  ModelCapability,
  ModelRequest,
  ModelResponse,
  ModelRoutingCriteria,
  ModelRoutingResult,
  ModelTaskDomain,
  ProviderHealth,
  TaskType,
} from '@/core/types';

export type { IntelligentModelRouterContract, RuntimeModelRouterOptions };

export function mapTaskTypeToModelDomain(taskType: TaskType): ModelTaskDomain {
  switch (taskType) {
    case 'coding':
      return 'coding';
    case 'vision_task':
      return 'vision';
    case 'research':
      return 'research';
    case 'planning':
    case 'cybersecurity':
      return 'reasoning';
    default:
      return 'conversation';
  }
}

export function mapTaskTypeToRequiredCapabilities(
  taskType: TaskType
): ModelCapability[] {
  switch (taskType) {
    case 'coding':
      return ['conversation', 'coding'];
    case 'planning':
    case 'cybersecurity':
    case 'research':
      return ['conversation', 'reasoning'];
    case 'vision_task':
      return ['vision'];
    default:
      return ['conversation'];
  }
}

/**
 * RuntimeModelRouter unifying the v0.4 Multi-Model Intelligence System (`src/core/models`)
 * with `JarvisCoreRuntime` and backward-compatible plugin hooks on `AIModelRouter`.
 */
export class RuntimeModelRouter extends CoreMultiModelRouter {
  constructor(
    legacyModelRouter?: AIModelRouter,
    options?: RuntimeModelRouterOptions
  ) {
    super(options);

    if (legacyModelRouter) {
      for (const custom of legacyModelRouter.listCustomAdapters()) {
        this.registerLegacyAdapter(custom);
      }
      legacyModelRouter.onProviderRegistered((adapter) => {
        this.registerLegacyAdapter(adapter);
      });
    }
  }

  /**
   * Backward-compatible route evaluation helper delegating to `selectModel`.
   */
  async evaluateRoute(criteria: ModelRoutingCriteria): Promise<ModelRoutingResult> {
    return this.selectModel(criteria);
  }

  /**
   * Backward-compatible generation helper delegating to `executeWithRouting`.
   */
  async generate(
    criteria: ModelRoutingCriteria,
    request: ModelRequest
  ): Promise<{ routing: ModelRoutingResult; response: ModelResponse }> {
    const { routing, response } = await this.executeWithRouting(criteria, request);
    return { routing, response };
  }

  async listLegacyProviderHealth(): Promise<ProviderHealth[]> {
    return this.listProviderHealth().map((s) => ({
      providerId: s.providerId,
      providerName: s.providerName,
      status:
        s.configurationState === 'UNCONFIGURED'
          ? 'not_configured'
          : s.healthState === 'AVAILABLE'
            ? 'ready'
            : 'degraded',
      runtimeHealth: s.healthState,
      configurationState: s.configurationState,
      requiresPaidKey: s.providerId !== 'jarvis-foundation',
      checkedAt: s.lastCheckedAt,
      detail:
        s.lastErrorSummary ??
        `${s.configurationState} · Health: ${s.healthState} · Circuit: ${s.circuitState}`,
    }));
  }
}
