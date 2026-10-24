/**
 * JARVIS-X v1.3.0 — Query-dependent source quality.
 *
 * There is NO permanent "trusted domains" list anywhere in this engine. A
 * domain is only ever judged against the question being asked:
 *
 *   * a standards document outranks a news article for protocol details;
 *   * a vendor's own marketing page is DOWN-weighted when the question is
 *     whether that vendor's product is good;
 *   * a community post can beat a stale news article for a niche operational
 *     question where practitioners are the primary source;
 *   * an academic paper outranks both for an empirical claim.
 *
 * The composite is decomposed into named components and signals so the UI can
 * explain a ranking without exposing hidden reasoning.
 */

import type { ResearchIntent, SourceQuality, WebSource, WebSourceType } from './types';
import { assessFreshness } from './freshness';
import { keyTerms, similarity } from './text-utils';

export interface QualityContext {
  intent: ResearchIntent;
  queryTerms: string[];
  now: Date;
  freshnessRequirement: 'none' | 'prefer_recent' | 'must_be_current';
  /** Optional: derived from the mode budget when omitted. */
  freshnessWeight?: number;
  /** Independent groups currently supporting the same topic. */
  corroborationGroups: number;
}

const BASE_AUTHORITY: Record<WebSourceType, number> = {
  STANDARDS_BODY: 0.93,
  GOVERNMENT_INSTITUTIONAL: 0.9,
  ACADEMIC: 0.88,
  PRIMARY_OFFICIAL: 0.86,
  ESTABLISHED_REPORTING: 0.7,
  SECONDARY_REPORTING: 0.58,
  MANUFACTURER_CLAIM: 0.52,
  COMMUNITY_FORUM: 0.4,
  OWNER_DOCUMENT: 0.8,
  UNKNOWN: 0.35,
};

export interface SourceScore {
  quality: SourceQuality;
  /** Mirror of `quality.overall`, for sorting call sites. */
  overall: number;
}

export function scoreSource(source: WebSource, context: QualityContext): SourceScore {
  const signals: string[] = [];

  const relevance = computeRelevance(source, context.queryTerms);
  const authority = computeAuthority(source, context.intent, signals);
  const freshness = computeFreshness(source, context);
  const completeness = computeCompleteness(source);
  const corroboration = computeCorroboration(source, context);

  // ---- Weighted composite ----
  const freshnessWeight = clamp01(
    context.freshnessWeight ?? defaultFreshnessWeight(context.freshnessRequirement)
  );
  const baseAuthorityWeight = 0.3;
  const relevanceWeight = 0.3;
  const completenessWeight = 0.15;
  const corroborationWeight = 0.1;
  const remaining = 1 - freshnessWeight - baseAuthorityWeight - relevanceWeight - completenessWeight - corroborationWeight;

  let overall =
    relevance * relevanceWeight +
    authority * baseAuthorityWeight +
    freshness * freshnessWeight +
    completeness * completenessWeight +
    corroboration * corroborationWeight +
    authority * remaining; // the slack reinforces authority rather than vanishing

  // ---- Penalties ----
  if (source.provenance === 'DOCUMENT_SOURCE') {
    // An owner's own document is authoritative for THEIR facts, but it is not
    // independent evidence about the outside world.
    signals.push('owner_document(evidence, not independent corroboration)');
    overall *= 0.9;
  }
  if (source.trustSignals.includes('prompt_injection_neutralised')) {
    signals.push('contained_directive_text(neutralised)');
    overall *= 0.85;
  }
  if (source.trustSignals.includes('client_rendered')) {
    signals.push('client_rendered(little readable text)');
    overall *= 0.7;
  }
  if (source.trustSignals.includes('academic_metadata_only')) {
    signals.push('metadata_only(paper body not read)');
  }
  if (!source.publishedAt && !source.updatedAt) {
    signals.push('no_publication_date');
    overall *= 0.93;
  }
  if (source.duplicateOf) {
    signals.push('duplicate(not independent)');
    overall *= 0.5;
  }

  const quality: SourceQuality = {
    overall: round3(clamp01(overall)),
    relevance: round3(relevance),
    authority: round3(authority),
    freshness: round3(freshness),
    completeness: round3(completeness),
    corroboration: round3(corroboration),
    signals,
  };

  return { quality, overall: quality.overall };
}

/* ==========================================================================
 * Components
 * ======================================================================== */

function computeRelevance(source: WebSource, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;

  const titleTerms = new Set(keyTerms(source.title, 40));
  const bodyTerms = new Set(keyTerms(source.extractedText.slice(0, 20_000), 300));
  const querySet = new Set(queryTerms);

  const titleOverlap = similarity(querySet, titleTerms);
  const bodyOverlap = similarity(querySet, bodyTerms);

  // Title agreement is a strong relevance signal; body agreement confirms it.
  return clamp01(titleOverlap * 0.55 + bodyOverlap * 0.45 * 1.6);
}

function computeAuthority(source: WebSource, intent: ResearchIntent, signals: string[]): number {
  let authority = BASE_AUTHORITY[source.sourceType];
  signals.push(`source_type:${source.sourceType.toLowerCase()}`);

  switch (intent.kind) {
    case 'technical_investigation':
      if (source.sourceType === 'PRIMARY_OFFICIAL' || source.sourceType === 'STANDARDS_BODY') {
        authority += 0.06;
        signals.push('primary_document_for_technical_question');
      }
      if (source.sourceType === 'ESTABLISHED_REPORTING') authority -= 0.08;
      if (source.sourceType === 'COMMUNITY_FORUM') authority -= 0.05;
      break;

    case 'academic_discovery':
      if (source.sourceType === 'ACADEMIC') {
        authority += 0.08;
        signals.push('scholarly_source');
      }
      if (source.sourceType === 'COMMUNITY_FORUM' || source.sourceType === 'MANUFACTURER_CLAIM') authority -= 0.15;
      break;

    case 'market_product_research':
      // A vendor describing its own product is a claim, not verification.
      if (source.sourceType === 'MANUFACTURER_CLAIM' || source.sourceType === 'PRIMARY_OFFICIAL') {
        authority -= 0.12;
        signals.push('vendor_self_description(down-weighted)');
      }
      if (source.sourceType === 'ESTABLISHED_REPORTING' || source.sourceType === 'SECONDARY_REPORTING') {
        authority += 0.05;
        signals.push('independent_reporting');
      }
      break;

    case 'fact_checking':
      if (source.sourceType === 'COMMUNITY_FORUM') authority -= 0.12;
      if (source.sourceType === 'PRIMARY_OFFICIAL' || source.sourceType === 'GOVERNMENT_INSTITUTIONAL') authority += 0.05;
      break;

    case 'current_information':
      if (source.sourceType === 'COMMUNITY_FORUM') authority -= 0.05;
      break;

    case 'comparison':
      if (source.sourceType === 'MANUFACTURER_CLAIM') authority -= 0.1;
      break;

    case 'source_discovery':
      // Discovery rewards coverage variety; authority is secondary here.
      authority = authority * 0.8 + 0.2;
      break;

    default:
      break;
  }

  if (intent.requiresPrimarySources && belongsToPrimaryTier(source.sourceType)) {
    authority += 0.04;
    signals.push('primary_source_preferred');
  }

  if (source.author) {
    authority += 0.02;
    signals.push('named_author');
  }

  return clamp01(authority);
}

function belongsToPrimaryTier(type: WebSourceType): boolean {
  return (
    type === 'PRIMARY_OFFICIAL' ||
    type === 'STANDARDS_BODY' ||
    type === 'ACADEMIC' ||
    type === 'GOVERNMENT_INSTITUTIONAL'
  );
}

function computeFreshness(source: WebSource, context: QualityContext): number {
  const assessment = assessFreshness(source, {
    now: context.now,
    requirement: context.freshnessRequirement,
    newestComparableAgeDays: null,
  });
  return assessment.score;
}

function computeCompleteness(source: WebSource): number {
  let score = 0;
  const length = source.extractedText.length;

  if (length >= 4_000) score += 0.45;
  else if (length >= 1_500) score += 0.35;
  else if (length >= 600) score += 0.25;
  else if (length >= 200) score += 0.12;
  else score += 0.03;

  if (source.publishedAt) score += 0.2;
  if (source.updatedAt) score += 0.05;
  if (source.author) score += 0.1;
  if (source.academic?.doi) score += 0.1;
  if (source.title && source.title !== 'Untitled page') score += 0.1;

  return clamp01(score);
}

function computeCorroboration(source: WebSource, context: QualityContext): number {
  if (source.duplicateOf) return 0;
  // Corroboration is a property of the *set*, capped so a single topic with
  // many copies cannot inflate one source's score.
  return clamp01(Math.min(context.corroborationGroups, 4) / 4);
}

/* ==========================================================================
 * Helpers
 * ======================================================================== */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Rank sources for a question. Deterministic; ties broken by canonical URL. */
export function rankSources(sources: WebSource[]): WebSource[] {
  return [...sources].sort((a, b) => {
    const scoreA = a.quality?.overall ?? 0;
    const scoreB = b.quality?.overall ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    if (Boolean(a.duplicateOf) !== Boolean(b.duplicateOf)) return a.duplicateOf ? 1 : -1;
    return a.canonicalUrl.localeCompare(b.canonicalUrl);
  });
}

/** Fraction of ranked weight held by the single strongest independence group. */
export function dominantGroupShare(sources: WebSource[]): number {
  const totals = new Map<string, number>();
  let grand = 0;

  for (const source of sources) {
    if (source.duplicateOf) continue;
    const weight = source.quality?.overall ?? 0.1;
    totals.set(source.independenceGroup, (totals.get(source.independenceGroup) ?? 0) + weight);
    grand += weight;
  }

  if (grand === 0) return 0;
  return Math.max(...totals.values()) / grand;
}

/* ==========================================================================
 * Independence accounting
 * ======================================================================== */

/**
 * Number of genuinely independent voices behind a set of sources.
 *
 * Syndicated copies, mirrors and duplicates share an independence group and are
 * counted ONCE. This is the number used for corroboration everywhere else, so it
 * lives here next to the quality engine that consumes it.
 */
export function independentGroupCount(sources: WebSource[]): number {
  const groups = new Set<string>();
  for (const source of sources) {
    if (source.fetchStatus !== 'OK') continue;
    if (source.duplicateOf) continue;
    groups.add(source.independenceGroup || source.domain || source.sourceId);
  }
  return groups.size;
}

function defaultFreshnessWeight(requirement: 'none' | 'prefer_recent' | 'must_be_current'): number {
  if (requirement === 'must_be_current') return 0.4;
  if (requirement === 'prefer_recent') return 0.25;
  return 0;
}
