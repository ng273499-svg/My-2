/**
 * JARVIS-X v1.2.0 — Grounded Answering
 *
 * Distinguishes SUPPORTED / PARTIALLY_SUPPORTED / NOT_SUPPORTED /
 * CONFLICTING_EVIDENCE. When the authorized documents do not support an
 * answer, JARVIS-X says so and never invents missing document facts.
 *
 * The default answerer is an extractive, deterministic grounder: every
 * sentence it emits is taken from retrieved evidence, so grounding is
 * verifiable by construction. A model-drafted answer can also be verified and
 * repaired through `verifyDraft`.
 */

import type {
  AssembledContext,
  Citation,
  ClaimVerificationResult,
  DetectedConflict,
  DocumentChunk,
  GroundedAnswer,
  GroundingStatus,
  RetrievalResult,
  ScoredChunk,
} from './types';
import { ContextAssembler, DEFAULT_CONTEXT_BUDGET_TOKENS } from './context-assembly';
import { ClaimVerifier, ConflictDetector } from './verification';
import { buildCitations, renderCitationsBlock, renderInlineCitation } from './citations';
import { improveSentenceSelection } from './sentence-selection';

const INSUFFICIENT_EVIDENCE_MESSAGE =
  'The authorized documents do not contain enough evidence to answer that question. ' +
  'JARVIS-X will not infer facts that are not present in the retrieved passages.';

export interface GroundingOptions {
  budgetTokens?: number;
  maxChunks?: number;
  titlesByDocumentId?: Map<string, string>;
}

export class GroundedAnswerer {
  private readonly assembler = new ContextAssembler();
  private readonly claimVerifier = new ClaimVerifier();
  private readonly conflictDetector = new ConflictDetector();

  /**
   * Produce a grounded answer from retrieval results.
   * The draft is extractive: selected sentences come from evidence verbatim.
   */
  answer(
    query: string,
    retrieval: RetrievalResult,
    options: GroundingOptions = {}
  ): { answer: GroundedAnswer; context: AssembledContext } {
    const titles = options.titlesByDocumentId ?? new Map<string, string>();
    const context = this.assembler.assemble(retrieval.selected, {
      budgetTokens: options.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      maxChunks: options.maxChunks ?? 12,
      titlesByDocumentId: titles,
    });

    const warnings: string[] = [...retrieval.diagnostics];

    // ---- No evidence at all -------------------------------------------
    if (context.usedChunks.length === 0) {
      return {
        answer: {
          answer: INSUFFICIENT_EVIDENCE_MESSAGE,
          status: 'NOT_SUPPORTED',
          citations: [],
          verification: {
            claims: [],
            unsupportedClaims: [],
            supportedCount: 0,
            totalClaims: 0,
            status: 'NOT_SUPPORTED',
            summary: 'No authorized evidence was retrieved.',
          },
          conflicts: [],
          warnings,
          usedDocumentIds: [],
          insufficientEvidence: true,
        },
        context,
      };
    }

    // ---- Detect conflicts BEFORE drafting so they are surfaced --------
    const conflicts = this.conflictDetector.detect(
      context.usedChunks,
      titles,
      context.citations
    );

    // ---- Build an extractive draft ------------------------------------
    const draft = improveSentenceSelection(query, retrieval.selected, context.usedChunks);

    // ---- Verify claims against evidence --------------------------------
    const verification = this.claimVerifier.verify(draft, context.usedChunks, context.citations);

    // ---- Repair: drop unsupported sentences ---------------------------
    let finalBody = this.claimVerifier.repair(draft, verification);
    const repairedVerification = this.claimVerifier.verify(
      finalBody,
      context.usedChunks,
      context.citations
    );

    let status: GroundingStatus = repairedVerification.status;

    if (conflicts.length > 0) {
      status = 'CONFLICTING_EVIDENCE';
    }

    const insufficientEvidence =
      repairedVerification.totalClaims === 0 || repairedVerification.supportedCount === 0;

    if (insufficientEvidence) {
      return {
        answer: {
          answer: INSUFFICIENT_EVIDENCE_MESSAGE,
          status: 'NOT_SUPPORTED',
          citations: context.citations,
          verification: repairedVerification,
          conflicts,
          warnings,
          usedDocumentIds: [...new Set(context.usedChunks.map((c) => c.documentId))],
          insufficientEvidence: true,
        },
        context,
      };
    }

    // ---- Attach citations ---------------------------------------------
    finalBody = this.assembler.attachInlineMarkers(
      finalBody,
      context.citations,
      context.usedChunks
    );

    if (conflicts.length > 0) {
      finalBody += `\n\n**Conflicting evidence detected**\n${conflicts
        .map((c) => `- ${c.explanation} ${c.freshnessNote}`)
        .join('\n')}`;
    }

    if (repairedVerification.unsupportedClaims.length > 0) {
      warnings.push(
        `${repairedVerification.unsupportedClaims.length} unsupported sentence(s) were removed from the draft.`
      );
    }
    if (context.truncated) {
      warnings.push(
        `Context budget (${context.budgetTokens} tokens) reached; evidence was limited to ${context.usedChunks.length} passage(s).`
      );
    }

    const finalAnswer = `${finalBody}${renderCitationsBlock(context.citations)}`;

    return {
      answer: {
        answer: finalAnswer,
        status,
        citations: context.citations,
        verification: repairedVerification,
        conflicts,
        warnings,
        usedDocumentIds: [...new Set(context.usedChunks.map((c) => c.documentId))],
        insufficientEvidence: false,
      },
      context,
    };
  }

  /**
   * Verify and repair an externally drafted answer (e.g. produced by a
   * configured model). Unsupported sentences are removed, never rewritten.
   */
  verifyDraft(
    draft: string,
    usedChunks: DocumentChunk[],
    citations: Citation[],
    titles: Map<string, string>
  ): { answer: GroundedAnswer } {
    const verification = this.claimVerifier.verify(draft, usedChunks, citations);
    const repairedBody = this.claimVerifier.repair(draft, verification);
    const reVerified = this.claimVerifier.verify(repairedBody, usedChunks, citations);
    const conflicts = this.conflictDetector.detect(usedChunks, titles, citations);

    const insufficientEvidence =
      reVerified.totalClaims === 0 || reVerified.supportedCount === 0;

    if (insufficientEvidence) {
      return {
        answer: {
          answer: INSUFFICIENT_EVIDENCE_MESSAGE,
          status: 'NOT_SUPPORTED',
          citations,
          verification: reVerified,
          conflicts,
          warnings: [],
          usedDocumentIds: [...new Set(usedChunks.map((c) => c.documentId))],
          insufficientEvidence: true,
        },
      };
    }

    const status: GroundingStatus =
      conflicts.length > 0 ? 'CONFLICTING_EVIDENCE' : reVerified.status;

    const withMarkers = this.assembler.attachInlineMarkers(repairedBody, citations, usedChunks);

    return {
      answer: {
        answer: `${withMarkers}${renderCitationsBlock(citations)}`,
        status,
        citations,
        verification: reVerified,
        conflicts,
        warnings:
          reVerified.unsupportedClaims.length > 0
            ? [`${reVerified.unsupportedClaims.length} unsupported sentence(s) removed.`]
            : [],
        usedDocumentIds: [...new Set(usedChunks.map((c) => c.documentId))],
        insufficientEvidence: false,
      },
    };
  }
}

/** Convenience helper for a single inline citation string. */
export function firstCitationLabel(citations: Citation[]): string | null {
  return citations.length > 0 ? renderInlineCitation(citations[0]) : null;
}

/** Re-export for downstream consumers. */
export { INSUFFICIENT_EVIDENCE_MESSAGE };
export type { ClaimVerificationResult, DetectedConflict, ScoredChunk };
