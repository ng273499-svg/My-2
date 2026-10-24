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

export interface GeminiAdapterConfig extends BaseAdapterConfig {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Isolated Google Gemini Provider Adapter (`gemini`).
 * Speaks Gemini `generateContent` REST contract strictly inside this module.
 * Reports `UNCONFIGURED` when `GEMINI_API_KEY` is absent.
 */
export class GeminiProviderAdapter extends BaseAIProviderAdapter {
  public readonly providerId = 'gemini';
  public readonly providerName = 'Google Gemini';
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

  constructor(config: GeminiAdapterConfig = {}) {
    super(config);
    this.explicitApiKey = config.apiKey;
    this.explicitBaseUrl = config.baseUrl;
  }

  private getApiKey(): string | undefined {
    if (this.explicitApiKey !== undefined) {
      return this.explicitApiKey.trim() || undefined;
    }
    return resolveServerProviderCredentials().geminiApiKey;
  }

  private getBaseUrl(): string {
    return (
      this.explicitBaseUrl?.trim() ||
      resolveServerProviderCredentials().geminiBaseUrl
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
        ? 'Configured via server GEMINI_API_KEY.'
        : 'UNCONFIGURED — server env GEMINI_API_KEY is not set.';

    return [
      {
        modelId: 'gemini-2.5-pro',
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: 'Gemini 2.5 Pro Long-Context',
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
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 65_536,
        latencyClass: 'BALANCED',
        costClass: 'MEDIUM',
        qualityTier: 94,
        reliabilityScore: 0.97,
        supportsToolUse: true,
        supportsStructuredOutput: true,
        supportsStreaming: true,
        healthStatus,
        isDeterministicFallback: false,
        statusNote: note,
      },
      {
        modelId: 'gemini-2.5-flash',
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: 'Gemini 2.5 Flash',
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
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 65_536,
        latencyClass: 'ULTRA_LOW',
        costClass: 'LOW',
        qualityTier: 83,
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
        ? 'Gemini server credential present.'
        : 'UNCONFIGURED — GEMINI_API_KEY not set on server.',
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

    const userParts: Array<Record<string, unknown>> = [{ text: userText }];
    if (cleanB64) {
      userParts.push({
        inlineData: {
          mimeType: request.visionAttachment?.mimeType || 'image/png',
          data: cleanB64,
        },
      });
    }

    const contents = [
      ...request.workingHistory.slice(-10).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      {
        role: 'user',
        parts: userParts,
      },
    ];

    const body: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: request.systemPrompt }],
      },
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 1_500,
        ...(request.expectStructuredJson
          ? { responseMimeType: 'application/json' }
          : {}),
      },
    };

    if (request.availableTools && request.availableTools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.availableTools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parametersJsonSchema,
          })),
        },
      ];
    }

    const res = await this.fetchWithTimeout(
      `${this.getBaseUrl()}/models/${encodeURIComponent(resolvedModelId)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      },
      resolvedModelId,
      request.timeoutMs,
      signal
    );

    const payload = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name?: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
      usageMetadata?: { totalTokenCount?: number };
    };

    const textParts: string[] = [];
    const toolCallProposals: ModelToolCallProposal[] = [];

    for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
      if (part.text) {
        textParts.push(part.text);
      }
      if (part.functionCall?.name) {
        const matchedDef = request.availableTools?.find(
          (t) => t.name === part.functionCall!.name
        );
        toolCallProposals.push({
          callId: `gemini-call-${Date.now()}-${toolCallProposals.length}`,
          toolName: part.functionCall.name,
          capabilityId: matchedDef?.capabilityId ?? part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    const content = textParts.join('\n');
    return {
      providerId: this.providerId,
      modelId: resolvedModelId,
      content,
      toolCallProposals: toolCallProposals.length > 0 ? toolCallProposals : undefined,
      tokensUsedEstimate:
        payload.usageMetadata?.totalTokenCount ?? Math.max(1, Math.ceil(content.length / 4)),
      latencyMs: Math.max(1, Date.now() - start),
      isDeterministicFallback: false,
    };
  }
}
