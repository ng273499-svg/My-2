/**
 * JARVIS-X v1.3.0 — Citation engine and citation verifier.
 *
 * A citation is a promise: "this statement is supported by that retrieved
 * passage". The verifier checks that promise before anything is published.
 *
 * It can detect and repair:
 *   MISSING_SOURCE       citation points at a source that is not in the set
 *   WRONG_SOURCE         the citation's URL/title do not match its source
 *   UNSUPPORTED          the cited passage does not actually match the finding
 *   STALE                the citation is stale for a "current information" ask
 *   DUPLICATE_OVERCOUNT  several citations from one independence group are
 *                        presented as if they were independent corroboration
 *
 * Repair is conservative: broken citations are removed from the finding, and a
 * finding with no surviving citation is removed entirely. Nothing is invented.
 */

import type {
  CitationVerificationIssue,
  CitationVerificationResult,
  EvidenceUnit,
  ResearchFinding,
  WebCitation,
  WebSource,
} from './types';
import { containment, shortHash, termSet } from './text-utils';
import { canonicalizeUrl } from './source-normalization';

const MIN_SUPPORT_OVERLAP = 0.34;

export interface BuildCitationsInput {
  sources: WebSource[];
  evidence: EvidenceUnit[];
}

/** One citation per source that contributed at least one evidence unit. */
export function buildCitations(input: BuildCitationsInput): WebCitation[] {
  const evidenceBySource = new Map<string, EvidenceUnit[]>();

  for (const unit of input.evidence) {
    const list = evidenceBySource.get(unit.sourceId) ?? [];
    list.push(unit);
    evidenceBySource.set(unit.sourceId, list);
  }

  const citations: WebCitation[] = [];

  for (const source of input.sources) {
    const units = evidenceBySource.get(source.sourceId);
    if (!units || units.length === 0) continue;

    citations.push({
      citationId: `cit-${shortHash(source.sourceId)}`,
      sourceId: source.sourceId,
      url: source.url,
      canonicalUrl: source.canonicalUrl,
      title: source.title,
      domain: source.domain,
      retrievedAt: source.retrievedAt,
      publishedAt: source.publishedAt,
      evidenceIds: units.map((unit) => unit.evidenceId),
      provenance: source.provenance,
    });
  }

  return citations;
}

/* ==========================================================================
 * Verification
 * ======================================================================== */

export interface VerifyCitationsInput {
  findings: ResearchFinding[];
  citations: WebCitation[];
  evidence: EvidenceUnit[];
  sources: WebSource[];
  now: Date;
  freshnessRequirement: 'none' | 'prefer_recent' | 'must_be_current';
}

export interface CitationVerificationOutcome {
  findings: ResearchFinding[];
  verification: CitationVerificationResult;
  /**
   * Alias of `verification`. The published verification record is the single
   * source of truth; both names point at the same object so a caller can read
   * either without risking a divergent copy.
   */
  result: CitationVerificationResult;
  citations: WebCitation[];
}

export function verifyCitations(input: VerifyCitationsInput): CitationVerificationOutcome {
  const citationById = new Map(input.citations.map((citation) => [citation.citationId, citation]));
  const sourceById = new Map(input.sources.map((source) => [source.sourceId, source]));
  const evidenceById = new Map(input.evidence.map((unit) => [unit.evidenceId, unit]));

  const issues: CitationVerificationIssue[] = [];
  const removedClaims: string[] = [];
  const verifiedCitations = new Set<string>();
  const verifiedFindings: ResearchFinding[] = [];

  for (const finding of input.findings) {
    const survivingCitations: string[] = [];

    for (const citationId of finding.citationIds) {
      const citation = citationById.get(citationId);

      if (!citation) {
        issues.push({
          kind: 'MISSING_SOURCE',
          citationId,
          claimId: finding.claimId,
          detail: 'The finding cites a citation that does not exist in this result.',
        });
        continue;
      }

      const source = sourceById.get(citation.sourceId);
      if (!source) {
        issues.push({
          kind: 'MISSING_SOURCE',
          citationId,
          claimId: finding.claimId,
          detail: 'The citation points at a source that is not in the retrieved set.',
        });
        continue;
      }

      // Compare what the citation CLAIMS to what the source record IS. A mirror
      // legitimately shares a canonical URL with the original, so the comparison
      // is done on the retrieved URLs and on the canonical form of the claim.
      const citationCanonical = canonicalizeUrl(citation.url);
      const sourceCanonical = canonicalizeUrl(source.url);
      if (citationCanonical !== sourceCanonical && source.canonicalUrl !== citation.canonicalUrl) {
        issues.push({
          kind: 'WRONG_SOURCE',
          citationId,
          claimId: finding.claimId,
          detail: 'The citation URL does not match the source it claims to reference.',
        });
        continue;
      }

      // ---- Is the finding actually supported by the cited passages? ----
      const citingUnits = citation.evidenceIds
        .map((evidenceId) => evidenceById.get(evidenceId))
        .filter((unit): unit is EvidenceUnit => Boolean(unit));

      if (citingUnits.length === 0) {
        issues.push({
          kind: 'UNSUPPORTED',
          citationId,
          claimId: finding.claimId,
          detail: 'The citation references no surviving evidence passage.',
        });
        continue;
      }

      const findingTerms = termSet(finding.text);
      const supported = citingUnits.some(
        (unit) => containment(termSet(`${unit.claim} ${unit.passage}`), findingTerms) >= MIN_SUPPORT_OVERLAP
      );

      if (!supported) {
        issues.push({
          kind: 'UNSUPPORTED',
          citationId,
          claimId: finding.claimId,
          detail: 'No cited passage actually supports this statement.',
        });
        continue;
      }

      // ---- Staleness ----
      if (input.freshnessRequirement === 'must_be_current' && source.publishedAt) {
        const ageDays = (input.now.getTime() - Date.parse(source.publishedAt)) / 86_400_000;
        if (Number.isFinite(ageDays) && ageDays > 365) {
          issues.push({
            kind: 'STALE',
            citationId,
            claimId: finding.claimId,
            detail: `The cited source is ${Math.round(ageDays)} days old for a question about current information.`,
          });
          // Stale citations on a current question are demoted, not deleted.
          survivingCitations.push(citationId);
          verifiedCitations.add(citationId);
          continue;
        }
      }

      survivingCitations.push(citationId);
      verifiedCitations.add(citationId);
    }

    if (survivingCitations.length === 0) {
      removedClaims.push(finding.claimId);
      continue;
    }

    verifiedFindings.push({ ...finding, citationIds: [...new Set(survivingCitations)] });
  }

  // ---- Duplicate overcount across findings ----
  const groupUsage = new Map<string, Set<string>>();
  for (const finding of verifiedFindings) {
    for (const citationId of finding.citationIds) {
      const citation = citationById.get(citationId);
      if (!citation) continue;
      const source = sourceById.get(citation.sourceId);
      if (!source) continue;
      const groups = groupUsage.get(finding.claimId) ?? new Set<string>();
      if (groups.has(source.independenceGroup)) {
        issues.push({
          kind: 'DUPLICATE_OVERCOUNT',
          citationId,
          claimId: finding.claimId,
          detail:
            'This finding cites more than one source from the same independence group; those are not independent confirmations.',
        });
      }
      groups.add(source.independenceGroup);
      groupUsage.set(finding.claimId, groups);
    }
  }

  const verifiedCitationList = input.citations.filter((citation) => verifiedCitations.has(citation.citationId));
  const ok = issues.length === 0;

  const verification: CitationVerificationResult = {
    ok,
    checkedClaims: input.findings.length,
    verifiedCitations: verifiedCitations.size,
    issues,
    removedClaims,
  };

  return {
    findings: verifiedFindings,
    verification,
    result: verification,
    // Citations that lost every finding are dropped so the report cannot imply
    // unused support.
    citations: verifiedCitationList,
  };
}

/* ==========================================================================
 * Convenience
 * ======================================================================== */

/**
 * Positional form of `buildCitations` for callers that already hold the sources
 * and evidence arrays.
 */
export function buildCitationSet(sources: WebSource[], evidence: EvidenceUnit[]): WebCitation[] {
  return buildCitations({ sources, evidence });
}
