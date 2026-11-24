/**
 * JARVIS-X v1.3.0 — Research intent classification.
 *
 * Deterministic, explainable and short. Nine kinds, each mapped to a default
 * mode and a set of policy flags (freshness sensitivity, primary-source
 * preference, claim centricity).
 *
 * The rationale returned here is a SHORT user-facing explanation. No
 * chain-of-thought is produced or stored anywhere in this module.
 */

import type { ResearchIntent, ResearchIntentKind, ResearchMode } from './types';

export interface ClassifyOptions {
  mode?: ResearchMode;
  /** Injected clock — used only for "current information" detection. */
  now?: Date;
}

interface Rule {
  kind: ResearchIntentKind;
  patterns: RegExp[];
  weight: number;
}

const RULES: Rule[] = [
  {
    kind: 'fact_checking',
    weight: 1.35,
    patterns: [
      /\bis\s+it\s+(?:true|correct|accurate|really)\b/i,
      /\bfact[-\s]?check\b/i,
      /\bdebunk|\bmyth\b|\bmisleading\b|\bfalse\s+claim\b/i,
      /\b(?:verify|confirm)\s+(?:that|whether)\b/i,
      /\bclaim\s+that\b/i,
    ],
  },
  {
    kind: 'comparison',
    weight: 1.3,
    patterns: [
      /\bcompare\b|\bcomparison\b/i,
      /\bvs\.?\b|\bversus\b/i,
      /\bdifference\s+between\b/i,
      /\bbetter\s+than\b|\bworse\s+than\b/i,
      /\bpros\s+and\s+cons\b/i,
    ],
  },
  {
    kind: 'current_information',
    weight: 1.25,
    patterns: [
      /\blatest\b|\bnewest\b|\bmost\s+recent\b/i,
      /\bright\s+now\b|\bcurrently\b|\bcurrent\s+(?:version|price|status|state)\b/i,
      /\btoday\b|\bthis\s+(?:week|month|year)\b/i,
      /\bjust\s+(?:released|announced|launched)\b/i,
      /\bup[-\s]?to[-\s]?date\b/i,
    ],
  },
  {
    kind: 'technical_investigation',
    weight: 1.2,
    patterns: [
      /\bapi\b|\bspec(?:ification)?\b|\brfc\b|\bprotocol\b/i,
      /\bdocumentation\b|\bdocs\b|\breference\b/i,
      /\bhow\s+does\b.*\bwork\b/i,
      /\bimplementation\b|\binternals?\b|\barchitecture\b/i,
      /\bconfig(?:uration)?\b|\bdeploy(?:ment)?\b|\bperformance\b|\blatency\b/i,
      /\bsource\s+code\b|\brepository\b|\bchangelog\b/i,
    ],
  },
  {
    kind: 'academic_discovery',
    weight: 1.3,
    patterns: [
      /\bpaper(s)?\b|\bpeer[-\s]?reviewed\b|\bjournal\b|\barxiv\b|\bpreprint\b/i,
      /\bstudy\b|\bstudies\b|\bliterature\b|\bcitation(s)?\b|\bdoi\b/i,
      /\bmeta[-\s]?analysis\b|\brandomi[sz]ed\b|\bempirical\s+evidence\b/i,
    ],
  },
  {
    kind: 'market_product_research',
    weight: 1.2,
    patterns: [
      /\bmarket\s+(?:share|size|trend|analysis)\b/i,
      /\bpricing\b|\bprice\s+list\b|\bcost\s+per\b|\bsubscription\s+tier/i,
      /\bcompetitor(s)?\b|\bvendor(s)?\b|\balternative(s)?\s+to\b/i,
      /\brevenue\b|\bfunding\b|\bvaluation\b|\bipo\b/i,
    ],
  },
  {
    kind: 'source_discovery',
    weight: 1.15,
    patterns: [
      /\bfind\s+(?:me\s+)?(?:sources?|references?|citations?|papers?|articles?)\b/i,
      /\bwhere\s+(?:can|do)\s+i\s+(?:read|find)\b/i,
      /\bprimary\s+sources?\b|\bofficial\s+documents?\b/i,
      /\bbibliograph(?:y|ies)\b|\breading\s+list\b/i,
    ],
  },
  {
    kind: 'factual_lookup',
    weight: 1.0,
    patterns: [
      /^\s*(?:what|who|when|where|which)\s+(?:is|are|was|were|did|does)\b/i,
      /\bhow\s+(?:many|much|long|old|far)\b/i,
      /\bdefine\b|\bdefinition\s+of\b|\bmeaning\s+of\b/i,
    ],
  },
  {
    kind: 'exploratory_research',
    weight: 0.9,
    patterns: [
      /\bresearch\b|\bexplore\b|\bunderstand\b|\boverview\b|\bdeep\s+dive\b/i,
      /\bhistory\s+of\b|\blandscape\b|\bstate\s+of\s+the\s+art\b/i,
    ],
  },
];

const MODE_TO_KIND: Record<ResearchMode, ResearchIntentKind> = {
  QUICK_RESEARCH: 'factual_lookup',
  DEEP_RESEARCH: 'exploratory_research',
  FACT_CHECK: 'fact_checking',
  COMPARE: 'comparison',
  LATEST: 'current_information',
  TECHNICAL_RESEARCH: 'technical_investigation',
  MARKET_RESEARCH: 'market_product_research',
  ACADEMIC_DISCOVERY: 'academic_discovery',
  SOURCE_DISCOVERY: 'source_discovery',
};

const PRIMARY_SOURCE_KINDS = new Set<ResearchIntentKind>([
  'technical_investigation',
  'academic_discovery',
  'source_discovery',
  'fact_checking',
]);

const FRESHNESS_KINDS = new Set<ResearchIntentKind>(['current_information', 'market_product_research']);

export function classifyResearchIntent(query: string, options: ClassifyOptions = {}): ResearchIntent {
  const text = query.trim();

  if (options.mode) {
    const kind = MODE_TO_KIND[options.mode];
    return buildIntent(kind, text, options.mode, 0.95, `Mode ${options.mode} was selected explicitly.`, options.now);
  }

  const scores = new Map<ResearchIntentKind, number>();

  for (const rule of RULES) {
    let hits = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) hits += 1;
    }
    if (hits > 0) scores.set(rule.kind, hits * rule.weight);
  }

  // A question mark and a short query are WEAK evidence for a factual lookup.
  // The bonus only applies when no more specific kind also matched — otherwise
  // "what does the API specification say" would be dragged to factual_lookup.
  const onlyFactual = scores.size === 0 || (scores.size === 1 && scores.has('factual_lookup'));
  if (onlyFactual && text.length <= 90 && /\?$/.test(text)) {
    scores.set('factual_lookup', (scores.get('factual_lookup') ?? 0) + 0.4);
  }

  if (scores.size === 0) {
    const fallback: ResearchIntentKind = text.split(/\s+/).length <= 6 ? 'factual_lookup' : 'exploratory_research';
    return buildIntent(
      fallback,
      text,
      modeFor(fallback),
      0.45,
      'No strong signal was found, so a general research approach was chosen.',
      options.now
    );
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [kind, score] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;

  const margin = score - runnerUp;
  const confidence = clamp01(0.55 + Math.min(0.4, margin / Math.max(1, score)) * 0.4);

  const rationale =
    runnerUp === 0
      ? `The question clearly matches ${describe(kind)}.`
      : `The question best matches ${describe(kind)} (runner-up: ${describe(ranked[1][0])}).`;

  return buildIntent(kind, text, modeFor(kind), confidence, rationale, options.now);
}

/* ==========================================================================
 * Construction
 * ======================================================================== */

function buildIntent(
  kind: ResearchIntentKind,
  query: string,
  mode: ResearchMode,
  confidence: number,
  rationale: string,
  now: Date | undefined
): ResearchIntent {
  return {
    kind,
    mode,
    confidence: round3(clamp01(confidence)),
    rationale,
    freshnessSensitive: FRESHNESS_KINDS.has(kind) || /\b(?:latest|current|today|now)\b/i.test(query),
    requiresPrimarySources: PRIMARY_SOURCE_KINDS.has(kind),
    claimCentric: kind === 'fact_checking' || /\bis\s+it\s+true\b/i.test(query),
    detectedEntities: detectEntities(query, now),
  };
}

function modeFor(kind: ResearchIntentKind): ResearchMode {
  switch (kind) {
    case 'fact_checking':
      return 'FACT_CHECK';
    case 'comparison':
      return 'COMPARE';
    case 'current_information':
      return 'LATEST';
    case 'technical_investigation':
      return 'TECHNICAL_RESEARCH';
    case 'academic_discovery':
      return 'ACADEMIC_DISCOVERY';
    case 'market_product_research':
      return 'MARKET_RESEARCH';
    case 'source_discovery':
      return 'SOURCE_DISCOVERY';
    case 'exploratory_research':
      return 'DEEP_RESEARCH';
    case 'factual_lookup':
    default:
      return 'QUICK_RESEARCH';
  }
}

/**
 * Lightweight entity detection: quoted phrases, proper nouns and version
 * strings. Deliberately conservative — a missed entity is harmless, an invented
 * one is not.
 */
function detectEntities(query: string, now: Date | undefined): string[] {
  const entities = new Set<string>();

  for (const match of query.matchAll(/"([^"]{2,60})"/g)) entities.add(match[1].trim());

  // Capitalised multi-word phrases (skipping the first word of the sentence).
  for (const match of query.matchAll(/\b([A-Z][A-Za-z0-9.+-]{1,30}(?:\s+[A-Z][A-Za-z0-9.+-]{1,30}){0,3})\b/g)) {
    const candidate = match[1].trim();
    if (candidate.split(/\s+/).length === 1 && /^(?:The|This|That|What|Which|When|Where|Why|How|Is|Are|Was|Were|Do|Does|Did|Can|Could|Should|Would)$/.test(candidate)) {
      continue;
    }
    if (candidate.length >= 2) entities.add(candidate);
  }

  for (const match of query.matchAll(/\bv?\d+\.\d+(?:\.\d+)?\b/g)) entities.add(match[0]);

  if (now) {
    // Years are entities only when they appear in the question itself.
    for (const match of query.matchAll(/\b(?:19|20)\d{2}\b/g)) entities.add(match[0]);
  }

  return [...entities].slice(0, 8);
}

function describe(kind: ResearchIntentKind): string {
  switch (kind) {
    case 'factual_lookup':
      return 'a direct factual lookup';
    case 'exploratory_research':
      return 'open-ended exploratory research';
    case 'comparison':
      return 'a comparison of two or more options';
    case 'fact_checking':
      return 'verification of a specific claim';
    case 'current_information':
      return 'a question about current information';
    case 'technical_investigation':
      return 'a technical investigation';
    case 'academic_discovery':
      return 'academic literature discovery';
    case 'market_product_research':
      return 'market or product research';
    case 'source_discovery':
      return 'source discovery';
    default:
      return 'general research';
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
