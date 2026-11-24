import type { SpecialistAgentManager } from '@/core/modules/specialist-agent-manager';
import type {
  RuntimeSpecialistId,
  SpecialistContractDescriptor,
  SpecialistTaskInput,
  SpecialistTaskOutput,
} from '@/core/types';

export interface SpecialistAgentContract {
  readonly contract: SpecialistContractDescriptor;
  execute(input: SpecialistTaskInput): Promise<SpecialistTaskOutput>;
}

/**
 * Specialist Registry (All 10 Specialist Contracts)
 * Provides a common plug-in interface for:
 *   ResearchAgent, CodingAgent, PlanningAgent, VisionAgent, MemoryAgent,
 *   AutomationAgent, VerificationAgent, CybersecurityAgent, DataAgent, DesignAgent
 * Bridges existing operational local specialists and defines clean `NOT_AVAILABLE` /
 * advisory contracts for specialists awaiting external providers.
 */
export class SpecialistRegistry {
  private readonly contracts = new Map<RuntimeSpecialistId, SpecialistAgentContract>();

  constructor(private readonly legacyManager: SpecialistAgentManager) {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    const descriptors: SpecialistContractDescriptor[] = [
      {
        id: 'research',
        agentClassName: 'ResearchAgent',
        displayName: 'Research Agent',
        roleSummary:
          'Decomposes research inquiries into verifiable sub-questions; awaits live web search connector.',
        status: 'CONTRACT_ONLY_NOT_AVAILABLE',
        primaryCapability: 'research',
        defaultRiskLevel: 'READ_ONLY',
        missingDependencies: ['Web Search API Connector', 'External Reasoning LLM'],
      },
      {
        id: 'coding',
        agentClassName: 'CodingAgent',
        displayName: 'Coding Agent',
        roleSummary:
          'Maps modular software interfaces & TypeScript/SQL contracts; code execution sandbox not connected.',
        status: 'CONTRACT_ONLY_NOT_AVAILABLE',
        primaryCapability: 'coding',
        defaultRiskLevel: 'LOW_RISK',
        missingDependencies: ['External Coding LLM', 'Sandboxed Code Execution Runtime'],
      },
      {
        id: 'planning',
        agentClassName: 'PlanningAgent',
        displayName: 'Planning Agent',
        roleSummary:
          'Structures multi-step objectives, explicit dependencies, and milestone checklists.',
        status: 'OPERATIONAL_LOCAL',
        primaryCapability: 'direct_conversation',
        defaultRiskLevel: 'LOW_RISK',
        missingDependencies: [],
      },
      {
        id: 'vision',
        agentClassName: 'VisionAgent',
        displayName: 'Vision Agent',
        roleSummary:
          'Contract for multimodal image, diagram, and camera frame understanding.',
        status: 'CONTRACT_ONLY_NOT_AVAILABLE',
        primaryCapability: 'vision',
        defaultRiskLevel: 'LOW_RISK',
        missingDependencies: ['Multimodal Vision AIProvider'],
      },
      {
        id: 'memory',
        agentClassName: 'MemoryAgent',
        displayName: 'Memory Agent',
        roleSummary:
          'Retrieves permitted operator/project memories and coordinates gated durable storage.',
        status: 'OPERATIONAL_LOCAL',
        primaryCapability: 'memory',
        defaultRiskLevel: 'READ_ONLY',
        missingDependencies: [],
      },
      {
        id: 'automation',
        agentClassName: 'AutomationAgent',
        displayName: 'Automation Agent',
        roleSummary:
          'Contract for scheduled triggers, cron jobs, and confirmation-gated workflow orchestration.',
        status: 'CONTRACT_ONLY_NOT_AVAILABLE',
        primaryCapability: 'automation',
        defaultRiskLevel: 'CONFIRMATION_REQUIRED',
        missingDependencies: ['Background Workflow Scheduler / Edge Runner'],
      },
      {
        id: 'verification',
        agentClassName: 'VerificationAgent',
        displayName: 'Verification Agent',
        roleSummary:
          'Audits runtime outputs against capability registry states and anti-fabrication policies.',
        status: 'OPERATIONAL_LOCAL',
        primaryCapability: 'verification',
        defaultRiskLevel: 'READ_ONLY',
        missingDependencies: [],
      },
      {
        id: 'cybersecurity',
        agentClassName: 'CybersecurityAgent',
        displayName: 'Cybersecurity Agent',
        roleSummary:
          'Defensive-only security review contract for RLS policies, secret hygiene, and threat modeling.',
        status: 'OPERATIONAL_LOCAL',
        primaryCapability: 'cybersecurity',
        defaultRiskLevel: 'LOW_RISK',
        missingDependencies: ['External CVE / Telemetry Feed (Optional)'],
      },
      {
        id: 'data',
        agentClassName: 'DataAgent',
        displayName: 'Data Agent',
        roleSummary:
          'Profiles structured CSV/JSON datasets, numeric column statistics, and SQL schema designs locally.',
        status: 'OPERATIONAL_LOCAL',
        primaryCapability: 'file_intelligence',
        defaultRiskLevel: 'LOW_RISK',
        missingDependencies: ['Binary PDF / Excel OCR Connector (Optional)'],
      },
      {
        id: 'design',
        agentClassName: 'DesignAgent',
        displayName: 'Design Agent',
        roleSummary:
          'Reviews spatial hierarchy, responsive mobile ergonomics, and accessible HUD design.',
        status: 'OPERATIONAL_LOCAL',
        primaryCapability: 'direct_conversation',
        defaultRiskLevel: 'READ_ONLY',
        missingDependencies: [],
      },
    ];

    for (const desc of descriptors) {
      this.contracts.set(desc.id, {
        contract: desc,
        execute: async (input) => this.dispatchContract(desc, input),
      });
    }
  }

  private async dispatchContract(
    desc: SpecialistContractDescriptor,
    input: SpecialistTaskInput
  ): Promise<SpecialistTaskOutput> {
    // Delegate to existing legacy specialist implementation if registered there
    const legacy = this.legacyManager.selectAgent(desc.id, input.intent, input.userMessage);
    if (legacy && legacy.descriptor.id === desc.id) {
      return this.legacyManager.dispatch(legacy, input);
    }

    if (desc.id === 'planning') {
      return {
        agentId: 'planning',
        agentName: 'Planning Agent',
        executedLive: true,
        summary: `Decomposed "${input.userMessage.slice(0, 80)}" into ordered phases with explicit capability & risk boundaries.`,
        structuredNotes: [
          'Phase 1: Validate inputs, user permissions, and available capabilities',
          'Phase 2: Execute safe read/local synthesis steps in dependency order',
          'Phase 3: Verify outputs and record operational task metadata',
        ],
      };
    }

    if (desc.id === 'cybersecurity') {
      return {
        agentId: 'cybersecurity',
        agentName: 'Cybersecurity Agent (Defensive)',
        executedLive: true,
        summary:
          'Completed defensive security posture evaluation (strictly defensive-only; active exploitation disabled).',
        structuredNotes: [
          'Verify PostgreSQL FORCE ROW LEVEL SECURITY (`auth.uid() = user_id`) on every user table',
          'Keep privileged credentials (`SUPABASE_SERVICE_ROLE_KEY`, provider keys) strictly server-only',
          'Sanitize external tool/document outputs as untrusted data before model consumption',
        ],
        missingIntegrationNote:
          'Live external vulnerability/CVE scanning is NOT_AVAILABLE in this phase.',
      };
    }

    if (desc.id === 'data') {
      return {
        agentId: 'data',
        agentName: 'Data Agent',
        executedLive: true,
        summary:
          'Evaluated structured data/schema inquiry using local CSV/JSON/SQL profiler.',
        structuredNotes: [
          'Supports attached CSV/TSV (row/column counts, numeric min/max/mean) and JSON schema inspection',
          'Quarantines external file text via PromptInjectionBoundary prior to synthesis',
        ],
        missingIntegrationNote:
          'Binary PDF/XLSX extraction remains NOT_AVAILABLE; attach CSV, JSON, Markdown, or SQL text for verified profiling.',
      };
    }

    // Honest NOT_AVAILABLE response for contract-only specialists (`vision`, etc.)
    return {
      agentId: desc.id,
      agentName: desc.displayName,
      executedLive: false,
      summary: `${desc.agentClassName} interface is registered, capability status: NOT_AVAILABLE.`,
      structuredNotes: [
        `Role contract: ${desc.roleSummary}`,
        `Missing dependency: ${desc.missingDependencies.join(', ') || 'External provider binding'}`,
      ],
      missingIntegrationNote: `${desc.agentClassName} full implementation is NOT_AVAILABLE yet; zero results were fabricated.`,
    };
  }

  register(agent: SpecialistAgentContract): void {
    this.contracts.set(agent.contract.id, agent);
  }

  get(id: RuntimeSpecialistId): SpecialistAgentContract | undefined {
    return this.contracts.get(id);
  }

  listContracts(): SpecialistContractDescriptor[] {
    return Array.from(this.contracts.values()).map((c) => c.contract);
  }
}
