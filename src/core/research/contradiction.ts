/**
 * JARVIS-X v1.3.0 — Contradiction detection.
 *
 * When credible sources disagree, JARVIS NEVER picks a winner silently and
 * never drops the losing side. Both positions are preserved in the claim graph
 * and surfaced in the report's CONFLICTS section.
 *
 * An explanation is only attached when the evidence supports one:
 *   * a real publication gap (the older source may describe a previous state),
 *   * explicit version scoping ("in 3.1" vs "in 3.2"),
 *   * vendor claim vs independent measurement,
 *   * a historically-scoped passage (the older statement says it WAS true).
 *
 * If nothing distinguishes the two sides, `possibleExplanation` stays null and
 * `resolved` stays false. Guessing is not allowed here.
 */

import type { ClaimPosition, Contradiction, EvidenceUnit, WebSource } from './types';
import { containment, hasHistoricalScope, shortHash, termSet } from './text-utils';

export { hasHistoricalScope };

export interface ContradictionOptions {
  /** Accepted for call-site symmetry; contradictions are judged from evidence. */
  now?: Date;
  /** Minimum topical overlap for two passages to be about the same thing. */
  minOverlap?: number;
  /** Accepted alias for `minOverlap` (kept for caller compatibility). */
  minTopicOverlap?: number;
  /** Hard cap on stored contradictions. */
  maxContradictions?: number;
}

const DEFAULT_MIN_OVERLAP = 0.5;
const DEFAULT_MAX = 8;

export function detectContradictions(
  evidence: EvidenceUnit[],
  sources: WebSource[],
  options: ContradictionOptions
): Contradiction[] {
  const minOverlap = options.minOverlap ?? options.minTopicOverlap ?? DEFAULT_MIN_OVERLAP;
  const maxContradictions = options.maxContradictions ?? DEFAULT_MAX;
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));

  const supporting = evidence.filter((unit) => unit.supportType === 'SUPPORTS');
  const contradicting = evidence.filter((unit) => unit.supportType === 'CONTRADICTS');

  if (supporting.length === 0 || contradicting.length === 0) return [];

  const contradictions: Contradiction[] = [];
  const seen = new Set<string>();

  for (const neg of contradicting) {
    if (contradictions.length >= maxContradictions) break;

    const negSource = sourceById.get(neg.sourceId);
    if (!negSource) continue;

    const negTerms = termSet(`${neg.claim} ${neg.passage}`);

    for (const pos of supporting) {
      if (contradictions.length >= maxContradictions) break;

      const posSource = sourceById.get(pos.sourceId);
      if (!posSource) continue;

      // The same voice cannot contradict itself for our purposes.
      if (posSource.independenceGroup === negSource.independenceGroup) continue;

      const overlap = containment(negTerms, termSet(`${pos.claim} ${pos.passage}`));
      if (overlap < minOverlap) continue;

      const pairKey = [neg.evidenceId, pos.evidenceId].sort().join('|');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const sideA = toPosition(posSource, pos, 'SUPPORTS');
      const sideB = toPosition(negSource, neg, 'CONTRADICTS');

      const explanation = explain({
        sideA,
        sideB,
        posSource,
        negSource,
        posUnit: pos,
        negUnit: neg,
      });

      contradictions.push({
        contradictionId: `ctr-${shortHash(pairKey)}`,
        claim: neg.claim || pos.claim,
        sideA,
        sideB,
        possibleExplanation: explanation?.text ?? null,
        resolved: explanation?.resolved ?? false,
        severity: explanation?.resolved ? 'LOW' : severityFor(overlap, posSource, negSource),
      });
    }
  }

  // Prefer the most severe contradictions when over budget.
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  return contradictions.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, maxContradictions);
}

/* ==========================================================================
 * Explanation
 * ======================================================================== */

interface Explanation {
  text: string;
  resolved: boolean;
}

function explain(input: {
  sideA: ClaimPosition;
  sideB: ClaimPosition;
  posSource: WebSource;
  negSource: WebSource;
  posUnit: EvidenceUnit;
  negUnit: EvidenceUnit;
}): Explanation | null {
  const { sideA, sideB, posSource, negSource, posUnit, negUnit } = input;

  // 1. One side explicitly scopes itself to the past.
  if (hasHistoricalScope(negUnit.passage) && !hasHistoricalScope(posUnit.passage)) {
    return {
      text: 'The contradictory passage explicitly refers to an earlier state ("used to", "in version 1.x", "historically"), so it describes history rather than the present.',
      resolved: true,
    };
  }
  if (hasHistoricalScope(posUnit.passage) && !hasHistoricalScope(negUnit.passage)) {
    return {
      text: 'The supporting passage explicitly refers to an earlier state, so it cannot establish the present situation on its own.',
      resolved: false,
    };
  }

  // 2. A real publication gap.
  const dateA = sideA.publishedAt ? Date.parse(sideA.publishedAt) : null;
  const dateB = sideB.publishedAt ? Date.parse(sideB.publishedAt) : null;

  if (dateA !== null && dateB !== null && Math.abs(dateA - dateB) > 1000 * 60 * 60 * 24 * 120) {
    const older = dateA < dateB ? sideA : sideB;
    const newer = dateA < dateB ? sideB : sideA;
    return {
      text: `The sources are dated ${formatDate(older.publishedAt)} and ${formatDate(
        newer.publishedAt
      )}; the older statement may describe a previous state rather than a disagreement of fact.`,
      // A date gap explains the difference but does not prove which is current.
      resolved: false,
    };
  }

  // 3. Explicit version scoping.
  const versionsA = versionTokens(`${posUnit.claim} ${posUnit.passage}`);
  const versionsB = versionTokens(`${negUnit.claim} ${negUnit.passage}`);
  if (versionsA.length > 0 && versionsB.length > 0) {
    const shared = versionsA.filter((version) => versionsB.includes(version));
    if (shared.length === 0) {
      return {
        text: `The passages reference different releases (${versionsA.join(', ')} vs ${versionsB.join(
          ', '
        )}); the discrepancy may be version-specific.`,
        resolved: false,
      };
    }
  }

  // 4. Vendor self-description vs independent observation.
  const posVendor = posSource.sourceType === 'MANUFACTURER_CLAIM' || posSource.sourceType === 'PRIMARY_OFFICIAL';
  const negVendor = negSource.sourceType === 'MANUFACTURER_CLAIM' || negSource.sourceType === 'PRIMARY_OFFICIAL';

  if (posVendor !== negVendor) {
    const vendorSide = posVendor ? sideA : sideB;
    return {
      text: `One side is the ${vendorSide.domain} self-description and the other is an outside source; a vendor's own claim is not independent verification of itself.`,
      resolved: false,
    };
  }

  return null;
}

function versionTokens(text: string): string[] {
  const matches = text.match(/\bv?\d+\.\d+(?:\.\d+)?\b/g) ?? [];
  return [...new Set(matches.map((token) => token.replace(/^v/i, '')))].slice(0, 6);
}

function severityFor(overlap: number, posSource: WebSource, negSource: WebSource): Contradiction['severity'] {
  const quality = ((posSource.quality?.overall ?? 0.3) + (negSource.quality?.overall ?? 0.3)) / 2;
  if (quality >= 0.6 && overlap >= 0.65) return 'HIGH';
  if (quality >= 0.45) return 'MEDIUM';
  return 'LOW';
}

function toPosition(source: WebSource, unit: EvidenceUnit, stance: 'SUPPORTS' | 'CONTRADICTS'): ClaimPosition {
  return {
    sourceId: source.sourceId,
    sourceTitle: source.title,
    domain: source.domain,
    evidenceId: unit.evidenceId,
    statement: unit.passage,
    publishedAt: source.publishedAt ?? unit.publishedAt,
    stance,
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return 'an unknown date';
  return iso.slice(0, 10);
}

/* ==========================================================================
 * Numeric reconciliation
 * ======================================================================== */

export interface NumericDisagreement {
  /** Both numeric values, in the order they were supplied. */
  values: [number, number];
  metric: string;
  /** True only when the two values are measuring different things. */
  reconciled: boolean;
  /** Why they can coexist — null when no honest explanation exists. */
  explanation: string | null;
}

/**
 * Compare two numeric claims.
 *
 * Two numbers that differ are NOT automatically reconcilable, and this function
 * never pretends otherwise. It only reports `reconciled: true` when the values
 * are identical, or when the two passages are scoped to different versions /
 * different units (which makes them answers to different questions).
 */
export function reconcileNumericDisagreement(
  a: { value: number; unit?: string | null; text?: string | null },
  b: { value: number; unit?: string | null; text?: string | null }
): NumericDisagreement {
  const metric = a.unit ?? b.unit ?? 'value';

  if (a.value === b.value) {
    return { values: [a.value, b.value], metric, reconciled: true, explanation: 'The values are identical.' };
  }

  const unitA = (a.unit ?? '').trim().toLowerCase();
  const unitB = (b.unit ?? '').trim().toLowerCase();
  if (unitA && unitB && unitA !== unitB) {
    return {
      values: [a.value, b.value],
      metric,
      reconciled: true,
      explanation: `The values use different units (${unitA} vs ${unitB}), so they measure different quantities.`,
    };
  }

  const versionA = versionTokens(a.text ?? '');
  const versionB = versionTokens(b.text ?? '');
  const distinctVersions = versionA.some((token) => !versionB.includes(token)) || versionB.some((token) => !versionA.includes(token));
  if (distinctVersions) {
    return {
      values: [a.value, b.value],
      metric,
      reconciled: true,
      explanation: `The values are scoped to different versions (${[...versionA, ...versionB].slice(0, 4).join(', ')}).`,
    };
  }

  const historyA = hasHistoricalScope(a.text ?? '');
  const historyB = hasHistoricalScope(b.text ?? '');
  if (historyA !== historyB) {
    return {
      values: [a.value, b.value],
      metric,
      reconciled: true,
      explanation: 'One statement is explicitly scoped to a past state, so both can be true of different periods.',
    };
  }

  return {
    values: [a.value, b.value],
    metric,
    reconciled: false,
    explanation: null,
  };
}
