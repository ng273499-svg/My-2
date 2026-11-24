import type { VerificationEngine } from '@/core/modules/verification-engine';
import type {
  CapabilityExecutionResult,
  PermissionTier,
  RiskClassification,
  RuntimeVerificationReport,
  RuntimeVerificationStatus,
  VerificationSummary,
} from '@/core/types';

export interface CustomVerificationPostcondition {
  id: string;
  description: string;
  verify: (input: {
    responseContent: string;
    capabilityResults: CapabilityExecutionResult[];
    risk: RiskClassification;
  }) => { passed: boolean; failureReason?: string };
}

/**
 * Runtime Verification Layer
 * Explicitly separates `executionCompleted` (the orchestrator loop ran cleanly)
 * from `verificationStatus` (`VERIFIED` | `PARTIALLY_VERIFIED` | `FAILED_VERIFICATION` | `NOT_VERIFIABLE`).
 */
export class RuntimeVerificationLayer {
  private readonly customChecks: CustomVerificationPostcondition[] = [];

  constructor(private readonly legacyVerificationEngine: VerificationEngine) {}

  registerPostcondition(check: CustomVerificationPostcondition): void {
    this.customChecks.push(check);
  }

  verifyExecution(input: {
    executionCompleted: boolean;
    responseContent: string;
    permissionTier: PermissionTier;
    riskClassification: RiskClassification;
    approvalPaused: boolean;
    capabilityResults: CapabilityExecutionResult[];
  }): {
    report: RuntimeVerificationReport;
    legacySummary: VerificationSummary;
  } {
    const checksPassed: string[] = [];
    const checksFailed: string[] = [];
    const warnings: string[] = [];

    const legacy = this.legacyVerificationEngine.verifyTurn({
      responseContent: input.responseContent,
      permissionTier: input.permissionTier,
      permissionHalted: input.approvalPaused,
      externalLiveClaimBlocked: true,
    });

    checksPassed.push(...legacy.checksPassed);
    warnings.push(...legacy.warnings);

    if (!input.responseContent.trim()) {
      checksFailed.push('Final response content is empty.');
    }

    if (!legacy.noFabricatedCapabilitiesConfirmed) {
      checksFailed.push(
        'Response contained an unverified external action or capability fabrication claim.'
      );
    }

    // Verify that any NOT_AVAILABLE capability was honestly disclosed in the response or step summary
    const unavailableCaps = input.capabilityResults.filter(
      (r) => r.status === 'NOT_AVAILABLE'
    );
    const partialCaps = input.capabilityResults.filter(
      (r) => r.status === 'PARTIAL_LOCAL'
    );

    let unavailableHonest = true;
    if (unavailableCaps.length > 0) {
      const mentionsLimitation =
        /\b(not_available|not available|not connected|unconfigured|not implemented|standing by)\b/i.test(
          input.responseContent
        );
      if (mentionsLimitation) {
        checksPassed.push(
          `Unavailable capability (${unavailableCaps.map((c) => c.capabilityId).join(', ')}) reported honestly`
        );
      } else {
        unavailableHonest = false;
        checksFailed.push(
          `Capability (${unavailableCaps.map((c) => c.capabilityId).join(', ')}) returned NOT_AVAILABLE without transparent disclosure in final response.`
        );
      }
    }

    // Evaluate any registered custom postconditions
    for (const check of this.customChecks) {
      const outcome = check.verify({
        responseContent: input.responseContent,
        capabilityResults: input.capabilityResults,
        risk: input.riskClassification,
      });
      if (outcome.passed) {
        checksPassed.push(check.description);
      } else {
        checksFailed.push(outcome.failureReason ?? `Failed postcondition: ${check.id}`);
      }
    }

    // Determine exact `RuntimeVerificationStatus` distinct from `executionCompleted`
    let verificationStatus: RuntimeVerificationStatus;
    let summary: string;

    if (checksFailed.length > 0) {
      verificationStatus = 'FAILED_VERIFICATION';
      summary = `Verification failed: ${checksFailed.join('; ')}`;
    } else if (input.approvalPaused || input.riskClassification.blockedOffensiveRequest) {
      verificationStatus = 'NOT_VERIFIABLE';
      summary = input.approvalPaused
        ? 'Execution paused awaiting operator approval; target action outcome not yet verifiable.'
        : 'Request blocked by defensive security boundary; no target outcome executed.';
    } else if (unavailableCaps.length > 0) {
      verificationStatus = 'NOT_VERIFIABLE';
      summary = `Runtime completed cleanly, but requested capability (${unavailableCaps
        .map((c) => c.capabilityId)
        .join(', ')}) is NOT_AVAILABLE — desired external outcome cannot be verified.`;
    } else if (partialCaps.length > 0 || warnings.length > 0) {
      verificationStatus = 'PARTIALLY_VERIFIED';
      summary =
        'Local guidance verified; external runtime/provider components remain unconfigured.';
    } else {
      verificationStatus = 'VERIFIED';
      summary = 'Execution completed and desired response outcome verified.';
    }

    const mappedLegacyOutcome: VerificationSummary['outcome'] =
      verificationStatus === 'FAILED_VERIFICATION'
        ? 'blocked'
        : input.approvalPaused
          ? 'pending'
          : warnings.length > 0
            ? 'caution'
            : 'verified';

    return {
      report: {
        executionCompleted: input.executionCompleted,
        verificationStatus,
        checksPassed,
        checksFailed,
        warnings,
        unavailableCapabilitiesReportedHonestly: unavailableHonest,
        approvalGateRespected:
          !input.riskClassification.requiresApprovalPause || input.approvalPaused,
        summary,
      },
      legacySummary: {
        ...legacy,
        outcome: mappedLegacyOutcome,
      },
    };
  }
}
