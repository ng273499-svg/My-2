/**
 * JARVIS-X v1.2.0 — Bounded Document Summarization
 *
 * Supports quick, detailed, section, key-points, action-items, technical and
 * compare summaries.
 *
 * Large documents use a bounded hierarchical (map → reduce) strategy with a
 * fixed maximum number of stages. The beginning of a document is never simply
 * truncated — coverage is spread across the whole document.
 */

import type {
  Citation,
  DocumentChunk,
  SummaryKind,
  SummaryResult,
} from './types';
import { buildCitations } from './citations';

const MAX_STAGES = 6;
const MAX_SENTENCES_PER_STAGE = 3;
const MAX_OUTPUT_SENTENCES = 12;

const ACTION_CUES =
  /\b(must|should|shall|need to|needs to|required|action|todo|to-do|please|ensure|verify|implement|migrate|update|review|approve|complete)\b/i;

const TECHNICAL_CUES =
  /\b(api|endpoint|schema|table|column|function|class|interface|protocol|architecture|latency|throughput|database|index|deploy|config|version|parameter)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 30 && s.length <= 400);
}

function contentTerms(text: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are', 'was',
    'were', 'will', 'into', 'your', 'our', 'you', 'their', 'they', 'which',
    'there', 'these', 'those', 'such', 'been', 'being', 'than', 'then',
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !stop.has(t));
}

/**
 * Score sentences by lexical centrality within their stage, with optional
 * intent-specific boosts.
 */
function scoreSentences(
  stageSentences: Array<{ sentence: string; chunk: DocumentChunk }>,
  kind: SummaryKind
): Array<{ sentence: string; chunk: DocumentChunk; score: number }> {
  const freq = new Map<string, number>();
  for (const { sentence } of stageSentences) {
    for (const term of new Set(contentTerms(sentence))) {
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
  }

  return stageSentences
    .map(({ sentence, chunk }) => {
      const terms = new Set(contentTerms(sentence));
      let centrality = 0;
      for (const term of terms) centrality += freq.get(term) ?? 0;
      const normalized = terms.size > 0 ? centrality / terms.size : 0;

      let boost = 0;
      if (kind === 'action_items' && ACTION_CUES.test(sentence)) boost += 2.5;
      if (kind === 'technical' && TECHNICAL_CUES.test(sentence)) boost += 1.5;
      if (kind === 'key_points') boost += 0.5;

      // Prefer earlier, structurally important chunks as tie-breakers.
      const positionBoost = 1 / (1 + chunk.order * 0.02);

      return { sentence, chunk, score: normalized + boost + positionBoost };
    })
    .sort((a, b) => b.score - a.score);
}

export class SummarizationEngine {
  summarize(
    chunks: DocumentChunk[],
    kind: SummaryKind,
    titlesByDocumentId: Map<string, string>
  ): SummaryResult {
    if (chunks.length === 0) {
      return {
        kind,
        summary: 'No document evidence was available to summarize.',
        usedChunkIds: [],
        citations: [],
        stages: 0,
        bounded: true,
        truncated: false,
      };
    }

    if (kind === 'compare') {
      return this.compareDocuments(chunks, titlesByDocumentId);
    }

    // --- Map stage: partition across the WHOLE document set ---------------
    const stageCount = Math.min(MAX_STAGES, Math.max(1, chunks.length));
    const stageSize = Math.ceil(chunks.length / stageCount);
    const stages: Array<Array<{ sentence: string; chunk: DocumentChunk }>> = [];

    for (let i = 0; i < chunks.length; i += stageSize) {
      const slice = chunks.slice(i, i + stageSize);
      const stageSentences: Array<{ sentence: string; chunk: DocumentChunk }> = [];
      for (const chunk of slice) {
        for (const sentence of sentences(chunk.text)) {
          stageSentences.push({ sentence, chunk });
        }
      }
      if (stageSentences.length > 0) stages.push(stageSentences);
    }

    // --- Reduce stage: best sentences per stage, then global bound -------
    const limitPerStage = kind === 'quick' ? 1 : kind === 'detailed' ? MAX_SENTENCES_PER_STAGE : 2;
    const picked: Array<{ sentence: string; chunk: DocumentChunk; score: number }> = [];

    for (const stage of stages) {
      const ranked = scoreSentences(stage, kind);
      picked.push(...ranked.slice(0, limitPerStage));
    }

    // Filter by kind-specific cues where required, but never return nothing.
    let finalPicked = picked;
    if (kind === 'action_items') {
      const actions = picked.filter((p) => ACTION_CUES.test(p.sentence));
      finalPicked = actions.length > 0 ? actions : picked;
    } else if (kind === 'technical') {
      const technical = picked.filter((p) => TECHNICAL_CUES.test(p.sentence));
      finalPicked = technical.length > 0 ? technical : picked;
    }

    finalPicked = finalPicked.slice(0, MAX_OUTPUT_SENTENCES);

    const usedChunks: DocumentChunk[] = [];
    const seen = new Set<string>();
    for (const p of finalPicked) {
      if (!seen.has(p.chunk.chunkId)) {
        seen.add(p.chunk.chunkId);
        usedChunks.push(p.chunk);
      }
    }

    const citations: Citation[] = buildCitations(usedChunks, titlesByDocumentId);
    const heading =
      kind === 'key_points'
        ? '**Key points**'
        : kind === 'action_items'
          ? '**Action items**'
          : kind === 'technical'
            ? '**Technical summary**'
            : kind === 'section'
              ? '**Section summary**'
              : '**Summary**';

    const bullets = finalPicked.map((p) => `- ${p.sentence}`).join('\n');

    return {
      kind,
      summary: `${heading}\n${bullets}`,
      usedChunkIds: usedChunks.map((c) => c.chunkId),
      citations,
      stages: stages.length,
      bounded: true,
      truncated: chunks.length > stageCount * stageSize,
    };
  }

  private compareDocuments(
    chunks: DocumentChunk[],
    titlesByDocumentId: Map<string, string>
  ): SummaryResult {
    const byDocument = new Map<string, DocumentChunk[]>();
    for (const chunk of chunks) {
      const list = byDocument.get(chunk.documentId) ?? [];
      list.push(chunk);
      byDocument.set(chunk.documentId, list);
    }

    const sections: string[] = [];
    const usedChunks: DocumentChunk[] = [];

    for (const [documentId, docChunks] of byDocument.entries()) {
      const title = titlesByDocumentId.get(documentId) ?? documentId;
      const stageSentences: Array<{ sentence: string; chunk: DocumentChunk }> = [];
      for (const chunk of docChunks) {
        for (const s of sentences(chunk.text)) stageSentences.push({ sentence: s, chunk });
      }
      const ranked = scoreSentences(stageSentences, 'detailed').slice(0, 3);
      if (ranked.length === 0) continue;

      usedChunks.push(...ranked.map((r) => r.chunk));
      sections.push(
        `**${title}**\n${ranked.map((r) => `- ${r.sentence}`).join('\n')}`
      );
    }

    const dedupedChunks: DocumentChunk[] = [];
    const seen = new Set<string>();
    for (const c of usedChunks) {
      if (!seen.has(c.chunkId)) {
        seen.add(c.chunkId);
        dedupedChunks.push(c);
      }
    }

    return {
      kind: 'compare',
      summary: sections.length > 0 ? sections.join('\n\n') : 'No comparable evidence was found.',
      usedChunkIds: dedupedChunks.map((c) => c.chunkId),
      citations: buildCitations(dedupedChunks, titlesByDocumentId),
      stages: byDocument.size,
      bounded: true,
      truncated: false,
    };
  }
}
