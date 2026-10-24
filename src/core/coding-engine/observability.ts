/**
 * JARVIS-X v1.1.0 — Observability
 * Tracks task ID, mode, language/toolchain, files inspected/modified, commands,
 * duration, repair iterations, tests, build, verification result, specialist/model used.
 * Never logs secrets or private reasoning.
 */

import { SecretProtection } from './secret-protection';
import type { CodingObservabilityEvent } from './types';

export class CodingObservability {
  private readonly secretProtection: SecretProtection;
  private readonly events: CodingObservabilityEvent[] = [];

  constructor(secretProtection: SecretProtection) {
    this.secretProtection = secretProtection;
  }

  record(events: CodingObservabilityEvent[]): void {
    for (const e of events) {
      // Redact secrets from any event data
      const { sanitized } = this.secretProtection.redact(JSON.stringify(e));
      this.events.push(JSON.parse(sanitized));
    }
  }

  getEvents(): CodingObservabilityEvent[] {
    return [...this.events];
  }

  getSummary(taskId: string): {
    taskId: string;
    totalEvents: number;
    phases: string[];
    durationMs: number;
    repairIterations: number;
    verificationStatus: string;
  } {
    const taskEvents = this.events.filter((e) => e.taskId === taskId);
    if (taskEvents.length === 0) {
      return { taskId, totalEvents: 0, phases: [], durationMs: 0, repairIterations: 0, verificationStatus: 'UNVERIFIED' };
    }
    const phases = [...new Set(taskEvents.map((e) => e.phase))];
    const durationMs = taskEvents.reduce((sum, e) => sum + e.durationMs, 0);
    const repairIterations = Math.max(...taskEvents.map((e) => e.repairIterations));
    const last = taskEvents[taskEvents.length - 1];

    return {
      taskId,
      totalEvents: taskEvents.length,
      phases,
      durationMs,
      repairIterations,
      verificationStatus: last.verificationStatus,
    };
  }

  clear(): void {
    this.events.length = 0;
  }
}