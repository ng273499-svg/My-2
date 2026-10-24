/**
 * JARVIS-X v1.3.0 — Claim graph.
 *
 * A claim is a proposition that can be checked against evidence. Each node
 * carries exactly ONE of six verification states:
 *
 *   SUPPORTED           — independent, credible sources agree
 *   PARTIALLY_SUPPORTED — one source, or weak/stale agreement
 *   CONFLICTING         — credible sources disagree (both sides preserved)
 *   UNSUPPORTED         — only contradictory evidence exists
 *   OUTDATED            — support exists but predates fresher contradicting data
 *   UNKNOWN             — nothing retrieved speaks to it
 *
 * Nothing here decides truth. It records what the retrieved evidence does and
 * does not support, and why.
 */

import type {
  ClaimNode,
  ClaimGraph,
  ClaimPosition,
  Contradiction,
  EvidenceUnit,
  VerificationState,
  WebSource,
} from './types';
import {
  claimFromQuestion,
  containment,
  hasHistoricalScope,
  keyTerms,
  shortHash,
  termSet,
  similarity,
} from './text-utils';

export interface ClaimGraphContext {
  now: Date;
  freshnessRequirement: 'none' | 'prefer_recent' | 'must_be_current';
  /** Independent groups required before a claim can be called SUPPORTED. */
  minIndependentSupport: number;
  /** Maximum claims kept in the graph. */
  maxClaims?: number;
}

export interface BuildClaimGraphInput {
  query: string;
  subQuestions: string[];
  evidence: EvidenceUnit[];
  sources: WebSource[];
  context: ClaimGraphContext;
}

const DEFAULT_MAX_CLAIMS = 20;
const EVIDENCE_MATCH_THRESHOLD = 0.42;

export function buildClaimGraph(input: BuildClaimGraphInput): ClaimGraph {
  const { evidence, sources, context } = input;
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const maxClaims = context.maxClaims ?? DEFAULT_MAX_CLAIMS;

  // ---- 1. Candidate claims ----
  const seeds = buildClaimSeeds(input, maxClaims * 2);

  // ---- 2. Attach evidence ----
  const nodes: ClaimNode[] = [];

  for (const seed of seeds) {
    if (nodes.length >= maxClaims) break;

    const related = matchEvidence(seed.terms, evidence);

    if (related.supporting.length === 0 && related.contradicting.length === 0) {
      nodes.push(makeNode(seed.claimId, seed.text, [], [], context, 'UNKNOWN', ['No retrieved evidence speaks to this claim.']));
      continue;
    }

    const supportingSourceIds = unique(related.supporting.map((unit) => unit.sourceId));
    const contradictingSourceIds = unique(related.contradicting.map((unit) => unit.sourceId));

    // ---- Independence: duplicates never count twice ----
    const groups = new Set<string>();
    for (const sourceId of supportingSourceIds) {
      const source = sourceById.get(sourceId);
      if (!source || source.duplicateOf) continue;
      groups.add(source.independenceGroup);
    }
    const independentSupportCount = groups.size;

    const positions = buildPositions(related.supporting, related.contradicting, sourceById);
    const contested = related.supporting.length > 0 && related.contradicting.length > 0;

    const freshnessScore = computeClaimFreshness(related.supporting, related.contradicting);
    const avgQuality = mean([...related.supporting, ...related.contradicting].map((unit) => unit.quality));

    const notes: string[] = [];
    if (contested) notes.push('Credible sources disagree; both positions are preserved.');
    if (related.contradicting.some((unit) => unit.supportType === 'CONTRADICTS')) {
      notes.push('At least one passage contradicts this claim.');
    }
    const duplicateSupport = related.supporting.filter((unit) => sourceById.get(unit.sourceId)?.duplicateOf);
    if (duplicateSupport.length > 0) {
      notes.push(`${duplicateSupport.length} supporting passage(s) came from syndicated copies and were not counted as independent.`);
    }
    if (related.supporting.some((unit) => unit.supportType === 'CONTEXT')) {
      notes.push('Historically-scoped passages were treated as context, not as present-tense support.');
    }

    const state = computeState({
      supporting: related.supporting,
      contradicting: related.contradicting,
      independentSupportCount,
      avgQuality,
      freshnessScore,
      context,
    });

    const confidence = computeClaimConfidence({
      independentSupportCount,
      minIndependentSupport: context.minIndependentSupport,
      avgQuality,
      freshnessScore,
      contested,
      state,
    });

    nodes.push({
      claimId: seed.claimId,
      claim: seed.text,
      supportingEvidenceIds: related.supporting.map((unit) => unit.evidenceId),
      contradictingEvidenceIds: related.contradicting.map((unit) => unit.evidenceId),
      independentSupportCount,
      supportingSourceIds,
      contradictingSourceIds,
      freshnessScore: round3(freshnessScore),
      confidence: round3(confidence),
      state,
      contested,
      positions,
      notes,
    });
  }

  const staleSuperseded = nodes.filter((node) => node.state === 'OUTDATED').length;

  return {
    nodes,
    extractedCount: seeds.length,
    staleSuperseded,
  };
}

/* ==========================================================================
 * Seeds
 * ======================================================================== */

interface ClaimSeed {
  claimId: string;
  text: string;
  terms: Set<string>;
  /** True for the user's own questions (they are always kept). */
  fromQuestion: boolean;
}

function buildClaimSeeds(input: BuildClaimGraphInput, limit: number): ClaimSeed[] {
  const seeds: ClaimSeed[] = [];

  const push = (text: string, fromQuestion: boolean): void => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length < 12) return;

    const terms = termSet(cleaned);
    if (terms.size === 0) return;

    // Merge near-identical claims instead of listing them twice.
    for (const seed of seeds) {
      if (similarity(seed.terms, terms) >= 0.82) {
        if (fromQuestion && !seed.fromQuestion) {
          seed.fromQuestion = true;
        }
        return;
      }
    }

    seeds.push({
      claimId: `clm-${shortHash(cleaned)}`,
      text: cleaned,
      terms,
      fromQuestion,
    });
  };

  push(claimFromQuestion(input.query), true);
  for (const sub of input.subQuestions.slice(0, 4)) push(claimFromQuestion(sub), true);

  // Evidence-derived assertions, best first.
  const ranked = [...input.evidence].sort((a, b) => b.quality * b.relevance - a.quality * a.relevance);
  for (const unit of ranked) {
    if (seeds.length >= limit) break;
    if (unit.supportType !== 'SUPPORTS' && unit.supportType !== 'CONTRADICTS') continue;
    if (hasHistoricalScope(unit.passage)) continue;
    push(unit.claim, false);
  }

  return seeds;
}

/* ==========================================================================
 * Matching
 * ======================================================================== */

interface MatchedEvidence {
  supporting: EvidenceUnit[];
  contradicting: EvidenceUnit[];
}

function matchEvidence(claimTerms: Set<string>, evidence: EvidenceUnit[]): MatchedEvidence {
  const supporting: EvidenceUnit[] = [];
  const contradicting: EvidenceUnit[] = [];

  for (const unit of evidence) {
    const passageTerms = termSet(`${unit.claim} ${unit.passage}`);
    const overlap = containment(claimTerms, passageTerms);
    if (overlap < EVIDENCE_MATCH_THRESHOLD) continue;

    if (unit.supportType === 'CONTRADICTS') contradicting.push(unit);
    else if (unit.supportType === 'SUPPORTS') supporting.push(unit);
    // CONTEXT and NEUTRAL never confirm or deny.
  }

  return {
    supporting: supporting.slice(0, 12),
    contradicting: contradicting.slice(0, 8),
  };
}

function buildPositions(
  supporting: EvidenceUnit[],
  contradicting: EvidenceUnit[],
  sourceById: Map<string, WebSource>
): ClaimPosition[] {
  const positions: ClaimPosition[] = [];

  const push = (unit: EvidenceUnit, stance: 'SUPPORTS' | 'CONTRADICTS'): void => {
    const source = sourceById.get(unit.sourceId);
    if (!source) return;
    if (positions.some((position) => position.sourceId === unit.sourceId && position.stance === stance)) return;
    positions.push({
      sourceId: source.sourceId,
      sourceTitle: source.title,
      domain: source.domain,
      evidenceId: unit.evidenceId,
      statement: unit.passage,
      publishedAt: source.publishedAt ?? unit.publishedAt,
      stance,
    });
  };

  for (const unit of supporting.slice(0, 4)) push(unit, 'SUPPORTS');
  for (const unit of contradicting.slice(0, 4)) push(unit, 'CONTRADICTS');

  return positions;
}

/* ==========================================================================
 * State
 * ======================================================================== */

interface StateInput {
  supporting: EvidenceUnit[];
  contradicting: EvidenceUnit[];
  independentSupportCount: number;
  avgQuality: number;
  freshnessScore: number;
  context: ClaimGraphContext;
}

function computeState(input: StateInput): VerificationState {
  const { supporting, contradicting, independentSupportCount, avgQuality, freshnessScore, context } = input;

  if (supporting.length === 0 && contradicting.length === 0) return 'UNKNOWN';

  if (supporting.length === 0) return 'UNSUPPORTED';

  const contested = contradicting.length > 0;

  // Outdated beats "supported": support exists, but only from material that is
  // stale for a question that demands current information.
  if (context.freshnessRequirement === 'must_be_current') {
    const allSupportStale = supporting.every((unit) => unit.freshness < 0.4);
    if (allSupportStale && supporting.length > 0) return 'OUTDATED';
    if (allSupportStale && contested) return 'OUTDATED';
  }

  if (contested) return 'CONFLICTING';

  const enoughIndependent = independentSupportCount >= context.minIndependentSupport;
  const credible = avgQuality >= 0.45;
  const freshEnough = context.freshnessRequirement === 'none' ? true : freshnessScore >= 0.35;

  if (enoughIndependent && credible && freshEnough) return 'SUPPORTED';
  if (credible && supporting.length >= 1) return 'PARTIALLY_SUPPORTED';
  return 'PARTIALLY_SUPPORTED';
}

function computeClaimFreshness(supporting: EvidenceUnit[], contradicting: EvidenceUnit[]): number {
  const pool = supporting.length > 0 ? supporting : contradicting;
  if (pool.length === 0) return 0;
  return Math.max(0, ...pool.map((unit) => unit.freshness));
}

function computeClaimConfidence(input: {
  independentSupportCount: number;
  minIndependentSupport: number;
  avgQuality: number;
  freshnessScore: number;
  contested: boolean;
  state: VerificationState;
}): number {
  const independence = clamp01(input.independentSupportCount / Math.max(1, input.minIndependentSupport * 2));
  const base = independence * 0.4 + clamp01(input.avgQuality) * 0.35 + clamp01(input.freshnessScore) * 0.25;

  const penalties: Record<VerificationState, number> = {
    SUPPORTED: 0,
    PARTIALLY_SUPPORTED: 0.15,
    CONFLICTING: 0.25,
    OUTDATED: 0.3,
    UNSUPPORTED: 0.55,
    UNKNOWN: 0.6,
  };

  return clamp01(base - penalties[input.state] - (input.contested ? 0.05 : 0));
}

function makeNode(
  claimId: string,
  claim: string,
  supporting: EvidenceUnit[],
  contradicting: EvidenceUnit[],
  context: ClaimGraphContext,
  state: VerificationState,
  notes: string[]
): ClaimNode {
  void context;
  return {
    claimId,
    claim,
    supportingEvidenceIds: supporting.map((unit) => unit.evidenceId),
    contradictingEvidenceIds: contradicting.map((unit) => unit.evidenceId),
    independentSupportCount: 0,
    supportingSourceIds: [],
    contradictingSourceIds: [],
    freshnessScore: 0,
    confidence: 0,
    state,
    contested: false,
    positions: [],
    notes,
  };
}

/* ==========================================================================
 * Post-processing
 * ======================================================================== */

/**
 * Mark claims that a stronger, fresher contradiction has superseded.
 *
 * The superseded claim keeps its evidence and its position in the graph — it is
 * re-labelled OUTDATED, never deleted.
 */
export function applyContradictionOutcomes(
  graph: ClaimGraph,
  contradictions: Contradiction[]
): ClaimGraph {
  if (contradictions.length === 0) return graph;

  const nodes = graph.nodes.map((node) => {
    const involved = contradictions.filter(
      (contradiction) =>
        containsTerms(node.claim, contradiction.claim) || containsTerms(contradiction.claim, node.claim)
    );
    if (involved.length === 0) return node;

    const notes = [...node.notes, `${involved.length} contradiction(s) recorded against this claim.`];
    if (node.state === 'UNKNOWN' || node.state === 'UNSUPPORTED') {
      return { ...node, notes, contested: true, state: 'CONFLICTING' as VerificationState };
    }
    return { ...node, notes, contested: true };
  });

  return { ...graph, nodes };
}

function containsTerms(haystack: string, needle: string): boolean {
  const needleTerms = keyTerms(needle, 12);
  if (needleTerms.length === 0) return false;
  const haystackTerms = termSet(haystack);
  const hits = needleTerms.filter((term) => haystackTerms.has(term)).length;
  return hits >= Math.max(2, Math.ceil(needleTerms.length * 0.5));
}

/* ==========================================================================
 * Helpers
 * ======================================================================== */

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
