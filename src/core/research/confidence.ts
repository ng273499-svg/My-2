/**
 * JARVIS-X v1.3.0 — Transparent confidence.
 *
 * Confidence is a *report-level* statement about how much the retrieved
 * evidence supports the answer. It is always four things at once:
 * a level, a score, the components that produced the score, and notes saying
 * why. It never implies certainty, and it can never be HIGH without genuine
 * source independence.
 *
 * HIGH        — multiple independent groups agree, citations verified,
 *               contradictions are absent or fully explained.
 * MEDIUM      — corroborated but thin, or partially explained conflict.
 * LOW         — single-source, stale, or contested.
 * INSUFFICIENT— nothing verifiable was retrieved.
 */

import type {
  ClaimNode,
  ConfidenceAssessment,
  ConfidenceLevel,
  Contradiction,
  WebSource,
} from './types';
import type { FreshnessSummary } from './freshness';

export interface ConfidenceInput {
  nodes: ClaimNode[];
  sources: WebSource[];
  contradictions: Contradiction[];
  /** 0..1 — fraction of planned sub-questions that received evidence. */
  coverage: number;
  freshness: FreshnessSummary;
  /** True when the citation verifier removed nothing. */
  citationsVerified: boolean;
}

const WEIGHTS = {
  evidenceQuality: 0.26,
  sourceIndependence: 0.22,
  corroboration: 0.2,
  freshness: 0.18,
  coverage: 0.14,
} as const;

export function assessConfidence(input: ConfidenceInput): ConfidenceAssessment {
  const notes: string[] = [];

  const verifiedClaims = input.nodes.filter(
    (node) => node.state === 'SUPPORTED' || node.state === 'PARTIALLY_SUPPORTED'
  );
  const supportedClaims = input.nodes.filter((node) => node.state === 'SUPPORTED');
  const contestedClaims = input.nodes.filter((node) => node.contested);

  // ---- Nothing retrieved at all ----
  if (input.sources.length === 0 || input.nodes.length === 0) {
    return {
      level: 'INSUFFICIENT',
      score: 0,
      components: {
        evidenceQuality: 0,
        sourceIndependence: 0,
        corroboration: 0,
        freshness: 0,
        contradictionPenalty: 0,
        coverage: round3(clamp01(input.coverage)),
      },
      notes: ['No evidence was retrieved, so no confidence can be placed in an answer.'],
    };
  }

  if (verifiedClaims.length === 0) {
    return {
      level: 'INSUFFICIENT',
      score: 0.05,
      components: {
        evidenceQuality: 0,
        sourceIndependence: 0,
        corroboration: 0,
        freshness: 0,
        contradictionPenalty: 0,
        coverage: round3(clamp01(input.coverage)),
      },
      notes: [
        'Sources were retrieved but none supports a verifiable claim about the question.',
        'The report states what could not be established instead of answering.',
      ],
    };
  }

  // ---- Components ----
  const independentGroups = new Set(
    input.sources.filter((source) => !source.duplicateOf).map((source) => source.independenceGroup)
  ).size;

  const usableSources = input.sources.filter((source) => source.fetchStatus === 'OK' && !source.duplicateOf);
  const evidenceQuality =
    usableSources.length === 0
      ? 0
      : usableSources.reduce((sum, source) => sum + (source.quality?.overall ?? 0.3), 0) / usableSources.length;

  const sourceIndependence = clamp01(independentGroups / 4);
  const corroboration = clamp01(
    input.nodes.reduce((sum, node) => sum + Math.min(1, node.independentSupportCount / 2), 0) /
      Math.max(1, input.nodes.length)
  );
  const freshness = clamp01(input.freshness.fresh / Math.max(1, input.freshness.dated || 1));
  const coverage = clamp01(input.coverage);

  const contestedRatio = contestedClaims.length / Math.max(1, input.nodes.length);
  const contradictionPenalty = clamp01(
    contestedRatio * 0.6 + (input.contradictions.length > 0 ? Math.min(0.25, input.contradictions.length * 0.05) : 0)
  );

  let score =
    evidenceQuality * WEIGHTS.evidenceQuality +
    sourceIndependence * WEIGHTS.sourceIndependence +
    corroboration * WEIGHTS.corroboration +
    freshness * WEIGHTS.freshness +
    coverage * WEIGHTS.coverage;

  score = clamp01(score - contradictionPenalty);

  if (!input.citationsVerified) {
    score = clamp01(score - 0.15);
    notes.push('Some citations could not be verified and were removed before publication.');
  }

  // ---- Level ----
  let level: ConfidenceLevel;
  if (score >= 0.7 && independentGroups >= 3 && contestedRatio <= 0.25) {
    level = 'HIGH';
  } else if (score >= 0.48 && independentGroups >= 2) {
    level = 'MEDIUM';
  } else {
    level = 'LOW';
  }

  // A single independent voice can never be HIGH, whatever the arithmetic says.
  if (level === 'HIGH' && supportedClaims.length === 0) level = 'MEDIUM';
  if (level === 'HIGH' && input.freshness.stale > 0 && input.freshness.stale >= input.freshness.dated) {
    level = 'MEDIUM';
  }

  // ---- Notes ----
  if (independentGroups >= 3) notes.push(`${independentGroups} independent source groups contributed.`);
  else if (independentGroups === 1) notes.push('Only one independent source group contributed.');
  else notes.push(`${independentGroups} independent source groups contributed; stronger corroboration was expected.`);

  if (contestedClaims.length > 0) {
    notes.push(
      `${contestedClaims.length} of ${input.nodes.length} claims are contested; both sides are reported.`
    );
  }
  if (input.freshness.undated > 0) {
    notes.push(`${input.freshness.undated} source(s) had no verifiable publication date.`);
  }
  if (input.freshness.stale > 0) {
    notes.push(`${input.freshness.stale} dated source(s) are stale for this question.`);
  }
  if (coverage < 1) {
    notes.push(`${Math.round(coverage * 100)}% of the planned sub-questions received evidence.`);
  }

  return {
    level,
    score: round3(score),
    components: {
      evidenceQuality: round3(evidenceQuality),
      sourceIndependence: round3(sourceIndependence),
      corroboration: round3(corroboration),
      freshness: round3(freshness),
      contradictionPenalty: round3(contradictionPenalty),
      coverage: round3(coverage),
    },
    notes,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
