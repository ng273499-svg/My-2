/**
 * JARVIS-X v1.3.0 — Specialist research agents under ONE orchestrator.
 *
 * Eight contracts, no free-running autonomy:
 *
 *   research_planner        question → bounded plan
 *   source_discovery        plan → candidate URLs
 *   source_quality          source → quality decomposition
 *   evidence_analyst        source → bounded evidence units
 *   contradiction_analyst   evidence → contradictions (both sides kept)
 *   fact_checker            claim → verdict + rationale
 *   citation_verifier       findings → verified citations
 *   research_critic         whole result → structured critique
 *
 * Agents never talk to each other and never re-enter the orchestrator. Each is
 * a pure, bounded function invoked in a fixed order, so there is no
 * agent-to-agent loop that could run away.
 */

import type {
  ClaimNode,
  CitationVerificationResult,
  ConfidenceAssessment,
  Contradiction,
  FactCheckResult,
  ResearchMode,
  WebCitation,
  WebSource,
} from './types';
import type { FreshnessSummary } from './freshness';

export type ResearchAgentId =
  | 'research_planner'
  | 'source_discovery'
  | 'source_quality'
  | 'evidence_analyst'
  | 'contradiction_analyst'
  | 'fact_checker'
  | 'citation_verifier'
  | 'research_critic';

export interface AgentContract {
  id: ResearchAgentId;
  role: string;
  inputs: string[];
  outputs: string[];
  /** Hard bound this agent must respect. */
  bound: string;
  /** Permission level — research agents are read-only by construction. */
  authority: 'READ_ONLY';
}

export const RESEARCH_AGENT_CONTRACTS: AgentContract[] = [
  {
    id: 'research_planner',
    role: 'Turn a question + intent into a bounded research plan.',
    inputs: ['question', 'intent', 'mode budget'],
    outputs: ['objective', 'sub-questions', 'queries', 'stopping criteria'],
    bound: 'maxQueries ≤ 12; deadline ≤ 120 s',
    authority: 'READ_ONLY',
  },
  {
    id: 'source_discovery',
    role: 'Issue the planned queries against the configured search provider.',
    inputs: ['queries', 'search provider status'],
    outputs: ['candidate urls', 'search honesty metadata'],
    bound: 'maxQueries; no retry storm',
    authority: 'READ_ONLY',
  },
  {
    id: 'source_quality',
    role: 'Score each source against the question (never a static domain list).',
    inputs: ['source', 'intent', 'freshness requirement'],
    outputs: ['quality decomposition', 'signals'],
    bound: 'per source, O(1)',
    authority: 'READ_ONLY',
  },
  {
    id: 'evidence_analyst',
    role: 'Extract bounded, citable evidence passages.',
    inputs: ['source text', 'question'],
    outputs: ['evidence units'],
    bound: 'maxEvidenceUnits ≤ 160; passage ≤ 600 chars',
    authority: 'READ_ONLY',
  },
  {
    id: 'contradiction_analyst',
    role: 'Detect disagreement and preserve both positions.',
    inputs: ['evidence', 'sources'],
    outputs: ['contradictions'],
    bound: 'max 8 stored',
    authority: 'READ_ONLY',
  },
  {
    id: 'fact_checker',
    role: 'Adjudicate a claim into one of six verdicts.',
    inputs: ['claim graph', 'evidence', 'history'],
    outputs: ['verdict', 'counts', 'rationale'],
    bound: 'single pass',
    authority: 'READ_ONLY',
  },
  {
    id: 'citation_verifier',
    role: 'Verify every citation before anything is published.',
    inputs: ['findings', 'citations', 'evidence', 'sources'],
    outputs: ['verified citations', 'issues', 'removed claims'],
    bound: 'single pass',
    authority: 'READ_ONLY',
  },
  {
    id: 'research_critic',
    role: 'Critique the finished result and state concrete gaps.',
    inputs: ['result'],
    outputs: ['passed flag', 'issues', 'recommendations'],
    bound: '≤ 12 issues',
    authority: 'READ_ONLY',
  },
];

/** Research agents hold no tool authority at all. */
export function agentCanExecuteTools(_id: ResearchAgentId): boolean {
  void _id;
  return false;
}

/* ==========================================================================
 * Research critic
 * ======================================================================== */

export interface CriticInput {
  mode: ResearchMode;
  query: string;
  sources: WebSource[];
  nodes: ClaimNode[];
  contradictions: Contradiction[];
  citations: WebCitation[];
  citationVerification: CitationVerificationResult | null;
  confidence: ConfidenceAssessment;
  freshness: FreshnessSummary;
  factCheck: FactCheckResult | null;
  coverage: number;
  live: boolean;
}

export interface CriticIssue {
  code: string;
  severity: 'INFO' | 'WARNING' | 'BLOCKER';
  message: string;
}

export interface CriticResult {
  passed: boolean;
  issues: CriticIssue[];
  recommendations: string[];
}

export function runResearchCritic(input: CriticInput): CriticResult {
  const issues: CriticIssue[] = [];
  const recommendations: string[] = [];

  const readable = input.sources.filter((source) => source.fetchStatus === 'OK');
  const inaccessible = input.sources.filter((source) => source.fetchStatus !== 'OK');
  const groups = new Set(readable.filter((source) => !source.duplicateOf).map((source) => source.independenceGroup));

  // ---- Blockers ----
  if (readable.length === 0) {
    issues.push({
      code: 'NO_READABLE_SOURCES',
      severity: 'BLOCKER',
      message: 'No source could be read, so no finding may be published.',
    });
  }

  if (input.citationVerification && !input.citationVerification.ok) {
    const unsupported = input.citationVerification.issues.filter((issue) => issue.kind === 'UNSUPPORTED').length;
    if (unsupported > 0) {
      issues.push({
        code: 'UNSUPPORTED_CITATIONS_REMOVED',
        severity: 'WARNING',
        message: `${unsupported} citation(s) did not support their finding and were removed.`,
      });
    }
    if (input.citationVerification.removedClaims.length > 0) {
      issues.push({
        code: 'CLAIMS_REMOVED',
        severity: 'WARNING',
        message: `${input.citationVerification.removedClaims.length} finding(s) were removed because no citation survived verification.`,
      });
    }
  }

  // ---- Corroboration ----
  if (readable.length > 0 && groups.size < 2) {
    issues.push({
      code: 'SINGLE_INDEPENDENCE_GROUP',
      severity: 'WARNING',
      message: 'All readable sources belong to one independence group, so nothing is corroborated.',
    });
    recommendations.push('Look for a genuinely independent second source before relying on this answer.');
  }

  // ---- Coverage ----
  if (input.coverage < 0.5) {
    issues.push({
      code: 'LOW_COVERAGE',
      severity: 'WARNING',
      message: `Only ${Math.round(input.coverage * 100)}% of planned sub-questions received evidence.`,
    });
    recommendations.push('Narrow the question or allow a deeper research mode to cover the gaps.');
  }

  // ---- Freshness ----
  if (input.freshness.dated === 0) {
    issues.push({
      code: 'NO_VERIFIABLE_DATES',
      severity: 'INFO',
      message: 'No source asserted a verifiable publication date; recency is unknown.',
    });
  } else if (input.freshness.stale > 0) {
    issues.push({
      code: 'STALE_SOURCES',
      severity: 'WARNING',
      message: `${input.freshness.stale} dated source(s) are stale for this question.`,
    });
  }

  // ---- Conflicts ----
  if (input.contradictions.length > 0) {
    issues.push({
      code: 'CONFLICTS_RECORDED',
      severity: 'INFO',
      message: `${input.contradictions.length} contradiction(s) were recorded and both sides were kept.`,
    });
  }

  // ---- Confidence honesty ----
  if (input.confidence.level === 'HIGH' && groups.size < 3) {
    issues.push({
      code: 'CONFIDENCE_NOT_JUSTIFIED',
      severity: 'WARNING',
      message: 'HIGH confidence was asserted without three independent source groups.',
    });
  }

  // ---- Accessibility honesty ----
  if (inaccessible.length > 0) {
    issues.push({
      code: 'INACCESSIBLE_SOURCES',
      severity: 'INFO',
      message: `${inaccessible.length} source(s) could not be read and contributed no evidence.`,
    });
  }

  // ---- Live honesty ----
  if (!input.live) {
    issues.push({
      code: 'NON_LIVE_PROVIDER',
      severity: 'INFO',
      message: 'Evidence came from a NON-LIVE provider; the result must not be presented as live web research.',
    });
  }

  // ---- Claim level corroboration ----
  const supportedWithoutIndependence = input.nodes.filter(
    (node) => node.state === 'SUPPORTED' && node.independentSupportCount < 2
  );
  if (supportedWithoutIndependence.length > 0) {
    issues.push({
      code: 'SUPPORTED_WITHOUT_CORROBORATION',
      severity: 'WARNING',
      message: `${supportedWithoutIndependence.length} claim(s) were marked SUPPORTED without two independent groups.`,
    });
  }

  const passed = !issues.some((issue) => issue.severity === 'BLOCKER');

  return {
    passed,
    issues: issues.slice(0, 12),
    recommendations: recommendations.slice(0, 4),
  };
}
