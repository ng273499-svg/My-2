import type {
  ModelCapability,
  ModelRequest,
  ModelResponse,
  ModelTaskDomain,
  ProviderHealth,
  RegisteredModelMetadata,
} from '@/core/types';
import { BaseAIProviderAdapter, type BaseAdapterConfig } from './base-adapter';
import { getProviderConfigState, resolveServerProviderCredentials } from '../provider-config';

export interface OpenAICompatibleAdapterConfig extends BaseAdapterConfig {
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
}

/**
 * Isolated OpenAI-Compatible Self-Hosted / Custom Gateway Adapter (`openai-compatible`).
 * Demonstrates clean extensibility: supports Ollama, vLLM, LM Studio, or custom gateways
 * without fabricating unknown model context limits or pricing (`UNKNOWN` when unspecified).
 */
export class OpenAICompatibleProviderAdapter extends BaseAIProviderAdapter {
  public readonly providerId: string;
  public readonly providerName: string;
  public readonly supportedDomains: ModelTaskDomain[] = [
    'conversation',
    'reasoning',
    'coding',
  ];
  public readonly capabilities: ModelCapability[] = [
    'conversation',
    'chat',
    'streaming',
    'reasoning',
    'coding',
  ];

  private readonly explicitBaseUrl?: string;
  private readonly explicitApiKey?: string;
  private readonly explicitModelId?: string;

  constructor(config: OpenAICompatibleAdapterConfig = {}) {
    super(config);
    this.providerId = config.providerId ?? 'openai-compatible';
    this.providerName = config.providerName ?? 'OpenAI-Compatible Endpoint (Ollama / vLLM)';
    this.explicitBaseUrl = config.baseUrl;
    this.explicitApiKey = config.apiKey;
    this.explicitModelId = config.modelId;
  }

  private getBaseUrl(): string | undefined {
    const raw =
      this.explicitBaseUrl !== undefined
        ? this.explicitBaseUrl
        : resolveServerProviderCredentials().compatibleBaseUrl;
    return raw?.trim() ? raw.trim().replace(/\/$/, '') : undefined;
  }

  private getApiKey(): string | undefined {
    if (this.explicitApiKey !== undefined) {
      return this.explicitApiKey.trim() || undefined;
    }
    return resolveServerProviderCredentials().compatibleApiKey;
  }

  private getModelId(): string {
    return (
      this.explicitModelId?.trim() ||
      resolveServerProviderCredentials().compatibleModelId ||
      'compatible-custom-model'
    );
  }

  isConfigured(): boolean {
    return Boolean(this.getBaseUrl());
  }

  listRegisteredModels(): RegisteredModelMetadata[] {
    const configState = getProviderConfigState(this.isConfigured());
    const healthStatus = configState === 'CONFIGURED' ? 'AVAILABLE' : 'UNAVAILABLE';
    const modelId = this.getModelId();
    return [
      {
        modelId,
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: `Compatible Endpoint (${modelId})`,
        capabilities: [...this.capabilities],
        supportedModalities: ['text'],
        configurationState: configState,
        enabled: true,
        // Never invent unknown specifications for arbitrary self-hosted endpoints
        contextWindowTokens: 'UNKNOWN',
        maxOutputTokens: 'UNKNOWN',
        latencyClass: 'UNKNOWN',
        costClass: 'UNKNOWN',
        qualityTier: 'UNKNOWN',
        reliabilityScore: 0.9,
        supportsToolUse: false,
        supportsStructuredOutput: false,
        supportsStreaming: true,
        healthStatus,
        isDeterministicFallback: false,
        statusNote:
          configState === 'CONFIGURED'
            ? 'Configured via COMPATIBLE_OPENAI_BASE_URL.'
            : 'UNCONFIGURED — server env COMPATIBLE_OPENAI_BASE_URL is not set.',
      },
    ];
  }

  getHealth(): ProviderHealth {
    const configured = this.isConfigured();
    return {
      providerId: this.providerId,
      providerName: this.providerName,
      status: configured ? 'ready' : 'not_configured',
      runtimeHealth: configured ? 'AVAILABLE' : 'UNAVAILABLE',
      configurationState: configured ? 'CONFIGURED' : 'UNCONFIGURED',
      requiresPaidKey: false,
      checkedAt: new Date().toISOString(),
      detail: configured
        ? 'Compatible endpoint configured.'
        : 'UNCONFIGURED — COMPATIBLE_OPENAI_BASE_URL not set.',
    };
  }

  protected async performGenerate(
    request: ModelRequest,
    resolvedModelId: string,
    signal: AbortSignal
  ): Promise<ModelResponse> {
    const start = Date.now();
    const baseUrl = this.getBaseUrl()!;
    const apiKey = this.getApiKey();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await this.fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: resolvedModelId,
          messages: [
            { role: 'system', content: request.systemPrompt },
            ...request.workingHistory.slice(-8),
            { role: 'user', content: request.userPrompt },
          ],
          max_tokens: request.maxTokens ?? 1_024,
        }),
      },
      resolvedModelId,
      request.timeoutMs,
      signal
    );

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content ?? '';

    return {
      providerId: this.providerId,
      modelId: resolvedModelId,
      content,
      tokensUsedEstimate:
        payload.usage?.total_tokens ?? Math.max(1, Math.ceil(content.length / 4)),
      latencyMs: Math.max(1, Date.now() - start),
      isDeterministicFallback: false,
    };
  }
}
