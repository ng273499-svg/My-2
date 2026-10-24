/**
 * JARVIS-X v1.3.0 — FACT_CHECK verdicts.
 *
 * Six outcomes, never a boolean:
 *
 *   SUPPORTED            independent credible sources agree with the claim
 *   PARTIALLY_SUPPORTED  one credible source, or support with a caveat
 *   CONTRADICTED         credible sources contradict the claim
 *   MIXED                credible sources both support and contradict it
 *   OUTDATED             the supporting material is stale for a current claim
 *   INSUFFICIENT_EVIDENCE nothing retrieved can adjudicate the claim
 *
 * The verdict always carries counts and a rationale so a reader can see exactly
 * how much evidence stands behind it.
 */

import type {
  ClaimNode,
  FactCheckResult,
  FactCheckVerdict,
  WebSource,
} from './types';

export interface FactCheckInput {
  claim: string;
  nodes: ClaimNode[];
  subQuestions?: string[];
  sources: WebSource[];
  freshnessRequirement: 'none' | 'prefer_recent' | 'must_be_current';
  freshnessNote?: string | null;
}

export function runFactCheck(input: FactCheckInput): FactCheckResult {
  const supporting = input.nodes.filter((node) => node.supportingEvidenceIds.length > 0);
  const contradicting = input.nodes.filter((node) => node.contradictingEvidenceIds.length > 0);
  const contested = input.nodes.filter((node) => node.contested);

  const supportingCount = sum(supporting.map((node) => node.supportingEvidenceIds.length));
  const contradictingCount = sum(contradicting.map((node) => node.contradictingEvidenceIds.length));

  // Independent groups, never raw source count.
  const supportGroups = new Set<string>();
  const sourceById = new Map(input.sources.map((source) => [source.sourceId, source]));
  for (const node of supporting) {
    for (const sourceId of node.supportingSourceIds) {
      const source = sourceById.get(sourceId);
      if (!source || source.duplicateOf) continue;
      supportGroups.add(source.independenceGroup);
    }
  }
  const independentSupport = supportGroups.size;

  const allSupportStale =
    supporting.length > 0 && supporting.every((node) => node.freshnessScore < 0.35);

  let verdict: FactCheckVerdict;
  let rationale: string;

  if (supportingCount === 0 && contradictingCount === 0) {
    verdict = 'INSUFFICIENT_EVIDENCE';
    rationale =
      'No retrieved source addresses this claim directly, so it can be neither confirmed nor refuted here.';
  } else if (supportingCount === 0) {
    verdict = 'CONTRADICTED';
    rationale = `${contradictingCount} passage(s) from ${contradicting.length} claim group(s) contradict the claim and nothing retrieved supports it.`;
  } else if (contradictingCount === 0) {
    if (input.freshnessRequirement === 'must_be_current' && allSupportStale) {
      verdict = 'OUTDATED';
      rationale =
        'The claim is supported only by material that is stale for a question about current information.';
    } else if (independentSupport >= 2) {
      verdict = 'SUPPORTED';
      rationale = `${independentSupport} independent source group(s) support the claim with no retrieved contradiction.`;
    } else {
      verdict = 'PARTIALLY_SUPPORTED';
      rationale =
        'The claim is supported, but by a single independent source group, so it is not corroborated.';
    }
  } else if (contested.length > 0) {
    verdict = 'MIXED';
    rationale = `Evidence cuts both ways: ${supportingCount} supporting and ${contradictingCount} contradicting passage(s) across ${supporting.length + contradicting.length} claim group(s).`;
  } else {
    verdict = 'PARTIALLY_SUPPORTED';
    rationale = 'Support exists but is not strong enough to settle the claim.';
  }

  return {
    claim: input.claim,
    subClaims: input.subQuestions?.slice(0, 5) ?? input.nodes.slice(0, 5).map((node) => node.claim),
    verdict,
    supportingCount,
    contradictingCount,
    independentSupport,
    rationale,
    claimIds: input.nodes.map((node) => node.claimId),
    freshnessNote: input.freshnessNote ?? null,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/* ==========================================================================
 * Sub-claim splitting
 * ======================================================================== */

/**
 * Split a compound claim into checkable sub-claims.
 *
 * Splitting is conservative: a clause is only separated when it is joined by an
 * explicit conjunction AND is long enough to stand alone. No paraphrasing and no
 * invented sub-claims — the strings returned are substrings of the input.
 */
export function splitSubClaims(claim: string): string[] {
  const normalized = claim.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];

  const parts = normalized
    .split(/\s+(?:and|but|while|whereas|however)\s+|;\s+/i)
    .map((part) => part.trim().replace(/^(?:that|also)\s+/i, ''))
    .filter((part) => part.length >= 24);

  if (parts.length <= 1) return [normalized];
  return parts.slice(0, 5);
}
