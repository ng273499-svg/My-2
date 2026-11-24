import type { SpecialistAgent, SpecialistTaskInput, SpecialistTaskOutput } from '@/core/types';

export class DesignAgent implements SpecialistAgent {
  public readonly descriptor = {
    id: 'design' as const,
    name: 'Design Agent',
    roleSummary: 'Interface systems, spatial hierarchy, responsive UX flows, and design token architecture.',
    readiness: 'interface_ready' as const,
    defaultPermissionTier: 'SAFE_READ' as const,
    requiredCapabilities: ['reasoning', 'vision_camera'],
    missingDependencies: ['Multimodal Design/Vision LLM Provider'],
  };

  canHandle(intent: string, userMessage: string): number {
    if (intent === 'design') return 0.93;
    if (/\b(design|ui|ux|layout|palette|typography|wireframe|mockup|responsive)\b/i.test(userMessage)) {
      return 0.84;
    }
    return 0.08;
  }

  async execute(input: SpecialistTaskInput): Promise<SpecialistTaskOutput> {
    return {
      agentId: 'design',
      agentName: this.descriptor.name,
      executedLive: false,
      summary: `Generated structural UX & visual hierarchy checklist for "${input.userMessage.slice(0, 80)}".`,
      structuredNotes: [
        'Evaluated desktop 3-zone vs mobile single-column ergonomics (44px+ touch targets).',
        'Visual generation & screenshot critique require connecting a Vision/Multimodal model.',
      ],
      missingIntegrationNote:
        'Multimodal Vision/Design Model Provider is not connected yet.',
    };
  }
}
