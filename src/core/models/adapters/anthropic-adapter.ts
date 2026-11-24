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

export interface AnthropicAdapterConfig extends BaseAdapterConfig {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Isolated Anthropic Provider Adapter (`anthropic`).
 * Speaks Anthropic Messages API strictly inside this module.
 * Reports `UNCONFIGURED` when `ANTHROPIC_API_KEY` is absent.
 */
export class AnthropicProviderAdapter extends BaseAIProviderAdapter {
  public readonly providerId = 'anthropic';
  public readonly providerName = 'Anthropic';
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

  constructor(config: AnthropicAdapterConfig = {}) {
    super(config);
    this.explicitApiKey = config.apiKey;
    this.explicitBaseUrl = config.baseUrl;
  }

  private getApiKey(): string | undefined {
    if (this.explicitApiKey !== undefined) {
      return this.explicitApiKey.trim() || undefined;
    }
    return resolveServerProviderCredentials().anthropicApiKey;
  }

  private getBaseUrl(): string {
    return (
      this.explicitBaseUrl?.trim() ||
      resolveServerProviderCredentials().anthropicBaseUrl
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
        ? 'Configured via server ANTHROPIC_API_KEY.'
        : 'UNCONFIGURED — server env ANTHROPIC_API_KEY is not set.';

    return [
      {
        modelId: 'claude-3-7-sonnet',
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: 'Claude 3.7 Sonnet',
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
        contextWindowTokens: 200_000,
        maxOutputTokens: 16_384,
        latencyClass: 'BALANCED',
        costClass: 'HIGH',
        qualityTier: 96,
        reliabilityScore: 0.98,
        supportsToolUse: true,
        supportsStructuredOutput: true,
        supportsStreaming: true,
        healthStatus,
        isDeterministicFallback: false,
        statusNote: note,
      },
      {
        modelId: 'claude-3-5-haiku',
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: 'Claude 3.5 Haiku',
        capabilities: [
          'conversation',
          'chat',
          'streaming',
          'coding',
          'structured_output',
          'tool_calling',
        ],
        supportedModalities: ['text'],
        configurationState: configState,
        enabled: true,
        contextWindowTokens: 200_000,
        maxOutputTokens: 8_192,
        latencyClass: 'FAST',
        costClass: 'LOW',
        qualityTier: 81,
        reliabilityScore: 0.98,
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
        ? 'Anthropic server credential present.'
        : 'UNCONFIGURED — ANTHROPIC_API_KEY not set on server.',
    };
  }

  protected async performGenerate(
    request: ModelRequest,
    resolvedModelId: string,
    signal: AbortSignal
  ): Promise<ModelResponse> {
    const start = Date.now();
    const apiKey = this.getApiKey()!;

    const userText = [
      request.userPrompt,
      request.capabilityContext
        ? `\n[Capability Observation]\n${request.capabilityContext}`
        : '',
      request.untrustedDataContext ? `\n${request.untrustedDataContext}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const rawB64 = request.visionAttachment?.base64Data;
    const cleanB64 = rawB64?.includes(',')
      ? rawB64.slice(rawB64.indexOf(',') + 1)
      : rawB64;

    const messages = [
      ...request.workingHistory.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      {
        role: 'user',
        content: cleanB64
          ? [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: request.visionAttachment?.mimeType || 'image/png',
                  data: cleanB64,
                },
              },
              { type: 'text', text: userText },
            ]
          : userText,
      },
    ];

    const body: Record<string, unknown> = {
      model: resolvedModelId,
      max_tokens: request.maxTokens ?? 1_500,
      system: request.systemPrompt,
      messages,
    };

    if (request.availableTools && request.availableTools.length > 0) {
      body.tools = request.availableTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parametersJsonSchema,
      }));
    }

    const res = await this.fetchWithTimeout(
      `${this.getBaseUrl()}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      },
      resolvedModelId,
      request.timeoutMs,
      signal
    );

    const payload = (await res.json()) as {
      content?: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const textParts: string[] = [];
    const toolCallProposals: ModelToolCallProposal[] = [];

    for (const block of payload.content ?? []) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        const matchedDef = request.availableTools?.find((t) => t.name === block.name);
        toolCallProposals.push({
          callId: block.id,
          toolName: block.name,
          capabilityId: matchedDef?.capabilityId ?? block.name,
          arguments: block.input ?? {},
        });
      }
    }

    const content = textParts.join('\n');
    const tokensUsed =
      (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0) ||
      Math.max(1, Math.ceil(content.length / 4));

    return {
      providerId: this.providerId,
      modelId: resolvedModelId,
      content,
      toolCallProposals: toolCallProposals.length > 0 ? toolCallProposals : undefined,
      tokensUsedEstimate: tokensUsed,
      latencyMs: Math.max(1, Date.now() - start),
      isDeterministicFallback: false,
    };
  }
}
