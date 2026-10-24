import type {
  ModelCapability,
  ModelRequest,
  ModelResponse,
  ModelTaskDomain,
  ModelToolCallProposal,
  ProviderHealth,
  RegisteredModelMetadata,
} from '@/core/types';
import { BaseAIProviderAdapter, type BaseAdapterConfig } from './base-adapter';
import { getProviderConfigState, resolveServerProviderCredentials } from '../provider-config';

export interface OpenAIAdapterConfig extends BaseAdapterConfig {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Isolated OpenAI Provider Adapter (`openai`).
 * Speaks standard OpenAI Chat Completions wire protocol strictly inside this file.
 * Reports `UNCONFIGURED` when `OPENAI_API_KEY` is absent.
 */
export class OpenAIProviderAdapter extends BaseAIProviderAdapter {
  public readonly providerId = 'openai';
  public readonly providerName = 'OpenAI';
  public readonly supportedDomains: ModelTaskDomain[] = [
    'conversation',
    'reasoning',
    'coding',
    'vision',
    'research',
  ];
  public readonly capabilities: ModelCapability[] = [
    'conversation',
    'chat',
    'streaming',
    'reasoning',
    'coding',
    'vision',
    'structured_output',
    'tool_calling',
  ];

  private readonly explicitApiKey?: string;
  private readonly explicitBaseUrl?: string;

  constructor(config: OpenAIAdapterConfig = {}) {
    super(config);
    this.explicitApiKey = config.apiKey;
    this.explicitBaseUrl = config.baseUrl;
  }

  private getApiKey(): string | undefined {
    if (this.explicitApiKey !== undefined) {
      return this.explicitApiKey.trim() || undefined;
    }
    return resolveServerProviderCredentials().openaiApiKey;
  }

  private getBaseUrl(): string {
    return (
      this.explicitBaseUrl?.trim() ||
      resolveServerProviderCredentials().openaiBaseUrl
    ).replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  listRegisteredModels(): RegisteredModelMetadata[] {
    const configState = getProviderConfigState(this.isConfigured());
    const healthStatus = configState === 'CONFIGURED' ? 'AVAILABLE' : 'UNAVAILABLE';
    const note =
      configState === 'CONFIGURED'
        ? 'Configured via server OPENAI_API_KEY.'
        : 'UNCONFIGURED — server env OPENAI_API_KEY is not set.';

    return [
      {
        modelId: 'gpt-4o',
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: 'OpenAI GPT-4o Multimodal',
        capabilities: [
          'conversation',
          'chat',
          'streaming',
          'reasoning',
          'coding',
          'vision',
          'structured_output',
          'tool_calling',
        ],
        supportedModalities: ['text', 'image'],
        configurationState: configState,
        enabled: true,
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        latencyClass: 'BALANCED',
        costClass: 'MEDIUM',
        qualityTier: 93,
        reliabilityScore: 0.97,
        supportsToolUse: true,
        supportsStructuredOutput: true,
        supportsStreaming: true,
        healthStatus,
        isDeterministicFallback: false,
        statusNote: note,
      },
      {
        modelId: 'gpt-4o-mini',
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: 'OpenAI GPT-4o Mini',
        capabilities: [
          'conversation',
          'chat',
          'streaming',
          'coding',
          'vision',
          'structured_output',
          'tool_calling',
        ],
        supportedModalities: ['text', 'image'],
        configurationState: configState,
        enabled: true,
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        latencyClass: 'FAST',
        costClass: 'LOW',
        qualityTier: 78,
        reliabilityScore: 0.98,
        supportsToolUse: true,
        supportsStructuredOutput: true,
        supportsStreaming: true,
        healthStatus,
        isDeterministicFallback: false,
        statusNote: note,
      },
      {
        modelId: 'o3-mini',
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: 'OpenAI o3-mini Reasoning',
        capabilities: [
          'conversation',
          'chat',
          'streaming',
          'reasoning',
          'coding',
          'structured_output',
          'tool_calling',
        ],
        supportedModalities: ['text'],
        configurationState: configState,
        enabled: true,
        contextWindowTokens: 200_000,
        maxOutputTokens: 65_536,
        latencyClass: 'DEEP',
        costClass: 'MEDIUM',
        qualityTier: 95,
        reliabilityScore: 0.96,
        supportsToolUse: true,
        supportsStructuredOutput: true,
        supportsStreaming: true,
        healthStatus,
        isDeterministicFallback: false,
        statusNote: note,
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
      requiresPaidKey: true,
      checkedAt: new Date().toISOString(),
      detail: configured
        ? 'OpenAI server credential present.'
        : 'UNCONFIGURED — OPENAI_API_KEY not set on server.',
    };
  }

  protected async performGenerate(
    request: ModelRequest,
    resolvedModelId: string,
    signal: AbortSignal
  ): Promise<ModelResponse> {
    const start = Date.now();
    const apiKey = this.getApiKey()!;

    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'system', content: request.systemPrompt },
      ...request.workingHistory.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const compositeUserParts = [request.userPrompt];
    if (request.capabilityContext) {
      compositeUserParts.push(`\n[Capability Observation]\n${request.capabilityContext}`);
    }
    if (request.untrustedDataContext) {
      compositeUserParts.push(`\n${request.untrustedDataContext}`);
    }

    const rawB64 = request.visionAttachment?.base64Data;
    if (rawB64 && rawB64.length > 0) {
      const dataUrl = rawB64.startsWith('data:')
        ? rawB64
        : `data:${request.visionAttachment?.mimeType || 'image/png'};base64,${rawB64}`;
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: compositeUserParts.join('\n') },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      });
    } else {
      messages.push({ role: 'user', content: compositeUserParts.join('\n') });
    }

    const body: Record<string, unknown> = {
      model: resolvedModelId,
      messages,
      max_tokens: request.maxTokens ?? 1_500,
    };

    if (request.expectStructuredJson) {
      body.response_format = { type: 'json_object' };
    }

    if (request.availableTools && request.availableTools.length > 0) {
      body.tools = request.availableTools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parametersJsonSchema,
        },
      }));
    }

    const res = await this.fetchWithTimeout(
      `${this.getBaseUrl()}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      resolvedModelId,
      request.timeoutMs,
      signal
    );

    const payload = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { total_tokens?: number };
    };

    const firstMsg = payload.choices?.[0]?.message;
    const textContent = firstMsg?.content ?? '';

    const toolCallProposals: ModelToolCallProposal[] = [];
    for (const tc of firstMsg?.tool_calls ?? []) {
      const toolName = tc.function?.name ?? '';
      const matchedDef = request.availableTools?.find((t) => t.name === toolName);
      let parsedArgs: Record<string, unknown> = {};
      if (tc.function?.arguments) {
        try {
          const candidate = JSON.parse(tc.function.arguments);
          if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            parsedArgs = candidate as Record<string, unknown>;
          }
        } catch {
          parsedArgs = {};
        }
      }
      if (toolName) {
        toolCallProposals.push({
          callId: tc.id || `call-${Date.now()}`,
          toolName,
          capabilityId: matchedDef?.capabilityId ?? toolName,
          arguments: parsedArgs,
        });
      }
    }

    return {
      providerId: this.providerId,
      modelId: resolvedModelId,
      content: textContent,
      toolCallProposals: toolCallProposals.length > 0 ? toolCallProposals : undefined,
      tokensUsedEstimate:
        payload.usage?.total_tokens ?? Math.max(1, Math.ceil(textContent.length / 4)),
      latencyMs: Math.max(1, Date.now() - start),
      isDeterministicFallback: false,
    };
  }
}
