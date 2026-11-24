/**
 * JARVIS-X v1.2.0 — Claim-to-Source Verifier & Conflict Detection
 *
 * Pipeline: draft answer → extract important claims → map claims to evidence →
 * detect unsupported claims → repair/remove unsupported claims → final answer.
 *
 * Only concise verification metadata is returned. No private chain-of-thought.
 */

import type {
  Citation,
  ClaimEvidenceLink,
  ClaimVerificationResult,
  DetectedConflict,
  DocumentChunk,
  GroundingStatus,
} from './types';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of',
  'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'from', 'as', 'into',
  'it', 'its', 'also', 'which', 'such', 'will', 'can', 'may', 'has', 'have',
]);

function contentTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\-.\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOP_WORDS.has(t))
  );
}

/**
 * Split an answer into candidate factual claims. Hedged or meta sentences
 * (e.g. "The documents do not contain…") are still verified, but claims with
 * no content terms are skipped.
 */
export function extractClaims(answer: string): string[] {
  const cleaned = answer
    .replace(/\*\*Sources\*\*[\s\S]*$/i, '')
    .replace(/\[[^\]]*,\s*(?:p{1,2}\.\s*\d+(?:[–-]\d+)?|section\s+"[^"]*"|document body)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = cleaned.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

  return sentences
    .filter((s) => s.length >= 20)
    .filter((s) => contentTerms(s).size >= 2)
    .slice(0, 30);
}

export class ClaimVerifier {
  /**
   * Map each claim to the chunks that plausibly support it. A claim is
   * "supported" when a meaningful share of its content terms appear in a
   * single chunk, or when its distinctive terms are spread across the
   * retrieved evidence.
   */
  verify(
    answer: string,
    usedChunks: DocumentChunk[],
    citations: Citation[]
  ): ClaimVerificationResult {
    const claims = extractClaims(answer);
    const citationIdsByChunk = new Map<string, string[]>();
    for (const citation of citations) {
      const list = citationIdsByChunk.get(citation.chunkId) ?? [];
      list.push(citation.citationId);
      citationIdsByChunk.set(citation.chunkId, list);
    }

    const chunkTerms = usedChunks.map((c) => ({ chunk: c, terms: contentTerms(c.text) }));
    const corpusTerms = new Set<string>();
    for (const entry of chunkTerms) for (const t of entry.terms) corpusTerms.add(t);

    const links: ClaimEvidenceLink[] = [];
    const unsupported: string[] = [];

    for (const claim of claims) {
      const claimTerms = contentTerms(claim);
      if (claimTerms.size === 0) continue;

      const supporting: Array<{ chunkId: string; ratio: number }> = [];
      for (const entry of chunkTerms) {
        let overlap = 0;
        for (const t of claimTerms) if (entry.terms.has(t)) overlap += 1;
        const ratio = overlap / claimTerms.size;
        if (ratio >= 0.4) {
          supporting.push({ chunkId: entry.chunk.chunkId, ratio });
        }
      }

      // Global coverage across all retrieved evidence.
      let globalOverlap = 0;
      for (const t of claimTerms) if (corpusTerms.has(t)) globalOverlap += 1;
      const globalCoverage = globalOverlap / claimTerms.size;

      const best = supporting.sort((a, b) => b.ratio - a.ratio)[0];

      if (best) {
        links.push({
          claim,
          supportingChunkIds: [best.chunkId],
          citationIds: citationIdsByChunk.get(best.chunkId) ?? [],
          confidence: Number(best.ratio.toFixed(3)),
        });
      } else if (globalCoverage >= 0.5) {
        // Terms are distributed across evidence — attribute to top chunks.
        const chunkIds = chunkTerms
          .map((e) => {
            let overlap = 0;
            for (const t of claimTerms) if (e.terms.has(t)) overlap += 1;
            return { chunkId: e.chunk.chunkId, overlap };
          })
          .filter((e) => e.overlap > 0)
          .sort((a, b) => b.overlap - a.overlap)
          .slice(0, 3)
          .map((e) => e.chunkId);

        links.push({
          claim,
          supportingChunkIds: chunkIds,
          citationIds: chunkIds.flatMap((id) => citationIdsByChunk.get(id) ?? []),
          confidence: Number(globalCoverage.toFixed(3)),
        });
      } else {
        unsupported.push(claim);
      }
    }

    const supportedCount = links.length;
    const totalClaims = links.length + unsupported.length;

    let status: GroundingStatus;
    if (totalClaims === 0) {
      status = 'NOT_SUPPORTED';
    } else if (unsupported.length === 0) {
      status = 'SUPPORTED';
    } else if (supportedCount > 0) {
      status = 'PARTIALLY_SUPPORTED';
    } else {
      status = 'NOT_SUPPORTED';
    }

    const summary =
      totalClaims === 0
        ? 'No verifiable factual claims were produced.'
        : `${supportedCount}/${totalClaims} claim(s) traced to retrieved evidence${
            unsupported.length > 0 ? `, ${unsupported.length} unsupported` : ''
          }.`;

    return {
      claims: links,
      unsupportedClaims: unsupported,
      supportedCount,
      totalClaims,
      status,
      summary,
    };
  }

  /**
   * Remove unsupported sentences from a draft. Returns the repaired answer.
   * Never invents replacement content.
   */
  repair(answer: string, verification: ClaimVerificationResult): string {
    if (verification.unsupportedClaims.length === 0) return answer;

    let repaired = answer;
    for (const claim of verification.unsupportedClaims) {
      // Remove the sentence and any inline citation marker attached to it.
      const pattern = new RegExp(
        `${claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\[[^\\]]*\\])?\\s*`,
        'g'
      );
      repaired = repaired.replace(pattern, '');
    }

    repaired = repaired.replace(/\s{2,}/g, ' ').trim();

    return repaired.length > 0
      ? repaired
      : 'The supplied documents do not contain enough evidence to support an answer to that question.';
  }
}

/* ---------------------------------------------------------------------------
 * Conflict detection
 * ------------------------------------------------------------------------- */

const NEGATION_PAIRS: Array<[RegExp, RegExp]> = [
  [/\b(required|must|shall|mandatory)\b/i, /\b(not required|optional|must not|shall not|prohibited|forbidden)\b/i],
  [/\b(enabled|supported|allowed|permitted)\b/i, /\b(disabled|unsupported|not allowed|not permitted|deprecated|removed)\b/i],
  [/\b(is|are|uses|supports)\b/i, /\b(is not|are not|does not|do not|no longer)\b/i],
  [/\b(increase|increased|higher|larger|more)\b/i, /\b(decrease|decreased|lower|smaller|fewer)\b/i],
];

export class ConflictDetector {
  /**
   * Detect statements across DIFFERENT documents that make opposing claims
   * about the same subject. Both sources are always preserved.
   */
  detect(
    chunks: DocumentChunk[],
    titlesByDocumentId: Map<string, string>,
    citations: Citation[]
  ): DetectedConflict[] {
    const citationByChunk = new Map(citations.map((c) => [c.chunkId, c]));
    const conflicts: DetectedConflict[] = [];

    const byDocument = new Map<string, DocumentChunk[]>();
    for (const chunk of chunks) {
      const list = byDocument.get(chunk.documentId) ?? [];
      list.push(chunk);
      byDocument.set(chunk.documentId, list);
    }

    const documentIds = [...byDocument.keys()];
    if (documentIds.length < 2) return [];

    const sentencesOf = (chunk: DocumentChunk): string[] =>
      chunk.text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 25);

    const seenTopics = new Set<string>();

    for (let i = 0; i < documentIds.length; i += 1) {
      for (let j = i + 1; j < documentIds.length; j += 1) {
        const docA = documentIds[i];
        const docB = documentIds[j];

        for (const chunkA of byDocument.get(docA) ?? []) {
          for (const chunkB of byDocument.get(docB) ?? []) {
            const termsA = contentTerms(chunkA.text);
            const shared = [...contentTerms(chunkB.text)].filter((t) => termsA.has(t));
            // Require a meaningful shared subject before comparing polarity.
            if (shared.length < 4) continue;

            const topicKey = shared.sort().slice(0, 6).join('|');
            if (seenTopics.has(topicKey)) continue;

            const sentencePairs: Array<{ a: string; b: string }> = [];
            for (const sa of sentencesOf(chunkA)) {
              for (const sb of sentencesOf(chunkB)) {
                const tA = contentTerms(sa);
                const tB = contentTerms(sb);
                const sharedInPair = [...tA].filter((t) => tB.has(t));
                if (sharedInPair.length < 4) continue;

                const opposing = NEGATION_PAIRS.some(
                  ([positive, negative]) =>
                    (positive.test(sa) && negative.test(sb)) ||
                    (negative.test(sa) && positive.test(sb))
                );
                if (opposing) sentencePairs.push({ a: sa, b: sb });
              }
            }

            if (sentencePairs.length === 0) continue;
            seenTopics.add(topicKey);

            const pair = sentencePairs[0];
            const citationA = citationByChunk.get(chunkA.chunkId);
            const citationB = citationByChunk.get(chunkB.chunkId);

            conflicts.push({
              topic: shared.slice(0, 6).join(', '),
              positions: [
                {
                  statement: pair.a.slice(0, 300),
                  documentId: chunkA.documentId,
                  documentTitle: titlesByDocumentId.get(chunkA.documentId) ?? chunkA.documentId,
                  chunkId: chunkA.chunkId,
                  citationId: citationA?.citationId ?? '',
                },
                {
                  statement: pair.b.slice(0, 300),
                  documentId: chunkB.documentId,
                  documentTitle: titlesByDocumentId.get(chunkB.documentId) ?? chunkB.documentId,
                  chunkId: chunkB.chunkId,
                  citationId: citationB?.citationId ?? '',
                },
              ],
              explanation: `Two documents make opposing statements about "${shared
                .slice(0, 4)
                .join(', ')}". Both are preserved; JARVIS-X does not silently choose one.`,
              freshnessNote:
                'Newer ingestion is not treated as more correct. Verify document versions before relying on either statement.',
            });
          }
        }
      }
    }

    return conflicts.slice(0, 5);
  }
}
