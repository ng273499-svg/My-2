import {
  AutomationAgent,
  CodingAgent,
  DesignAgent,
  MemoryAgent,
  ResearchAgent,
  VerificationAgent,
} from '@/core/agents';
import type { MemoryAgentStoreBridge } from '@/core/agents/memory-agent';
import type {
  SpecialistAgent,
  SpecialistAgentDescriptor,
  SpecialistDomain,
  SpecialistTaskInput,
  SpecialistTaskOutput,
} from '@/core/types';

/**
 * Specialist Agent Manager
 * Registers, scores, and dispatches tasks to specialist sub-agents.
 */
export class SpecialistAgentManager {
  private agents = new Map<SpecialistDomain, SpecialistAgent>();

  constructor(memoryBridge: MemoryAgentStoreBridge) {
    const defaults: SpecialistAgent[] = [
      new ResearchAgent(),
      new CodingAgent(),
      new DesignAgent(),
      new MemoryAgent(memoryBridge),
      new AutomationAgent(),
      new VerificationAgent(),
    ];

    for (const agent of defaults) {
      this.agents.set(agent.descriptor.id, agent);
    }
  }

  registerAgent(agent: SpecialistAgent): void {
    this.agents.set(agent.descriptor.id, agent);
  }

  listDescriptors(): SpecialistAgentDescriptor[] {
    return Array.from(this.agents.values()).map((a) => a.descriptor);
  }

  selectAgent(
    preferredId: SpecialistDomain | undefined,
    intent: string,
    userMessage: string
  ): SpecialistAgent | null {
    if (preferredId && this.agents.has(preferredId)) {
      return this.agents.get(preferredId)!;
    }

    let best: { agent: SpecialistAgent; score: number } | null = null;
    for (const agent of this.agents.values()) {
      const score = agent.canHandle(intent, userMessage);
      if (score >= 0.65 && (!best || score > best.score)) {
        best = { agent, score };
      }
    }

    return best?.agent ?? null;
  }

  async dispatch(
    agent: SpecialistAgent,
    input: SpecialistTaskInput
  ): Promise<SpecialistTaskOutput> {
    return agent.execute(input);
  }
}
