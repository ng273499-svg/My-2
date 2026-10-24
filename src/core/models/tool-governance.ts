import type { PermissionSecurityManager } from '@/core/modules/permission-security-manager';
import type { CapabilityRegistry } from '@/core/runtime/capability-registry';
import { mapRiskToPermissionTier } from '@/core/runtime/classifiers';
import type {
  CapabilityExecutionResult,
  ModelToolCallProposal,
  ModelToolDefinition,
  PermissionRequest,
  RiskLevel,
  TaskClassification,
  TaskPlanStep,
} from '@/core/types';
import { PromptInjectionBoundary } from './prompt-boundary';
import {
  GovernedToolCallProposalSchema,
  StructuredOutputValidator,
} from './structured-output';

export interface GovernedToolEvaluationInput {
  taskId: string;
  userId: string;
  conversationId: string;
  projectId: string | null;
  providerId: string;
  modelId: string;
  userMessage: string;
  taskClassification: TaskClassification;
  memorySnippets: string[];
  proposals: ModelToolCallProposal[];
  consumeToolCallBudget: () => void;
  signal?: AbortSignal;
}

export interface GovernedToolEvaluationResult {
  executedResults: CapabilityExecutionResult[];
  rejectedProposals: string[];
  pausedForApproval?: {
    proposal: ModelToolCallProposal;
    riskLevel: RiskLevel;
    pendingRequest: PermissionRequest;
  };
  flaggedInjectionPatterns: string[];
}

/**
 * Provider-neutral Tool Governance Bridge.
 * Guarantees that model-emitted tool call proposals NEVER execute directly and
 * NEVER bypass `CapabilityRegistry`, `RiskClassifier` risk tiers, `PermissionSecurityManager`,
 * tool-call budgets, or `PromptInjectionBoundary` output sanitization.
 */
export class GovernedToolCallBridge {
  private readonly validator = new StructuredOutputValidator();
  private readonly boundary = new PromptInjectionBoundary();

  constructor(
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly permissionManager: PermissionSecurityManager
  ) {}

  /**
   * Projects registered `CapabilityRegistry` definitions into provider-neutral
   * `ModelToolDefinition[]` descriptors so adapters can advertise governed tools.
   */
  buildGovernedToolCatalog(): ModelToolDefinition[] {
    return this.capabilityRegistry.listDefinitions().map((def) => ({
      name: def.id,
      capabilityId: def.id,
      description: `${def.name} [availability=${def.availability}, risk=${def.defaultRiskLevel}]: ${def.description}`,
      parametersJsonSchema: {
        type: 'object',
        properties: {
          objective: {
            type: 'string',
            description: 'Concise action or query for the capability.',
          },
          target: {
            type: 'string',
            description: 'Optional target resource identifier.',
          },
        },
        required: ['objective'],
      },
    }));
  }

  async evaluateAndExecuteProposals(
    input: GovernedToolEvaluationInput
  ): Promise<GovernedToolEvaluationResult> {
    const executedResults: CapabilityExecutionResult[] = [];
    const rejectedProposals: string[] = [];
    const flaggedInjectionPatterns: string[] = [];

    for (const rawProposal of input.proposals) {
      // 1. Validate schema integrity of model-emitted tool proposal
      let proposal: ModelToolCallProposal;
      try {
        proposal = this.validator.validateData(
          rawProposal,
          GovernedToolCallProposalSchema,
          {
            providerId: input.providerId,
            modelId: input.modelId,
            schemaName: 'GovernedToolCallProposal',
          }
        );
      } catch (err) {
        rejectedProposals.push(
          `Rejected malformed tool call proposal: ${
            err instanceof Error ? err.message : 'invalid schema'
          }`
        );
        continue;
      }

      // 2. Enforce CapabilityRegistry registration (reject unknown / hallucinated tools)
      const targetCapId = proposal.capabilityId || proposal.toolName;
      if (!this.capabilityRegistry.has(targetCapId)) {
        rejectedProposals.push(
          `Rejected unregistered capability "${targetCapId}" proposed by ${input.providerId}/${input.modelId}.`
        );
        continue;
      }

      const capDef = this.capabilityRegistry.getDefinition(targetCapId);
      const riskLevel = capDef.defaultRiskLevel;
      const mappedTier = mapRiskToPermissionTier(riskLevel);

      // 3. Enforce Risk & Permission Gate — NEVER auto-execute CONFIRMATION_REQUIRED or SENSITIVE
      if (riskLevel === 'CONFIRMATION_REQUIRED' || riskLevel === 'SENSITIVE') {
        const objectiveArg =
          typeof proposal.arguments.objective === 'string'
            ? proposal.arguments.objective
            : input.userMessage;
        const targetArg =
          typeof proposal.arguments.target === 'string'
            ? proposal.arguments.target
            : targetCapId;

        const secEval = await this.permissionManager.evaluate({
          userId: input.userId,
          conversationId: input.conversationId,
          actionCode: `model_tool.${targetCapId}`,
          actionTitle:
            riskLevel === 'SENSITIVE'
              ? `Authorize Model-Proposed Sensitive Tool (${capDef.name})`
              : `Confirm Model-Proposed Tool (${capDef.name})`,
          targetResource: targetArg,
          tier: mappedTier,
          summary: `Model ${input.providerId}/${input.modelId} proposed tool "${targetCapId}": ${objectiveArg.slice(0, 160)}`,
          pendingPayload: {
            taskId: input.taskId,
            selectedCapability: targetCapId,
            proposedByModel: input.modelId,
            arguments: proposal.arguments,
          },
        });

        if (!secEval.allowedImmediately && secEval.pendingRequest) {
          return {
            executedResults,
            rejectedProposals,
            flaggedInjectionPatterns,
            pausedForApproval: {
              proposal: { ...proposal, capabilityId: targetCapId },
              riskLevel,
              pendingRequest: secEval.pendingRequest,
            },
          };
        }
      } else {
        await this.permissionManager.evaluate({
          userId: input.userId,
          conversationId: input.conversationId,
          actionCode: `model_tool.${targetCapId}`,
          actionTitle: `Safe Model Tool (${capDef.name})`,
          targetResource: targetCapId,
          tier: 'SAFE_READ',
          summary: `Executed safe read/low-risk model tool "${targetCapId}".`,
          pendingPayload: {
            taskId: input.taskId,
            proposedByModel: input.modelId,
          },
        });
      }

      // 4. Enforce runtime tool-call budget before invoking capability
      if (capDef.countsAsToolCall) {
        input.consumeToolCallBudget();
      }

      const syntheticStep: TaskPlanStep = {
        stepId: `tool-${proposal.callId}`,
        order: executedResults.length + 1,
        objective:
          typeof proposal.arguments.objective === 'string'
            ? proposal.arguments.objective
            : input.userMessage,
        requiredCapability: targetCapId,
        dependencies: [],
        riskLevel,
        status: 'in_progress',
        expectedResult: `Governed tool execution for ${targetCapId}`,
        attempts: 1,
      };

      const rawResult = await this.capabilityRegistry.invoke(targetCapId, {
        taskId: input.taskId,
        userId: input.userId,
        conversationId: input.conversationId,
        projectId: input.projectId,
        step: syntheticStep,
        userMessage: syntheticStep.objective,
        taskClassification: input.taskClassification,
        memorySnippets: input.memorySnippets,
        signal: input.signal,
      });

      // 5. Quarantine/sanitize untrusted external tool outputs
      const sanitized = this.boundary.sanitizeToolObservation(
        targetCapId,
        rawResult.summary
      );
      if (sanitized.flaggedPatterns.length > 0) {
        flaggedInjectionPatterns.push(...sanitized.flaggedPatterns);
      }

      executedResults.push({
        ...rawResult,
        summary: sanitized.sanitizedSummary,
      });
    }

    return {
      executedResults,
      rejectedProposals,
      flaggedInjectionPatterns,
    };
  }
}
