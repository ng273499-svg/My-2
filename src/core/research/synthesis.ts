/**
 * JARVIS-X v1.3.0 — Synthesis.
 *
 * The report is separated into four sections that must never blur:
 *
 *   VERIFIED FINDINGS    — supported by independent, credible, current evidence
 *   QUALIFIED FINDINGS   — supported, but weakly / stale / single-source
 *   CONFLICTS            — credible sources disagree; BOTH sides are shown
 *   UNKNOWN              — what the evidence could not establish
 *
 * Synthesis is extractive by design. Every statement traces to a retrieved
 * passage plus a citation id, so nothing is ever "filled in" from model memory.
 * When the evidence is thin the report says so rather than writing a plausible
 * paragraph.
 */

import type {
  ClaimNode,
  ConfidenceAssessment,
  Contradiction,
  EvidenceUnit,
  FactCheckResult,
  ResearchFinding,
  ResearchMode,
  WebCitation,
  WebSource,
} from './types';
import type { FreshnessSummary } from './freshness';
import { truncateWords } from './text-utils';

export interface SynthesisInput {
  query: string;
  mode: ResearchMode;
  nodes: ClaimNode[];
  evidence: EvidenceUnit[];
  sources: WebSource[];
  citations: WebCitation[];
  contradictions: Contradiction[];
  confidence: ConfidenceAssessment;
  factCheck: FactCheckResult | null;
  freshness: FreshnessSummary;
  limitations: string[];
  live: boolean;
}

export interface SynthesisOutput {
  executiveSummary: string;
  verifiedFindings: ResearchFinding[];
  qualifiedFindings: ResearchFinding[];
  conflicts: ResearchFinding[];
  unknowns: string[];
  caveats: string[];
}

export function synthesiseResearch(input: SynthesisInput): SynthesisOutput {
  const sourceById = new Map(input.sources.map((source) => [source.sourceId, source]));
  const evidenceById = new Map(input.evidence.map((unit) => [unit.evidenceId, unit]));
  const citationBySource = new Map(input.citations.map((citation) => [citation.sourceId, citation]));

  const verifiedFindings: ResearchFinding[] = [];
  const qualifiedFindings: ResearchFinding[] = [];
  const conflicts: ResearchFinding[] = [];
  const unknowns: string[] = [];

  for (const node of input.nodes) {
    const supportUnits = node.supportingEvidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((unit): unit is EvidenceUnit => Boolean(unit));

    const contradictionUnits = node.contradictingEvidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((unit): unit is EvidenceUnit => Boolean(unit));

    // A finding may only cite the sources whose passages it actually QUOTES.
    // Attaching every unit of the node would make the citation unverifiable —
    // a promise the text does not keep.
    const quotedSupport = pickQuoted(supportUnits, citationBySource);
    const quotedContradiction = pickQuoted(contradictionUnits, citationBySource);

    const citationIds = unique([
      ...quotedSupport.map((entry) => entry.citationId),
      ...quotedContradiction.map((entry) => entry.citationId),
    ]);

    switch (node.state) {
      case 'SUPPORTED': {
        const finding = buildFinding(node, supportUnits, sourceById, quotedSupport, 'SUPPORTED');
        if (finding) verifiedFindings.push(finding);
        else unknowns.push(`Evidence for "${node.claim}" could not be quoted directly.`);
        break;
      }

      case 'PARTIALLY_SUPPORTED':
      case 'OUTDATED': {
        const finding = buildFinding(node, supportUnits, sourceById, quotedSupport, node.state);
        const suffix =
          node.state === 'OUTDATED'
            ? ' (supported only by material that is stale for this question)'
            : node.independentSupportCount < 2
              ? ' (single independent source — not corroborated)'
              : ' (support is limited)';
        if (finding) qualifiedFindings.push({ ...finding, text: `${finding.text}${suffix}` });
        else unknowns.push(`Evidence for "${node.claim}" could not be quoted directly.`);
        break;
      }

      case 'CONFLICTING': {
        const finding = buildConflict(node, supportUnits, contradictionUnits, sourceById, [
          ...quotedSupport,
          ...quotedContradiction,
        ]);
        if (finding) conflicts.push(finding);
        break;
      }

      case 'UNSUPPORTED':
        unknowns.push(
          `Retrieved sources did not support: "${node.claim}". ${
            contradictionUnits.length > 0 ? `${contradictionUnits.length} passage(s) argue against it.` : ''
          }`.trim()
        );
        break;

      case 'UNKNOWN':
      default:
        unknowns.push(`No retrieved source speaks to: "${node.claim}".`);
        break;
    }
  }

  // ---- Contradictions that never reached a claim node still appear ----
  if (conflicts.length === 0 && input.contradictions.length > 0) {
    for (const contradiction of input.contradictions.slice(0, 4)) {
      const citationIds = unique(
        [
          citationBySource.get(contradiction.sideA.sourceId)?.citationId ?? '',
          citationBySource.get(contradiction.sideB.sourceId)?.citationId ?? '',
        ].filter(Boolean)
      );
      conflicts.push({
        text: `Sources disagree: ${contradiction.sideA.domain} states "${excerpt(
          contradiction.sideA.statement
        )}" while ${contradiction.sideB.domain} states "${excerpt(contradiction.sideB.statement)}".${
          contradiction.possibleExplanation ? ` ${contradiction.possibleExplanation}` : ''
        }`,
        claimId: contradiction.contradictionId,
        state: 'CONFLICTING',
        citationIds,
        confidence: contradiction.resolved ? 0.5 : 0.3,
      });
    }
  }

  const executiveSummary = buildSummary(input, { verifiedFindings, qualifiedFindings, conflicts, unknowns });

  const caveats = buildCaveats(input);

  return {
    executiveSummary,
    verifiedFindings: verifiedFindings.slice(0, 12),
    qualifiedFindings: qualifiedFindings.slice(0, 12),
    conflicts: conflicts.slice(0, 8),
    unknowns: unique(unknowns).slice(0, 12),
    caveats,
  };
}

/* ==========================================================================
 * Findings
 * ======================================================================== */

/**
 * Pair each supporting unit with the citation of the source it came from.
 * Only units that HAVE a citation are eligible to be quoted in a finding.
 */
function pickQuoted(
  units: EvidenceUnit[],
  citationBySource: Map<string, WebCitation>
): Array<{ unit: EvidenceUnit; citationId: string }> {
  return units
    .map((unit) => ({ unit, citationId: citationBySource.get(unit.sourceId)?.citationId ?? '' }))
    .filter((entry) => entry.citationId.length > 0);
}

function buildFinding(
  node: ClaimNode,
  supportUnits: EvidenceUnit[],
  sourceById: Map<string, WebSource>,
  quotedUnits: Array<{ unit: EvidenceUnit; citationId: string }>,
  state: ResearchFinding['state']
): ResearchFinding | null {
  if (supportUnits.length === 0) return null;

  // Prefer a passage from a primary-tier source; otherwise the strongest.
  const ranked = [...supportUnits].sort((a, b) => b.quality * b.relevance - a.quality * a.relevance);
  const unit = ranked[0];
  const source = sourceById.get(unit.sourceId);
  if (!source) return null;

  const ownCitation = quotedUnits.find((entry) => entry.unit.sourceId === unit.sourceId)?.citationId;
  if (!ownCitation) return null;

  // One finding, one quoted passage, one citation. Nothing else is claimed.
  const citationIds = [ownCitation];

  const date = source.publishedAt ? source.publishedAt.slice(0, 10) : null;
  const attribution = date ? `${source.domain}, ${date}` : `${source.domain}, date unverified`;
  const corroboration =
    node.independentSupportCount >= 2
      ? ` Corroborated by ${node.independentSupportCount} independent source groups.`
      : '';

  return {
    text: `${trimStatement(node.claim)} — "${excerpt(unit.passage)}" (${attribution}).${corroboration}`,
    claimId: node.claimId,
    state,
    citationIds,
    confidence: node.confidence,
  };
}

function buildConflict(
  node: ClaimNode,
  supportUnits: EvidenceUnit[],
  contradictionUnits: EvidenceUnit[],
  sourceById: Map<string, WebSource>,
  quotedUnits: Array<{ unit: EvidenceUnit; citationId: string }>
): ResearchFinding | null {
  const support = supportUnits[0];
  const contradiction = contradictionUnits[0];
  if (!support || !contradiction) return null;

  const supportSource = sourceById.get(support.sourceId);
  const contradictionSource = sourceById.get(contradiction.sourceId);
  if (!supportSource || !contradictionSource) return null;

  const supportCitation = quotedUnits.find((entry) => entry.unit.sourceId === support.sourceId)?.citationId;
  const contradictionCitation = quotedUnits.find((entry) => entry.unit.sourceId === contradiction.sourceId)?.citationId;
  if (!supportCitation || !contradictionCitation) return null;

  // Both sides are quoted, so both are cited — and nothing else.
  const citationIds = unique([supportCitation, contradictionCitation]);

  return {
    text:
      `${trimStatement(node.claim)} — sources disagree. ` +
      `${supportSource.domain} says "${excerpt(support.passage)}"; ` +
      `${contradictionSource.domain} says "${excerpt(contradiction.passage)}". ` +
      'Both positions are reported and neither has been suppressed.',
    claimId: node.claimId,
    state: 'CONFLICTING',
    citationIds,
    confidence: node.confidence,
  };
}

/* ==========================================================================
 * Summary
 * ======================================================================== */

function buildSummary(
  input: SynthesisInput,
  parts: {
    verifiedFindings: ResearchFinding[];
    qualifiedFindings: ResearchFinding[];
    conflicts: ResearchFinding[];
    unknowns: string[];
  }
): string {
  const lines: string[] = [];

  const usableSources = input.sources.filter((source) => source.fetchStatus === 'OK' && !source.duplicateOf);
  const groups = new Set(usableSources.map((source) => source.independenceGroup)).size;
  const inaccessible = input.sources.filter((source) => source.fetchStatus !== 'OK').length;

  if (input.sources.length === 0) {
    lines.push(
      'No source could be retrieved for this question, so no finding is reported. Any answer given here would be unsupported.'
    );
    return lines.join(' ');
  }

  if (parts.verifiedFindings.length === 0 && parts.qualifiedFindings.length === 0) {
    lines.push(
      `Sources were retrieved (${usableSources.length} readable, ${groups} independent group(s)) but none supports a verifiable answer to the question.`
    );
  } else {
    lines.push(
      `${parts.verifiedFindings.length} verified finding(s) and ${parts.qualifiedFindings.length} qualified finding(s) are reported from ${usableSources.length} readable source(s) across ${groups} independent group(s).`
    );
  }

  if (parts.verifiedFindings.length > 0) {
    const top = parts.verifiedFindings[0];
    lines.push(`Strongest supported point: ${truncateWords(top.text, 320)}`);
  }

  if (parts.conflicts.length > 0) {
    lines.push(
      `${parts.conflicts.length} conflict(s) are recorded and both sides are shown; JARVIS does not choose a winner when the evidence does not decide it.`
    );
  }

  if (input.factCheck) {
    lines.push(`Fact-check verdict: ${input.factCheck.verdict.replace(/_/g, ' ').toLowerCase()}.`);
  }

  lines.push(`Confidence: ${input.confidence.level} (${input.confidence.score.toFixed(2)}).`);

  if (input.freshness.dated === 0) {
    lines.push('No source asserted a verifiable publication date, so freshness could not be established.');
  } else if (input.freshness.stale > 0) {
    lines.push(`${input.freshness.stale} dated source(s) are stale for this question.`);
  }

  if (inaccessible > 0) {
    lines.push(`${inaccessible} source(s) could not be read and were not used as evidence.`);
  }

  if (!input.live) {
    lines.push(
      'This run used a NON-LIVE evidence provider: the result demonstrates the pipeline and must not be presented as live web research.'
    );
  }

  return lines.join(' ');
}

function buildCaveats(input: SynthesisInput): string[] {
  const caveats: string[] = [];

  const unverifiedDates = input.sources.filter(
    (source) => source.fetchStatus === 'OK' && !source.publishedAt && !source.updatedAt
  ).length;
  if (unverifiedDates > 0) {
    caveats.push(`${unverifiedDates} source(s) did not state a publication date; their recency is unverified.`);
  }

  const metadataOnly = input.sources.filter((source) => source.academic?.metadataOnly).length;
  if (metadataOnly > 0) {
    caveats.push(
      `${metadataOnly} academic source(s) were available only as metadata/abstract; the full paper was NOT read.`
    );
  }

  if (input.mode === 'LATEST' && input.freshness.dated === 0) {
    caveats.push('A "latest" claim cannot be made: no retrieved source carries a verifiable date.');
  }

  if (input.mode === 'MARKET_RESEARCH') {
    caveats.push(
      'Vendor material is treated as a claim, not as verification. Prices and availability were not independently confirmed unless a dated independent source is cited.'
    );
  }

  if (input.mode === 'ACADEMIC_DISCOVERY') {
    caveats.push(
      'Academic discovery reports what the retrieved metadata and abstracts say. Full-text claims require reading the paper itself.'
    );
  }

  return caveats;
}

/* ==========================================================================
 * Helpers
 * ======================================================================== */

function excerpt(text: string): string {
  return truncateWords(text.replace(/\s+/g, ' ').trim(), 260);
}

function trimStatement(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
