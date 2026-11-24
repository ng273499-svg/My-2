import type { SpecialistAgent, SpecialistTaskInput, SpecialistTaskOutput } from '@/core/types';

export class AutomationAgent implements SpecialistAgent {
  public readonly descriptor = {
    id: 'automation' as const,
    name: 'Automation Agent',
    roleSummary: 'Orchestrates external APIs, scheduled workflows, browser/computer actions, and smart-home devices.',
    readiness: 'interface_ready' as const,
    defaultPermissionTier: 'SENSITIVE_AUTH_REQUIRED' as const,
    requiredCapabilities: ['computer_actions', 'smart_home_devices', 'external_apis'],
    missingDependencies: [
      'Smart-Home / IoT Connector',
      'Browser/Computer-Use Sandbox',
      'External Webhook/API Credentials',
    ],
  };

  canHandle(intent: string, userMessage: string): number {
    if (intent === 'automation' || intent === 'sensitive_action') return 0.96;
    if (
      /\b(automate|smart home|lights|lock|unlock|door|thermostat|schedule|browser|click|execute command|send email|webhook)\b/i.test(
        userMessage
      )
    ) {
      return 0.89;
    }
    return 0.05;
  }

  async execute(input: SpecialistTaskInput): Promise<SpecialistTaskOutput> {
    return {
      agentId: 'automation',
      agentName: this.descriptor.name,
      executedLive: false,
      summary: `Validated automation contract for "${input.userMessage.slice(0, 80)}". External device/API connectors are not linked.`,
      structuredNotes: [
        'Enforced Tier-3 (SENSITIVE_AUTH_REQUIRED) security gate prior to dispatch.',
        'No physical smart-device, browser action, or external API mutation was performed because connectors are not configured.',
      ],
      missingIntegrationNote:
        'Smart-Home, Browser/Computer Actions, and External API connectors are currently unconfigured.',
    };
  }
}
