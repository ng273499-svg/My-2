/**
 * JARVIS-X v1.2.0 — Evidence Sentence Selection
 *
 * Deterministic extractive draft builder. Every sentence it returns is copied
 * verbatim from retrieved evidence, so a grounded answer is verifiable by
 * construction. It never paraphrases or invents content.
 */

import type { DocumentChunk, ScoredChunk } from './types';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'to', 'in', 'on',
  'at', 'by', 'for', 'with', 'about', 'from', 'as', 'into', 'it', 'its',
  'what', 'which', 'who', 'how', 'why', 'when', 'where', 'does', 'do', 'did',
]);

const MAX_SENTENCES = 6;
const MIN_SENTENCE_CHARS = 25;

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-.\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/**
 * Detect structural scaffolding produced by the tabular parser ("Columns: …",
 * "Row 3: a=1; b=2"). It is valid evidence and stays retrievable, but it reads
 * badly inside prose, so it is down-weighted rather than promoted to a claim.
 */
function looksLikeTableScaffolding(sentence: string): boolean {
  if (/^(Columns:|Row \d+:)/.test(sentence)) return true;
  const equals = (sentence.match(/=/g) ?? []).length;
  const semicolons = (sentence.match(/;/g) ?? []).length;
  const words = sentence.split(/\s+/).length;
  return equals >= 3 && semicolons >= 2 && words > 0 && equals / words > 0.08;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= MIN_SENTENCE_CHARS && s.length <= 420);
}

export interface SelectedSentence {
  sentence: string;
  chunk: DocumentChunk;
  score: number;
}

/**
 * Choose the most query-relevant evidence sentences, spreading selection
 * across evidence chunks so one long passage cannot monopolise the draft.
 */
export function selectEvidenceSentences(
  query: string,
  usedChunks: DocumentChunk[]
): SelectedSentence[] {
  const queryTerms = new Set(terms(query));
  if (queryTerms.size === 0 || usedChunks.length === 0) {
    // Fall back to the leading sentence of the first few chunks.
    const fallback: SelectedSentence[] = [];
    for (const chunk of usedChunks.slice(0, 3)) {
      const first = splitSentences(chunk.text)[0];
      if (first) fallback.push({ sentence: first, chunk, score: 0.1 });
    }
    return fallback;
  }

  const candidates: SelectedSentence[] = [];

  for (const chunk of usedChunks) {
    for (const sentence of splitSentences(chunk.text)) {
      const sentenceTerms = terms(sentence);
      if (sentenceTerms.length === 0) continue;

      let matched = 0;
      for (const t of new Set(sentenceTerms)) {
        if (queryTerms.has(t)) matched += 1;
      }
      const coverage = matched / queryTerms.size;

      // Reward sentences containing several distinct query terms.
      const distinctMatches = new Set(sentenceTerms.filter((t) => queryTerms.has(t))).size;
      const density = distinctMatches / Math.max(4, new Set(sentenceTerms).size);

      const base = coverage * 0.7 + density * 0.3;
      const score = looksLikeTableScaffolding(sentence) ? base * 0.35 : base;
      if (score <= 0) continue;
      candidates.push({ sentence, chunk, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Relative relevance floor: a sentence that matches a single query word by
  // accident must not be spliced into an otherwise focused answer. The single
  // best sentence is always kept so an answer is never silently empty.
  const bestScore = candidates.length > 0 ? candidates[0].score : 0;
  const sentenceFloor = bestScore * 0.45;

  // Take the best sentences, at most 2 per chunk, then bound the total.
  const perChunk = new Map<string, number>();
  const selected: SelectedSentence[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (selected.length >= MAX_SENTENCES) break;
    if (candidate.score <= 0) break;
    if (selected.length > 0 && candidate.score < sentenceFloor) break;
    if (seen.has(candidate.sentence)) continue;

    const count = perChunk.get(candidate.chunk.chunkId) ?? 0;
    if (count >= 2) continue;

    perChunk.set(candidate.chunk.chunkId, count + 1);
    seen.add(candidate.sentence);
    selected.push(candidate);
  }

  // Restore original chunk order for a coherent reading order.
  selected.sort((a, b) => a.chunk.order - b.chunk.order);
  return selected;
}

/**
 * Build a deterministic extractive draft for a query.
 * Returns plain prose with no fabricated connecting claims.
 */
export function improveSentenceSelection(
  query: string,
  scoredChunks: ScoredChunk[],
  usedChunks: DocumentChunk[]
): string {
  // Preserve the retrieval ranking when building the candidate list.
  const ordered: DocumentChunk[] = [];
  const seen = new Set<string>();
  for (const scored of scoredChunks) {
    if (seen.has(scored.chunk.chunkId)) continue;
    if (!usedChunks.some((c) => c.chunkId === scored.chunk.chunkId)) continue;
    seen.add(scored.chunk.chunkId);
    ordered.push(scored.chunk);
  }
  // Append any used chunk that retrieval ordering did not cover.
  for (const chunk of usedChunks) {
    if (!seen.has(chunk.chunkId)) {
      seen.add(chunk.chunkId);
      ordered.push(chunk);
    }
  }

  const selected = selectEvidenceSentences(query, ordered);
  if (selected.length === 0) return '';

  return selected.map((s) => s.sentence).join(' ');
}
