import type { ContextEmotionEngine } from '@/core/modules/context-emotion-engine';
import type { PermissionSecurityManager } from '@/core/modules/permission-security-manager';
import type { PersonalityEngine } from '@/core/modules/personality-engine';
import type { VoiceEngine } from '@/core/modules/voice-engine';
import {
  GovernedToolCallBridge,
  PromptInjectionBoundary,
  StructuredPlanProposalSchema,
} from '@/core/models';
import {
  generateUuid,
  isValidUuid,
  normalizeConversationId,
} from '@/core/utils/uuid';
import type {
  AgentActivityStep,
  AuthSessionStatus,
  CapabilityExecutionResult,
  ContextSignals,
  ModelRouteDecision,
  ModelRoutingCriteria,
  PermissionRequest,
  ResponseStyle,
  RuntimeExecutionLimits,
  RuntimeExecutionResult,
  RuntimeRequest,
  RuntimeTaskMetadata,
  TaskPlan,
  VerificationSummary,
} from '@/core/types';
import { CapabilityRegistry } from './capability-registry';
import {
  RiskClassifier,
  TaskClassifier,
  mapRiskToPermissionTier,
} from './classifiers';
import { RuntimeExecutionError, redactSecrets } from './errors';
import { RuntimeMemoryBridge } from './memory-context';
import { RuntimeTraceRecorder } from './observability';
import { StructuredTaskPlanner, type PlannerContract } from './planner';
import {
  RuntimeModelRouter,
  mapTaskTypeToModelDomain,
  mapTaskTypeToRequiredCapabilities,
} from './provider-abstraction';
import { SpecialistRegistry } from './specialist-registry';
import { RuntimeStateMachine } from './state-machine';
import { RuntimeVerificationLayer } from './verifier';

interface ActiveTaskHandle {
  userId: string;
  stateMachine: RuntimeStateMachine;
  abortController: AbortController;
}

export interface JarvisCoreRuntimeDependencies {
  contextEmotionEngine: ContextEmotionEngine;
  personalityEngine: PersonalityEngine;
  voiceEngine: VoiceEngine;
  permissionSecurityManager: PermissionSecurityManager;
  memoryBridge: RuntimeMemoryBridge;
  capabilityRegistry: CapabilityRegistry;
  specialistRegistry: SpecialistRegistry;
  modelRouter: RuntimeModelRouter;
  verificationLayer: RuntimeVerificationLayer;
  getSystemSummary: (authenticated: boolean) => Promise<string>;
  planner?: PlannerContract;
  taskClassifier?: TaskClassifier;
  riskClassifier?: RiskClassifier;
}

export interface RuntimeTurnOutput {
  result: RuntimeExecutionResult;
  activitySteps: AgentActivityStep[];
  contextSignals: ContextSignals;
  legacyRouteDecision: ModelRouteDecision;
  legacyVerification: VerificationSummary;
}

async function runWithDeadlineAndSignal<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  currentStage: RuntimeStateMachine['state']
): Promise<T> {
  if (signal.aborted) {
    throw new RuntimeExecutionError({
      code: 'TASK_CANCELLED',
      message: 'Task execution cancelled via signal.',
      retryable: false,
      failedState: currentStage,
    });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const deadlinePromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new RuntimeExecutionError({
          code: 'EXECUTION_TIMEOUT',
          message: `Execution timed out after ${timeoutMs}ms during ${currentStage}.`,
          retryable: false,
          failedState: currentStage,
        })
      );
    }, Math.max(1, timeoutMs));

    onAbort = () => {
      reject(
        new RuntimeExecutionError({
          code: 'TASK_CANCELLED',
          message: 'Task cancelled while awaiting operation.',
          retryable: false,
          failedState: currentStage,
        })
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([work(), deadlinePromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * JARVIS-X Central Core Runtime Orchestrator
 * Executes the bounded server-side state machine:
 *   RECEIVED -> UNDERSTANDING -> CONTEXT_LOADING -> PLANNING ->
 *   SELECTING_CAPABILITY -> [WAITING_FOR_USER_APPROVAL] ->
 *   EXECUTING -> OBSERVING -> VERIFYING -> COMPLETED | FAILED | CANCELLED
 */
export class JarvisCoreRuntime {
  public readonly taskClassifier: TaskClassifier;
  public readonly riskClassifier: RiskClassifier;
  public readonly toolGovernance: GovernedToolCallBridge;
  public readonly promptBoundary: PromptInjectionBoundary;
  public varPlanner: PlannerContract;
  private readonly activeTasks = new Map<string, ActiveTaskHandle>();

  constructor(private readonly deps: JarvisCoreRuntimeDependencies) {
    this.taskClassifier = deps.taskClassifier ?? new TaskClassifier();
    this.riskClassifier = deps.riskClassifier ?? new RiskClassifier();
    this.toolGovernance = new GovernedToolCallBridge(
      deps.capabilityRegistry,
      deps.permissionSecurityManager
    );
    this.promptBoundary = new PromptInjectionBoundary();
    this.varPlanner = deps.planner ?? new StructuredTaskPlanner();
  }

  setPlanner(planner: PlannerContract): void {
    this.varPlanner = planner;
  }

  /**
   * Gracefully cancels an in-flight task owned by `requestingUserId`.
   * Rejects cross-user cancellation attempts with `UNAUTHORIZED_ACCESS`.
   */
  cancelTask(requestingUserId: string, taskId: string): boolean {
    const handle = this.activeTasks.get(taskId);
    if (!handle) return false;
    if (handle.userId !== requestingUserId) {
      throw new RuntimeExecutionError({
        code: 'UNAUTHORIZED_ACCESS',
        message: 'Cannot cancel a task belonging to another user.',
        retryable: false,
        failedState: handle.stateMachine.state,
      });
    }
    handle.stateMachine.requestCancel();
    handle.abortController.abort();
    return true;
  }

  async execute(
    actor: AuthSessionStatus,
    request: RuntimeRequest,
    defaultLimits?: Partial<RuntimeExecutionLimits>
  ): Promise<RuntimeTurnOutput> {
    const startedIso = new Date().toISOString();
    const startMs = Date.now();
    const taskId =
      request.taskId && isValidUuid(request.taskId) ? request.taskId : generateUuid();
    const conversationId = normalizeConversationId(request.conversationId);

    const abortController = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) {
        abortController.abort();
      } else {
        request.signal.addEventListener('abort', () => abortController.abort(), {
          once: true,
        });
      }
    }

    const mergedLimits: Partial<RuntimeExecutionLimits> = {
      ...defaultLimits,
      ...request.limits,
    };

    const sm = new RuntimeStateMachine(mergedLimits, abortController.signal);
    const tracer = new RuntimeTraceRecorder(taskId);
    this.activeTasks.set(taskId, {
      userId: actor.userId,
      stateMachine: sm,
      abortController,
    });

    const capabilityResults: CapabilityExecutionResult[] = [];
    let totalRetries = 0;
    let plan: TaskPlan = {
      planId: generateUuid(),
      taskId,
      strategy: 'direct_response',
      conciseSummary: 'Pending plan initialization.',
      steps: [],
      createdAt: startedIso,
    };

    let taskClassification = this.taskClassifier.classify({
      ...request,
      message: request.message ?? '',
    });
    let riskClassification = this.riskClassifier.classify(
      taskClassification,
      request.message ?? ''
    );
    let responseStyle: ResponseStyle = 'calm';
    let contextSignals: ContextSignals = {
      detectedUrgency: 'low',
      userSentimentCue: 'neutral',
      domainComplexity: 'conversational',
      recommendedStyle: 'calm',
      styleRationale: 'Default calm posture.',
      timestampIso: startedIso,
    };
    let pendingApproval: PermissionRequest | undefined;

    tracer.recordTrace({
      phase: 'request',
      state: 'RECEIVED',
      summary: `Accepted ${taskClassification.modality} request (${request.message?.trim().length ?? 0} chars).`,
      attributes: {
        conversationId,
        modality: taskClassification.modality,
      },
    });

    try {
      const trimmedMessage = (request.message ?? '').trim();
      if (!trimmedMessage) {
        throw new RuntimeExecutionError({
          code: 'INVALID_INPUT',
          message: 'Request message cannot be empty.',
          retryable: false,
          failedState: 'RECEIVED',
        });
      }

      // =========================================================================
      // STATE 1: UNDERSTANDING (Intent, Task & Risk Classification)
      // =========================================================================
      const tUnderstand = Date.now();
      sm.transitionTo('UNDERSTANDING', 'Classifying intent, task type, and risk tier.');

      taskClassification = this.taskClassifier.classify({
        ...request,
        message: trimmedMessage,
      });
      riskClassification = this.riskClassifier.classify(
        taskClassification,
        trimmedMessage
      );

      tracer.recordTrace({
        phase: 'understanding',
        state: 'UNDERSTANDING',
        summary: `${taskClassification.summary} · Risk: ${riskClassification.riskLevel}`,
        attributes: {
          taskType: taskClassification.taskType,
          strategy: taskClassification.strategy,
          riskLevel: riskClassification.riskLevel,
        },
        durationMs: Math.max(1, Date.now() - tUnderstand),
      });
      tracer.recordActivity({
        runtimeState: 'UNDERSTANDING',
        summary: `Task: ${taskClassification.taskType} (${taskClassification.strategy}) · Risk: ${riskClassification.riskLevel}.`,
        moduleName: 'Task & Risk Classifiers',
        durationMs: Math.max(1, Date.now() - tUnderstand),
      });

      // =========================================================================
      // STATE 2: CONTEXT_LOADING (Auth Check + Permitted Memory/Project Context)
      // =========================================================================
      const tContext = Date.now();
      sm.transitionTo(
        'CONTEXT_LOADING',
        'Validating operator identity and loading permitted context.'
      );

      const requestedOwnerOverride =
        typeof request.metadata?.targetUserId === 'string'
          ? request.metadata.targetUserId
          : undefined;
      this.deps.memoryBridge.assertAuthorizedActor(actor, requestedOwnerOverride);

      const loadedContext = await runWithDeadlineAndSignal(
        () =>
          this.deps.memoryBridge.loadPermittedContext({
            actor,
            conversationId,
            projectId: request.projectId,
            query: trimmedMessage,
            taskType: taskClassification.taskType,
          }),
        sm.remainingTimeoutMs,
        abortController.signal,
        'CONTEXT_LOADING'
      );

      contextSignals = this.deps.contextEmotionEngine.analyze(
        trimmedMessage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskClassification.intent as any,
        {
          preferredResponseStyle: loadedContext.preferredStyle,
          voiceProfileId: loadedContext.voiceProfileId,
          voiceAutoSpeak: false,
          voiceBargeInEnabled: true,
          witLevel: loadedContext.witLevel,
          conciseness: loadedContext.conciseness,
          preferredModelProvider: loadedContext.preferredProviderId,
          proactiveAssistanceEnabled: loadedContext.proactiveEnabled,
          crossDeviceSyncEnabled: false,
        }
      );
      responseStyle = contextSignals.recommendedStyle;

      tracer.recordTrace({
        phase: 'context_loading',
        state: 'CONTEXT_LOADING',
        summary: `Loaded ${loadedContext.workingMessages.length} working turns & ${loadedContext.relevantMemories.length} permitted memory item(s).`,
        attributes: {
          workingTurns: loadedContext.workingMessages.length,
          memoriesLoaded: loadedContext.relevantMemories.length,
          authenticated: loadedContext.authenticated,
        },
        durationMs: Math.max(1, Date.now() - tContext),
      });
      tracer.recordActivity({
        runtimeState: 'CONTEXT_LOADING',
        summary: `Loaded ${loadedContext.workingMessages.length} turn(s) & ${loadedContext.relevantMemories.length} permitted memory item(s) · Style: "${responseStyle}".`,
        moduleName: 'Runtime Memory Bridge',
        durationMs: Math.max(1, Date.now() - tContext),
      });

      // =========================================================================
      // STATE 3: PLANNING (Structured Task Steps & Cycle Check — Zero CoT)
      // =========================================================================
      const tPlan = Date.now();
      sm.transitionTo('PLANNING', 'Generating structured execution plan.');

      plan = this.varPlanner.createPlan({
        taskId,
        message: trimmedMessage,
        taskClassification,
        riskClassification,
        limits: sm.limits,
      });

      const memoryCandidate = this.deps.memoryBridge.evaluateDurableMemoryCandidate(
        taskClassification.intent,
        taskClassification.extractedMemoryFact
      );

      tracer.recordTrace({
        phase: 'planning',
        state: 'PLANNING',
        summary: plan.conciseSummary,
        attributes: {
          stepCount: plan.steps.length,
          durableMemoryCandidate: memoryCandidate.shouldPersist,
        },
        durationMs: Math.max(1, Date.now() - tPlan),
      });
      tracer.recordActivity({
        runtimeState: 'PLANNING',
        summary: `${plan.conciseSummary} (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'})`,
        moduleName: 'Structured Task Planner',
        durationMs: Math.max(1, Date.now() - tPlan),
      });

      // =========================================================================
      // Defensive Security Policy Block (Refuse Offensive Exploitation Cleanly)
      // =========================================================================
      if (riskClassification.blockedOffensiveRequest) {
        sm.transitionTo(
          'SELECTING_CAPABILITY',
          'Evaluating defensive-only cybersecurity policy boundary.'
        );
        tracer.recordActivity({
          runtimeState: 'SELECTING_CAPABILITY',
          summary: 'Offensive exploitation request refused by Cybersecurity policy boundary.',
          moduleName: 'Risk Classifier & Policy Guard',
          stepState: 'blocked',
          durationMs: 1,
        });

        const refusalContent =
          'I cannot assist with offensive exploitation, unauthorized access, or credential attacks. **JARVIS-X Cybersecurity** operates strictly for defensive posture reviews, threat modeling, Row-Level Security auditing, and system hardening.';

        sm.transitionTo('VERIFYING', 'Verifying policy refusal integrity.');
        const { report: verReport, legacySummary } =
          this.deps.verificationLayer.verifyExecution({
            executionCompleted: true,
            responseContent: refusalContent,
            permissionTier: riskClassification.mappedPermissionTier,
            riskClassification,
            approvalPaused: false,
            capabilityResults,
          });

        tracer.recordActivity({
          runtimeState: 'VERIFYING',
          summary: verReport.summary,
          moduleName: 'Runtime Verification Layer',
          durationMs: 1,
        });

        sm.transitionTo('COMPLETED', 'Defensive refusal delivered.');
        tracer.recordActivity({
          runtimeState: 'COMPLETED',
          summary: 'Defensive policy boundary enforced cleanly.',
          moduleName: 'JARVIS Core Runtime',
          durationMs: 1,
        });

        const metadata: RuntimeTaskMetadata = {
          taskId,
          userId: actor.userId,
          conversationId,
          projectId: loadedContext.projectId,
          taskType: taskClassification.taskType,
          riskLevel: riskClassification.riskLevel,
          selectedCapability: 'cybersecurity',
          selectedSpecialist: 'cybersecurity',
          executionState: 'COMPLETED',
          approvalState: 'denied',
          verificationStatus: verReport.verificationStatus,
          errorStatus: null,
          retryCount: 0,
          toolCallsCount: 0,
          startedAt: startedIso,
          completedAt: new Date().toISOString(),
          durationMs: Math.max(1, Date.now() - startMs),
        };

        await this.deps.memoryBridge.persistTaskExecution(
          actor,
          metadata,
          riskClassification.mappedPermissionTier,
          'Refused offensive cybersecurity request under defensive-only policy.'
        );

        const routeEval = await this.deps.modelRouter.evaluateRoute({
          taskType: taskClassification.taskType,
          taskDomain: 'reasoning',
          requiredCapabilities: ['reasoning'],
          preferredProviderId: loadedContext.preferredProviderId,
          latencyPreference: 'ultra-low',
          costConstraint: 'free_only',
          estimatedContextTokens: trimmedMessage.length,
          minimumReliability: 0.9,
        });

        return {
          result: {
            taskId,
            conversationId,
            finalState: 'COMPLETED',
            responseContent: refusalContent,
            responseStyle: 'seriousness',
            taskClassification,
            riskClassification,
            plan,
            capabilityResults,
            routing: routeEval,
            verification: verReport,
            metadata,
            stateHistory: sm.transitions,
            trace: tracer.getTrace(),
            partialResultsPreserved: false,
          },
          activitySteps: tracer.getActivitySteps(),
          contextSignals,
          legacyRouteDecision: {
            selectedModel: {
              id: routeEval.selectedModelId,
              providerId: routeEval.selectedProviderId,
              providerName: routeEval.selectedDisplayName,
              displayName: routeEval.selectedDisplayName,
              availability: 'ready',
              isPaidExternal: false,
              capabilities: ['chat', 'reasoning'],
              latencyProfile: 'ultra-low',
              statusNote: routeEval.rationale,
            },
            reason: routeEval.rationale,
            fallbackUsed: routeEval.fallbackUsed,
          },
          legacyVerification: legacySummary,
        };
      }

      // =========================================================================
      // STATE 4: APPROVAL GATE CHECK (Pause for CONFIRMATION_REQUIRED / SENSITIVE)
      // =========================================================================
      const primaryStep = plan.steps[0];
      const primaryCapDef = this.deps.capabilityRegistry.getDefinition(
        primaryStep.requiredCapability
      );

      if (riskClassification.requiresApprovalPause) {
        const tSel = Date.now();
        sm.transitionTo(
          'SELECTING_CAPABILITY',
          `Selected "${primaryCapDef.id}" (${primaryCapDef.availability}); evaluating ${riskClassification.riskLevel} approval gate.`
        );

        tracer.recordTrace({
          phase: 'capability_selection',
          state: 'SELECTING_CAPABILITY',
          summary: `Capability "${primaryCapDef.id}" [${primaryCapDef.availability}] requires ${riskClassification.riskLevel} approval.`,
          attributes: {
            capabilityId: primaryCapDef.id,
            availability: primaryCapDef.availability,
            riskLevel: riskClassification.riskLevel,
          },
          durationMs: Math.max(1, Date.now() - tSel),
        });
        tracer.recordActivity({
          runtimeState: 'SELECTING_CAPABILITY',
          summary: `Selected capability "${primaryCapDef.name}" [${primaryCapDef.availability}] · Gate: ${riskClassification.riskLevel}.`,
          moduleName: 'Capability Registry & Risk Gate',
          durationMs: Math.max(1, Date.now() - tSel),
        });

        const securityEval = await this.deps.permissionSecurityManager.evaluate({
          userId: actor.userId,
          conversationId,
          actionCode: riskClassification.actionCode,
          actionTitle:
            riskClassification.riskLevel === 'SENSITIVE'
              ? 'Authorize Sensitive Operation'
              : 'Confirm Action Execution',
          targetResource: riskClassification.targetResource,
          tier: riskClassification.mappedPermissionTier,
          summary: plan.conciseSummary,
          pendingPayload: {
            taskId,
            intent: taskClassification.intent,
            taskType: taskClassification.taskType,
            selectedCapability: primaryCapDef.id,
            userMessage: trimmedMessage,
            extractedMemoryFact:
              taskClassification.extractedMemoryFact ?? trimmedMessage,
          },
        });

        if (!securityEval.allowedImmediately && securityEval.pendingRequest) {
          pendingApproval = securityEval.pendingRequest;
          primaryStep.status = 'waiting_approval';

          sm.transitionTo(
            'WAITING_FOR_USER_APPROVAL',
            `Execution paused pending explicit operator approval (${riskClassification.riskLevel}).`
          );

          const leadIn = this.deps.personalityEngine.styleLeadIn(
            responseStyle,
            loadedContext.witLevel
          );
          const capAvailabilityNote =
            primaryCapDef.availability === 'NOT_AVAILABLE'
              ? `\n\n*Capability Status:* \`${primaryCapDef.id}\` is currently **NOT_AVAILABLE** (${primaryCapDef.missingDependencyNote ?? 'connector unconfigured'}). Even after approval, JARVIS-X will report **Not Connected / NOT_AVAILABLE** honestly rather than faking external execution.`
              : '';

          const gateMessage =
            riskClassification.riskLevel === 'SENSITIVE'
              ? `${leadIn} I’ve paused task **\`${taskId.slice(0, 8)}\`** (**"${trimmedMessage}"**) in state **\`WAITING_FOR_USER_APPROVAL\`** at the **Sensitive Security Gate (\`SENSITIVE\` / \`SENSITIVE_AUTH_REQUIRED\`)**.\n\nJARVIS-X never executes sensitive device, computer, or destructive actions automatically. Use the authorization card below to verify or deny.${capAvailabilityNote}`
              : `${leadIn} Task **\`${taskId.slice(0, 8)}\`** requires **Operator Confirmation (\`CONFIRMATION_REQUIRED\`)** before modifying state for **"${taskClassification.extractedMemoryFact ?? trimmedMessage}"**.\n\n Execution is paused in **\`WAITING_FOR_USER_APPROVAL\`**. Approve or decline below.${capAvailabilityNote}`;

          const { report: verReport, legacySummary } =
            this.deps.verificationLayer.verifyExecution({
              executionCompleted: false,
              responseContent: gateMessage,
              permissionTier: riskClassification.mappedPermissionTier,
              riskClassification,
              approvalPaused: true,
              capabilityResults,
            });

          tracer.recordTrace({
            phase: 'completion',
            state: 'WAITING_FOR_USER_APPROVAL',
            summary: `Paused safely at ${riskClassification.riskLevel} gate (requestId=${pendingApproval.id}).`,
            attributes: {
              permissionRequestId: pendingApproval.id,
              verificationStatus: verReport.verificationStatus,
            },
          });
          tracer.recordActivity({
            runtimeState: 'WAITING_FOR_USER_APPROVAL',
            summary:
              riskClassification.riskLevel === 'SENSITIVE'
                ? 'Waiting for step-up authorization — zero sensitive actions executed.'
                : 'Waiting for operator confirmation — execution safely paused.',
            moduleName: 'Permission & Security Manager',
            stepState: 'awaiting_permission',
            durationMs: 1,
          });

          const routeEval = await this.deps.modelRouter.evaluateRoute({
            taskType: taskClassification.taskType,
            taskDomain: mapTaskTypeToModelDomain(taskClassification.taskType),
            requiredCapabilities: ['chat'],
            preferredProviderId: loadedContext.preferredProviderId,
            latencyPreference: 'ultra-low',
            costConstraint: 'free_only',
            estimatedContextTokens: trimmedMessage.length,
            minimumReliability: 0.9,
          });

          const metadata: RuntimeTaskMetadata = {
            taskId,
            userId: actor.userId,
            conversationId,
            projectId: loadedContext.projectId,
            taskType: taskClassification.taskType,
            riskLevel: riskClassification.riskLevel,
            selectedCapability: primaryCapDef.id,
            selectedSpecialist: primaryStep.specialistId,
            executionState: 'WAITING_FOR_USER_APPROVAL',
            approvalState: 'pending',
            verificationStatus: verReport.verificationStatus,
            errorStatus: null,
            retryCount: 0,
            toolCallsCount: 0,
            startedAt: startedIso,
            completedAt: null,
            durationMs: Math.max(1, Date.now() - startMs),
          };

          await this.deps.memoryBridge.persistTaskExecution(
            actor,
            metadata,
            riskClassification.mappedPermissionTier,
            `Paused at ${riskClassification.riskLevel} gate (${riskClassification.actionCode}).`
          );

          return {
            result: {
              taskId,
              conversationId,
              finalState: 'WAITING_FOR_USER_APPROVAL',
              responseContent: gateMessage,
              responseStyle,
              taskClassification,
              riskClassification,
              plan,
              capabilityResults,
              routing: routeEval,
              verification: verReport,
              metadata,
              stateHistory: sm.transitions,
              trace: tracer.getTrace(),
              pendingApproval,
              partialResultsPreserved: false,
            },
            activitySteps: tracer.getActivitySteps(),
            contextSignals,
            legacyRouteDecision: {
              selectedModel: {
                id: routeEval.selectedModelId,
                providerId: routeEval.selectedProviderId,
                providerName: routeEval.selectedDisplayName,
                displayName: routeEval.selectedDisplayName,
                availability: 'ready',
                isPaidExternal: false,
                capabilities: ['chat', 'reasoning'],
                latencyProfile: 'ultra-low',
                statusNote: routeEval.rationale,
              },
              reason: routeEval.rationale,
              fallbackUsed: routeEval.fallbackUsed,
            },
            legacyVerification: legacySummary,
          };
        }
      } else {
        // Record SAFE_READ governance audit entry
        await this.deps.permissionSecurityManager.evaluate({
          userId: actor.userId,
          conversationId,
          actionCode: riskClassification.actionCode,
          actionTitle: 'Safe Runtime Execution',
          targetResource: riskClassification.targetResource,
          tier: 'SAFE_READ',
          summary: plan.conciseSummary,
          pendingPayload: { taskId, taskType: taskClassification.taskType },
        });
      }

      // =========================================================================
      // STATES 5–7: BOUNDED AGENT LOOP (SELECTING_CAPABILITY -> EXECUTING -> OBSERVING)
      // =========================================================================
      const specialistNotes: string[] = [];
      const selectedCapabilityLabels: string[] = [];

      for (let i = 0; i < plan.steps.length; i += 1) {
        const step = plan.steps[i];
        sm.consumeStepBudget();

        // Transition into SELECTING_CAPABILITY
        const tSelect = Date.now();
        sm.transitionTo(
          'SELECTING_CAPABILITY',
          `Selecting capability "${step.requiredCapability}" for ${step.stepId}.`
        );

        const capDef = this.deps.capabilityRegistry.getDefinition(
          step.requiredCapability
        );
        const specialistContract = step.specialistId
          ? this.deps.specialistRegistry.get(step.specialistId)
          : undefined;

        selectedCapabilityLabels.push(
          `${capDef.id}[${capDef.availability}]${
            specialistContract ? `/${specialistContract.contract.agentClassName}` : ''
          }`
        );

        tracer.recordTrace({
          phase: 'capability_selection',
          state: 'SELECTING_CAPABILITY',
          summary: `Step ${step.stepId}: capability="${capDef.id}" (${capDef.availability})${
            specialistContract
              ? `, specialist=${specialistContract.contract.agentClassName}`
              : ''
          }`,
          attributes: {
            stepId: step.stepId,
            capabilityId: capDef.id,
            availability: capDef.availability,
            specialist: specialistContract?.contract.agentClassName ?? null,
          },
          durationMs: Math.max(1, Date.now() - tSelect),
        });
        tracer.recordActivity({
          runtimeState: 'SELECTING_CAPABILITY',
          summary: `Selected: ${selectedCapabilityLabels.join(' → ')}`,
          moduleName: 'Capability & Specialist Registry',
          durationMs: Math.max(1, Date.now() - tSelect),
        });

        if (capDef.countsAsToolCall) {
          sm.consumeToolCallBudget();
        }

        // Transition into EXECUTING (with bounded retry loop)
        const tExec = Date.now();
        sm.transitionTo('EXECUTING', `Executing ${step.stepId} (${capDef.id}).`);
        step.status = 'in_progress';

        let capResult: CapabilityExecutionResult | undefined;
        let lastErr: unknown = null;
        const maxAttempts = 1 + sm.limits.maxRetriesPerStep;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          step.attempts = attempt;
          try {
            capResult = await runWithDeadlineAndSignal(
              () =>
                this.deps.capabilityRegistry.invoke(step.requiredCapability, {
                  taskId,
                  userId: actor.userId,
                  conversationId,
                  projectId: loadedContext.projectId,
                  step,
                  userMessage: trimmedMessage,
                  taskClassification,
                  memorySnippets: loadedContext.relevantMemories.map((m) => m.content),
                  visionAttachment: request.visionAttachment,
                  documentAttachment: request.documentAttachment,
                  signal: abortController.signal,
                }),
              sm.remainingTimeoutMs,
              abortController.signal,
              'EXECUTING'
            );
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const isRetryable =
              err instanceof RuntimeExecutionError
                ? err.retryable
                : /transient|temporary|retry|econnreset/i.test(
                    err instanceof Error ? err.message : ''
                  );

            // Never retry cancellation or timeout
            if (
              err instanceof RuntimeExecutionError &&
              (err.code === 'TASK_CANCELLED' || err.code === 'EXECUTION_TIMEOUT')
            ) {
              step.status = err.code === 'TASK_CANCELLED' ? 'cancelled' : 'failed';
              throw err;
            }

            if (!isRetryable) {
              step.status = 'failed';
              if (err instanceof RuntimeExecutionError) {
                throw err;
              }
              throw new RuntimeExecutionError({
                code: 'STEP_EXECUTION_FAILED',
                message:
                  err instanceof Error
                    ? err.message
                    : `Step ${step.stepId} failed with non-retryable error.`,
                retryable: false,
                failedState: 'EXECUTING',
                attemptsMade: attempt,
                cause: err,
              });
            }

            if (attempt < maxAttempts) {
              totalRetries += 1;
              tracer.recordTrace({
                phase: 'execution',
                state: 'EXECUTING',
                summary: `Retry ${attempt}/${sm.limits.maxRetriesPerStep} for ${step.stepId} after transient failure.`,
                attributes: {
                  stepId: step.stepId,
                  attempt,
                },
              });
            } else {
              step.status = 'failed';
              throw new RuntimeExecutionError({
                code: 'RETRY_LIMIT_EXCEEDED',
                message: `Step "${step.stepId}" exhausted retry limit (${sm.limits.maxRetriesPerStep} retries): ${
                  err instanceof Error ? err.message : 'execution error'
                }`,
                retryable: false,
                failedState: 'EXECUTING',
                attemptsMade: attempt,
                cause: err,
              });
            }
          }
        }

        if (!capResult || lastErr) {
          throw new RuntimeExecutionError({
            code: 'STEP_EXECUTION_FAILED',
            message: `Step ${step.stepId} produced no capability output.`,
            retryable: false,
            failedState: 'EXECUTING',
          });
        }

        // Dispatch specialist contract summary when applicable
        if (specialistContract) {
          const specOut = await runWithDeadlineAndSignal(
            () =>
              specialistContract.execute({
                conversationId,
                userMessage: trimmedMessage,
                intent: taskClassification.intent,
              }),
            sm.remainingTimeoutMs,
            abortController.signal,
            'EXECUTING'
          );

          const includeCapTelemetry =
            (capResult.capabilityId === 'vision' ||
              capResult.capabilityId === 'file_intelligence') &&
            (capResult.status === 'EXECUTED' || capResult.status === 'PARTIAL_LOCAL');

          const formattedSpec = [
            `**${specOut.agentName} (${specialistContract.contract.status}):**`,
            specOut.summary,
            includeCapTelemetry
              ? `- **Verified Local Inspection (\`${capResult.status}\`):** ${capResult.summary}`
              : '',
            ...specOut.structuredNotes.map((n) => `- ${n}`),
            specOut.missingIntegrationNote
              ? `*Capability Note:* ${specOut.missingIntegrationNote}`
              : '',
          ]
            .filter(Boolean)
            .join('\n');

          specialistNotes.push(formattedSpec);
        } else if (
          (capResult.capabilityId === 'vision' ||
            capResult.capabilityId === 'file_intelligence') &&
          (capResult.status === 'EXECUTED' || capResult.status === 'PARTIAL_LOCAL')
        ) {
          specialistNotes.push(
            `**Capability \`${capResult.capabilityId}\` (\`${capResult.status}\`):**\n- ${capResult.summary}`
          );
        } else if (capResult.status === 'NOT_AVAILABLE') {
          specialistNotes.push(
            `**Capability \`${capResult.capabilityId}\` Status: \`NOT_AVAILABLE\`**\n- ${capResult.summary}${
              capResult.honestLimitationNote
                ? `\n- *Limitation:* ${capResult.honestLimitationNote}`
                : ''
            }`
          );
        }

        // Sanitize untrusted external observations through PromptInjectionBoundary
        const sanitizedObs = this.promptBoundary.sanitizeToolObservation(
          capResult.capabilityId,
          capResult.summary
        );
        const safeCapResult: CapabilityExecutionResult = {
          ...capResult,
          summary: sanitizedObs.sanitizedSummary,
        };

        capabilityResults.push(safeCapResult);
        step.status = 'completed';
        step.observationSummary = safeCapResult.summary;

        tracer.recordTrace({
          phase: 'execution',
          state: 'EXECUTING',
          summary: `Completed ${step.stepId} (${capResult.capabilityId} -> ${capResult.status}).`,
          attributes: {
            stepId: step.stepId,
            status: capResult.status,
            attempts: step.attempts,
          },
          durationMs: Math.max(1, Date.now() - tExec),
        });
        tracer.recordActivity({
          runtimeState: 'EXECUTING',
          summary: `Executed ${capabilityResults.length}/${plan.steps.length} step(s) · Latest: ${capResult.capabilityId} (${capResult.status}).`,
          moduleName: specialistContract
            ? specialistContract.contract.displayName
            : capDef.name,
          durationMs: Math.max(1, Date.now() - tExec),
        });

        // Transition into OBSERVING
        const tObs = Date.now();
        sm.transitionTo(
          'OBSERVING',
          `Observed ${step.stepId} outcome (${capResult.status}).`
        );
        tracer.recordTrace({
          phase: 'observation',
          state: 'OBSERVING',
          summary: step.observationSummary,
          attributes: {
            stepId: step.stepId,
            capabilityStatus: capResult.status,
          },
          durationMs: Math.max(1, Date.now() - tObs),
        });
        tracer.recordActivity({
          runtimeState: 'OBSERVING',
          summary: step.observationSummary,
          moduleName: 'Runtime Observation Collector',
          durationMs: Math.max(1, Date.now() - tObs),
        });
      }

      // =========================================================================
      // Synthesize Final Response via Provider-Agnostic RuntimeModelRouter
      // =========================================================================
      const leadIn = this.deps.personalityEngine.styleLeadIn(
        responseStyle,
        loadedContext.witLevel
      );

      let capabilityContextBlock: string | undefined;
      if (taskClassification.intent === 'voice_inquiry') {
        const voiceDiag = this.deps.voiceEngine.getDiagnostics(
          loadedContext.voiceProfileId
        );
        const prosody = this.deps.personalityEngine.buildVoiceProsodyHint(
          responseStyle,
          loadedContext.voiceProfileId
        );
        capabilityContextBlock = [
          `${leadIn} **Voice Engine Status:**`,
          `- **Target Persona:** ${voiceDiag.activeFemaleVoiceProfile.name} — *${voiceDiag.activeFemaleVoiceProfile.timbreDescription}*`,
          `- **Server Neural STT / TTS:** ${
            voiceDiag.neuralTtsConnected
              ? 'Connected (`OpenAISpeechAdapter`)'
              : '`NOT_AVAILABLE` / Unconfigured on server (Zero-Cost Client Browser Female Web Speech Synthesis active in supported browsers)'
          }`,
          `- **Barge-In Interruption Controller:** Active (\`state=${voiceDiag.bargeInState}\`, interruptions=${voiceDiag.bargeInInterruptionsCount}).`,
          `- **Active Style Prosody Hint:** \`rate=${prosody.speakingRate}x\`, \`contour=${prosody.pitchContour}\`, \`pause=${prosody.clausePauseMs}ms\`.`,
        ].join('\n');
      } else if (specialistNotes.length > 0) {
        const planHeader =
          plan.steps.length > 1
            ? [
                `**Execution Plan (${plan.steps.length} Steps):**`,
                ...plan.steps.map(
                  (s) =>
                    `${s.order}. \`[${s.stepId}]\` ${s.objective} → *${s.status.toUpperCase()}* (\`${s.requiredCapability}\`)`
                ),
              ].join('\n')
            : '';

        capabilityContextBlock = [leadIn, planHeader, ...specialistNotes]
          .filter(Boolean)
          .join('\n\n');
      }

      const systemSummary = await this.deps.getSystemSummary(actor.authenticated);
      const effectiveRoutingPolicy =
        request.routingPolicyOverride ?? loadedContext.routingPolicy ?? 'AUTO_BALANCED';
      const effectiveManualModelId =
        request.manualModelIdOverride !== undefined
          ? request.manualModelIdOverride
          : loadedContext.manualModelId;

      const baseDirective = this.deps.personalityEngine.buildSystemDirective(
        responseStyle,
        {
          preferredResponseStyle: loadedContext.preferredStyle,
          voiceProfileId: loadedContext.voiceProfileId,
          voiceAutoSpeak: false,
          voiceBargeInEnabled: true,
          witLevel: loadedContext.witLevel,
          conciseness: loadedContext.conciseness,
          preferredModelProvider: loadedContext.preferredProviderId,
          routingPolicy: effectiveRoutingPolicy,
          manualModelId: effectiveManualModelId,
          proactiveAssistanceEnabled: loadedContext.proactiveEnabled,
          crossDeviceSyncEnabled: false,
        }
      );

      // Evaluate Prompt-Injection Boundary on untrusted external sources, attached documents, recalled external knowledge chunks & message
      const attachedDocSources = request.documentAttachment?.textContent
        ? [
            {
              sourceType: 'file' as const,
              label: request.documentAttachment.fileName,
              rawContent: request.documentAttachment.textContent.slice(0, 16_000),
            },
          ]
        : [];
      const combinedUntrustedSources = [
        ...(request.untrustedSources ?? []),
        ...attachedDocSources,
        ...(loadedContext.untrustedMemorySources ?? []),
      ];
      const boundaryEval = this.promptBoundary.evaluate(
        baseDirective,
        trimmedMessage,
        combinedUntrustedSources
      );
      if (boundaryEval.injectionAttemptDetected) {
        tracer.recordTrace({
          phase: 'understanding',
          state: 'OBSERVING',
          summary: `Quarantined untrusted prompt-injection pattern(s): ${boundaryEval.detectedPatterns.join(', ')}`,
          attributes: {
            promptInjectionDetected: true,
            patternCount: boundaryEval.detectedPatterns.length,
          },
        });
      }

      const trustedMemorySnippets = loadedContext.relevantMemories
        .filter((m) => m.provenance !== 'untrusted_external')
        .map(
          (m) =>
            `[${m.memoryScope ?? 'semantic'}/${m.category}] ${m.content}`
        );

      const taskDomain = mapTaskTypeToModelDomain(taskClassification.taskType);
      const requiredCapabilities = mapTaskTypeToRequiredCapabilities(
        taskClassification.taskType
      );
      const routingCriteria: ModelRoutingCriteria = {
        taskId,
        taskType: taskClassification.taskType,
        taskDomain,
        requiredCapabilities,
        requiredModality: taskDomain === 'vision' ? 'image' : 'text',
        requireStructuredOutput: Boolean(request.requireStructuredOutput),
        routingPolicy: effectiveRoutingPolicy,
        manualModelId: effectiveManualModelId,
        preferredProviderId: loadedContext.preferredProviderId,
        latencyPreference:
          effectiveRoutingPolicy === 'SPEED_FIRST'
            ? 'ultra-low'
            : taskDomain === 'reasoning'
              ? 'deep-reasoning'
              : 'balanced',
        costConstraint: 'unrestricted',
        estimatedContextTokens: Math.max(
          16,
          Math.ceil(
            (trimmedMessage.length +
              (capabilityContextBlock?.length ?? 0) +
              (boundaryEval.sanitizedUntrustedBlock?.length ?? 0)) /
              4
          )
        ),
        minimumReliability: 0.75,
        maxFallbackAttempts: sm.limits.maxModelFallbacks ?? 2,
      };

      const modelRequestPayload = {
        taskId,
        taskDomain: routingCriteria.taskDomain,
        systemPrompt: boundaryEval.enforcedSystemDirective,
        userPrompt: trimmedMessage,
        untrustedDataContext: boundaryEval.sanitizedUntrustedBlock,
        workingHistory: loadedContext.workingMessages,
        responseStyle,
        capabilityContext: capabilityContextBlock,
        memoryContext: trustedMemorySnippets,
        systemSummary,
        availableTools: this.toolGovernance.buildGovernedToolCatalog(),
        visionAttachment: request.visionAttachment,
        structuredOutputSchemaName: request.requireStructuredOutput
          ? 'StructuredPlanProposal'
          : undefined,
        expectStructuredJson: Boolean(request.requireStructuredOutput),
        timeoutMs: sm.remainingTimeoutMs,
        signal: abortController.signal,
      };

      let routingResultPair: {
        routing: RuntimeExecutionResult['routing'];
        response: Awaited<ReturnType<RuntimeModelRouter['executeWithRouting']>>['response'];
      };

      const tRoute = Date.now();
      try {
        routingResultPair = await runWithDeadlineAndSignal(
          () =>
            this.deps.modelRouter.executeWithRouting(
              routingCriteria,
              modelRequestPayload,
              request.requireStructuredOutput ? StructuredPlanProposalSchema : undefined
            ),
          sm.remainingTimeoutMs,
          abortController.signal,
          'OBSERVING'
        );
      } catch (routeErr) {
        // When no cloud vision model is configured and policy is not strict manual,
        // synthesize an honest PARTIAL_LOCAL metadata report via a compatible text model
        // without ever claiming multimodal vision is active.
        if (
          routeErr instanceof RuntimeExecutionError &&
          routeErr.code === 'NO_COMPATIBLE_MODEL' &&
          taskDomain === 'vision' &&
          effectiveRoutingPolicy !== 'MANUAL'
        ) {
          const fallbackTextCriteria: ModelRoutingCriteria = {
            ...routingCriteria,
            taskDomain: 'conversation',
            requiredCapabilities: ['conversation'],
            requiredModality: 'text',
          };
          const fallbackPair = await runWithDeadlineAndSignal(
            () =>
              this.deps.modelRouter.executeWithRouting(
                fallbackTextCriteria,
                modelRequestPayload
              ),
            sm.remainingTimeoutMs,
            abortController.signal,
            'OBSERVING'
          );
          const visionFallbackReason =
            'No multimodal vision model configured; synthesized honest PARTIAL_LOCAL metadata summary via compatible text model.';
          fallbackPair.routing = {
            ...fallbackPair.routing,
            fallbackUsed: true,
            fallbackCount: fallbackPair.routing.fallbackCount + 1,
            fallbackReasons: [
              visionFallbackReason,
              ...fallbackPair.routing.fallbackReasons,
            ],
            rationale: visionFallbackReason,
          };
          routingResultPair = fallbackPair;
        } else {
          throw routeErr;
        }
      }

      const { routing, response: modelResponse } = routingResultPair;

      tracer.recordTrace({
        phase: 'model_routing',
        state: 'OBSERVING',
        summary: `Routed [${routing.routingPolicy}] -> ${routing.selectedProviderId}/${routing.selectedModelId} (fallbacks=${routing.fallbackCount}).`,
        attributes: {
          providerId: routing.selectedProviderId,
          modelId: routing.selectedModelId,
          routingPolicy: routing.routingPolicy,
          fallbackCount: routing.fallbackCount,
          fallbackUsed: routing.fallbackUsed,
          latencyMs: modelResponse.latencyMs,
        },
        durationMs: Math.max(1, Date.now() - tRoute),
      });

      // =========================================================================
      // Governed Model Tool-Calling Enforcement (NEVER bypasses Permission Gate)
      // =========================================================================
      let detectedInjectionFlag = boundaryEval.injectionAttemptDetected;
      if (modelResponse.toolCallProposals && modelResponse.toolCallProposals.length > 0) {
        const governedEval = await this.toolGovernance.evaluateAndExecuteProposals({
          taskId,
          userId: actor.userId,
          conversationId,
          projectId: loadedContext.projectId,
          providerId: routing.selectedProviderId,
          modelId: routing.selectedModelId,
          userMessage: trimmedMessage,
          taskClassification,
          memorySnippets: loadedContext.relevantMemories.map((m) => m.content),
          proposals: modelResponse.toolCallProposals,
          consumeToolCallBudget: () => sm.consumeToolCallBudget(),
          signal: abortController.signal,
        });

        if (governedEval.flaggedInjectionPatterns.length > 0) {
          detectedInjectionFlag = true;
        }

        if (governedEval.executedResults.length > 0) {
          capabilityResults.push(...governedEval.executedResults);
        }

        if (governedEval.pausedForApproval) {
          const { proposal, riskLevel: toolRisk, pendingRequest } =
            governedEval.pausedForApproval;
          const mappedToolTier = mapRiskToPermissionTier(toolRisk);
          pendingApproval = pendingRequest;

          sm.transitionTo(
            'WAITING_FOR_USER_APPROVAL',
            `Model-proposed tool "${proposal.capabilityId}" (${toolRisk}) paused by PermissionSecurityManager.`
          );

          const pauseText = `Model **${routing.selectedDisplayName}** (\`${routing.selectedProviderId}/${routing.selectedModelId}\`) proposed invoking governed capability **\`${proposal.capabilityId}\`** (\`${toolRisk}\`).\n\nJARVIS-X never allows model tool calls to bypass \`PermissionSecurityManager\`. Execution is paused in **\`WAITING_FOR_USER_APPROVAL\`** pending your explicit decision.`;

          const upgradedRisk = {
            ...riskClassification,
            riskLevel: toolRisk,
            mappedPermissionTier: mappedToolTier,
            requiresApprovalPause: true,
            requiresStepUpVerification: toolRisk === 'SENSITIVE',
          };

          const { report: toolVerReport, legacySummary: toolLegacyVer } =
            this.deps.verificationLayer.verifyExecution({
              executionCompleted: false,
              responseContent: pauseText,
              permissionTier: mappedToolTier,
              riskClassification: upgradedRisk,
              approvalPaused: true,
              capabilityResults,
            });

          const pausedMeta: RuntimeTaskMetadata = {
            taskId,
            userId: actor.userId,
            conversationId,
            projectId: loadedContext.projectId,
            taskType: taskClassification.taskType,
            riskLevel: toolRisk,
            selectedCapability: proposal.capabilityId,
            selectedProviderId: routing.selectedProviderId,
            selectedModelId: routing.selectedModelId,
            routingPolicy: routing.routingPolicy,
            fallbackCount: routing.fallbackCount,
            executionState: 'WAITING_FOR_USER_APPROVAL',
            approvalState: 'pending',
            verificationStatus: toolVerReport.verificationStatus,
            errorStatus: null,
            retryCount: totalRetries,
            toolCallsCount: sm.toolCallsCount,
            startedAt: startedIso,
            completedAt: null,
            durationMs: Math.max(1, Date.now() - startMs),
          };

          await this.deps.memoryBridge.persistTaskExecution(
            actor,
            pausedMeta,
            mappedToolTier,
            `Model tool "${proposal.capabilityId}" paused at ${toolRisk} gate.`
          );

          tracer.recordActivity({
            runtimeState: 'WAITING_FOR_USER_APPROVAL',
            summary: `Blocked auto-execution of model-proposed tool "${proposal.capabilityId}" (${toolRisk}).`,
            moduleName: 'Governed Tool-Call Bridge',
            stepState: 'awaiting_permission',
            durationMs: 1,
          });

          return {
            result: {
              taskId,
              conversationId,
              finalState: 'WAITING_FOR_USER_APPROVAL',
              responseContent: pauseText,
              responseStyle,
              taskClassification,
              riskClassification: upgradedRisk,
              plan,
              capabilityResults,
              routing,
              modelTelemetry: routing.telemetry
                ? {
                    ...routing.telemetry,
                    verificationResult: toolVerReport.verificationStatus,
                  }
                : undefined,
              promptInjectionDetected: detectedInjectionFlag,
              verification: toolVerReport,
              metadata: pausedMeta,
              stateHistory: sm.transitions,
              trace: tracer.getTrace(),
              pendingApproval,
              partialResultsPreserved: capabilityResults.length > 0,
            },
            activitySteps: tracer.getActivitySteps(),
            contextSignals,
            legacyRouteDecision: {
              selectedModel: {
                id: routing.selectedModelId,
                providerId: routing.selectedProviderId,
                providerName: routing.selectedDisplayName,
                displayName: routing.selectedDisplayName,
                availability: 'ready',
                isPaidExternal: false,
                capabilities: ['chat', 'tool_calling'],
                latencyProfile: 'balanced',
                statusNote: routing.rationale,
              },
              reason: routing.rationale,
              fallbackUsed: routing.fallbackUsed,
            },
            legacyVerification: toolLegacyVer,
          };
        }
      }

      // Ensure unavailable capabilities are ALWAYS transparently noted even if a custom AIProvider omitted them
      const unavailableIds = capabilityResults
        .filter((c) => c.status === 'NOT_AVAILABLE')
        .map((c) => c.capabilityId);

      let finalContent = modelResponse.content;
      if (
        unavailableIds.length > 0 &&
        !/\b(not_available|not available|not connected|unconfigured|not implemented)\b/i.test(
          finalContent
        )
      ) {
        finalContent = `${finalContent}\n\n*Capability Status Notice:* \`${unavailableIds.join(
          ', '
        )}\` reported **\`NOT_AVAILABLE\`** — no live external execution was performed.`;
      }

      // =========================================================================
      // STATE 8: VERIFYING (Distinguishes Execution Completion vs Outcome Verified)
      // =========================================================================
      const tVer = Date.now();
      sm.transitionTo(
        'VERIFYING',
        'Evaluating verification contract and anti-fabrication checks.'
      );

      const { report: verReport, legacySummary } =
        this.deps.verificationLayer.verifyExecution({
          executionCompleted: true,
          responseContent: finalContent,
          permissionTier: riskClassification.mappedPermissionTier,
          riskClassification,
          approvalPaused: false,
          capabilityResults,
        });

      tracer.recordTrace({
        phase: 'verification',
        state: 'VERIFYING',
        summary: `${verReport.verificationStatus}: ${verReport.summary}`,
        attributes: {
          verificationStatus: verReport.verificationStatus,
          executionCompleted: verReport.executionCompleted,
        },
        durationMs: Math.max(1, Date.now() - tVer),
      });
      tracer.recordActivity({
        runtimeState: 'VERIFYING',
        summary: `${verReport.verificationStatus} — ${verReport.summary}`,
        moduleName: 'Runtime Verification Layer',
        stepState:
          verReport.verificationStatus === 'FAILED_VERIFICATION'
            ? 'failed'
            : 'completed',
        durationMs: Math.max(1, Date.now() - tVer),
      });

      if (verReport.verificationStatus === 'FAILED_VERIFICATION') {
        throw new RuntimeExecutionError({
          code: 'VERIFICATION_FAILED',
          message: verReport.summary,
          retryable: false,
          failedState: 'VERIFYING',
        });
      }

      // =========================================================================
      // STATE 9: COMPLETED -> Persist Operational Task & Audit Metadata
      // =========================================================================
      sm.transitionTo('COMPLETED', 'Runtime task completed and verified.');
      const totalDurationMs = Math.max(1, Date.now() - startMs);

      tracer.recordTrace({
        phase: 'completion',
        state: 'COMPLETED',
        summary: `Completed task ${taskId} in ${totalDurationMs}ms (${verReport.verificationStatus}).`,
        attributes: {
          durationMs: totalDurationMs,
          verificationStatus: verReport.verificationStatus,
          retries: totalRetries,
          toolCalls: sm.toolCallsCount,
        },
        durationMs: totalDurationMs,
      });
      tracer.recordActivity({
        runtimeState: 'COMPLETED',
        summary: `Completed (${totalDurationMs}ms · Verification: ${verReport.verificationStatus} · Model: ${routing.selectedDisplayName}).`,
        moduleName: 'JARVIS Core Runtime',
        durationMs: totalDurationMs,
      });

      const metadata: RuntimeTaskMetadata = {
        taskId,
        userId: actor.userId,
        conversationId,
        projectId: loadedContext.projectId,
        taskType: taskClassification.taskType,
        riskLevel: riskClassification.riskLevel,
        selectedCapability: primaryStep.requiredCapability,
        selectedSpecialist: primaryStep.specialistId,
        selectedProviderId: routing.selectedProviderId,
        selectedModelId: routing.selectedModelId,
        routingPolicy: routing.routingPolicy,
        fallbackCount: routing.fallbackCount,
        executionState: 'COMPLETED',
        approvalState: 'not_required',
        verificationStatus: verReport.verificationStatus,
        errorStatus: null,
        retryCount: totalRetries,
        toolCallsCount: sm.toolCallsCount,
        startedAt: startedIso,
        completedAt: new Date().toISOString(),
        durationMs: totalDurationMs,
      };

      const completedTelemetry = routing.telemetry
        ? {
            ...routing.telemetry,
            verificationResult: verReport.verificationStatus,
          }
        : undefined;

      await this.deps.memoryBridge.persistTaskExecution(
        actor,
        metadata,
        riskClassification.mappedPermissionTier,
        `${plan.conciseSummary} -> ${verReport.verificationStatus}`
      );

      return {
        result: {
          taskId,
          conversationId,
          finalState: 'COMPLETED',
          responseContent: finalContent,
          responseStyle,
          taskClassification,
          riskClassification,
          plan,
          capabilityResults,
          routing: completedTelemetry
            ? { ...routing, telemetry: completedTelemetry }
            : routing,
          modelTelemetry: completedTelemetry,
          promptInjectionDetected: detectedInjectionFlag,
          verification: verReport,
          metadata,
          stateHistory: sm.transitions,
          trace: tracer.getTrace(),
          partialResultsPreserved: false,
        },
        activitySteps: tracer.getActivitySteps(),
        contextSignals,
        legacyRouteDecision: {
          selectedModel: {
            id: routing.selectedModelId,
            providerId: routing.selectedProviderId,
            providerName: routing.selectedDisplayName,
            displayName: routing.selectedDisplayName,
            availability: 'ready',
            isPaidExternal: false,
            capabilities: ['chat', 'reasoning'],
            latencyProfile: 'ultra-low',
            statusNote: routing.rationale,
          },
          reason: routing.rationale,
          fallbackUsed: routing.fallbackUsed,
        },
        legacyVerification: legacySummary,
      };
    } catch (rawErr) {
      // =========================================================================
      // FAILURE & CANCELLATION RECOVERY (Structured Error + Partial Result Preservation)
      // =========================================================================
      const runtimeErr =
        rawErr instanceof RuntimeExecutionError
          ? rawErr
          : new RuntimeExecutionError({
              code: 'STEP_EXECUTION_FAILED',
              message:
                rawErr instanceof Error
                  ? rawErr.message
                  : 'Unexpected runtime execution failure.',
              retryable: false,
              failedState: sm.state,
            });

      const structuredError = runtimeErr.toStructured();
      const targetTerminalState =
        structuredError.code === 'TASK_CANCELLED' ? 'CANCELLED' : 'FAILED';

      if (!sm.isTerminal) {
        try {
          sm.transitionTo(targetTerminalState, structuredError.message);
        } catch {
          // Already terminal
        }
      }

      const partialPreserved = capabilityResults.length > 0;
      const partialNote = partialPreserved
        ? `\n\n**Preserved Partial Step Results (${capabilityResults.length}):**\n${capabilityResults
            .map((r) => `- \`${r.capabilityId}\` (${r.status}): ${r.summary}`)
            .join('\n')}`
        : '';

      const safeFailureResponse =
        targetTerminalState === 'CANCELLED'
          ? `Task **\`${taskId.slice(0, 8)}\`** was **cancelled** cleanly (\`CANCELLED\`). No further steps were executed.${partialNote}`
          : `Task **\`${taskId.slice(0, 8)}\`** halted cleanly in state **\`FAILED\`** (\`${structuredError.code}\`): ${redactSecrets(
              structuredError.message
            )}${partialNote}`;

      tracer.recordTrace({
        phase: 'error',
        state: targetTerminalState,
        summary: `[${structuredError.code}] ${structuredError.message}`,
        attributes: {
          errorCode: structuredError.code,
          retryable: structuredError.retryable,
          failedState: structuredError.failedState,
          partialResultsPreserved: partialPreserved,
        },
      });
      tracer.recordActivity({
        runtimeState: targetTerminalState,
        summary: `${structuredError.code}: ${structuredError.message}`,
        moduleName: 'Failure Recovery Guard',
        stepState: targetTerminalState === 'CANCELLED' ? 'cancelled' : 'failed',
        durationMs: Math.max(1, Date.now() - startMs),
      });

      const verificationStatus =
        structuredError.code === 'VERIFICATION_FAILED'
          ? ('FAILED_VERIFICATION' as const)
          : ('NOT_VERIFIABLE' as const);

      const metadata: RuntimeTaskMetadata = {
        taskId,
        userId: actor.userId,
        conversationId,
        projectId: request.projectId ?? null,
        taskType: taskClassification.taskType,
        riskLevel: riskClassification.riskLevel,
        selectedCapability:
          plan.steps[0]?.requiredCapability ?? 'direct_conversation',
        selectedSpecialist: plan.steps[0]?.specialistId,
        executionState: targetTerminalState,
        approvalState: 'not_required',
        verificationStatus,
        errorStatus: structuredError.code,
        retryCount: totalRetries,
        toolCallsCount: sm.toolCallsCount,
        startedAt: startedIso,
        completedAt: new Date().toISOString(),
        durationMs: Math.max(1, Date.now() - startMs),
      };

      // Only persist task metadata if the error wasn't an UNAUTHORIZED_ACCESS block
      if (structuredError.code !== 'UNAUTHORIZED_ACCESS' && isValidUuid(actor.userId)) {
        try {
          await this.deps.memoryBridge.persistTaskExecution(
            actor,
            metadata,
            riskClassification.mappedPermissionTier,
            `[${structuredError.code}] ${structuredError.message}`
          );
        } catch {
          // Never mask the primary structured runtime error if audit persistence fails
        }
      }

      return {
        result: {
          taskId,
          conversationId,
          finalState: targetTerminalState,
          responseContent: safeFailureResponse,
          responseStyle: 'concern',
          taskClassification,
          riskClassification,
          plan,
          capabilityResults,
          routing: {
            selectedProviderId: 'jarvis-foundation',
            selectedModelId: 'foundation-local-v1',
            selectedDisplayName: 'Foundation Deterministic Core v0.4',
            routingPolicy: 'AUTO_BALANCED',
            automaticMultiModelRoutingActive: false,
            fallbackUsed: false,
            fallbackCount: 0,
            fallbackReasons: [],
            rationale: 'Task halted prior to or during model synthesis.',
          },
          verification: {
            executionCompleted: false,
            verificationStatus,
            checksPassed: [],
            checksFailed: [structuredError.message],
            warnings: [],
            unavailableCapabilitiesReportedHonestly: true,
            approvalGateRespected: true,
            summary: structuredError.message,
          },
          metadata,
          stateHistory: sm.transitions,
          trace: tracer.getTrace(),
          error: structuredError,
          partialResultsPreserved: partialPreserved,
        },
        activitySteps: tracer.getActivitySteps(),
        contextSignals,
        legacyRouteDecision: {
          selectedModel: {
            id: 'foundation-local-v1',
            providerId: 'jarvis-foundation',
            providerName: 'JARVIS-X Foundation Local Engine',
            displayName: 'Foundation Deterministic Core v0.1',
            availability: 'ready',
            isPaidExternal: false,
            capabilities: ['chat', 'reasoning'],
            latencyProfile: 'ultra-low',
            statusNote: 'Active local core.',
          },
          reason: 'Task terminated via failure/cancellation recovery.',
          fallbackUsed: false,
        },
        legacyVerification: {
          outcome: 'blocked',
          checksPassed: [],
          warnings: [structuredError.message],
          noFabricatedCapabilitiesConfirmed: true,
          permissionPolicyVerified: true,
        },
      };
    } finally {
      this.activeTasks.delete(taskId);
    }
  }
}
