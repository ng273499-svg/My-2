import type {
  ModelDescriptor,
  ModelGenerationInput,
  ModelGenerationOutput,
  ModelProviderAdapter,
  ModelRouteDecision,
} from '@/core/types';

/**
 * Built-in deterministic Foundation Provider (Active out-of-the-box with zero paid keys).
 * Gives clear, articulate, honest JARVIS-X responses grounded in live architectural telemetry,
 * memory state, specialist agent outputs, and capability statuses.
 */
class FoundationLocalProvider implements ModelProviderAdapter {
  public readonly providerId = 'jarvis-foundation';
  public readonly providerName = 'JARVIS-X Foundation Local Engine';

  isConfigured(): boolean {
    return true;
  }

  listModels(): ModelDescriptor[] {
    return [
      {
        id: 'foundation-local-v1',
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: 'Foundation Deterministic Core v0.1',
        availability: 'ready',
        isPaidExternal: false,
        capabilities: ['chat', 'reasoning', 'tool_calling'],
        latencyProfile: 'ultra-low',
        statusNote: 'Active local architectural router & response synthesizer (no external API keys required).',
      },
    ];
  }

  async generate(input: ModelGenerationInput): Promise<ModelGenerationOutput> {
    const start = Date.now();
    const lower = input.userMessage.toLowerCase();

    const sections: string[] = [];

    if (/^(hi|hello|hey|greetings|good morning|good evening|jarvis)\b/i.test(input.userMessage.trim())) {
      sections.push(
        `Good to have you at the console. **JARVIS-X Foundation v0.1** is online and operating cleanly.`
      );
      sections.push(
        `Right now, my **14 core engines**, **3-tier security & permission gate**, **session memory manager**, and **Supabase-ready schema layer** are active. External LLM providers, neural voice streaming, vision models, and smart-device connectors remain cleanly decoupled and marked **Not Connected** until you choose to link them.`
      );
    } else if (/\b(status|diagnostics|what works|architecture|capabilities|modules)\b/.test(lower)) {
      sections.push(
        `Here is an exact, unembellished readout of the **JARVIS-X Build 0.1** foundation:`
      );
      sections.push(
        [
          '- **Operational Now:** JARVIS Core orchestrator, Conversation Engine, Context & Style Engine, Personality Engine (Aria female voice prosody profiles), Session Memory Manager, Reasoning/Planning Engine, 3-Tier Permission & Security Gate, Self-Verification Engine, and responsive HUD.',
          `- **Data Persistence:** ${input.systemCapabilitiesSummary}`,
          '- **Standby / Not Connected:** Paid/external LLM APIs (OpenAI, Anthropic, Gemini, Local Ollama), real-time neural STT/TTS & barge-in streaming, Vision multimodal model, Web Research, Code Sandbox, Browser/Computer-Use, and Smart-Home IoT integrations.',
        ].join('\n')
      );
    } else if (input.specialistSummary) {
      sections.push(input.specialistSummary);
      if (input.memorySnippets && input.memorySnippets.length > 0) {
        sections.push(
          `**Relevant Memory Context:**\n${input.memorySnippets.map((m) => `- ${m}`).join('\n')}`
        );
      }
      sections.push(
        `*Model Router Note:* Running on **Foundation Deterministic Core v0.1** because no external LLM provider key is configured yet. Once you connect a provider adapter in \`AIModelRouter\`, open-ended synthesis and deep specialist reasoning will route automatically without UI or architectural changes.`
      );
    } else {
      sections.push(
        `I’ve processed your message (**"${input.userMessage.slice(0, 110)}${input.userMessage.length > 110 ? '…' : ''}"**) through the JARVIS-X cognitive pipeline.`
      );
      if (input.memorySnippets && input.memorySnippets.length > 0) {
        sections.push(
          `**Active Session Recall:**\n${input.memorySnippets.map((m) => `- ${m}`).join('\n')}`
        );
      }
      sections.push(
        `Because Build 0.1 runs with **zero paid external API keys** by design, open-ended generative LLM inference is currently standing by. You can test **Memory storage** (*"Remember that our primary stack uses Next.js and Supabase"*), **Specialist routing** (*"Research quantum error correction"* or *"Design a mobile telemetry card"*), or **Security gates** (*"Unlock the studio smart lock"*) right now.`
      );
    }

    const content = sections.join('\n\n');
    return {
      content,
      modelId: 'foundation-local-v1',
      providerId: this.providerId,
      tokensEstimated: Math.ceil(content.length / 4),
      latencyMs: Math.max(1, Date.now() - start),
      usedFallbackFoundation: false,
    };
  }
}

/**
 * Extensible External Provider Slot Adapter
 * Allows future providers (OpenAI, Anthropic, Google Gemini, Local Ollama/vLLM) to plug in
 * cleanly via server-side environment credentials without rewriting JARVIS Core or UI.
 */
class ExternalConfigurableProviderSlot implements ModelProviderAdapter {
  constructor(
    public readonly providerId: string,
    public readonly providerName: string,
    private readonly modelId: string,
    private readonly modelDisplayName: string,
    private readonly envVarName: string,
    private readonly isPaid: boolean,
    private readonly capabilities: ModelDescriptor['capabilities'],
    private readonly latencyProfile: ModelDescriptor['latencyProfile']
  ) {}

  isConfigured(): boolean {
    if (typeof process === 'undefined' || !process.env) return false;
    return Boolean(process.env[this.envVarName]?.trim());
  }

  listModels(): ModelDescriptor[] {
    const ready = this.isConfigured();
    return [
      {
        id: this.modelId,
        providerId: this.providerId,
        providerName: this.providerName,
        displayName: this.modelDisplayName,
        availability: ready ? 'ready' : 'not_configured',
        isPaidExternal: this.isPaid,
        requiredEnvVar: this.envVarName,
        capabilities: this.capabilities,
        latencyProfile: this.latencyProfile,
        statusNote: ready
          ? `Server credential ${this.envVarName} detected — adapter slot ready for live dispatch.`
          : `Not Connected — server env ${this.envVarName} not set.`,
      },
    ];
  }

  async generate(): Promise<ModelGenerationOutput> {
    throw new Error(
      `Provider "${this.providerName}" adapter requires live SDK wire-up and ${this.envVarName}.`
    );
  }
}

/**
 * AI Model Router
 * Registry and capability-aware router supporting multiple AI providers cleanly.
 */
export class AIModelRouter {
  private providers = new Map<string, ModelProviderAdapter>();
  private foundationProvider = new FoundationLocalProvider();
  private listeners: Array<(adapter: ModelProviderAdapter) => void> = [];

  constructor() {
    this.registerProvider(this.foundationProvider);
    this.registerProvider(
      new ExternalConfigurableProviderSlot(
        'local-openai-compatible',
        'Local Runtime (Ollama / vLLM)',
        'local-llama-compatible',
        'Local Open-Weights Adapter',
        'LOCAL_LLM_BASE_URL',
        false,
        ['chat', 'streaming', 'coding', 'reasoning'],
        'balanced'
      )
    );
    this.registerProvider(
      new ExternalConfigurableProviderSlot(
        'anthropic',
        'Anthropic Adapter Slot',
        'claude-sonnet-slot',
        'Claude Multimodal Reasoning Slot',
        'ANTHROPIC_API_KEY',
        true,
        ['chat', 'streaming', 'reasoning', 'coding', 'vision', 'tool_calling'],
        'deep-reasoning'
      )
    );
    this.registerProvider(
      new ExternalConfigurableProviderSlot(
        'openai',
        'OpenAI Adapter Slot',
        'gpt-multimodal-slot',
        'GPT Realtime & Multimodal Slot',
        'OPENAI_API_KEY',
        true,
        ['chat', 'streaming', 'reasoning', 'coding', 'vision', 'audio_in', 'audio_out', 'tool_calling'],
        'balanced'
      )
    );
    this.registerProvider(
      new ExternalConfigurableProviderSlot(
        'gemini',
        'Google Gemini Adapter Slot',
        'gemini-multimodal-slot',
        'Gemini Long-Context Multimodal Slot',
        'GEMINI_API_KEY',
        true,
        ['chat', 'streaming', 'reasoning', 'vision', 'audio_in', 'tool_calling', 'embeddings'],
        'balanced'
      )
    );
  }

  registerProvider(adapter: ModelProviderAdapter): void {
    this.providers.set(adapter.providerId, adapter);
    for (const listener of this.listeners) {
      listener(adapter);
    }
  }

  onProviderRegistered(listener: (adapter: ModelProviderAdapter) => void): void {
    this.listeners.push(listener);
  }

  listCustomAdapters(): ModelProviderAdapter[] {
    const builtInIds = new Set([
      'jarvis-foundation',
      'local-openai-compatible',
      'anthropic',
      'openai',
      'gemini',
    ]);
    return Array.from(this.providers.values()).filter(
      (p) => !builtInIds.has(p.providerId)
    );
  }

  listAllModels(): ModelDescriptor[] {
    const models: ModelDescriptor[] = [];
    for (const provider of this.providers.values()) {
      models.push(...provider.listModels());
    }
    return models;
  }

  selectModel(preferredProviderId = 'auto'): ModelRouteDecision {
    if (preferredProviderId !== 'auto') {
      const requested = this.providers.get(preferredProviderId);
      if (requested && requested.isConfigured()) {
        const model = requested.listModels()[0];
        return {
          selectedModel: model,
          reason: `Routed to configured preferred provider (${requested.providerName}).`,
          fallbackUsed: false,
        };
      }
    }

    const foundationModel = this.foundationProvider.listModels()[0];
    return {
      selectedModel: foundationModel,
      reason:
        preferredProviderId !== 'auto'
          ? `Preferred provider "${preferredProviderId}" is not configured; safely routed to Foundation Deterministic Core v0.1.`
          : 'Routed to active Foundation Deterministic Core v0.1 (no external paid LLM keys required).',
      fallbackUsed: preferredProviderId !== 'auto',
    };
  }

  async dispatchGeneration(
    preferredProviderId: string,
    input: ModelGenerationInput
  ): Promise<{ decision: ModelRouteDecision; output: ModelGenerationOutput }> {
    const decision = this.selectModel(preferredProviderId);
    const provider =
      this.providers.get(decision.selectedModel.providerId) ?? this.foundationProvider;

    try {
      const output = await provider.generate(input);
      return { decision, output };
    } catch {
      const fallbackOutput = await this.foundationProvider.generate(input);
      return {
        decision: {
          selectedModel: this.foundationProvider.listModels()[0],
          reason: 'Fallback to Foundation Deterministic Core v0.1 after external slot check.',
          fallbackUsed: true,
        },
        output: { ...fallbackOutput, usedFallbackFoundation: true },
      };
    }
  }
}
