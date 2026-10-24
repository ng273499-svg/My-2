import type {
  RuntimeExecutionLimits,
  RuntimeState,
  RuntimeStateTransition,
} from '@/core/types';
import { RuntimeExecutionError } from './errors';

export const DEFAULT_RUNTIME_LIMITS: RuntimeExecutionLimits = {
  maxSteps: 6,
  maxStateTransitions: 24,
  maxRetriesPerStep: 2,
  executionTimeoutMs: 15_000,
  maxToolCalls: 5,
  maxModelFallbacks: 2,
};

export const HARD_CAP_LIMITS: RuntimeExecutionLimits = {
  maxSteps: 20,
  maxStateTransitions: 64,
  maxRetriesPerStep: 5,
  executionTimeoutMs: 60_000,
  maxToolCalls: 16,
  maxModelFallbacks: 4,
};

const TERMINAL_STATES = new Set<RuntimeState>([
  'COMPLETED',
  'WAITING_FOR_USER_APPROVAL',
  'FAILED',
  'CANCELLED',
]);

const ALLOWED_TRANSITIONS: Record<RuntimeState, ReadonlySet<RuntimeState>> = {
  RECEIVED: new Set(['UNDERSTANDING', 'FAILED', 'CANCELLED']),
  UNDERSTANDING: new Set(['CONTEXT_LOADING', 'FAILED', 'CANCELLED']),
  CONTEXT_LOADING: new Set(['PLANNING', 'FAILED', 'CANCELLED']),
  PLANNING: new Set(['SELECTING_CAPABILITY', 'FAILED', 'CANCELLED']),
  SELECTING_CAPABILITY: new Set([
    'EXECUTING',
    'WAITING_FOR_USER_APPROVAL',
    'VERIFYING',
    'FAILED',
    'CANCELLED',
  ]),
  EXECUTING: new Set([
    'OBSERVING',
    'WAITING_FOR_USER_APPROVAL',
    'FAILED',
    'CANCELLED',
  ]),
  OBSERVING: new Set([
    'SELECTING_CAPABILITY', // bounded multi-step loop back for next planned step
    'EXECUTING',
    'VERIFYING',
    'WAITING_FOR_USER_APPROVAL',
    'FAILED',
    'CANCELLED',
  ]),
  VERIFYING: new Set(['COMPLETED', 'FAILED', 'CANCELLED']),
  WAITING_FOR_USER_APPROVAL: new Set([]),
  COMPLETED: new Set([]),
  FAILED: new Set([]),
  CANCELLED: new Set([]),
};

export function normalizeRuntimeLimits(
  overrides?: Partial<RuntimeExecutionLimits>
): RuntimeExecutionLimits {
  const clamp = (val: number | undefined, fallback: number, min: number, max: number) => {
    if (val === undefined || !Number.isFinite(val)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(val)));
  };

  return {
    maxSteps: clamp(
      overrides?.maxSteps,
      DEFAULT_RUNTIME_LIMITS.maxSteps,
      1,
      HARD_CAP_LIMITS.maxSteps
    ),
    maxStateTransitions: clamp(
      overrides?.maxStateTransitions,
      DEFAULT_RUNTIME_LIMITS.maxStateTransitions,
      6,
      HARD_CAP_LIMITS.maxStateTransitions
    ),
    maxRetriesPerStep: clamp(
      overrides?.maxRetriesPerStep,
      DEFAULT_RUNTIME_LIMITS.maxRetriesPerStep,
      0,
      HARD_CAP_LIMITS.maxRetriesPerStep
    ),
    executionTimeoutMs: clamp(
      overrides?.executionTimeoutMs,
      DEFAULT_RUNTIME_LIMITS.executionTimeoutMs,
      5,
      HARD_CAP_LIMITS.executionTimeoutMs
    ),
    maxToolCalls: clamp(
      overrides?.maxToolCalls,
      DEFAULT_RUNTIME_LIMITS.maxToolCalls,
      0,
      HARD_CAP_LIMITS.maxToolCalls
    ),
    maxModelFallbacks: clamp(
      overrides?.maxModelFallbacks,
      DEFAULT_RUNTIME_LIMITS.maxModelFallbacks ?? 2,
      0,
      HARD_CAP_LIMITS.maxModelFallbacks ?? 4
    ),
  };
}

/**
 * Bounded Agent State Machine
 * Enforces legal transitions, wall-clock execution deadlines, step/tool budgets,
 * cancellation checks, and hard state-transition ceilings so infinite loops are impossible.
 */
export class RuntimeStateMachine {
  private currentState: RuntimeState = 'RECEIVED';
  private readonly history: RuntimeStateTransition[] = [];
  private readonly startedAtMs: number;
  private stepsExecuted = 0;
  private toolCallsUsed = 0;
  private manuallyCancelled = false;
  public readonly limits: RuntimeExecutionLimits;

  constructor(
    limitsOverride?: Partial<RuntimeExecutionLimits>,
    private readonly signal?: AbortSignal
  ) {
    this.limits = normalizeRuntimeLimits(limitsOverride);
    this.startedAtMs = Date.now();
    this.history.push({
      from: null,
      to: 'RECEIVED',
      reason: 'Task accepted by JARVIS-X Core Runtime.',
      timestamp: new Date().toISOString(),
      elapsedMs: 0,
    });
  }

  get state(): RuntimeState {
    return this.currentState;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.currentState);
  }

  get elapsedMs(): number {
    return Math.max(0, Date.now() - this.startedAtMs);
  }

  get remainingTimeoutMs(): number {
    return Math.max(1, this.limits.executionTimeoutMs - this.elapsedMs);
  }

  get transitions(): RuntimeStateTransition[] {
    return [...this.history];
  }

  get toolCallsCount(): number {
    return this.toolCallsUsed;
  }

  get executedStepCount(): number {
    return this.stepsExecuted;
  }

  requestCancel(): void {
    this.manuallyCancelled = true;
  }

  get isCancelRequested(): boolean {
    return Boolean(this.manuallyCancelled || this.signal?.aborted);
  }

  assertHealthyBeforeAdvance(): void {
    if (this.isCancelRequested && !this.isTerminal) {
      throw new RuntimeExecutionError({
        code: 'TASK_CANCELLED',
        message: 'Task execution was cancelled by operator or AbortSignal.',
        retryable: false,
        failedState: this.currentState,
      });
    }

    if (this.elapsedMs > this.limits.executionTimeoutMs && !this.isTerminal) {
      throw new RuntimeExecutionError({
        code: 'EXECUTION_TIMEOUT',
        message: `Task exceeded configured execution timeout (${this.limits.executionTimeoutMs}ms).`,
        retryable: false,
        failedState: this.currentState,
      });
    }
  }

  transitionTo(nextState: RuntimeState, reason: string): RuntimeStateTransition {
    if (this.isTerminal) {
      throw new RuntimeExecutionError({
        code: 'INVALID_STATE_TRANSITION',
        message: `Cannot transition from terminal state "${this.currentState}" to "${nextState}".`,
        retryable: false,
        failedState: this.currentState,
      });
    }

    // Check cancellation / timeout before non-terminal forward transitions
    if (nextState !== 'FAILED' && nextState !== 'CANCELLED') {
      this.assertHealthyBeforeAdvance();
    }

    // Hard infinite-loop guard: even legal cycles (OBSERVING -> SELECTING_CAPABILITY -> EXECUTING)
    // cannot exceed `limits.maxStateTransitions`
    if (
      nextState !== 'FAILED' &&
      nextState !== 'CANCELLED' &&
      this.history.length >= this.limits.maxStateTransitions
    ) {
      throw new RuntimeExecutionError({
        code: 'STATE_TRANSITION_LIMIT_EXCEEDED',
        message: `Bounded agent loop halted: exceeded maxStateTransitions (${this.limits.maxStateTransitions}).`,
        retryable: false,
        failedState: this.currentState,
      });
    }

    const allowed = ALLOWED_TRANSITIONS[this.currentState];
    if (!allowed.has(nextState)) {
      throw new RuntimeExecutionError({
        code: 'INVALID_STATE_TRANSITION',
        message: `Illegal runtime state transition: ${this.currentState} -> ${nextState}.`,
        retryable: false,
        failedState: this.currentState,
      });
    }

    const prev = this.currentState;
    this.currentState = nextState;
    const entry: RuntimeStateTransition = {
      from: prev,
      to: nextState,
      reason,
      timestamp: new Date().toISOString(),
      elapsedMs: this.elapsedMs,
    };
    this.history.push(entry);
    return entry;
  }

  consumeStepBudget(): void {
    this.assertHealthyBeforeAdvance();
    this.stepsExecuted += 1;
    if (this.stepsExecuted > this.limits.maxSteps) {
      throw new RuntimeExecutionError({
        code: 'STEP_LIMIT_EXCEEDED',
        message: `Bounded agent loop halted: exceeded maximum step limit (${this.limits.maxSteps}).`,
        retryable: false,
        failedState: this.currentState,
      });
    }
  }

  consumeToolCallBudget(): void {
    this.assertHealthyBeforeAdvance();
    this.toolCallsUsed += 1;
    if (this.toolCallsUsed > this.limits.maxToolCalls) {
      throw new RuntimeExecutionError({
        code: 'TOOL_CALL_LIMIT_EXCEEDED',
        message: `Exceeded maximum tool call budget (${this.limits.maxToolCalls}) for a single task.`,
        retryable: false,
        failedState: this.currentState,
      });
    }
  }
}
