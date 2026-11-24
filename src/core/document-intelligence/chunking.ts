/**
 * JARVIS-X v1.2.0 — Structure-Aware Chunking
 *
 * Prefers structural boundaries (document → section → heading → paragraph →
 * semantic chunk) over arbitrary character splits. Every chunk keeps full
 * provenance: section, heading path, page range, hashes and trust level.
 *
 * Bounded sizes, configurable overlap, and duplicate suppression.
 */

import crypto from 'crypto';
import type {
  ChunkingOptions,
  DocumentBlock,
  DocumentChunk,
  DocumentSection,
  NormalizedDocument,
} from './types';

export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  maxChunkChars: 1_200,
  overlapChars: 150,
  minChunkChars: 40,
};

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function estimateTokens(text: string): number {
  // Conservative provider-neutral estimate: ~4 chars per token.
  return Math.max(1, Math.ceil(text.length / 4));
}

interface HeadingFrame {
  level: number;
  heading: string;
}

/**
 * Derive document sections from block headings using a heading-level stack.
 * Returns sections plus a per-block section mapping.
 */
export function deriveSections(blocks: DocumentBlock[]): {
  sections: DocumentSection[];
  blockSection: Map<string, DocumentSection>;
} {
  const sections: DocumentSection[] = [];
  const blockSection = new Map<string, DocumentSection>();
  const stack: HeadingFrame[] = [];

  let current: DocumentSection = {
    sectionId: 's-0',
    heading: null,
    headingPath: [],
    level: 0,
    blockIds: [],
  };
  sections.push(current);

  for (const block of blocks) {
    if (block.kind === 'heading') {
      const level = block.level ?? 1;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack.push({ level, heading: block.text });

      current = {
        sectionId: `s-${sections.length}`,
        heading: block.text,
        headingPath: stack.map((f) => f.heading),
        level,
        startPage: block.page,
        endPage: block.page,
        blockIds: [],
      };
      sections.push(current);
      current.blockIds.push(block.blockId);
      blockSection.set(block.blockId, current);
      continue;
    }

    if (block.page) {
      current.startPage = current.startPage ?? block.page;
      current.endPage = block.page;
    }
    current.blockIds.push(block.blockId);
    blockSection.set(block.blockId, current);
  }

  return {
    sections: sections.filter((s) => s.blockIds.length > 0 || s.heading !== null),
    blockSection,
  };
}

/**
 * Split a long text block into bounded pieces at sentence boundaries where
 * possible. Used only when a single paragraph exceeds the chunk budget.
 */
function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const pieces: string[] = [];
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer.length + sentence.length > maxChars && buffer.length > 0) {
      pieces.push(buffer.trim());
      buffer = '';
    }
    if (sentence.length > maxChars) {
      // Hard split an oversized sentence at word boundaries.
      let remaining = sentence;
      while (remaining.length > maxChars) {
        let cut = remaining.lastIndexOf(' ', maxChars);
        if (cut <= 0) cut = maxChars;
        pieces.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut);
      }
      buffer = remaining;
      continue;
    }
    buffer += sentence;
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces.filter((p) => p.length > 0);
}

/**
 * Build chunks for a normalized document. Deterministic for a given input.
 */
export function chunkDocument(
  doc: NormalizedDocument,
  options?: Partial<ChunkingOptions>
): { chunks: DocumentChunk[]; duplicatesRemoved: number } {
  const opts: ChunkingOptions = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
  const { sections, blockSection } = deriveSections(doc.blocks);

  const blockById = new Map(doc.blocks.map((b) => [b.blockId, b]));
  const chunks: DocumentChunk[] = [];
  const seenHashes = new Set<string>();
  let duplicatesRemoved = 0;
  let order = 0;

  for (const section of sections) {
    const sectionBlocks = section.blockIds
      .map((id) => blockById.get(id))
      .filter((b): b is DocumentBlock => Boolean(b));
    if (sectionBlocks.length === 0) continue;

    // Accumulate blocks into a chunk buffer respecting the character budget.
    let buffer: DocumentBlock[] = [];
    let bufferChars = 0;

    const emit = () => {
      if (buffer.length === 0) return;

      const text = buffer
        .map((b) => b.text)
        .join('\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (!text) {
        buffer = [];
        bufferChars = 0;
        return;
      }

      const pages = buffer
        .map((b) => b.page)
        .filter((p): p is number => typeof p === 'number');
      const pageRange: [number, number] | null =
        pages.length > 0 ? [Math.min(...pages), Math.max(...pages)] : null;

      const contentHash = hashContent(text);
      if (seenHashes.has(contentHash)) {
        duplicatesRemoved += 1;
        buffer = [];
        bufferChars = 0;
        return;
      }
      seenHashes.add(contentHash);

      const headingPath = section.headingPath.length
        ? section.headingPath
        : doc.sections.find((s) => s.sectionId === blockSection.get(buffer[0].blockId)?.sectionId)
            ?.headingPath ?? [];

      chunks.push({
        chunkId: `${doc.documentId}-c-${order}`,
        documentId: doc.documentId,
        ownerId: doc.ownerId,
        projectId: doc.projectId,
        section: section.heading,
        headingPath,
        page: pageRange ? pageRange[0] : null,
        pageRange,
        text,
        charCount: text.length,
        tokenEstimate: estimateTokens(text),
        contentHash,
        trustLevel: doc.trustLevel,
        order,
        ingestedAt: doc.ingestedAt,
      });
      order += 1;

      buffer = [];
      bufferChars = 0;
    };

    for (const block of sectionBlocks) {
      const blockText = block.text;

      // Oversized single block: split at sentence boundaries.
      if (blockText.length > opts.maxChunkChars) {
        emit();
        const pieces = splitLongText(blockText, opts.maxChunkChars);
        for (const piece of pieces) {
          const pageRange: [number, number] | null =
            typeof block.page === 'number' ? [block.page, block.page] : null;
          const contentHash = hashContent(piece);
          if (seenHashes.has(contentHash)) {
            duplicatesRemoved += 1;
            continue;
          }
          seenHashes.add(contentHash);
          chunks.push({
            chunkId: `${doc.documentId}-c-${order}`,
            documentId: doc.documentId,
            ownerId: doc.ownerId,
            projectId: doc.projectId,
            section: section.heading,
            headingPath: section.headingPath,
            page: pageRange ? pageRange[0] : null,
            pageRange,
            text: piece,
            charCount: piece.length,
            tokenEstimate: estimateTokens(piece),
            contentHash,
            trustLevel: doc.trustLevel,
            order,
            ingestedAt: doc.ingestedAt,
          });
          order += 1;
        }
        continue;
      }

      // A chunk must never straddle a page boundary: page-level provenance is
      // only trustworthy when each chunk maps to exactly one page.
      const bufferPage = buffer.find((b) => typeof b.page === 'number')?.page;
      const pageChanged =
        typeof block.page === 'number' &&
        typeof bufferPage === 'number' &&
        block.page !== bufferPage;

      if (pageChanged && buffer.length > 0) {
        emit();
      }

      // Would this block overflow the current chunk?
      if (bufferChars + blockText.length + 2 > opts.maxChunkChars && buffer.length > 0) {
        const lastBlock = buffer[buffer.length - 1];
        emit();
        // Apply bounded overlap: carry the tail of the previous block forward.
        if (opts.overlapChars > 0 && lastBlock) {
          const tail = lastBlock.text.slice(-opts.overlapChars);
          if (tail.trim()) {
            buffer.push({
              ...lastBlock,
              blockId: `${lastBlock.blockId}-overlap`,
              text: tail,
            });
            bufferChars = tail.length;
          }
        }
      }

      buffer.push(block);
      bufferChars += blockText.length + 2;
    }
    emit();
  }

  // Drop chunks below the minimum unless they are the only content available.
  const filtered =
    chunks.length > 1 ? chunks.filter((c) => c.charCount >= opts.minChunkChars) : chunks;

  return {
    // Re-index in reading order while keeping IDs globally unique per document.
    chunks: filtered.map((c, idx) => ({
      ...c,
      order: idx,
      chunkId: `${doc.documentId}-c-${idx}`,
    })),
    duplicatesRemoved,
  };
}
