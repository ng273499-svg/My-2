/**
 * JARVIS-X v1.3.0 — Freshness engine.
 *
 * Rules that are never broken:
 *   * A date is only used when the page asserted it. No date → `dateVerified`
 *     is false and `referenceDate` is null. Nothing is inferred from the URL,
 *     the fetch time or the file name.
 *   * "Latest" is only ever claimed from a record that carries a real date.
 *   * Staleness is relative to the QUESTION. An old manual is not stale for a
 *     historical question; it is stale for "what changed this week".
 */

import type { WebSource } from './types';

export interface FreshnessAssessment {
  /** 0..1 — higher is fresher. */
  score: number;
  ageDays: number | null;
  /** True only when the page asserted a parseable publication/update date. */
  dateVerified: boolean;
  isStale: boolean;
  signals: string[];
  /** The date used for the assessment (publication or update). */
  referenceDate: string | null;
}

export interface FreshnessContext {
  now: Date;
  requirement: 'none' | 'prefer_recent' | 'must_be_current';
  /** Freshest age (days) among comparable sources; null when unknown. */
  newestComparableAgeDays?: number | null;
}

export function assessFreshness(source: WebSource, context: FreshnessContext): FreshnessAssessment {
  const signals: string[] = [];
  const referenceDate = source.updatedAt ?? source.publishedAt ?? null;

  if (!referenceDate) {
    signals.push('date_unknown');
    // Neutral: absence of a date is not evidence of staleness.
    return {
      score: 0.5,
      ageDays: null,
      dateVerified: false,
      isStale: false,
      signals,
      referenceDate: null,
    };
  }

  const ageDays = daysBetween(referenceDate, context.now);
  if (ageDays === null) {
    signals.push('date_unparseable');
    return {
      score: 0.5,
      ageDays: null,
      dateVerified: false,
      isStale: false,
      signals,
      referenceDate,
    };
  }

  signals.push(source.updatedAt ? 'update_date_asserted' : 'publication_date_asserted');
  let score = ageScore(ageDays);

  // ---- Relative staleness ----
  const newest = context.newestComparableAgeDays ?? null;
  let isStale = false;

  if (newest !== null) {
    const gapDays = ageDays - newest;
    if (gapDays > 365) {
      // A year older than the freshest comparable source.
      score *= context.requirement === 'must_be_current' ? 0.45 : 0.7;
      isStale = true;
      signals.push('superseded_by_newer_source');
    } else if (gapDays > 90) {
      score *= context.requirement === 'must_be_current' ? 0.65 : 0.85;
      signals.push('older_than_newest_source');
    }
  }

  // ---- Requirement weighting ----
  if (context.requirement === 'must_be_current' && ageDays > 180) {
    score *= 0.6;
    isStale = true;
    signals.push('stale_for_current_information_request');
  } else if (context.requirement === 'prefer_recent' && ageDays > 400) {
    score *= 0.75;
    signals.push('older_than_preferred_window');
  }

  // ---- Future dates are suspicious, never "fresher than fresh" ----
  if (ageDays < -2) {
    score *= 0.4;
    signals.push('date_in_the_future');
  }

  return {
    score: round3(clamp01(score)),
    ageDays,
    dateVerified: true,
    isStale,
    signals,
    referenceDate,
  };
}

function ageScore(ageDays: number): number {
  const age = Math.max(0, ageDays);
  if (age <= 7) return 1;
  if (age <= 30) return 0.95;
  if (age <= 90) return 0.85;
  if (age <= 180) return 0.75;
  if (age <= 365) return 0.65;
  if (age <= 730) return 0.5;
  if (age <= 1_460) return 0.35;
  return 0.2;
}

export function daysBetween(dateIso: string, now: Date): number | null {
  const parsed = Date.parse(dateIso);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((now.getTime() - parsed) / 86_400_000);
}

/* ==========================================================================
 * "Latest" — evidence required
 * ======================================================================== */

export interface LatestVerdict {
  source: WebSource;
  date: string;
  ageDays: number;
}

/**
 * The newest source that actually asserts a date.
 *
 * Returns null when nothing carries a verifiable date — in that case JARVIS
 * must say freshness could not be established instead of naming a "latest".
 */
export function findLatestVerified(sources: WebSource[], now: Date): LatestVerdict | null {
  let best: LatestVerdict | null = null;

  for (const source of sources) {
    if (source.fetchStatus !== 'OK') continue;
    const date = source.updatedAt ?? source.publishedAt;
    if (!date) continue;

    const ageDays = daysBetween(date, now);
    if (ageDays === null || ageDays < 0) continue;

    if (!best || ageDays < best.ageDays) best = { source, date, ageDays };
  }

  return best;
}

/* ==========================================================================
 * Set-level freshness
 * ======================================================================== */

export interface FreshnessSummary {
  assessed: number;
  dated: number;
  undated: number;
  stale: number;
  fresh: number;
  newestAgeDays: number | null;
  medianAgeDays: number | null;
  /** Honest one-line statement for the report limitations. */
  note: string;
}

export function summariseFreshness(sources: WebSource[], context: FreshnessContext): FreshnessSummary {
  const ages: number[] = [];
  let dated = 0;
  let stale = 0;
  let fresh = 0;
  let undated = 0;

  for (const source of sources) {
    if (source.fetchStatus !== 'OK') continue;
    const assessment = assessFreshness(source, context);
    if (assessment.dateVerified && assessment.ageDays !== null) {
      dated += 1;
      ages.push(assessment.ageDays);
      if (assessment.isStale) stale += 1;
      if (assessment.ageDays <= 180) fresh += 1;
    } else {
      undated += 1;
    }
  }

  ages.sort((a, b) => a - b);
  const newestAgeDays = ages.length > 0 ? ages[0] : null;
  const medianAgeDays = ages.length > 0 ? ages[Math.floor(ages.length / 2)] : null;

  let note: string;
  if (dated === 0) {
    note = 'No retrieved source asserted a verifiable publication date, so freshness could not be established.';
  } else if (stale > 0) {
    note = `${stale} of ${dated} dated sources are stale for this question${
      undated > 0 ? `; ${undated} source(s) have no verifiable date` : ''
    }.`;
  } else {
    note = `All ${dated} dated sources are within the freshness window${
      undated > 0 ? `; ${undated} source(s) have no verifiable date` : ''
    }.`;
  }

  return { assessed: dated + undated, dated, undated, stale, fresh, newestAgeDays, medianAgeDays, note };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
