/**
 * JARVIS-X v1.2.0 — Bounded Reranking
 *
 * Pipeline: query → candidate retrieval → deduplication → relevance scoring →
 * reranking → context selection.
 *
 * Provider-neutral. When no advanced reranker is configured, a transparent
 * deterministic fallback is used and reported as such.
 */

import type { QueryUnderstanding, ScoredChunk } from './types';

export type RerankingMode = 'deterministic_fallback' | 'provider';

export interface Reranker {
  readonly mode: RerankingMode;
  readonly providerId: string;
  rerank(
    candidates: ScoredChunk[],
    query: string,
    understanding: QueryUnderstanding
  ): Promise<ScoredChunk[]>;
}

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-.\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Remove redundant candidates.
 *
 * Deduplication is scoped PER DOCUMENT on purpose. Two near-identical passages
 * from two DIFFERENT documents are distinct sources: they must both survive,
 * because collapsing them would make cross-document contradiction detection
 * impossible and would silently drop one side of a conflict — exactly the
 * behaviour the v1.2 spec forbids.
 */
export function deduplicateCandidates(candidates: ScoredChunk[]): {
  kept: ScoredChunk[];
  removed: number;
} {
  const kept: ScoredChunk[] = [];
  let removed = 0;

  // documentId → { hashes, termSets }
  const perDocument = new Map<
    string,
    { hashes: Set<string>; termSets: Array<Set<string>> }
  >();

  for (const candidate of candidates) {
    const documentId = candidate.chunk.documentId;
    let state = perDocument.get(documentId);
    if (!state) {
      state = { hashes: new Set<string>(), termSets: [] };
      perDocument.set(documentId, state);
    }

    const hash = candidate.chunk.contentHash;
    if (state.hashes.has(hash)) {
      removed += 1;
      continue;
    }

    const candidateTerms = new Set(terms(candidate.chunk.text));
    let isNearDuplicate = false;
    for (const existing of state.termSets) {
      if (candidateTerms.size === 0 || existing.size === 0) continue;
      let overlap = 0;
      for (const t of candidateTerms) {
        if (existing.has(t)) overlap += 1;
      }
      const jaccard = overlap / (candidateTerms.size + existing.size - overlap);
      if (jaccard >= 0.9) {
        isNearDuplicate = true;
        break;
      }
    }
    if (isNearDuplicate) {
      removed += 1;
      continue;
    }

    state.hashes.add(hash);
    state.termSets.push(candidateTerms);
    kept.push(candidate);
  }

  return { kept, removed };
}

/**
 * Transparent deterministic reranker.
 *
 * Scores each candidate on explainable signals only:
 *   - query-term coverage (how much of the query the chunk actually contains)
 *   - exact phrase presence
 *   - heading/section match
 *   - length sanity (penalise very short or bloated chunks)
 *   - structural agreement with the detected intent
 *
 * Blended with the incoming hybrid score so retrieval work is not discarded.
 */
export class DeterministicReranker implements Reranker {
  readonly mode: RerankingMode = 'deterministic_fallback';
  readonly providerId = 'jarvis-deterministic-reranker-v1';

  async rerank(
    candidates: ScoredChunk[],
    query: string,
    understanding: QueryUnderstanding
  ): Promise<ScoredChunk[]> {
    const queryTerms = understanding.keywords.length
      ? understanding.keywords
      : [...new Set(terms(query))];

    const reranked = candidates.map((candidate) => {
      const chunkTerms = new Set(terms(candidate.chunk.text));
      const lowerText = candidate.chunk.text.toLowerCase();

      // 1. Coverage: fraction of query terms present.
      let matched = 0;
      for (const term of queryTerms) {
        if (chunkTerms.has(term)) matched += 1;
      }
      const coverage = queryTerms.length > 0 ? matched / queryTerms.length : 0;

      // 2. Exact phrase presence (strong signal for factual lookup).
      const phrase = query.trim().toLowerCase();
      const exactPhrase = phrase.length >= 8 && lowerText.includes(phrase) ? 1 : 0;

      // 3. Heading/section match.
      const headingHaystack = `${candidate.chunk.section ?? ''} ${candidate.chunk.headingPath.join(' ')}`.toLowerCase();
      const headingMatch = queryTerms.some((t) => headingHaystack.includes(t)) ? 1 : 0;

      // 4. Length sanity — prefer chunks that are substantive but not bloated.
      const len = candidate.chunk.charCount;
      const lengthScore = len < 60 ? 0.2 : len > 2_000 ? 0.6 : 1;

      // 5. Intent-specific structure agreement.
      let structureScore = 0;
      if (understanding.intent === 'table_data' && /Row \d+:|Columns:/.test(candidate.chunk.text)) {
        structureScore = 1;
      } else if (
        understanding.intent === 'code_documentation' &&
        /(function|class|interface|const |export |def )/.test(candidate.chunk.text)
      ) {
        structureScore = 1;
      } else if (understanding.intent === 'summarization' && candidate.chunk.section) {
        structureScore = 0.6;
      }

      const deterministic =
        0.45 * coverage +
        0.2 * exactPhrase +
        0.1 * headingMatch +
        0.1 * lengthScore +
        0.15 * structureScore;

      // Blend: keep 55% of the hybrid signal, add 45% rerank signal.
      const rerankScore = 0.55 * candidate.hybridScore + 0.45 * deterministic;

      return { ...candidate, rerankScore };
    });

    reranked.sort(
      (a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0) || b.hybridScore - a.hybridScore
    );
    return reranked;
  }
}

export class RerankingService {
  private readonly reranker: Reranker;

  constructor(reranker?: Reranker) {
    this.reranker = reranker ?? new DeterministicReranker();
  }

  get mode(): RerankingMode {
    return this.reranker.mode;
  }

  get providerId(): string {
    return this.reranker.providerId;
  }

  async rerank(
    candidates: ScoredChunk[],
    query: string,
    understanding: QueryUnderstanding
  ): Promise<{ selected: ScoredChunk[]; removedDuplicates: number }> {
    const { kept, removed } = deduplicateCandidates(candidates);
    const ranked = await this.reranker.rerank(kept, query, understanding);
    return { selected: ranked, removedDuplicates: removed };
  }
}
