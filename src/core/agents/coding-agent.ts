import type { SpecialistAgent, SpecialistTaskInput, SpecialistTaskOutput } from '@/core/types';

export class CodingAgent implements SpecialistAgent {
  public readonly descriptor = {
    id: 'coding' as const,
    name: 'Coding Agent',
    roleSummary: 'Software architecture, static analysis, refactoring plans, and sandboxed code execution.',
    readiness: 'interface_ready' as const,
    defaultPermissionTier: 'CONFIRMATION_REQUIRED' as const,
    requiredCapabilities: ['coding', 'code_execution'],
    missingDependencies: ['Coding LLM Provider', 'Isolated Code Execution Sandbox'],
  };

  canHandle(intent: string, userMessage: string): number {
    if (intent === 'coding') return 0.95;
    if (/\b(code|typescript|python|refactor|bug|compile|algorithm|endpoint|sql|function)\b/i.test(userMessage)) {
      return 0.86;
    }
    return 0.1;
  }

  async execute(input: SpecialistTaskInput): Promise<SpecialistTaskOutput> {
    return {
      agentId: 'coding',
      agentName: this.descriptor.name,
      executedLive: false,
      summary: `Staged engineering specification for request (${input.userMessage.slice(0, 90)}).`,
      structuredNotes: [
        'Module boundaries, TypeScript contract expectations, and test surface mapped.',
        'Code execution sandbox is unconfigured — no untrusted code was executed.',
      ],
      missingIntegrationNote:
        'Connect an AI Coding Model Provider and optional Code Execution Sandbox to synthesize & run code.',
    };
  }
}
