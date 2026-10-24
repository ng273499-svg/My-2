/**
 * JARVIS-X v1.2.0 — Citation Engine
 *
 * Builds citations ONLY from verified provenance. If an exact page number was
 * not established during extraction, the closest verified structural location
 * is cited instead — a page number is never invented.
 */

import type { Citation, DocumentChunk } from './types';

/**
 * Human-readable location derived strictly from what extraction produced.
 */
export function buildLocationLabel(chunk: DocumentChunk): string {
  if (chunk.pageRange) {
    const [start, end] = chunk.pageRange;
    return start === end ? `p. ${start}` : `pp. ${start}–${end}`;
  }
  if (typeof chunk.page === 'number') {
    return `p. ${chunk.page}`;
  }
  if (chunk.section) {
    return `section "${chunk.section}"`.slice(0, 120);
  }
  if (chunk.headingPath.length > 0) {
    return `"${chunk.headingPath[chunk.headingPath.length - 1]}"`.slice(0, 120);
  }
  return 'document body';
}

export function citationFromChunk(
  chunk: DocumentChunk,
  documentTitle: string,
  index: number
): Citation {
  return {
    citationId: `cit-${index}`,
    documentId: chunk.documentId,
    documentTitle,
    chunkId: chunk.chunkId,
    page: chunk.page,
    pageRange: chunk.pageRange,
    section: chunk.section,
    headingPath: chunk.headingPath,
    locationLabel: buildLocationLabel(chunk),
  };
}

/** Build a deduplicated citation list for a set of chunks. */
export function buildCitations(
  chunks: DocumentChunk[],
  titlesByDocumentId: Map<string, string>
): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const key = `${chunk.documentId}::${chunk.chunkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      citationFromChunk(
        chunk,
        titlesByDocumentId.get(chunk.documentId) ?? chunk.documentId,
        out.length + 1
      )
    );
  }

  return out;
}

/** Render an inline citation marker, e.g. `[Architecture.pdf, p. 14]`. */
export function renderInlineCitation(citation: Citation): string {
  return `[${citation.documentTitle}, ${citation.locationLabel}]`;
}

/** Render the citation list appended to a grounded answer. */
export function renderCitationsBlock(citations: Citation[]): string {
  if (citations.length === 0) return '';
  const lines = citations.map(
    (c) => `- [${c.citationId}] ${c.documentTitle} — ${c.locationLabel}`
  );
  return `\n\n**Sources**\n${lines.join('\n')}`;
}
