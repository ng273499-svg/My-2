import type {
  AIProvider,
  ModelCapability,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
  ModelTaskDomain,
  ProviderHealth,
  RegisteredModelMetadata,
} from '@/core/types';
import {
  mapHttpStatusToFailureKind,
  normalizeProviderError,
  ProviderAdapterError,
} from '../errors';
import { redactSecrets } from '../provider-config';

export type ProviderFetchFn = typeof fetch;

export interface BaseAdapterConfig {
  defaultTimeoutMs?: number;
  fetchFn?: ProviderFetchFn;
}

/**
 * Abstract base class isolating common HTTP timeout handling, error normalization,
 * secret redaction, and fallback streaming emulation for providers without native SSE.
 */
export abstract class BaseAIProviderAdapter implements AIProvider {
  abstract readonly providerId: string;
  abstract readonly providerName: string;
  abstract readonly supportedDomains: ModelTaskDomain[];
  abstract readonly capabilities: ModelCapability[];

  protected readonly defaultTimeoutMs: number;
  protected readonly fetchFn: ProviderFetchFn;

  constructor(config: BaseAdapterConfig = {}) {
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 12_000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  abstract isConfigured(): boolean;
  abstract listRegisteredModels(): RegisteredModelMetadata[];
  abstract getHealth(): Promise<ProviderHealth> | ProviderHealth;
  protected abstract performGenerate(
    request: ModelRequest,
    resolvedModelId: string,
    signal: AbortSignal
  ): Promise<ModelResponse>;

  isAvailable(): boolean {
    return this.isConfigured();
  }

  protected resolveModelId(requestedModelId?: string): string {
    const models = this.listRegisteredModels();
    if (requestedModelId) {
      const found = models.find((m) => m.modelId === requestedModelId);
      if (!found) {
        throw new ProviderAdapterError({
          providerId: this.providerId,
          modelId: requestedModelId,
          failureKind: 'MODEL_UNAVAILABLE',
          message: `Model "${requestedModelId}" is not registered on provider "${this.providerId}".`,
          retryable: true,
        });
      }
      if (!found.enabled) {
        throw new ProviderAdapterError({
          providerId: this.providerId,
          modelId: requestedModelId,
          failureKind: 'MODEL_UNAVAILABLE',
          message: `Model "${requestedModelId}" is disabled in ModelRegistry.`,
          retryable: true,
        });
      }
      return found.modelId;
    }

    const firstEnabled = models.find((m) => m.enabled);
    if (!firstEnabled) {
      throw new ProviderAdapterError({
        providerId: this.providerId,
        modelId: 'unknown',
        failureKind: 'MODEL_UNAVAILABLE',
        message: `No enabled models registered on provider "${this.providerId}".`,
        retryable: true,
      });
    }
    return firstEnabled.modelId;
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    modelId: string,
    timeoutMs?: number,
    externalSignal?: AbortSignal
  ): Promise<Response> {
    if (externalSignal?.aborted) {
      throw new ProviderAdapterError({
        providerId: this.providerId,
        modelId,
        failureKind: 'TIMEOUT',
        message: `Request aborted before contacting ${this.providerId}.`,
        retryable: false,
      });
    }

    const controller = new AbortController();
    const effectiveTimeout = Math.max(50, timeoutMs ?? this.defaultTimeoutMs);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const res = await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
      });

      if (!res.ok) {
        let errorDetail = `HTTP ${res.status}`;
        try {
          const text = await res.text();
          if (text) {
            errorDetail = `HTTP ${res.status}: ${redactSecrets(text).slice(0, 220)}`;
          }
        } catch {
          // ignore body read errors
        }

        const failureKind = mapHttpStatusToFailureKind(res.status);
        throw new ProviderAdapterError({
          providerId: this.providerId,
          modelId,
          failureKind,
          httpStatus: res.status,
          message: `${this.providerId}/${modelId} returned ${errorDetail}`,
          retryable: failureKind !== 'AUTH_OR_CONFIG_ERROR',
        });
      }

      return res;
    } catch (err) {
      throw normalizeProviderError(err, this.providerId, modelId);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const modelId = this.resolveModelId(request.modelId);
    if (!this.isConfigured()) {
      throw new ProviderAdapterError({
        providerId: this.providerId,
        modelId,
        failureKind: 'AUTH_OR_CONFIG_ERROR',
        message: `Provider "${this.providerName}" is UNCONFIGURED on server.`,
        retryable: false,
      });
    }

    const controller = new AbortController();
    const effectiveTimeout = Math.max(50, request.timeoutMs ?? this.defaultTimeoutMs);
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      return await this.performGenerate(request, modelId, controller.signal);
    } catch (err) {
      throw normalizeProviderError(err, this.providerId, modelId);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async *streamGenerate(
    request: ModelRequest
  ): AsyncGenerator<ModelStreamChunk, ModelResponse, void> {
    const response = await this.generate(request);

    if (response.toolCallProposals && response.toolCallProposals.length > 0) {
      for (const proposal of response.toolCallProposals) {
        yield {
          type: 'tool_call_proposal',
          proposal,
          modelId: response.modelId,
          providerId: response.providerId,
        };
      }
    }

    // Emit clean provider-neutral word/sentence chunks
    const segments = response.content.match(/.{1,64}(\s|$)/g) ?? [response.content];
    for (const seg of segments) {
      if (seg.length > 0) {
        yield {
          type: 'delta',
          textDelta: seg,
          modelId: response.modelId,
          providerId: response.providerId,
        };
      }
    }

    yield {
      type: 'done',
      latencyMs: response.latencyMs,
      tokensUsedEstimate: response.tokensUsedEstimate,
      modelId: response.modelId,
      providerId: response.providerId,
    };

    return response;
  }
}
