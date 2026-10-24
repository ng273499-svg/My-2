import type { PermissionTier } from './permission';

/**
 * User-facing Agent Activity stages displayed in the Agent Activity Panel.
 * Directly reflects real Core Runtime states (private chain-of-thought is never stored or emitted).
 */
export type AgentLifecycleStage =
  | 'understanding'
  | 'context_loading'
  | 'planning'
  | 'selecting'
  | 'executing'
  | 'observing'
  | 'verifying'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepExecutionState =
  | 'pending'
  | 'active'
  | 'completed'
  | 'awaiting_permission'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface AgentActivityStep {
  stage: AgentLifecycleStage;
  runtimeState?: string;
  label: string;
  summary: string;
  state: StepExecutionState;
  moduleName: string;
  durationMs?: number;
  timestamp: string;
}

export type SpecialistDomain =
  | 'research'
  | 'coding'
  | 'planning'
  | 'vision'
  | 'memory'
  | 'automation'
  | 'verification'
  | 'cybersecurity'
  | 'data'
  | 'design';

export type SpecialistReadiness = 'operational_local' | 'interface_ready';

export interface SpecialistAgentDescriptor {
  id: SpecialistDomain;
  name: string;
  roleSummary: string;
  readiness: SpecialistReadiness;
  defaultPermissionTier: PermissionTier;
  requiredCapabilities: string[];
  missingDependencies: string[];
}

export interface SpecialistTaskInput {
  conversationId: string;
  userMessage: string;
  intent: string;
  parameters?: Record<string, unknown>;
}

export interface SpecialistTaskOutput {
  agentId: SpecialistDomain;
  agentName: string;
  executedLive: boolean;
  summary: string;
  structuredNotes: string[];
  missingIntegrationNote?: string;
}

export interface SpecialistAgent {
  readonly descriptor: SpecialistAgentDescriptor;
  canHandle(intent: string, userMessage: string): number; // 0..1 confidence score
  execute(input: SpecialistTaskInput): Promise<SpecialistTaskOutput>;
}
