import type { SpecialistAgent, SpecialistTaskInput, SpecialistTaskOutput } from '@/core/types';

export class ResearchAgent implements SpecialistAgent {
  public readonly descriptor = {
    id: 'research' as const,
    name: 'Research Agent',
    roleSummary: 'Multi-source web investigation, citation verification, and domain synthesis.',
    readiness: 'interface_ready' as const,
    defaultPermissionTier: 'SAFE_READ' as const,
    requiredCapabilities: ['web_research', 'reasoning'],
    missingDependencies: ['Web Search API Connector', 'External Reasoning LLM Provider'],
  };

  canHandle(intent: string, userMessage: string): number {
    if (intent === 'research') return 0.94;
    if (/\b(research|investigate|sources|compare|latest news|literature|study)\b/i.test(userMessage)) {
      return 0.85;
    }
    return 0.1;
  }

  async execute(input: SpecialistTaskInput): Promise<SpecialistTaskOutput> {
    const topic = input.userMessage.trim().slice(0, 120);
    return {
      agentId: 'research',
      agentName: this.descriptor.name,
      executedLive: false,
      summary: `Prepared structured research brief topology for "${topic}". Live web retrieval is currently not connected.`,
      structuredNotes: [
        'Primary inquiry decomposed into verifiable sub-questions.',
        'Citation & source-ranking contract initialized.',
        'Live external search skipped: no Web Research connector is configured in Build 0.1.',
      ],
      missingIntegrationNote:
        'Web Research Connector & External LLM Provider are not configured yet.',
    };
  }
}
