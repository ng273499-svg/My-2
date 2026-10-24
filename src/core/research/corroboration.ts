/**
 * JARVIS-X v1.3.0 — Independence and corroboration.
 *
 * A claim is only "corroborated" when INDEPENDENT sources agree. Independence
 * is an evidence property, not a domain property:
 *
 *   * a syndicated copy of the same article on five sites is ONE voice;
 *   * a mirror with a different URL but identical text is the same voice;
 *   * two different articles from the same publisher are usually the same
 *     editorial voice and are grouped by registered domain.
 *
 * Counting copies is the single easiest way to fake confidence, so this module
 * exists to make that impossible.
 */

import type { Contradiction, EvidenceUnit, WebSource } from './types';
import { shingleSimilarity, shingles } from './source-normalization';
import { shortHash } from './text-utils';

export interface IndependenceAnalysis {
  groups: Array<{
    groupId: string;
    domains: string[];
    sourceIds: string[];
    /** True when the group looks like one article republished. */
    syndicated: boolean;
  }>;
  independentGroupCount: number;
  duplicateCount: number;
  /** Pairs that look like the same article on different domains. */
  syndicationPairs: Array<{ a: string; b: string; similarity: number }>;
}

const SYNDICATION_THRESHOLD = 0.8;

export function analyseIndependence(sources: WebSource[]): IndependenceAnalysis {
  const active = sources.filter((source) => source.fetchStatus === 'OK');

  // Group id comes from the de-duplication layer when available; otherwise the
  // domain is the group (same publisher → same editorial voice).
  const groupOf = new Map<string, string>();
  for (const source of active) {
    groupOf.set(source.sourceId, source.independenceGroup || source.duplicateOf || source.domain);
  }

  const signatures = new Map<string, Set<string>>();
  for (const source of active) {
    if (source.duplicateOf) continue;
    signatures.set(source.sourceId, shingles(source.extractedText.slice(0, 8_000)));
  }

  const syndicationPairs: Array<{ a: string; b: string; similarity: number }> = [];

  for (let i = 0; i < active.length; i += 1) {
    const a = active[i];
    if (a.duplicateOf) continue;

    for (let j = i + 1; j < active.length; j += 1) {
      const b = active[j];
      if (b.duplicateOf) continue;
      if (a.independenceGroup === b.independenceGroup) continue;

      const score = shingleSimilarity(
        signatures.get(a.sourceId) as Set<string>,
        signatures.get(b.sourceId) as Set<string>
      );

      if (score >= SYNDICATION_THRESHOLD) {
        syndicationPairs.push({ a: a.sourceId, b: b.sourceId, similarity: round3(score) });
        // Merge the weaker voice into the stronger one's group.
        const keep = (a.quality?.overall ?? 0) >= (b.quality?.overall ?? 0) ? a : b;
        const drop = keep === a ? b : a;
        const keepGroup = groupOf.get(keep.sourceId) as string;
        groupOf.set(drop.sourceId, keepGroup);
        drop.independenceGroup = keepGroup;
      }
    }
  }

  const grouped = new Map<string, { domains: Set<string>; sourceIds: string[] }>();
  for (const source of active) {
    const groupId = groupOf.get(source.sourceId) as string;
    const entry = grouped.get(groupId) ?? { domains: new Set<string>(), sourceIds: [] };
    entry.domains.add(source.domain);
    entry.sourceIds.push(source.sourceId);
    grouped.set(groupId, entry);
  }

  const groups = [...grouped.entries()].map(([rawId, entry]) => ({
    groupId: `grp-${shortHash(rawId)}`,
    domains: [...entry.domains],
    sourceIds: entry.sourceIds,
    syndicated: entry.domains.size > 1,
  }));

  return {
    groups,
    independentGroupCount: groups.length,
    duplicateCount: sources.length - active.length + syndicationPairs.length,
    syndicationPairs,
  };
}

/* ==========================================================================
 * Corroboration
 * ======================================================================== */

export interface CorroborationResult {
  /** Distinct independence groups that support the claim. */
  independentSupport: number;
  supportingDomains: string[];
  /** Sources that support but belong to an already-counted group. */
  redundantSupport: number;
  syndicatedCopiesDetected: number;
  strong: boolean;
}

export function corroborate(
  supportingSourceIds: string[],
  sources: WebSource[],
  evidence: EvidenceUnit[],
  options: { minIndependent?: number } = {}
): CorroborationResult {
  const minIndependent = options.minIndependent ?? 2;
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const evidenceCountBySource = new Map<string, number>();

  for (const unit of evidence) {
    if (unit.supportType !== 'SUPPORTS') continue;
    evidenceCountBySource.set(unit.sourceId, (evidenceCountBySource.get(unit.sourceId) ?? 0) + 1);
  }

  const groups = new Set<string>();
  const domains = new Set<string>();
  let redundant = 0;
  let syndicated = 0;

  for (const sourceId of supportingSourceIds) {
    const source = byId.get(sourceId);
    if (!source) continue;

    if (source.duplicateOf) {
      syndicated += 1;
      continue;
    }

    if (groups.has(source.independenceGroup)) {
      redundant += 1;
      continue;
    }

    groups.add(source.independenceGroup);
    domains.add(source.domain);
  }

  return {
    independentSupport: groups.size,
    supportingDomains: [...domains],
    redundantSupport: redundant,
    syndicatedCopiesDetected: syndicated,
    strong: groups.size >= minIndependent,
  };
}

/* ==========================================================================
 * Contradiction de-duplication helper
 * ======================================================================== */

/** Collapse contradictions that describe the same two positions. */
export function uniqueContradictions(contradictions: Contradiction[]): Contradiction[] {
  const seen = new Set<string>();
  const output: Contradiction[] = [];

  for (const contradiction of contradictions) {
    const key = [contradiction.sideA.sourceId, contradiction.sideB.sourceId]
      .sort()
      .join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(contradiction);
  }

  return output;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
