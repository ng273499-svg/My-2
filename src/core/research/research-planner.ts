/**
 * JARVIS-X v1.3.0 — Bounded research planner.
 *
 * Produces the plan that governs the whole run:
 *   main question · sub-questions · queries · evidence categories ·
 *   freshness requirement · preferred source types · stopping criteria ·
 *   hard budgets
 *
 * Every number is clamped to HARD_CEILING, so a hostile or malformed request
 * cannot widen the plan into an open crawl.
 */

import {
  HARD_CEILING,
  clampBudget,
  type ResearchBudget,
  type ResearchIntent,
  type ResearchMode,
  type ResearchObjective,
  type ResearchPlan,
  type WebSourceType,
} from './types';
import { expandQueries } from './query-expansion';
import { shortHash } from './text-utils';

export interface PlanOptions {
  now: Date;
  mode: ResearchMode;
  /** Caller hints, always clamped. */
  maxQueries?: number;
  maxSources?: number;
  freshness?: 'any' | 'recent' | 'latest';
}

export function buildResearchPlan(query: string, intent: ResearchIntent, options: PlanOptions): ResearchPlan {
  const budget = clampBudget(options.mode, {
    ...(typeof options.maxQueries === 'number' ? { maxQueries: options.maxQueries } : {}),
    ...(typeof options.maxSources === 'number' ? { maxSources: options.maxSources } : {}),
  });

  const freshnessRequirement = resolveFreshnessRequirement(options.freshness, intent);
  if (freshnessRequirement === 'must_be_current') {
    // Freshness dominates ranking for current-information questions.
    budget.freshnessWeight = Math.max(budget.freshnessWeight, 0.4);
  }

  const maxQueries = Math.min(budget.maxQueries, HARD_CEILING.maxQueries);
  const queries = expandQueries({ query, intent, maxQueries, now: options.now });

  const objective: ResearchObjective = {
    mainQuestion: query.trim(),
    subQuestions: deriveSubQuestions(query, intent),
    searchQueries: queries,
    requiredEvidenceCategories: evidenceCategoriesFor(intent),
    freshnessRequirement,
    preferredSourceTypes: preferredSourceTypesFor(intent),
    stoppingCriteria: [
      `Stop after ${maxQueries} quer${maxQueries === 1 ? 'y' : 'ies'}.`,
      `Stop after ${budget.maxSources} normalized sources.`,
      `Stop after ${budget.maxFollowUpRounds} follow-up round(s).`,
      'Stop when every planned sub-question has at least one supporting source.',
      'Stop when the deadline is reached and report what was gathered so far.',
    ],
  };

  return {
    planId: `plan-${shortHash(`${query}:${options.mode}:${options.now.toISOString()}`)}`,
    intent,
    objective,
    budget,
    maxQueries,
    maxSources: Math.min(budget.maxSources, HARD_CEILING.maxSources),
    maxFollowUpRounds: Math.min(budget.maxFollowUpRounds, HARD_CEILING.maxFollowUpRounds),
    generatedAt: options.now.toISOString(),
  };
}

/* ==========================================================================
 * Sub-questions
 * ======================================================================== */

/**
 * Derive 2–5 concrete sub-questions.
 *
 * These are produced by template, from the user's own words only. No content is
 * invented: a sub-question is a way to look at the question, not an answer.
 */
export function deriveSubQuestions(query: string, intent: ResearchIntent): string[] {
  const cleaned = query.trim().replace(/\s+/g, ' ');
  const subject = subjectOf(cleaned);
  const questions: string[] = [];

  const push = (text: string): void => {
    const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (normalized.length < 8) return;
    for (const existing of questions) {
      if (existing.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === normalized) return;
    }
    questions.push(text);
  };

  switch (intent.kind) {
    case 'fact_checking':
      push(`What do primary sources state about ${subject}?`);
      push(`Is there independent evidence that supports or contradicts ${subject}?`);
      push(`Has the claim about ${subject} been accurate historically?`);
      break;

    case 'comparison':
      push(`What are the documented differences for ${subject}?`);
      push(`What do independent benchmarks say about ${subject}?`);
      push(`What limitations or drawbacks are reported for ${subject}?`);
      break;

    case 'current_information':
      push(`What is the most recent documented state of ${subject}?`);
      push(`What do official release notes or announcements say about ${subject}?`);
      push(`When was ${subject} last verifiably updated?`);
      break;

    case 'technical_investigation':
      push(`What does the official documentation state about ${subject}?`);
      push(`What are the documented constraints or limitations of ${subject}?`);
      push(`Which version introduced changes affecting ${subject}?`);
      break;

    case 'academic_discovery':
      push(`Which peer-reviewed studies address ${subject}?`);
      push(`What sample sizes and methods are reported for ${subject}?`);
      push(`What limitations do the studies of ${subject} acknowledge?`);
      break;

    case 'market_product_research':
      push(`What does the vendor officially state about ${subject}?`);
      push(`What do independent sources report about ${subject}?`);
      push(`What pricing or availability is verifiable for ${subject}?`);
      break;

    case 'source_discovery':
      push(`Which primary or official sources cover ${subject}?`);
      push(`Which authoritative references are available for ${subject}?`);
      break;

    case 'exploratory_research':
      push(`What is the documented background of ${subject}?`);
      push(`What does current evidence say about ${subject}?`);
      push(`What is contested or uncertain about ${subject}?`);
      break;

    case 'factual_lookup':
    default:
      push(`What do authoritative sources state about ${subject}?`);
      push(`Is there any conflicting information about ${subject}?`);
      break;
  }

  return questions.slice(0, 5);
}

/**
 * Extract the topic from a question without inventing one.
 * Falls back to the whole question when no clean subject can be isolated.
 */
export function subjectOf(question: string): string {
  const cleaned = question
    .replace(/\?+$/g, '')
    .replace(/^\s*(?:is\s+it\s+true\s+that|is|are|was|were|does|do|did|can|could|should|would|will)\s+/i, '')
    .replace(/^\s*(?:what|which|who|whom|where|when|why|how)\s+(?:is|are|was|were|does|do|did|has|have|can|could|should|would|will)\s+/i, '')
    .replace(/^\s*(?:what|which|who|where|when|why|how)\s+/i, '')
    .replace(/^\s*(?:please\s+)?(?:research|find|look\s+up|tell\s+me\s+about|explain|compare)\s+/i, '')
    .replace(/^\s*(?:the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length >= 4 ? cleaned : question.trim();
}

/* ==========================================================================
 * Policy tables
 * ======================================================================== */

function resolveFreshnessRequirement(
  hint: 'any' | 'recent' | 'latest' | undefined,
  intent: ResearchIntent
): 'none' | 'prefer_recent' | 'must_be_current' {
  if (hint === 'latest') return 'must_be_current';
  if (hint === 'recent') return 'prefer_recent';
  if (hint === 'any') return 'none';

  if (intent.kind === 'current_information') return 'must_be_current';
  if (intent.freshnessSensitive || intent.kind === 'market_product_research') return 'prefer_recent';
  return 'none';
}

function preferredSourceTypesFor(intent: ResearchIntent): WebSourceType[] {
  switch (intent.kind) {
    case 'technical_investigation':
      return ['PRIMARY_OFFICIAL', 'STANDARDS_BODY', 'ACADEMIC', 'ESTABLISHED_REPORTING', 'COMMUNITY_FORUM'];
    case 'academic_discovery':
      return ['ACADEMIC', 'GOVERNMENT_INSTITUTIONAL', 'PRIMARY_OFFICIAL'];
    case 'fact_checking':
      return ['PRIMARY_OFFICIAL', 'GOVERNMENT_INSTITUTIONAL', 'STANDARDS_BODY', 'ESTABLISHED_REPORTING', 'ACADEMIC'];
    case 'current_information':
      return ['PRIMARY_OFFICIAL', 'ESTABLISHED_REPORTING', 'GOVERNMENT_INSTITUTIONAL'];
    case 'market_product_research':
      return ['ESTABLISHED_REPORTING', 'SECONDARY_REPORTING', 'GOVERNMENT_INSTITUTIONAL', 'PRIMARY_OFFICIAL'];
    case 'comparison':
      return ['PRIMARY_OFFICIAL', 'ACADEMIC', 'ESTABLISHED_REPORTING', 'SECONDARY_REPORTING'];
    case 'source_discovery':
      return ['PRIMARY_OFFICIAL', 'STANDARDS_BODY', 'GOVERNMENT_INSTITUTIONAL', 'ACADEMIC'];
    default:
      return ['PRIMARY_OFFICIAL', 'ESTABLISHED_REPORTING', 'ACADEMIC', 'SECONDARY_REPORTING'];
  }
}

function evidenceCategoriesFor(intent: ResearchIntent): string[] {
  switch (intent.kind) {
    case 'technical_investigation':
      return ['official specification', 'reference documentation', 'release notes', 'practitioner reports'];
    case 'academic_discovery':
      return ['peer-reviewed study', 'preprint', 'systematic review', 'replication'];
    case 'fact_checking':
      return ['primary statement', 'independent verification', 'contradicting evidence'];
    case 'current_information':
      return ['official announcement', 'dated release note', 'independent latest reporting'];
    case 'market_product_research':
      return ['vendor claim', 'independent measurement', 'pricing evidence'];
    case 'comparison':
      return ['per-option specification', 'independent benchmark', 'reported limitations'];
    case 'source_discovery':
      return ['primary document', 'authoritative reference'];
    default:
      return ['background', 'current evidence', 'counter-evidence'];
  }
}

/* ==========================================================================
 * Object form
 * ======================================================================== */

/**
 * Stateful wrapper around `buildResearchPlan`.
 *
 * The planner holds only the injected clock — no memory of previous questions,
 * no accumulated crawl state. Every call is independent and bounded.
 */
export class ResearchPlanner {
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  plan(
    intent: ResearchIntent,
    query: string,
    options: Omit<PlanOptions, 'now' | 'mode'> & { mode?: ResearchMode } = {}
  ): ResearchPlan {
    return buildResearchPlan(query, intent, {
      now: this.now(),
      mode: options.mode ?? intent.mode,
      ...(options.maxQueries !== undefined ? { maxQueries: options.maxQueries } : {}),
      ...(options.maxSources !== undefined ? { maxSources: options.maxSources } : {}),
      ...(options.freshness !== undefined ? { freshness: options.freshness } : {}),
    });
  }
}
