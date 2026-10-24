import type {
  MemoryEntry,
  SpecialistAgent,
  SpecialistTaskInput,
  SpecialistTaskOutput,
} from '@/core/types';

export interface MemoryAgentStoreBridge {
  recallRelevant(query: string): Promise<MemoryEntry[]>;
  countEntries(): Promise<number>;
}

export class MemoryAgent implements SpecialistAgent {
  public readonly descriptor = {
    id: 'memory' as const,
    name: 'Memory Agent',
    roleSummary: 'Curates working session recall, episodic summaries, and Supabase-ready long-term memory.',
    readiness: 'operational_local' as const,
    defaultPermissionTier: 'SAFE_READ' as const,
    requiredCapabilities: ['internal_diagnostics'],
    missingDependencies: ['Supabase pgvector Cloud Link (using local ephemeral store)'],
  };

  constructor(private readonly storeBridge: MemoryAgentStoreBridge) {}

  canHandle(intent: string, userMessage: string): number {
    if (intent === 'memory_read' || intent === 'memory_write') return 0.97;
    if (/\b(remember|memory|memories|recall|forget|what do you know about)\b/i.test(userMessage)) {
      return 0.9;
    }
    return 0.15;
  }

  async execute(input: SpecialistTaskInput): Promise<SpecialistTaskOutput> {
    const matched = await this.storeBridge.recallRelevant(input.userMessage);
    const total = await this.storeBridge.countEntries();

    return {
      agentId: 'memory',
      agentName: this.descriptor.name,
      executedLive: true,
      summary: `Inspected active memory store (${matched.length} matching of ${total} stored records).`,
      structuredNotes:
        matched.length > 0
          ? matched.slice(0, 3).map((m) => `[${m.category.toUpperCase()}] ${m.content}`)
          : ['No direct lexical matches in current memory buffer; ready to store confirmed facts.'],
      missingIntegrationNote:
        'Persistent cross-session vector recall will activate once Supabase credentials are provided.',
    };
  }
}
