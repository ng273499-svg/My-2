import { generateUuid } from '@/core/utils/uuid';
import type {
  AgentActivityStep,
  AgentLifecycleStage,
  RuntimeState,
  StepExecutionState,
  TaskTraceEvent,
} from '@/core/types';
import { redactSecrets, sanitizeTelemetryAttributes } from './errors';

const STATE_TO_UI_STAGE: Record<
  RuntimeState,
  { stage: AgentLifecycleStage; label: string } | null
> = {
  RECEIVED: null,
  UNDERSTANDING: { stage: 'understanding', label: 'Understanding' },
  CONTEXT_LOADING: { stage: 'context_loading', label: 'Loading context' },
  PLANNING: { stage: 'planning', label: 'Planning' },
  SELECTING_CAPABILITY: { stage: 'selecting', label: 'Selecting capability' },
  EXECUTING: { stage: 'executing', label: 'Executing' },
  OBSERVING: { stage: 'observing', label: 'Observing' },
  VERIFYING: { stage: 'verifying', label: 'Verifying' },
  WAITING_FOR_USER_APPROVAL: {
    stage: 'waiting_for_approval',
    label: 'Waiting for approval',
  },
  COMPLETED: { stage: 'completed', label: 'Completed' },
  FAILED: { stage: 'failed', label: 'Failed' },
  CANCELLED: { stage: 'cancelled', label: 'Cancelled' },
};

/**
 * Structured Task Observability Recorder
 * Emits secret-scrubbed `TaskTraceEvent` spans keyed by `taskId` and projects
 * real runtime state transitions onto concise user-facing `AgentActivityStep` items.
 * Never logs hidden chain-of-thought or credentials.
 */
export class RuntimeTraceRecorder {
  private readonly traceEvents: TaskTraceEvent[] = [];
  private readonly activitySteps: AgentActivityStep[] = [];

  constructor(public readonly taskId: string) {}

  recordTrace(input: {
    phase: TaskTraceEvent['phase'];
    state: RuntimeState;
    summary: string;
    attributes?: Record<string, unknown>;
    durationMs?: number;
  }): TaskTraceEvent {
    const event: TaskTraceEvent = {
      traceId: generateUuid(),
      taskId: this.taskId,
      phase: input.phase,
      state: input.state,
      summary: redactSecrets(input.summary).slice(0, 320),
      attributes: sanitizeTelemetryAttributes(input.attributes),
      timestamp: new Date().toISOString(),
      durationMs: input.durationMs,
    };
    this.traceEvents.push(event);
    return event;
  }

  recordActivity(input: {
    runtimeState: RuntimeState;
    summary: string;
    moduleName: string;
    stepState?: StepExecutionState;
    durationMs?: number;
    labelOverride?: string;
  }): void {
    const mapped = STATE_TO_UI_STAGE[input.runtimeState];
    if (!mapped) return;

    const defaultStepState: StepExecutionState =
      input.runtimeState === 'WAITING_FOR_USER_APPROVAL'
        ? 'awaiting_permission'
        : input.runtimeState === 'FAILED'
          ? 'failed'
          : input.runtimeState === 'CANCELLED'
            ? 'cancelled'
            : 'completed';

    const step: AgentActivityStep = {
      stage: mapped.stage,
      runtimeState: input.runtimeState,
      label: input.labelOverride ?? mapped.label,
      summary: redactSecrets(input.summary).slice(0, 300),
      state: input.stepState ?? defaultStepState,
      moduleName: input.moduleName,
      durationMs: input.durationMs,
      timestamp: new Date().toISOString(),
    };

    const existingIdx = this.activitySteps.findIndex((s) => s.stage === step.stage);
    if (existingIdx >= 0) {
      this.activitySteps[existingIdx] = step;
    } else {
      this.activitySteps.push(step);
    }
  }

  getTrace(): TaskTraceEvent[] {
    return [...this.traceEvents];
  }

  getActivitySteps(): AgentActivityStep[] {
    return [...this.activitySteps];
  }
}
