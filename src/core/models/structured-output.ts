import { z } from 'zod';
import { ProviderAdapterError } from './errors';

/**
 * =============================================================================
 * STRUCTURED OUTPUT VALIDATION SCHEMAS & PARSER
 * Ensures model-generated structured outputs are strictly validated before
 * reaching Planner, Capability Selection, Tool Execution, or Verification.
 * =============================================================================
 */

export const StructuredPlanProposalSchema = z.object({
  conciseSummary: z.string().min(1).max(500),
  steps: z
    .array(
      z.object({
        objective: z.string().min(1).max(300),
        requiredCapability: z.string().min(1).max(80),
        expectedResult: z.string().min(1).max(300),
      })
    )
    .min(1)
    .max(6),
});

export const CapabilitySelectionProposalSchema = z.object({
  selectedCapability: z.string().min(1).max(80),
  rationale: z.string().min(1).max(400),
  confidence: z.number().min(0).max(1),
});

export const GovernedToolCallProposalSchema = z.object({
  callId: z.string().min(1).max(120),
  toolName: z.string().min(1).max(80),
  capabilityId: z.string().min(1).max(80),
  arguments: z.record(z.unknown()),
  reason: z.string().max(300).optional(),
});

export const VerificationAssistSchema = z.object({
  addressesObjective: z.boolean(),
  containsUnverifiedClaims: z.boolean(),
  notes: z.array(z.string().max(240)).max(8),
});

export type StructuredPlanProposal = z.infer<typeof StructuredPlanProposalSchema>;
export type CapabilitySelectionProposal = z.infer<typeof CapabilitySelectionProposalSchema>;
export type GovernedToolCallProposalValidated = z.infer<typeof GovernedToolCallProposalSchema>;
export type VerificationAssistPayload = z.infer<typeof VerificationAssistSchema>;

/**
 * Extracts JSON safely from raw model output (either pure JSON or ```json fenced block)
 * without using unsafe eval or heuristic coercion.
 */
export function extractJsonCandidate(rawContent: string): unknown {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    throw new Error('Model returned empty structured output.');
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;

  return JSON.parse(candidate);
}

export class StructuredOutputValidator {
  validateJsonText<T>(
    rawText: string,
    schema: z.ZodType<T>,
    meta: { providerId: string; modelId: string; schemaName: string }
  ): T {
    let parsedJson: unknown;
    try {
      parsedJson = extractJsonCandidate(rawText);
    } catch (err) {
      throw new ProviderAdapterError({
        providerId: meta.providerId,
        modelId: meta.modelId,
        failureKind: 'MALFORMED_STRUCTURED_OUTPUT',
        message: `Malformed JSON for schema "${meta.schemaName}": ${
          err instanceof Error ? err.message : 'parse error'
        }`,
        retryable: true,
      });
    }

    return this.validateData(parsedJson, schema, meta);
  }

  validateData<T>(
    data: unknown,
    schema: z.ZodType<T>,
    meta: { providerId: string; modelId: string; schemaName: string }
  ): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      const issueSummary = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new ProviderAdapterError({
        providerId: meta.providerId,
        modelId: meta.modelId,
        failureKind: 'MALFORMED_STRUCTURED_OUTPUT',
        message: `Structured output failed "${meta.schemaName}" validation (${issueSummary}).`,
        retryable: true,
      });
    }
    return result.data;
  }
}
