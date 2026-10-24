import type {
  AIProvider,
  CircuitBreakerState,
  ProviderConfigState,
  ProviderFailureKind,
  ProviderHealthSummary,
  ProviderRuntimeHealthState,
} from '@/core/types';
import { redactSecrets } from './provider-config';

export interface ProviderHealthTrackerOptions {
  /** Consecutive failures required to trip circuit breaker OPEN (default: 3) */
  failureThreshold?: number;
  /** Cooldown duration in ms before OPEN transitions to HALF_OPEN (default: 30_000) */
  cooldownMs?: number;
  /** Bounded timeout in ms for explicit health probes (default: 1_500) */
  healthCheckTimeoutMs?: number;
  /** Injectable clock for deterministic cooldown & recovery testing */
  nowFn?: () => number;
}

interface InternalProviderState {
  providerId: string;
  providerName: string;
  configurationState: ProviderConfigState;
  baseReliability: number;
  healthState: ProviderRuntimeHealthState;
  circuitState: CircuitBreakerState;
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
  cooldownUntilMs: number | null;
  lastErrorSummary: string | null;
  lastCheckedMs: number;
}

/**
 * Tracks live provider health (`AVAILABLE`, `DEGRADED`, `UNAVAILABLE`, `UNKNOWN`)
 * and manages per-provider circuit breakers (`CLOSED`, `OPEN`, `HALF_OPEN`) with
 * cooldown-based automatic recovery.
 */
export class ProviderHealthTracker {
  private readonly states = new Map<string, InternalProviderState>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly nowFn: () => number;

  constructor(options: ProviderHealthTrackerOptions = {}) {
    this.failureThreshold = Math.max(2, options.failureThreshold ?? 3);
    this.cooldownMs = Math.max(500, options.cooldownMs ?? 30_000);
    this.healthCheckTimeoutMs = Math.max(100, options.healthCheckTimeoutMs ?? 1_500);
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  registerProvider(params: {
    providerId: string;
    providerName: string;
    configurationState: ProviderConfigState;
    baseReliability?: number;
    initialHealthState?: ProviderRuntimeHealthState;
  }): void {
    const now = this.nowFn();
    const isConfigured = params.configurationState === 'CONFIGURED';
    const healthState: ProviderRuntimeHealthState = isConfigured
      ? params.initialHealthState ?? 'AVAILABLE'
      : 'UNAVAILABLE';

    this.states.set(params.providerId, {
      providerId: params.providerId,
      providerName: params.providerName,
      configurationState: params.configurationState,
      baseReliability: Math.min(1, Math.max(0.1, params.baseReliability ?? 0.95)),
      healthState,
      circuitState: 'CLOSED',
      consecutiveFailures: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      cooldownUntilMs: null,
      lastErrorSummary: isConfigured ? null : 'Provider credentials not configured on server.',
      lastCheckedMs: now,
    });
  }

  private evaluateCooldownTransition(state: InternalProviderState): void {
    if (
      state.circuitState === 'OPEN' &&
      state.cooldownUntilMs !== null &&
      this.nowFn() >= state.cooldownUntilMs
    ) {
      state.circuitState = 'HALF_OPEN';
      state.healthState = 'DEGRADED';
      state.cooldownUntilMs = null;
      state.lastCheckedMs = this.nowFn();
    }
  }

  canAttempt(providerId: string): boolean {
    const state = this.states.get(providerId);
    if (!state) return false;
    if (state.configurationState !== 'CONFIGURED') return false;

    this.evaluateCooldownTransition(state);

    if (state.circuitState === 'OPEN') {
      return false;
    }

    if (state.healthState === 'UNAVAILABLE') {
      return false;
    }

    return true;
  }

  recordSuccess(providerId: string): void {
    const state = this.states.get(providerId);
    if (!state) return;

    state.totalSuccesses += 1;
    state.consecutiveFailures = 0;
    state.circuitState = 'CLOSED';
    state.healthState = state.configurationState === 'CONFIGURED' ? 'AVAILABLE' : 'UNAVAILABLE';
    state.cooldownUntilMs = null;
    state.lastErrorSummary = null;
    state.lastCheckedMs = this.nowFn();
  }

  recordFailure(
    providerId: string,
    failureKind: ProviderFailureKind,
    errorSummary: string
  ): void {
    const state = this.states.get(providerId);
    if (!state) return;

    const now = this.nowFn();
    state.totalFailures += 1;
    state.consecutiveFailures += 1;
    state.lastErrorSummary = redactSecrets(errorSummary).slice(0, 240);
    state.lastCheckedMs = now;

    // Non-transient credential/configuration failures or repeated failures open circuit
    if (
      failureKind === 'AUTH_OR_CONFIG_ERROR' ||
      state.circuitState === 'HALF_OPEN' ||
      state.consecutiveFailures >= this.failureThreshold
    ) {
      state.circuitState = 'OPEN';
      state.healthState = 'UNAVAILABLE';
      state.cooldownUntilMs = now + this.cooldownMs;
      return;
    }

    // Single transient failure lowers routing priority (DEGRADED) without permanent disablement
    state.healthState = 'DEGRADED';
    state.circuitState = 'CLOSED';
  }

  setManualAvailability(
    providerId: string,
    healthState: ProviderRuntimeHealthState,
    detail?: string
  ): void {
    const state = this.states.get(providerId);
    if (!state) return;
    state.healthState = healthState;
    if (healthState === 'AVAILABLE') {
      state.circuitState = 'CLOSED';
      state.consecutiveFailures = 0;
      state.cooldownUntilMs = null;
      state.lastErrorSummary = null;
    } else if (healthState === 'UNAVAILABLE') {
      state.lastErrorSummary = detail ? redactSecrets(detail) : 'Marked unavailable.';
    }
    state.lastCheckedMs = this.nowFn();
  }

  getEffectiveReliability(providerId: string, modelBaselineReliability = 0.95): number {
    const state = this.states.get(providerId);
    if (!state || state.configurationState !== 'CONFIGURED') return 0;

    this.evaluateCooldownTransition(state);

    if (state.circuitState === 'OPEN' || state.healthState === 'UNAVAILABLE') {
      return 0;
    }

    const base = Math.min(state.baseReliability, modelBaselineReliability);
    if (state.circuitState === 'HALF_OPEN') {
      // Allow post-cooldown recovery probe at cautious priority without blocking compatibility
      return Math.max(0.75, Number((base - 0.15).toFixed(3)));
    }
    if (state.healthState === 'DEGRADED') {
      const penalty = Math.min(0.45, Math.max(0.15, state.consecutiveFailures * 0.15));
      return Math.max(0.1, Number((base - penalty).toFixed(3)));
    }
    if (state.healthState === 'UNKNOWN') {
      return Math.max(0.1, Number((base - 0.08).toFixed(3)));
    }
    return base;
  }

  getSummary(providerId: string): ProviderHealthSummary | undefined {
    const state = this.states.get(providerId);
    if (!state) return undefined;

    this.evaluateCooldownTransition(state);

    return {
      providerId: state.providerId,
      providerName: state.providerName,
      configurationState: state.configurationState,
      healthState: state.healthState,
      circuitState: state.circuitState,
      consecutiveFailures: state.consecutiveFailures,
      totalSuccesses: state.totalSuccesses,
      totalFailures: state.totalFailures,
      effectiveReliability: this.getEffectiveReliability(providerId, state.baseReliability),
      cooldownUntilIso:
        state.cooldownUntilMs !== null ? new Date(state.cooldownUntilMs).toISOString() : null,
      lastErrorSummary: state.lastErrorSummary,
      lastCheckedAt: new Date(state.lastCheckedMs).toISOString(),
    };
  }

  listSummaries(): ProviderHealthSummary[] {
    return Array.from(this.states.keys())
      .map((id) => this.getSummary(id))
      .filter((s): s is ProviderHealthSummary => Boolean(s));
  }

  /**
   * Executes a bounded, non-blocking health check against a provider adapter and
   * updates health/recovery state accordingly.
   */
  async runBoundedHealthProbe(provider: AIProvider): Promise<ProviderHealthSummary | undefined> {
    const state = this.states.get(provider.providerId);
    if (!state) return undefined;

    if (!provider.isAvailable() && state.configurationState === 'UNCONFIGURED') {
      state.healthState = 'UNAVAILABLE';
      state.lastCheckedMs = this.nowFn();
      return this.getSummary(provider.providerId);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const health = await Promise.race([
        Promise.resolve(provider.getHealth()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Provider health probe timed out')),
            this.healthCheckTimeoutMs
          );
        }),
      ]);

      if (health.status === 'ready') {
        this.recordSuccess(provider.providerId);
      } else if (health.status === 'degraded') {
        state.healthState = 'DEGRADED';
        state.lastErrorSummary = redactSecrets(health.detail);
        state.lastCheckedMs = this.nowFn();
      } else {
        state.healthState = 'UNAVAILABLE';
        state.lastErrorSummary = redactSecrets(health.detail);
        state.lastCheckedMs = this.nowFn();
      }
    } catch (err) {
      this.recordFailure(
        provider.providerId,
        'TIMEOUT',
        err instanceof Error ? err.message : 'Health probe failed'
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    return this.getSummary(provider.providerId);
  }
}
