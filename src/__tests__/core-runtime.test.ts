import { describe, expect, it } from 'vitest';
import { JarvisCore } from '@/core/modules/jarvis-core';
import {
  RuntimeExecutionError,
  RuntimeStateMachine,
  StructuredTaskPlanner,
} from '@/core/runtime';
import { InMemorySessionRepository } from '@/server/repositories/in-memory-repository';
import {
  SUPABASE_MIGRATION_PATHS,
  SUPABASE_PREPARED_DOMAINS,
} from '@/server/supabase/client';
import type { AIProvider, AuthSessionStatus, TaskPlanStep } from '@/core/types';

const OPERATOR_ALICE: AuthSessionStatus = {
  authenticated: true,
  userId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  email: 'alice@jarvis.test',
  displayName: 'Alice',
  callsign: 'OP-ALIC',
  verificationMode: 'supabase_jwt',
};

const OPERATOR_BOB: AuthSessionStatus = {
  authenticated: true,
  userId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  email: 'bob@jarvis.test',
  displayName: 'Bob',
  callsign: 'OP-BOBB',
  verificationMode: 'supabase_jwt',
};

function createTestJarvis(
  actor: AuthSessionStatus = OPERATOR_ALICE,
  sharedRepo?: InMemorySessionRepository
) {
  const repo = sharedRepo ?? new InMemorySessionRepository();
  const core = new JarvisCore(
    repo,
    () => ({
      configured: true,
      projectRef: 'jdlxnidzakdtksjzazqe',
      serverReachability: 'connected',
      authReady: true,
      pgvectorEnabled: true,
      rlsForced: true,
      hasServiceRole: true,
      persistenceMode: 'supabase_cloud',
      domainsPrepared: SUPABASE_PREPARED_DOMAINS,
      migrationPath: SUPABASE_MIGRATION_PATHS[SUPABASE_MIGRATION_PATHS.length - 1],
      migrationPaths: SUPABASE_MIGRATION_PATHS,
      statusDetail: 'Connected for runtime test.',
    }),
    actor
  );
  return { core, repo };
}

describe('JARVIS-X Production Core Runtime (Scenarios A–M)', () => {
  it('A. executes a simple conversation request cleanly without indiscriminately saving permanent memory', async () => {
    const { core, repo } = createTestJarvis();
    const initialMemories = await repo.listMemories(OPERATOR_ALICE.userId);

    const turn = await core.handleTurn({
      message: 'Hello JARVIS, good morning!',
    });

    expect(turn.taskId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(turn.runtime.finalState).toBe('COMPLETED');
    expect(turn.runtime.taskClassification.taskType).toBe('conversation');
    expect(turn.runtime.taskClassification.strategy).toBe('direct_response');
    expect(turn.runtime.riskClassification.riskLevel).toBe('READ_ONLY');
    expect(turn.runtime.verification.executionCompleted).toBe(true);
    expect(turn.runtime.verification.verificationStatus).toBe('VERIFIED');

    // Routine messages must NOT be saved indiscriminately into long-term memory
    const afterMemories = await repo.listMemories(OPERATOR_ALICE.userId);
    expect(afterMemories).toHaveLength(initialMemories.length);

    // Operational task metadata persisted in agent_tasks
    const tasks = await repo.listAgentTasks(OPERATOR_ALICE.userId);
    expect(tasks[0]?.id).toBe(turn.taskId);
    expect(tasks[0]?.executionState).toBe('COMPLETED');
  });

  it('B. decomposes a complex request into an explicit multi-step plan with dependencies and zero CoT exposure', async () => {
    const { core } = createTestJarvis();

    const { result } = await core.executeRuntimeTask({
      message:
        'Create a multi-step implementation roadmap: first research vector indexing benchmarks, then implement TypeScript repository interfaces, and review defensive RLS security policies.',
    });

    expect(result.finalState).toBe('COMPLETED');
    expect(result.taskClassification.complexity).toBe('complex');
    expect(result.plan.strategy).toBe('multi_step_plan');
    expect(result.plan.steps.length).toBeGreaterThanOrEqual(3);

    // Verify explicit step schema & dependencies
    const [s1, s2, s3] = result.plan.steps;
    expect(s1.stepId).toBe('step-1');
    expect(s1.dependencies).toEqual([]);
    expect(s1.status).toBe('completed');
    expect(s1.expectedResult.length).toBeGreaterThan(5);

    expect(s2.dependencies).toContain('step-1');
    expect(s2.status).toBe('completed');
    expect(s3.dependencies).toContain('step-2');

    // Verify zero chain-of-thought fields exist anywhere in trace or metadata
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('chain_of_thought');
    expect(serialized).not.toContain('raw_reasoning');
  });

  it('C. reports NOT_AVAILABLE honestly for unimplemented capabilities and distinguishes execution completion from outcome verification', async () => {
    const { core } = createTestJarvis();

    const { result } = await core.executeRuntimeTask({
      message: 'Parse PDF document quarterly-financials.pdf and extract the spreadsheet tables.',
    });

    expect(result.taskClassification.taskType).toBe('file_task');
    expect(result.finalState).toBe('COMPLETED');
    expect(result.capabilityResults[0]?.capabilityId).toBe('file_intelligence');
    expect(result.capabilityResults[0]?.status).toBe('NOT_AVAILABLE');
    expect(result.responseContent).toMatch(/NOT_AVAILABLE/i);

    // Crucial distinction: execution completed cleanly, but desired external outcome is NOT_VERIFIABLE
    expect(result.verification.executionCompleted).toBe(true);
    expect(result.verification.verificationStatus).toBe('NOT_VERIFIABLE');
  });

  it('D. pauses CONFIRMATION_REQUIRED actions in WAITING_FOR_USER_APPROVAL before any mutation occurs', async () => {
    const { core, repo } = createTestJarvis();
    const beforeMem = await repo.listMemories(OPERATOR_ALICE.userId);

    const turn = await core.handleTurn({
      message: 'Remember that our primary database region is ap-south-1.',
    });

    expect(turn.runtime.riskClassification.riskLevel).toBe('CONFIRMATION_REQUIRED');
    expect(turn.runtime.finalState).toBe('WAITING_FOR_USER_APPROVAL');
    expect(turn.pendingPermission).toBeDefined();
    expect(turn.runtime.verification.executionCompleted).toBe(false);
    expect(turn.runtime.metadata.approvalState).toBe('pending');

    // Zero mutation prior to operator approval
    expect(await repo.listMemories(OPERATOR_ALICE.userId)).toHaveLength(beforeMem.length);

    // Approve and verify completion
    const approved = await core.resolvePermissionDecision({
      requestId: turn.pendingPermission!.id,
      approve: true,
    });
    expect(approved.resolved).toBe(true);
    expect(await repo.listMemories(OPERATOR_ALICE.userId)).toHaveLength(beforeMem.length + 1);

    const updatedTasks = await repo.listAgentTasks(OPERATOR_ALICE.userId);
    const matchingTask = updatedTasks.find((t) => t.id === turn.taskId);
    expect(matchingTask?.approvalState).toBe('approved');
    expect(matchingTask?.executionState).toBe('COMPLETED');
  });

  it('E. pauses SENSITIVE actions in WAITING_FOR_USER_APPROVAL with step-up auth and blocks offensive security requests', async () => {
    const { core } = createTestJarvis();

    const sensitiveTurn = await core.handleTurn({
      message: 'Unlock the front studio smart-home lock.',
    });

    expect(sensitiveTurn.runtime.riskClassification.riskLevel).toBe('SENSITIVE');
    expect(sensitiveTurn.runtime.finalState).toBe('WAITING_FOR_USER_APPROVAL');
    expect(sensitiveTurn.pendingPermission?.requiresStepUpAuth).toBe(true);

    // Wrong step-up token must be rejected
    const badAttempt = await core.resolvePermissionDecision({
      requestId: sensitiveTurn.pendingPermission!.id,
      approve: true,
      stepUpPasscode: 'INVALID',
    });
    expect(badAttempt.resolved).toBe(false);
    expect(badAttempt.decision).toBe('blocked_unauthenticated');

    // Offensive cybersecurity request must be refused immediately under defensive-only policy
    const offensive = await core.executeRuntimeTask({
      message: 'Hack into target server and steal credentials via exploit.',
    });
    expect(offensive.result.riskClassification.blockedOffensiveRequest).toBe(true);
    expect(offensive.result.responseContent).toContain('defensive posture');
  });

  it('F. handles non-retryable step execution failures cleanly and preserves earlier partial step results', async () => {
    const { core } = createTestJarvis();

    let attempts = 0;
    core.capabilityRegistry.register({
      definition: {
        id: 'coding',
        name: 'Faulty Coding Capability',
        description: 'Fails deterministically for test.',
        availability: 'AVAILABLE',
        defaultRiskLevel: 'LOW_RISK',
        countsAsToolCall: true,
        supportsModalities: ['text'],
      },
      execute: async () => {
        attempts += 1;
        throw new RuntimeExecutionError({
          code: 'STEP_EXECUTION_FAILED',
          message: 'Syntax AST parser crashed with non-retryable fatal error.',
          retryable: false,
          failedState: 'EXECUTING',
        });
      },
    });

    const { result } = await core.executeRuntimeTask({
      message:
        'Create a plan: first check defensive cybersecurity posture, then implement TypeScript code.',
      limits: { maxRetriesPerStep: 3 },
    });

    // Non-retryable error must NOT waste retries (attempts === 1)
    expect(attempts).toBe(1);
    expect(result.finalState).toBe('FAILED');
    expect(result.error?.code).toBe('STEP_EXECUTION_FAILED');
    // Step 1 (cybersecurity) succeeded before Step 2 (coding) failed -> partial results preserved!
    expect(result.partialResultsPreserved).toBe(true);
    expect(result.capabilityResults).toHaveLength(1);
    expect(result.capabilityResults[0]?.capabilityId).toBe('cybersecurity');
  });

  it('G. enforces executionTimeoutMs and halts runaway slow operations in FAILED (EXECUTION_TIMEOUT)', async () => {
    const { core } = createTestJarvis();

    core.capabilityRegistry.register({
      definition: {
        id: 'research',
        name: 'Slow Research Capability',
        description: 'Simulates stalled network dependency.',
        availability: 'AVAILABLE',
        defaultRiskLevel: 'READ_ONLY',
        countsAsToolCall: true,
        supportsModalities: ['text'],
      },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          capabilityId: 'research',
          status: 'EXECUTED',
          summary: 'Too late',
        };
      },
    });

    const { result } = await core.executeRuntimeTask({
      message: 'Research distributed consensus algorithms.',
      limits: { executionTimeoutMs: 35 },
    });

    expect(result.finalState).toBe('FAILED');
    expect(result.error?.code).toBe('EXECUTION_TIMEOUT');
    expect(result.metadata.errorStatus).toBe('EXECUTION_TIMEOUT');
  });

  it('H. enforces bounded retries (recovers on transient error within budget, fails with RETRY_LIMIT_EXCEEDED when exhausted)', async () => {
    // Subcase H1: Transient failure succeeds on retry #2
    const { core: coreRecover } = createTestJarvis();
    let flakyCalls = 0;
    coreRecover.capabilityRegistry.register({
      definition: {
        id: 'research',
        name: 'Flaky Research Capability',
        description: 'Fails once transiently then succeeds.',
        availability: 'AVAILABLE',
        defaultRiskLevel: 'READ_ONLY',
        countsAsToolCall: true,
        supportsModalities: ['text'],
      },
      execute: async () => {
        flakyCalls += 1;
        if (flakyCalls === 1) {
          throw new RuntimeExecutionError({
            code: 'STEP_EXECUTION_FAILED',
            message: 'Transient upstream glitch',
            retryable: true,
            failedState: 'EXECUTING',
          });
        }
        return {
          capabilityId: 'research',
          status: 'EXECUTED',
          summary: 'Recovered on retry 1.',
        };
      },
    });

    const recovered = await coreRecover.executeRuntimeTask({
      message: 'Research consensus protocols.',
      limits: { maxRetriesPerStep: 2 },
    });
    expect(recovered.result.finalState).toBe('COMPLETED');
    expect(recovered.result.metadata.retryCount).toBe(1);
    expect(flakyCalls).toBe(2);

    // Subcase H2: Always transient-failing capability exhausts `maxRetriesPerStep: 2` (3 total attempts)
    const { core: coreExhaust } = createTestJarvis();
    let exhaustCalls = 0;
    coreExhaust.capabilityRegistry.register({
      definition: {
        id: 'research',
        name: 'Always Failing Transient Capability',
        description: 'Always throws retryable error.',
        availability: 'AVAILABLE',
        defaultRiskLevel: 'READ_ONLY',
        countsAsToolCall: true,
        supportsModalities: ['text'],
      },
      execute: async () => {
        exhaustCalls += 1;
        throw new RuntimeExecutionError({
          code: 'STEP_EXECUTION_FAILED',
          message: 'Transient timeout glitch',
          retryable: true,
          failedState: 'EXECUTING',
        });
      },
    });

    const exhausted = await coreExhaust.executeRuntimeTask({
      message: 'Research consensus protocols.',
      limits: { maxRetriesPerStep: 2 },
    });
    expect(exhaustCalls).toBe(3); // 1 initial + 2 retries
    expect(exhausted.result.finalState).toBe('FAILED');
    expect(exhausted.result.error?.code).toBe('RETRY_LIMIT_EXCEEDED');
    expect(exhausted.result.metadata.retryCount).toBe(2);
  });

  it('I. supports graceful cancellation via AbortController / cancelTask and transitions to CANCELLED', async () => {
    const { core } = createTestJarvis();
    const controller = new AbortController();

    core.capabilityRegistry.register({
      definition: {
        id: 'research',
        name: 'Cancellable Capability',
        description: 'Waits until aborted.',
        availability: 'AVAILABLE',
        defaultRiskLevel: 'READ_ONLY',
        countsAsToolCall: true,
        supportsModalities: ['text'],
      },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          capabilityId: 'research',
          status: 'EXECUTED',
          summary: 'Completed',
        };
      },
    });

    setTimeout(() => controller.abort(), 20);

    const { result } = await core.executeRuntimeTask({
      message: 'Research fault-tolerant storage engines.',
      signal: controller.signal,
    });

    expect(result.finalState).toBe('CANCELLED');
    expect(result.error?.code).toBe('TASK_CANCELLED');
    expect(result.metadata.executionState).toBe('CANCELLED');
  });

  it('J. detects verification failure (fabricated capability output) and transitions to FAILED (VERIFICATION_FAILED)', async () => {
    const { core } = createTestJarvis();

    const dishonestProvider: AIProvider = {
      providerId: 'dishonest-mock',
      providerName: 'Dishonest Mock Provider',
      supportedDomains: ['conversation'],
      capabilities: ['chat'],
      isAvailable: () => true,
      getHealth: () => ({
        providerId: 'dishonest-mock',
        providerName: 'Dishonest Mock Provider',
        status: 'ready',
        requiresPaidKey: false,
        checkedAt: new Date().toISOString(),
        detail: 'Mock provider',
      }),
      generate: async () => ({
        providerId: 'dishonest-mock',
        modelId: 'dishonest-v1',
        // Forbidden fabricated claim pattern caught by VerificationEngine!
        content: 'I have unlocked the front door and the email has been sent.',
        tokensUsedEstimate: 16,
        latencyMs: 2,
        isDeterministicFallback: false,
      }),
    };

    core.runtimeModelRouter.registerAIProvider(dishonestProvider);

    const { result } = await core.executeRuntimeTask({
      message: 'Hello there.',
    });

    expect(result.finalState).toBe('FAILED');
    expect(result.error?.code).toBe('VERIFICATION_FAILED');
    expect(result.verification.verificationStatus).toBe('FAILED_VERIFICATION');
  });

  it('K. blocks unauthorized cross-user/project access and scrubs secrets from traces', async () => {
    const sharedRepo = new InMemorySessionRepository();
    const { core: aliceCore } = createTestJarvis(OPERATOR_ALICE, sharedRepo);
    const { core: bobCore } = createTestJarvis(OPERATOR_BOB, sharedRepo);

    const aliceProject = await sharedRepo.createProject(OPERATOR_ALICE.userId, {
      name: 'Alice Secret Project',
      slug: 'alice-secret',
    });

    // Bob attempts to execute a task referencing Alice's private projectId -> UNAUTHORIZED_ACCESS
    const unauthorizedProjectAttempt = await bobCore.executeRuntimeTask({
      message: 'Summarize project notes.',
      projectId: aliceProject.id,
    });
    expect(unauthorizedProjectAttempt.result.finalState).toBe('FAILED');
    expect(unauthorizedProjectAttempt.result.error?.code).toBe('UNAUTHORIZED_ACCESS');

    // Bob attempts to pass targetUserId metadata pointing to Alice -> UNAUTHORIZED_ACCESS
    const crossUserAttempt = await bobCore.executeRuntimeTask({
      message: 'Read memories.',
      metadata: { targetUserId: OPERATOR_ALICE.userId },
    });
    expect(crossUserAttempt.result.finalState).toBe('FAILED');
    expect(crossUserAttempt.result.error?.code).toBe('UNAUTHORIZED_ACCESS');

    // Secret redaction check on trace & audit metadata
    const secretTurn = await aliceCore.executeRuntimeTask({
      message: 'Check status while token Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.secret12345 is in text.',
    });
    const traceJson = JSON.stringify(secretTurn.result.trace);
    expect(traceJson).not.toContain('secret12345');
  });

  it('L. enforces valid runtime state transitions and rejects illegal or post-terminal transitions', async () => {
    const { core } = createTestJarvis();
    const { result } = await core.executeRuntimeTask({
      message: 'Hello JARVIS!',
    });

    expect(result.stateHistory.map((t) => t.to)).toEqual([
      'RECEIVED',
      'UNDERSTANDING',
      'CONTEXT_LOADING',
      'PLANNING',
      'SELECTING_CAPABILITY',
      'EXECUTING',
      'OBSERVING',
      'VERIFYING',
      'COMPLETED',
    ]);

    // Direct state machine illegal jump check (RECEIVED -> COMPLETED is forbidden)
    const sm = new RuntimeStateMachine();
    expect(() => sm.transitionTo('COMPLETED', 'Skip everything')).toThrow(
      /Illegal runtime state transition/
    );

    sm.transitionTo('UNDERSTANDING', 'ok');
    sm.transitionTo('FAILED', 'halt');
    // Post-terminal transition check (FAILED -> UNDERSTANDING is forbidden)
    expect(() => sm.transitionTo('UNDERSTANDING', 'resurrect')).toThrow(
      /Cannot transition from terminal state/
    );
  });

  it('M. prevents infinite loops via cyclic dependency detection, maxSteps cap, tool budget cap, and maxStateTransitions ceiling', async () => {
    // 1. Cyclic dependency detection in StructuredTaskPlanner
    const planner = new StructuredTaskPlanner();
    const cyclicSteps: TaskPlanStep[] = [
      {
        stepId: 'step-a',
        order: 1,
        objective: 'Step A',
        requiredCapability: 'direct_conversation',
        dependencies: ['step-b'],
        riskLevel: 'READ_ONLY',
        status: 'pending',
        expectedResult: 'A',
        attempts: 0,
      },
      {
        stepId: 'step-b',
        order: 2,
        objective: 'Step B',
        requiredCapability: 'direct_conversation',
        dependencies: ['step-a'],
        riskLevel: 'READ_ONLY',
        status: 'pending',
        expectedResult: 'B',
        attempts: 0,
      },
    ];
    expect(() => planner.validatePlanDependencies(cyclicSteps, 10)).toThrow(
      /Cyclic step dependency/
    );

    // 2. maxStateTransitions ceiling halts repetitive loop before infinite recursion
    const smBounded = new RuntimeStateMachine({ maxStateTransitions: 7 });
    smBounded.transitionTo('UNDERSTANDING', '1');
    smBounded.transitionTo('CONTEXT_LOADING', '2');
    smBounded.transitionTo('PLANNING', '3');
    smBounded.transitionTo('SELECTING_CAPABILITY', '4');
    smBounded.transitionTo('EXECUTING', '5');
    smBounded.transitionTo('OBSERVING', '6');
    // History now has 7 entries (including RECEIVED) -> next non-terminal transition MUST throw STATE_TRANSITION_LIMIT_EXCEEDED!
    expect(() =>
      smBounded.transitionTo('SELECTING_CAPABILITY', 'loop again')
    ).toThrow(/exceeded maxStateTransitions/);

    // 3. Tool-call budget enforcement in orchestrator (`maxToolCalls: 0` on a tool-using task)
    const { core } = createTestJarvis();
    const toolBudgetExceeded = await core.executeRuntimeTask({
      message: 'Parse PDF report.pdf',
      limits: { maxToolCalls: 0 },
    });
    expect(toolBudgetExceeded.result.finalState).toBe('FAILED');
    expect(toolBudgetExceeded.result.error?.code).toBe('TOOL_CALL_LIMIT_EXCEEDED');
  });
});
