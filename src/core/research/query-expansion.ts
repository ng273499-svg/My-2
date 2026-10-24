/**
 * JARVIS-X v1.3.0 — Bounded query expansion.
 *
 * Expansion is deliberately shallow: it adds at most a handful of
 * intent-specific reformulations and stops. There is no recursive query
 * generation, no "search the search results" loop, and no synonym explosion.
 *
 * Any date appended to a query comes from the RUNTIME clock, never from a
 * hardcoded year, so "latest" mean latest now.
 */

import type { ResearchIntent } from './types';
import { keyTerms } from './text-utils';

export interface QueryExpansionInput {
  query: string;
  intent: ResearchIntent;
  maxQueries: number;
  now: Date;
}

interface Variant {
  text: string;
  /** Only used for the modes that genuinely need it. */
  kind: 'base' | 'specific' | 'official' | 'critical' | 'temporal' | 'academic' | 'market';
}

export function expandQueries(input: QueryExpansionInput): string[] {
  const base = input.query.trim().replace(/\s+/g, ' ');
  if (!base) return [];

  const variants: Variant[] = [{ text: base, kind: 'base' }];
  const core = stripQuestionWords(base);
  const terms = keyTerms(base, 8);

  switch (input.intent.kind) {
    case 'technical_investigation':
      variants.push({ text: `${core} official documentation`, kind: 'official' });
      variants.push({ text: `${core} API reference changelog`, kind: 'specific' });
      break;

    case 'academic_discovery':
      variants.push({ text: `${core} peer reviewed study`, kind: 'academic' });
      variants.push({ text: `${core} meta-analysis findings`, kind: 'academic' });
      break;

    case 'market_product_research':
      variants.push({ text: `${core} pricing official`, kind: 'market' });
      variants.push({ text: `${core} independent review comparison`, kind: 'critical' });
      break;

    case 'comparison':
      variants.push({ text: `${core} benchmark comparison`, kind: 'specific' });
      variants.push({ text: `${core} drawbacks limitations`, kind: 'critical' });
      break;

    case 'fact_checking':
      variants.push({ text: `${core} fact check evidence`, kind: 'critical' });
      variants.push({ text: `${core} primary source statement`, kind: 'official' });
      break;

    case 'current_information': {
      // The year comes from the injected clock, not from a constant.
      const year = input.now.getUTCFullYear();
      variants.push({ text: `${core} ${year}`, kind: 'temporal' });
      variants.push({ text: `${core} release notes`, kind: 'official' });
      break;
    }

    case 'source_discovery':
      variants.push({ text: `${core} primary source`, kind: 'official' });
      variants.push({ text: `${core} official statement`, kind: 'official' });
      break;

    case 'exploratory_research':
      variants.push({ text: `${core} overview`, kind: 'specific' });
      variants.push({ text: `${core} criticism limitations`, kind: 'critical' });
      break;

    case 'factual_lookup':
    default:
      if (terms.length >= 2) variants.push({ text: terms.slice(0, 4).join(' '), kind: 'specific' });
      break;
  }

  // A second critical/limitations angle is valuable for anything evaluative.
  if (input.intent.kind === 'comparison' || input.intent.kind === 'market_product_research') {
    variants.push({ text: `${core} known issues`, kind: 'critical' });
  }

  const output: string[] = [];
  const seen = new Set<string>();

  for (const variant of variants) {
    if (output.length >= input.maxQueries) break;
    const normalized = normalizeForKey(variant.text);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(variant.text);
  }

  return output;
}

/** Remove leading question scaffolding so variants read like queries. */
function stripQuestionWords(text: string): string {
  return text
    .replace(/\?+$/g, '')
    .replace(/^\s*(?:is\s+it\s+true\s+that|is|are|was|were|does|do|did|can|could|should|would|will)\s+/i, '')
    .replace(/^\s*(?:what|which|who|whom|where|when|why|how)\s+(?:is|are|was|were|does|do|did|has|have|can|could|should|would|will)\s+/i, '')
    .replace(/^\s*(?:what|which|who|where|when|why|how)\s+/i, '')
    .replace(/^\s*(?:please\s+)?(?:research|find|look\s+up|tell\s+me\s+about|explain|compare)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/* ==========================================================================
 * Private-query minimisation
 * ======================================================================== */

const PRIVATE_MARKERS: Array<{ id: string; pattern: RegExp; replacement: string }> = [
  { id: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/gi, replacement: '[email]' },
  { id: 'phone', pattern: /\+?\d[\d\s().-]{7,}\d/g, replacement: '[phone]' },
  { id: 'url_credentials', pattern: /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, replacement: '$1' },
  { id: 'bearer_token', pattern: /\b(?:bearer|token|api[_-]?key)\s*[:=]\s*[A-Za-z0-9._-]{12,}/gi, replacement: '[secret]' },
  { id: 'project_id', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: '[identifier]' },
  { id: 'long_number', pattern: /\b\d{12,}\b/g, replacement: '[identifier]' },
  { id: 'file_path', pattern: /(?:^|\s)(?:\/(?:home|Users|var|etc|srv)\/[^\s]+)/g, replacement: ' [path]' },
];

/**
 * Reduce the private data that leaves the system in a search query.
 *
 * Minimisation is conservative: it removes personal identifiers, credentials and
 * absolute paths, and keeps the actual question. It never silently rewrites the
 * question's meaning — if nothing private is present the string is unchanged.
 */
export function minimiseQueryDisclosure(query: string): string {
  let out = query;
  for (const marker of PRIVATE_MARKERS) {
    marker.pattern.lastIndex = 0;
    out = out.replace(marker.pattern, marker.replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/* ==========================================================================
 * Follow-up query generation
 * ======================================================================== */

export interface FollowUpInput {
  uncoveredSubQuestions: string[];
  coveredSubQuestions?: string[];
  intent: ResearchIntent;
  /** Hard cap; the caller's budget always wins. */
  maxQueries?: number;
}

/**
 * Build follow-up queries for sub-questions that no evidence currently covers.
 *
 * One query per uncovered sub-question, in the order they were planned, and only
 * for sub-questions that have not already been searched. No recursive expansion:
 * a follow-up query is a single reformulation, not a new research run.
 */
export function buildFollowUpQueries(input: FollowUpInput): string[] {
  const maxQueries = Math.max(0, Math.min(input.maxQueries ?? 3, 6));
  const covered = new Set(
    (input.coveredSubQuestions ?? []).map((question) => normalizeForKey(question))
  );

  const queries: string[] = [];
  const seen = new Set<string>();

  for (const subQuestion of input.uncoveredSubQuestions) {
    if (queries.length >= maxQueries) break;

    const key = normalizeForKey(subQuestion);
    if (!key || covered.has(key) || seen.has(key)) continue;
    seen.add(key);

    const base = stripQuestionWords(subQuestion);
    if (!base) continue;

    queries.push(input.intent.kind === 'academic_discovery' ? `${base} study` : base);
  }

  return queries;
}
