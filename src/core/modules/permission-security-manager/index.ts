import { generateUuid, normalizeConversationId } from '@/core/utils/uuid';
import type {
  PermissionRecord,
  PermissionRequest,
  PermissionTier,
  SecurityEvaluation,
} from '@/core/types';
import type { DataRepository } from '@/server/repositories/types';

export interface EvaluatePermissionInput {
  userId: string;
  conversationId: string;
  actionCode: string;
  actionTitle: string;
  targetResource: string;
  tier: PermissionTier;
  summary: string;
  pendingPayload: Record<string, unknown>;
}

/**
 * Permission & Security Manager
 * Enforces the 3-tier JARVIS-X governance model with per-operator isolation:
 * 1. SAFE_READ: Auto-approved and logged.
 * 2. CONFIRMATION_REQUIRED: Halts execution until explicit user approval.
 * 3. SENSITIVE_AUTH_REQUIRED: Never silently executed; requires explicit step-up
 *    verification phrase in addition to operator approval.
 */
export class PermissionSecurityManager {
  constructor(
    private readonly repository: DataRepository,
    private readonly sharedPendingStore: Map<string, PermissionRequest> = new Map()
  ) {}

  private key(userId: string, requestId: string): string {
    return `${userId}:${requestId}`;
  }

  async evaluate(input: EvaluatePermissionInput): Promise<SecurityEvaluation> {
    const id = generateUuid();
    const convId = normalizeConversationId(input.conversationId);
    const now = new Date().toISOString();

    if (input.tier === 'SAFE_READ') {
      const auditRecord: PermissionRecord = {
        id,
        conversationId: convId,
        actionCode: input.actionCode,
        targetResource: input.targetResource,
        tier: input.tier,
        decision: 'auto_allowed',
        rationale: 'Read-only operation within safe diagnostic/conversational policy.',
        createdAt: now,
        resolvedAt: now,
      };
      await this.repository.recordPermission(input.userId, auditRecord);
      return {
        allowedImmediately: true,
        tier: input.tier,
        decision: 'auto_allowed',
        auditRecord,
      };
    }

    const requiresStepUpAuth = input.tier === 'SENSITIVE_AUTH_REQUIRED';
    const impactDescription = requiresStepUpAuth
      ? 'Tier-3 Sensitive Operation: Requires explicit step-up verification token before JARVIS-X will dispatch or touch external/destructive interfaces.'
      : 'Tier-2 Confirmation Gate: Requires explicit operator approval before mutating memory, preferences, or scheduled tasks.';

    const pendingRequest: PermissionRequest = {
      id,
      conversationId: convId,
      actionCode: input.actionCode,
      actionTitle: input.actionTitle,
      targetResource: input.targetResource,
      tier: input.tier,
      summary: input.summary,
      impactDescription,
      requiresStepUpAuth,
      pendingPayload: input.pendingPayload,
      createdAt: now,
    };

    this.sharedPendingStore.set(this.key(input.userId, id), pendingRequest);

    const auditRecord: PermissionRecord = {
      id,
      conversationId: convId,
      actionCode: input.actionCode,
      targetResource: input.targetResource,
      tier: input.tier,
      decision: 'pending',
      rationale: impactDescription,
      createdAt: now,
    };

    await this.repository.recordPermission(input.userId, auditRecord);

    return {
      allowedImmediately: false,
      tier: input.tier,
      decision: 'pending',
      pendingRequest,
      auditRecord,
    };
  }

  getPendingRequest(userId: string, requestId: string): PermissionRequest | undefined {
    return this.sharedPendingStore.get(this.key(userId, requestId));
  }

  verifyStepUpToken(providedPasscode?: string): boolean {
    const expected = (process.env.JARVIS_STEP_UP_PASSCODE || 'JARVIS-VERIFY').trim();
    if (!providedPasscode) return false;
    return providedPasscode.trim() === expected;
  }

  async resolveRequest(
    userId: string,
    requestId: string,
    approve: boolean,
    stepUpPasscode?: string
  ): Promise<{
    resolved: boolean;
    decision: PermissionRecord['decision'];
    request?: PermissionRequest;
    errorReason?: string;
  }> {
    const mapKey = this.key(userId, requestId);
    const request = this.sharedPendingStore.get(mapKey);
    if (!request) {
      return {
        resolved: false,
        decision: 'denied',
        errorReason: 'Permission request not found for this operator or already resolved.',
      };
    }

    if (!approve) {
      this.sharedPendingStore.delete(mapKey);
      await this.repository.updatePermissionDecision(userId, requestId, 'denied');
      return {
        resolved: true,
        decision: 'denied',
        request,
      };
    }

    if (request.requiresStepUpAuth && !this.verifyStepUpToken(stepUpPasscode)) {
      await this.repository.updatePermissionDecision(
        userId,
        requestId,
        'blocked_unauthenticated'
      );
      return {
        resolved: false,
        decision: 'blocked_unauthenticated',
        request,
        errorReason:
          'Step-up authorization failed. Sensitive Tier-3 operations require explicit verification code (default verification phrase: JARVIS-VERIFY).',
      };
    }

    this.sharedPendingStore.delete(mapKey);
    const authMethod = request.requiresStepUpAuth
      ? 'step_up_passcode_verified'
      : 'operator_explicit_confirmation';

    await this.repository.updatePermissionDecision(
      userId,
      requestId,
      'approved',
      authMethod
    );

    return {
      resolved: true,
      decision: 'approved',
      request,
    };
  }
}
