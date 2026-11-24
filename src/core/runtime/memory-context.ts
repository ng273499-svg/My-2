import type { MemoryManager } from '@/core/modules/memory-manager';
import { HIERARCHICAL_SCOPE_DESCRIPTORS } from '@/core/memory';
import { isValidUuid, normalizeConversationId } from '@/core/utils/uuid';
import type {
  AuthSessionStatus,
  DurableMemoryCandidate,
  LoadedRuntimeContext,
  MemoryScopeDescriptor,
  RuntimeTaskMetadata,
} from '@/core/types';
import type { DataRepository } from '@/server/repositories/types';
import { RuntimeExecutionError, redactSecrets } from './errors';

export const PREPARED_MEMORY_SCOPES: MemoryScopeDescriptor[] =
  HIERARCHICAL_SCOPE_DESCRIPTORS;

/**
 * Runtime Memory & Context Integration Bridge (v0.5 Hierarchical Memory Engine)
 * - Validates actor identity & project ownership BEFORE loading user/project data.
 * - Executes hybrid scoped retrieval across all 7 hierarchical memory scopes within a
 *   strict token budget while quarantining `untrusted_external` knowledge chunks.
 * - Persists operational task & audit metadata after execution WITHOUT indiscriminately
 *   saving routine conversational messages into permanent long-term memory.
 */
export class RuntimeMemoryBridge {
  constructor(
    private readonly repository: DataRepository,
    private readonly memoryManager: MemoryManager
  ) {}

  assertAuthorizedActor(actor: AuthSessionStatus, requestedUserId?: string): void {
    if (!actor.userId || !isValidUuid(actor.userId)) {
      throw new RuntimeExecutionError({
        code: 'UNAUTHORIZED_ACCESS',
        message: 'Invalid or missing operator user identity.',
        retryable: false,
        failedState: 'CONTEXT_LOADING',
      });
    }

    if (requestedUserId && requestedUserId.toLowerCase() !== actor.userId.toLowerCase()) {
      throw new RuntimeExecutionError({
        code: 'UNAUTHORIZED_ACCESS',
        message: 'Cross-user data access denied: actor userId does not match target userId.',
        retryable: false,
        failedState: 'CONTEXT_LOADING',
      });
    }
  }

  async loadPermittedContext(input: {
    actor: AuthSessionStatus;
    conversationId?: string;
    projectId?: string | null;
    query: string;
    taskType?: string;
    maxMemoryTokenBudget?: number;
  }): Promise<LoadedRuntimeContext> {
    this.assertAuthorizedActor(input.actor);

    const userId = input.actor.userId;
    const conversationId = normalizeConversationId(input.conversationId);

    // Verify project ownership cleanly via user-scoped repository (RLS + partition isolation)
    let verifiedProjectId: string | null = null;
    if (input.projectId) {
      const userProjects = await this.repository.listProjects(userId);
      const owned = userProjects.find((p) => p.id === input.projectId);
      if (!owned) {
        throw new RuntimeExecutionError({
          code: 'UNAUTHORIZED_ACCESS',
          message: `Unauthorized project reference "${input.projectId}" for current operator.`,
          retryable: false,
          failedState: 'CONTEXT_LOADING',
        });
      }
      verifiedProjectId = owned.id;
    }

    const [preferences, history] = await Promise.all([
      this.repository.getPreferences(userId),
      this.repository.getMessages(userId, conversationId),
    ]);

    const retrievalBundle = await this.memoryManager.retrieveHierarchicalBundle(
      userId,
      {
        query: input.query,
        projectId: verifiedProjectId,
        taskType: input.taskType,
        maxItems: 6,
        maxTokenBudget: input.maxMemoryTokenBudget ?? 1_200,
      },
      history
    );

    return {
      userId,
      authenticated: input.actor.authenticated,
      conversationId,
      projectId: verifiedProjectId,
      workingMessages: retrievalBundle.workingTurns,
      relevantMemories: retrievalBundle.entries,
      untrustedMemorySources: retrievalBundle.untrustedMemorySources,
      memoryRetrievalSummary: {
        totalTokensEstimated: retrievalBundle.totalTokensEstimated,
        untrustedItemsQuarantined: retrievalBundle.untrustedItemsQuarantined,
        expiredFilteredOut: retrievalBundle.expiredFilteredOut,
        supersededFilteredOut: retrievalBundle.supersededFilteredOut,
      },
      preferredStyle: preferences.preferredResponseStyle,
      preferredProviderId: preferences.preferredModelProvider,
      routingPolicy: preferences.routingPolicy ?? 'AUTO_BALANCED',
      manualModelId: preferences.manualModelId ?? null,
      voiceProfileId: preferences.voiceProfileId,
      witLevel: preferences.witLevel,
      conciseness: preferences.conciseness,
      proactiveEnabled: preferences.proactiveAssistanceEnabled,
      memoryScopesAvailable: PREPARED_MEMORY_SCOPES,
    };
  }

  /**
   * Evaluates whether a turn contains durable information worth storing permanently.
   * Never indiscriminately stores routine messages — durable writes require explicit
   * operator intent + confirmation gate approval.
   */
  evaluateDurableMemoryCandidate(
    intent: string,
    extractedFact?: string
  ): DurableMemoryCandidate {
    if (intent === 'memory_write' && extractedFact && extractedFact.trim().length >= 3) {
      const cleaned = redactSecrets(extractedFact.trim());
      const category = /\b(prefer|preferred|style|tone)\b/i.test(cleaned)
        ? 'preference'
        : /\b(workflow|runbook|pipeline|always run)\b/i.test(cleaned)
          ? 'workflow'
          : 'fact';

      return {
        shouldPersist: true,
        category,
        content: cleaned,
        reason: 'Explicit operator memory storage directive (gated by CONFIRMATION_REQUIRED).',
      };
    }

    return {
      shouldPersist: false,
      reason:
        'Routine conversational turn — kept in conversation working history only; not promoted to permanent long-term memory.',
    };
  }

  async persistTaskExecution(
    actor: AuthSessionStatus,
    metadata: RuntimeTaskMetadata,
    permissionTier: string,
    statusSummary: string
  ): Promise<void> {
    this.assertAuthorizedActor(actor, metadata.userId);
    const safeSummary = redactSecrets(statusSummary).slice(0, 280);

    await this.repository.recordAgentTask(actor.userId, {
      id: metadata.taskId,
      conversationId: metadata.conversationId,
      projectId: metadata.projectId,
      specialistAgent: metadata.selectedSpecialist ?? 'direct_core',
      objective: safeSummary,
      lifecycleStage: metadata.executionState,
      permissionTier,
      statusSummary: safeSummary,
      taskType: metadata.taskType,
      riskLevel: metadata.riskLevel,
      selectedCapability: metadata.selectedCapability,
      executionState: metadata.executionState,
      approvalState: metadata.approvalState,
      verificationStatus: metadata.verificationStatus,
      errorStatus: metadata.errorStatus,
      startedAt: metadata.startedAt,
      completedAt: metadata.completedAt,
      resultPayload: {
        retryCount: metadata.retryCount,
        toolCallsCount: metadata.toolCallsCount,
        durationMs: metadata.durationMs,
        selectedProviderId: metadata.selectedProviderId ?? null,
        selectedModelId: metadata.selectedModelId ?? null,
        routingPolicy: metadata.routingPolicy ?? 'AUTO_BALANCED',
        fallbackCount: metadata.fallbackCount ?? 0,
      },
    });

    await this.repository.appendAuditLog(actor.userId, {
      eventType: `runtime.task.${metadata.executionState.toLowerCase()}`,
      entityType: 'agent_task',
      entityId: metadata.taskId,
      severity:
        metadata.executionState === 'FAILED'
          ? 'warning'
          : metadata.approvalState === 'pending' && metadata.riskLevel === 'SENSITIVE'
            ? 'warning'
            : 'info',
      summary: `[${metadata.taskType}/${metadata.riskLevel}] ${safeSummary}`,
      metadata: {
        taskId: metadata.taskId,
        taskType: metadata.taskType,
        riskLevel: metadata.riskLevel,
        selectedCapability: metadata.selectedCapability,
        selectedProviderId: metadata.selectedProviderId ?? null,
        selectedModelId: metadata.selectedModelId ?? null,
        routingPolicy: metadata.routingPolicy ?? 'AUTO_BALANCED',
        fallbackCount: metadata.fallbackCount ?? 0,
        executionState: metadata.executionState,
        approvalState: metadata.approvalState,
        verificationStatus: metadata.verificationStatus,
        errorStatus: metadata.errorStatus,
        durationMs: metadata.durationMs,
      },
    });
  }
}
