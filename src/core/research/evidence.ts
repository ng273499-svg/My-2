/**
 * JARVIS-X v1.3.0 — Evidence extraction.
 *
 * Turns a normalized source into BOUNDED evidence units. A unit is a short
 * verbatim passage (hard-capped) plus the metadata needed to cite it. Whole
 * pages are never stored, never embedded and never forwarded as evidence.
 *
 * Support classification runs in this order, deliberately:
 *   1. Historically-scoped passages are CONTEXT. "The default used to be 60
 *      seconds in 1.x" is not evidence for today's default, and it is not a
 *      contradiction either.
 *   2. Polarity-opposed passages CONTRADICT (negation XOR negation).
 *   3. Passages that are genuinely about the question SUPPORT it.
 *   4. Everything else is NEUTRAL and is dropped from the citation set.
 */

import type {
  EvidenceSupportType,
  EvidenceUnit,
  ResearchIntent,
  WebSource,
} from './types';
import {
  chunkText,
  cleanSentence,
  containment,
  hasHistoricalScope,
  hasNegation,
  keyTerms,
  truncateWords,
} from './text-utils';

export interface EvidenceExtractionContext {
  query: string;
  intent: ResearchIntent;
  maxUnits: number;
  now: Date;
  /** Passages kept per source. Keeps one long page from dominating. */
  maxPerSource?: number;
  /** Hard cap on a single passage, in characters. */
  maxPassageChars?: number;
  /** Minimum relevance (0..1) for a passage to become a unit. */
  minRelevance?: number;
}

const DEFAULT_MAX_PASSAGE_CHARS = 600;
/** Hard storage ceiling for one passage, independent of the per-source default. */
const MAX_PASSAGE_CHARS = 1200;
const DEFAULT_MIN_RELEVANCE = 0.12;
const DEFAULT_MAX_PER_SOURCE = 6;

export interface EvidenceExtractionResult {
  units: EvidenceUnit[];
  /** Sources that produced no usable evidence (too short, off-topic, unreadable). */
  emptySourceIds: string[];
  /** True when the maxUnits ceiling stopped extraction early. */
  truncated: boolean;
  /** Units dropped because the source budget was already full. */
  droppedUnits: number;
}

/** Object form — preferred. Carries the honesty metadata about what was dropped. */
export function extractEvidence(sources: WebSource[], context: EvidenceExtractionContext): EvidenceExtractionResult {
  const maxPerSource = context.maxPerSource ?? DEFAULT_MAX_PER_SOURCE;
  const maxPassageChars = context.maxPassageChars ?? DEFAULT_MAX_PASSAGE_CHARS;
  const minRelevance = context.minRelevance ?? DEFAULT_MIN_RELEVANCE;

  const units: EvidenceUnit[] = [];
  const emptySourceIds: string[] = [];
  let truncated = false;
  let droppedUnits = 0;

  for (const source of sources) {
    if (source.fetchStatus !== 'OK' || !source.extractedText || source.extractedText.trim().length < 40) {
      emptySourceIds.push(source.sourceId);
      continue;
    }
    // A marked duplicate contributes NO evidence: the representative speaks for
    // the cluster, so a mirror cannot inflate the evidence count.
    if (source.duplicateOf) continue;

    const produced = extractFromSource(source, {
      query: context.query,
      maxPerSource,
      maxPassageChars,
      minRelevance,
    });

    if (produced.length === 0) {
      emptySourceIds.push(source.sourceId);
      continue;
    }

    for (const unit of produced) {
      if (units.length >= context.maxUnits) {
        truncated = true;
        droppedUnits += 1;
        continue;
      }
      units.push(unit);
    }
  }

  return { units, emptySourceIds, truncated, droppedUnits };
}

/** Flat form — convenient when only the units are needed. */
export function extractEvidenceUnits(sources: WebSource[], context: EvidenceExtractionContext): EvidenceUnit[] {
  return extractEvidence(sources, context).units;
}

function extractFromSource(
  source: WebSource,
  context: { query: string; maxPerSource: number; maxPassageChars: number; minRelevance: number }
): EvidenceUnit[] {
  const queryTerms = keyTerms(context.query, 24);
  const querySet = new Set(queryTerms);
  const queryNegative = hasNegation(context.query);

  const passages = buildPassages(source.extractedText, context.maxPassageChars);
  if (passages.length === 0) return [];

  const scored = passages
    .map((passage, index) => ({
      passage,
      index,
      score: scoreRelevance(passage.text, querySet, queryTerms),
      position: index / Math.max(1, passages.length - 1),
    }))
    .filter((entry) => entry.score >= context.minRelevance)
    .sort((a, b) => b.score - a.score)
    .slice(0, context.maxPerSource);

  const units: EvidenceUnit[] = [];

  for (const entry of scored) {
    const supportType = classifySupport(entry.passage.text, queryNegative, entry.score);
    const claim = summarisePassage(entry.passage.text, context.maxPassageChars);

    units.push({
      evidenceId: `ev-${source.sourceId}-${entry.index}`,
      sourceId: source.sourceId,
      documentId: source.provenance === 'DOCUMENT_SOURCE' ? source.sourceId.replace(/^doc-/, '') : null,
      provenance: source.provenance,
      claim,
      passage: truncateWords(entry.passage.text, context.maxPassageChars),
      section: entry.passage.section,
      publishedAt: source.publishedAt,
      retrievedAt: source.retrievedAt,
      relevance: round3(entry.score),
      quality: round3(source.quality?.overall ?? 0.35),
      freshness: round3(source.quality?.freshness ?? 0.5),
      supportType,
      positionInSource: round3(entry.position),
    });
  }

  return units;
}

/* ==========================================================================
 * Passages
 * ======================================================================== */

export interface Passage {
  text: string;
  section: string | null;
}

/**
 * Split a source into passages, carrying the nearest heading as the section.
 * Headings that are actually markdown-ish lines are detected textually so this
 * works for HTML-derived and plain-text sources alike.
 */
export function buildPassages(text: string, maxChars: number): Passage[] {
  const lines = text.split('\n');
  const paragraphsOut: Passage[] = [];

  let section: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (joined.length < 40) return;

    for (const chunk of chunkText(joined, maxChars)) {
      paragraphsOut.push({ text: chunk, section });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flush();
      continue;
    }

    if (isHeadingLine(line)) {
      flush();
      section = cleanSentence(line.replace(/^#{1,6}\s*/, '').replace(/:$/, ''));
      continue;
    }

    buffer.push(line);
  }
  flush();

  return paragraphsOut;
}

function isHeadingLine(line: string): boolean {
  if (line.length > 120) return false;
  if (/^#{1,6}\s+\S/.test(line)) return true;
  // A short Title-Case line with no terminal punctuation behaves like a heading.
  if (line.length <= 80 && !/[.!?]$/.test(line) && line.split(' ').length <= 10) {
    const words = line.split(' ');
    const capitalised = words.filter((word) => /^[A-Z0-9]/.test(word)).length;
    if (capitalised >= Math.ceil(words.length * 0.6)) return true;
  }
  return false;
}

/**
 * Passages for a source — no scoring, no side effects.
 * The default cap is the hard per-passage ceiling used for storage.
 */
export function passagesOf(source: WebSource, maxChars = DEFAULT_MAX_PASSAGE_CHARS): Passage[] {
  if (!source.extractedText) return [];
  return buildPassages(source.extractedText, maxChars);
}

/* ==========================================================================
 * Scoring
 * ======================================================================== */

function scoreRelevance(passage: string, querySet: Set<string>, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const passageTerms = new Set(keyTerms(passage, 200));
  if (passageTerms.size === 0) return 0;

  const overlap = containment(querySet, passageTerms);
  const density = queryTerms.filter((term) => passageTerms.has(term)).length / queryTerms.length;

  // Overlap dominates; density rewards passages that cover many query terms.
  return Math.min(1, overlap * 0.65 + density * 0.35);
}

function classifySupport(passage: string, queryNegative: boolean, relevance: number): EvidenceSupportType {
  if (hasHistoricalScope(passage)) return 'CONTEXT';
  if (relevance < 0.18) return 'NEUTRAL';

  const passageNegative = hasNegation(passage);
  if (passageNegative !== queryNegative) return 'CONTRADICTS';

  return relevance >= 0.28 ? 'SUPPORTS' : 'NEUTRAL';
}

function summarisePassage(passage: string, maxChars: number): string {
  const firstSentence = passage.split(/(?<=[.!?])\s/)[0] ?? passage;
  return truncateWords(cleanSentence(firstSentence), Math.min(240, maxChars));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
