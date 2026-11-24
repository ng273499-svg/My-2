/**
 * JARVIS-X v1.3.0 — Deep Research & Web Intelligence: shared contracts.
 *
 * Every value that can reach the UI is declared here so the engine, the API
 * layer and the HUD agree on one vocabulary. All enums are closed unions on
 * purpose: an unknown state is a bug, not a string.
 */

/* ==========================================================================
 * Modes and bounded budgets
 * ======================================================================== */

export type ResearchMode =
  | 'QUICK_RESEARCH'
  | 'DEEP_RESEARCH'
  | 'FACT_CHECK'
  | 'COMPARE'
  | 'LATEST'
  | 'TECHNICAL_RESEARCH'
  | 'MARKET_RESEARCH'
  | 'ACADEMIC_DISCOVERY'
  | 'SOURCE_DISCOVERY';

export const RESEARCH_MODES: ResearchMode[] = [
  'QUICK_RESEARCH',
  'DEEP_RESEARCH',
  'FACT_CHECK',
  'COMPARE',
  'LATEST',
  'TECHNICAL_RESEARCH',
  'MARKET_RESEARCH',
  'ACADEMIC_DISCOVERY',
  'SOURCE_DISCOVERY',
];

export interface ResearchBudget {
  /** Maximum distinct search queries the planner may issue. */
  maxQueries: number;
  /** Maximum sources kept after normalization. */
  maxSources: number;
  /** Maximum network fetches (each URL costs one). */
  maxFetches: number;
  /** Extra retrieve→gap→retrieve rounds. DEEP only. */
  maxFollowUpRounds: number;
  /** Maximum evidence units extracted across all sources. */
  maxEvidenceUnits: number;
  /** Token ceiling for the assembled synthesis context. */
  maxContextTokens: number;
  /** Wall-clock ceiling for the whole task. */
  deadlineMs: number;
  /** How hard freshness pushes ranking (0..1). */
  freshnessWeight: number;
  /** Minimum independent groups before evidence is called corroborated. */
  minIndependentSources: number;
}

/**
 * Hard ceiling. No caller-supplied number can raise these — the planner clamps
 * every request to this object, so a malformed payload can never turn a
 * research request into an open crawl.
 */
export const HARD_CEILING = {
  maxQueries: 12,
  maxSources: 40,
  maxFetches: 20,
  maxFollowUpRounds: 3,
  maxEvidenceUnits: 160,
  maxContextTokens: 8_000,
  deadlineMs: 120_000,
} as const;

export const RESEARCH_BUDGETS: Record<ResearchMode, ResearchBudget> = {
  QUICK_RESEARCH: {
    maxQueries: 2,
    maxSources: 6,
    maxFetches: 6,
    maxFollowUpRounds: 0,
    maxEvidenceUnits: 24,
    maxContextTokens: 2_000,
    deadlineMs: 25_000,
    freshnessWeight: 0.15,
    minIndependentSources: 2,
  },
  DEEP_RESEARCH: {
    maxQueries: 8,
    maxSources: 24,
    maxFetches: 16,
    maxFollowUpRounds: 3,
    maxEvidenceUnits: 120,
    maxContextTokens: 6_000,
    deadlineMs: 90_000,
    freshnessWeight: 0.2,
    minIndependentSources: 3,
  },
  FACT_CHECK: {
    maxQueries: 5,
    maxSources: 16,
    maxFetches: 12,
    maxFollowUpRounds: 1,
    maxEvidenceUnits: 80,
    maxContextTokens: 4_000,
    deadlineMs: 60_000,
    freshnessWeight: 0.25,
    minIndependentSources: 2,
  },
  COMPARE: {
    maxQueries: 6,
    maxSources: 20,
    maxFetches: 14,
    maxFollowUpRounds: 2,
    maxEvidenceUnits: 100,
    maxContextTokens: 5_000,
    deadlineMs: 75_000,
    freshnessWeight: 0.2,
    minIndependentSources: 2,
  },
  LATEST: {
    maxQueries: 4,
    maxSources: 14,
    maxFetches: 12,
    maxFollowUpRounds: 1,
    maxEvidenceUnits: 70,
    maxContextTokens: 3_500,
    deadlineMs: 50_000,
    freshnessWeight: 0.45,
    minIndependentSources: 2,
  },
  TECHNICAL_RESEARCH: {
    maxQueries: 6,
    maxSources: 18,
    maxFetches: 14,
    maxFollowUpRounds: 2,
    maxEvidenceUnits: 96,
    maxContextTokens: 5_000,
    deadlineMs: 75_000,
    freshnessWeight: 0.15,
    minIndependentSources: 2,
  },
  MARKET_RESEARCH: {
    maxQueries: 6,
    maxSources: 18,
    maxFetches: 14,
    maxFollowUpRounds: 2,
    maxEvidenceUnits: 96,
    maxContextTokens: 5_000,
    deadlineMs: 75_000,
    freshnessWeight: 0.35,
    minIndependentSources: 3,
  },
  ACADEMIC_DISCOVERY: {
    maxQueries: 6,
    maxSources: 20,
    maxFetches: 14,
    maxFollowUpRounds: 2,
    maxEvidenceUnits: 100,
    maxContextTokens: 5_000,
    deadlineMs: 75_000,
    freshnessWeight: 0.1,
    minIndependentSources: 2,
  },
  SOURCE_DISCOVERY: {
    maxQueries: 4,
    maxSources: 20,
    maxFetches: 12,
    maxFollowUpRounds: 1,
    maxEvidenceUnits: 60,
    maxContextTokens: 3_000,
    deadlineMs: 50_000,
    freshnessWeight: 0.2,
    minIndependentSources: 2,
  },
};

/** Clamp an arbitrary budget request to the hard ceiling. */
export function clampBudget(mode: ResearchMode, overrides?: Partial<ResearchBudget>): ResearchBudget {
  const base = RESEARCH_BUDGETS[mode];
  const pick = (key: keyof ResearchBudget, ceilingKey?: keyof typeof HARD_CEILING): number => {
    const requested = overrides?.[key];
    const value = typeof requested === 'number' && Number.isFinite(requested) ? requested : base[key];
    const ceiling = ceilingKey ? HARD_CEILING[ceilingKey] : Number.POSITIVE_INFINITY;
    return Math.max(1, Math.min(value, ceiling));
  };

  return {
    maxQueries: pick('maxQueries', 'maxQueries'),
    maxSources: pick('maxSources', 'maxSources'),
    maxFetches: pick('maxFetches', 'maxFetches'),
    maxFollowUpRounds: Math.min(
      typeof overrides?.maxFollowUpRounds === 'number' ? overrides.maxFollowUpRounds : base.maxFollowUpRounds,
      HARD_CEILING.maxFollowUpRounds
    ),
    maxEvidenceUnits: pick('maxEvidenceUnits', 'maxEvidenceUnits'),
    maxContextTokens: pick('maxContextTokens', 'maxContextTokens'),
    deadlineMs: pick('deadlineMs', 'deadlineMs'),
    freshnessWeight: Math.max(0, Math.min(1, overrides?.freshnessWeight ?? base.freshnessWeight)),
    minIndependentSources: Math.max(1, Math.min(overrides?.minIndependentSources ?? base.minIndependentSources, 6)),
  };
}

/* ==========================================================================
 * Intent
 * ======================================================================== */

export type ResearchIntentKind =
  | 'factual_lookup'
  | 'exploratory_research'
  | 'comparison'
  | 'fact_checking'
  | 'current_information'
  | 'technical_investigation'
  | 'academic_discovery'
  | 'market_product_research'
  | 'source_discovery';

export interface ResearchIntent {
  kind: ResearchIntentKind;
  mode: ResearchMode;
  /** 0..1 — how confident the classifier is. Never presented as certainty. */
  confidence: number;
  /** Short, user-facing rationale. Never private chain-of-thought. */
  rationale: string;
  freshnessSensitive: boolean;
  requiresPrimarySources: boolean;
  /** True when the request names a specific claim to check. */
  claimCentric: boolean;
  detectedEntities: string[];
}

/* ==========================================================================
 * Search provider
 * ======================================================================== */

export type SearchProviderStatus = 'AVAILABLE' | 'DEGRADED' | 'UNCONFIGURED' | 'UNAVAILABLE';

export interface SearchProviderHealth {
  providerId: string;
  label: string;
  status: SearchProviderStatus;
  /** TRUE only for a real external service. Synthetic adapters must be false. */
  live: boolean;
  /** Human-readable, honest statement about what this provider can do. */
  detail: string;
  /** True when the provider costs money. The default stack is zero-cost. */
  zeroCost: boolean;
}

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  /** Only when the provider genuinely asserts one. Otherwise null. */
  publishedAt: string | null;
  academic?: AcademicMetadata | null;
}

export interface AcademicMetadata {
  doi: string | null;
  authors: string[];
  venue: string | null;
  citationCount: number | null;
  isPreprint: boolean;
  /** True when only metadata/abstract was available — the paper was NOT read. */
  metadataOnly: boolean;
}

export interface SearchQueryInput {
  query: string;
  limit: number;
  signal?: AbortSignal;
  /** Academic mode passes this so an adapter can restrict to scholarly indexes. */
  scholarlyOnly?: boolean;
}

export interface SearchResponse {
  ok: boolean;
  providerId: string;
  live: boolean;
  results: SearchResult[];
  /** Honest status for THIS call (a provider can degrade transiently). */
  status?: SearchProviderStatus;
  detail?: string;
  errorCode?: ResearchFailureCode;
}

/* ==========================================================================
 * Failure + fetch vocabulary
 * ======================================================================== */

export type ResearchFailureCode =
  | 'SEARCH_UNAVAILABLE'
  | 'QUERY_REJECTED'
  | 'CANCELLED'
  | 'DEADLINE_EXCEEDED'
  | 'ALL_SOURCES_INACCESSIBLE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CITATION_VERIFICATION_FAILED'
  | 'INTERNAL_ERROR'
  | 'INVALID_QUERY';

/**
 * Exactly the statuses the specification names, plus UNSAFE_URL /
 * REDIRECT_REJECTED which are required by the SSRF layer. Nothing here implies
 * a partial read: a non-OK status means NO page content was used.
 */
export type FetchStatus =
  | 'OK'
  | 'ROBOTS_RESTRICTED'
  | 'AUTH_REQUIRED'
  | 'PAYWALLED'
  | 'BLOCKED'
  | 'RATE_LIMITED'
  | 'FETCH_FAILED'
  | 'UNSAFE_URL'
  | 'REDIRECT_REJECTED'
  | 'UNSUPPORTED_CONTENT'
  | 'TOO_LARGE'
  | 'TIMEOUT';

export interface FetchRequest {
  url: string;
  /** Per-call override, always clamped to the provider ceiling. */
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchedPage {
  status: FetchStatus;
  finalUrl: string | null;
  requestedUrl: string;
  httpStatus: number | null;
  contentType: string | null;
  bytes: number;
  /** Raw body — only present when status === 'OK'. */
  body: string | null;
  redirectChain: string[];
  detail: string;
  durationMs: number;
}

/** Structural contract implemented by WebFetchProvider and the fixture provider. */
export interface FetchProviderLike {
  fetch(request: FetchRequest): Promise<FetchedPage>;
}

export interface WebFetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  maxUrlLength: number;
}

export const DEFAULT_FETCH_LIMITS: WebFetchLimits = {
  maxBytes: 2 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 4,
  maxUrlLength: 2_048,
};

/* ==========================================================================
 * Sources
 * ======================================================================== */

export type WebSourceType =
  | 'PRIMARY_OFFICIAL'
  | 'STANDARDS_BODY'
  | 'ACADEMIC'
  | 'GOVERNMENT_INSTITUTIONAL'
  | 'ESTABLISHED_REPORTING'
  | 'SECONDARY_REPORTING'
  | 'MANUFACTURER_CLAIM'
  | 'COMMUNITY_FORUM'
  | 'OWNER_DOCUMENT'
  | 'UNKNOWN';

export type ProvenanceKind = 'WEB_SOURCE' | 'DOCUMENT_SOURCE';

export interface WebSource {
  sourceId: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  retrievedAt: string;
  contentHash: string;
  sourceType: WebSourceType;
  trustSignals: string[];
  freshnessSignals: string[];
  extractedText: string;
  provenance: ProvenanceKind;
  fetchStatus: FetchStatus;
  /** Search-provider metadata, carried for academic modes. */
  academic: AcademicMetadata | null;
  /** True when this source duplicates another (syndication/mirror). */
  duplicateOf: string | null;
  /** Group key for independence analysis (syndication cluster). */
  independenceGroup: string;
  quality: SourceQuality | null;
}

export interface SourceQuality {
  /** 0..1 transparent composite. */
  overall: number;
  relevance: number;
  authority: number;
  freshness: number;
  completeness: number;
  corroboration: number;
  /** Named signals — shown to the user instead of hidden reasoning. */
  signals: string[];
}

/* ==========================================================================
 * Evidence + claims
 * ======================================================================== */

export type EvidenceSupportType = 'SUPPORTS' | 'CONTRADICTS' | 'NEUTRAL' | 'CONTEXT';

export interface EvidenceUnit {
  evidenceId: string;
  sourceId: string;
  /** Set only for DOCUMENT_SOURCE evidence. */
  documentId: string | null;
  provenance: ProvenanceKind;
  /** Normalized restatement of what the passage asserts. */
  claim: string;
  /** Verbatim bounded passage. Never a full page. */
  passage: string;
  section: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  relevance: number;
  quality: number;
  freshness: number;
  supportType: EvidenceSupportType;
  /** Percentile rank of the passage inside its source. */
  positionInSource: number;
}

export type VerificationState =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'CONFLICTING'
  | 'UNSUPPORTED'
  | 'OUTDATED'
  | 'UNKNOWN';

export interface ClaimPosition {
  sourceId: string;
  sourceTitle: string;
  domain: string;
  evidenceId: string;
  statement: string;
  publishedAt: string | null;
  stance: 'SUPPORTS' | 'CONTRADICTS';
}

export interface ClaimNode {
  claimId: string;
  claim: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  /** Distinct independence groups among supporting sources. */
  independentSupportCount: number;
  supportingSourceIds: string[];
  contradictingSourceIds: string[];
  freshnessScore: number;
  confidence: number;
  state: VerificationState;
  contested: boolean;
  positions: ClaimPosition[];
  notes: string[];
}

export interface ClaimGraph {
  nodes: ClaimNode[];
  extractedCount: number;
  staleSuperseded: number;
}

export interface Contradiction {
  contradictionId: string;
  claim: string;
  sideA: ClaimPosition;
  sideB: ClaimPosition;
  /** Explanation ONLY when evidence supports one. Otherwise null. */
  possibleExplanation: string | null;
  resolved: boolean;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
}

/* ==========================================================================
 * Fact check
 * ======================================================================== */

export type FactCheckVerdict =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'CONTRADICTED'
  | 'MIXED'
  | 'OUTDATED'
  | 'INSUFFICIENT_EVIDENCE';

export interface FactCheckResult {
  claim: string;
  subClaims: string[];
  verdict: FactCheckVerdict;
  supportingCount: number;
  contradictingCount: number;
  independentSupport: number;
  rationale: string;
  claimIds: string[];
  freshnessNote: string | null;
}

/* ==========================================================================
 * Confidence
 * ======================================================================== */

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';

export interface ConfidenceAssessment {
  level: ConfidenceLevel;
  score: number;
  components: {
    evidenceQuality: number;
    sourceIndependence: number;
    corroboration: number;
    freshness: number;
    contradictionPenalty: number;
    coverage: number;
  };
  notes: string[];
}

/* ==========================================================================
 * Citations
 * ======================================================================== */

export interface WebCitation {
  citationId: string;
  sourceId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  domain: string;
  retrievedAt: string;
  publishedAt: string | null;
  evidenceIds: string[];
  provenance: ProvenanceKind;
}

export interface CitationVerificationIssue {
  kind: 'MISSING_SOURCE' | 'WRONG_SOURCE' | 'UNSUPPORTED' | 'STALE' | 'DUPLICATE_OVERCOUNT';
  citationId: string;
  claimId: string;
  detail: string;
}

export interface CitationVerificationResult {
  ok: boolean;
  checkedClaims: number;
  verifiedCitations: number;
  issues: CitationVerificationIssue[];
  /** Claims removed or downgraded because support could not be verified. */
  removedClaims: string[];
}

/* ==========================================================================
 * Research context + synthesis
 * ======================================================================== */

export interface ResearchContext {
  blocks: Array<{
    sourceId: string;
    citationId: string;
    provenance: ProvenanceKind;
    title: string;
    domain: string;
    publishedAt: string | null;
    passages: Array<{ evidenceId: string; text: string; section: string | null }>;
  }>;
  tokenEstimate: number;
  includedSourceIds: string[];
  excludedSourceIds: string[];
  truncated: boolean;
  duplicateGroupsCollapsed: number;
}

export interface ResearchFinding {
  text: string;
  claimId: string;
  state: VerificationState;
  citationIds: string[];
  confidence: number;
}

export interface ResearchSynthesis {
  executiveSummary: string;
  verifiedFindings: ResearchFinding[];
  qualifiedFindings: ResearchFinding[];
  conflicts: ResearchFinding[];
  unknowns: string[];
  caveats: string[];
}

export interface ResearchReport {
  title: string;
  query: string;
  mode: ResearchMode;
  generatedAt: string;
  /** True only when at least one source was retrieved over a live network. */
  live: boolean;
  status: 'COMPLETED' | 'PARTIAL' | 'INSUFFICIENT_EVIDENCE' | 'CANCELLED' | 'FAILED';
  executiveSummary: string;
  verifiedFindings: ResearchFinding[];
  qualifiedFindings: ResearchFinding[];
  conflicts: ResearchFinding[];
  unknowns: string[];
  citations: WebCitation[];
  confidence: ConfidenceAssessment;
  factCheck: FactCheckResult | null;
  contradictions: Contradiction[];
  sourcesUsed: number;
  sourcesDiscovered: number;
  providerStatus: SearchProviderHealth;
  limitations: string[];
  progress: ResearchProgressEvent[];
}

/* ==========================================================================
 * Progress + tasks
 * ======================================================================== */

export type ResearchStage =
  | 'Understanding question'
  | 'Planning research'
  | 'Searching sources'
  | 'Reading evidence'
  | 'Evaluating sources'
  | 'Checking contradictions'
  | 'Following up'
  | 'Verifying claims'
  | 'Checking citations'
  | 'Research complete';

export const RESEARCH_STAGES: ResearchStage[] = [
  'Understanding question',
  'Planning research',
  'Searching sources',
  'Reading evidence',
  'Evaluating sources',
  'Checking contradictions',
  'Following up',
  'Verifying claims',
  'Checking citations',
  'Research complete',
];

export interface ResearchProgressEvent {
  stage: ResearchStage;
  at: string;
  /** Safe, user-facing status text. No chain-of-thought. */
  detail: string;
  counts?: {
    queries?: number;
    sources?: number;
    evidence?: number;
    contradictions?: number;
  };
}

export type ResearchTaskStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CANCELLED'
  | 'FAILED';

export interface ResearchRequest {
  ownerId: string;
  query: string;
  mode?: ResearchMode;
  projectId?: string | null;
  /** Explicitly selected document IDs for document+web comparison. */
  documentIds?: string[];
  freshness?: 'any' | 'recent' | 'latest';
  maxSources?: number;
  maxQueries?: number;
  signal?: AbortSignal;
  /** Injected clock for deterministic tests. */
  now?: Date;
}

export interface ResearchResult {
  ok: boolean;
  taskId: string;
  query: string;
  mode: ResearchMode;
  status: ResearchTaskStatus;
  intent: ResearchIntent;
  plan: ResearchPlan;
  report: ResearchReport | null;
  sources: WebSource[];
  evidence: EvidenceUnit[];
  claimGraph: ClaimGraph;
  errors: ResearchFailureCode[];
  durationMs: number;
  cancelledAtStage: ResearchStage | null;
  metrics: ResearchMetrics;
}

export interface ResearchObjective {
  mainQuestion: string;
  subQuestions: string[];
  searchQueries: string[];
  requiredEvidenceCategories: string[];
  freshnessRequirement: 'none' | 'prefer_recent' | 'must_be_current';
  preferredSourceTypes: WebSourceType[];
  stoppingCriteria: string[];
}

export interface ResearchPlan {
  planId: string;
  intent: ResearchIntent;
  objective: ResearchObjective;
  budget: ResearchBudget;
  maxQueries: number;
  maxSources: number;
  maxFollowUpRounds: number;
  generatedAt: string;
}

export interface ResearchMetrics {
  queryCount: number;
  searchProvider: string;
  searchProviderStatus: SearchProviderStatus;
  live: boolean;
  sourcesDiscovered: number;
  sourcesFetched: number;
  fetchFailures: Array<{ domain: string; status: FetchStatus }>;
  /** Every source that could not be read, with the honest reason. */
  unreadableSources: Array<{ url: string; status: FetchStatus }>;
  evidenceUnits: number;
  followUpRounds: number;
  contradictions: number;
  citationCount: number;
  /** Approximate size of the assembled evidence context. */
  contextTokens: number;
  /** True when the context ceiling dropped passages before synthesis. */
  contextTruncated: boolean;
  confidence: ConfidenceLevel;
  verificationStatus: string;
  cancelled: boolean;
  /** Present only when the run was cancelled. */
  cancelledAtStage?: ResearchStage | null;
}

/* ==========================================================================
 * Observability
 * ======================================================================== */

export interface ResearchObservabilityEvent {
  eventId: string;
  taskId: string;
  timestamp: string;
  stage: ResearchStage | 'task_created' | 'task_cancelled' | 'task_failed';
  detail: string;
  numbers: Record<string, number>;
}
