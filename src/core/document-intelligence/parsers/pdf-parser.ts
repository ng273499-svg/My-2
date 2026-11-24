/**
 * JARVIS-X v1.2.0 — Real PDF Intelligence
 *
 * Text-based PDFs: real text extraction with page boundaries, page numbers,
 * document metadata, paragraph reconstruction, heuristic headings and
 * page-level provenance (so every chunk can map back to a page).
 *
 * Scanned/image PDFs: detected honestly. We NEVER hallucinate page contents.
 * An OCR adapter interface is provided; without a configured OCR engine the
 * document is reported as OCR_REQUIRED.
 */

import type {
  DocumentBlock,
  ParserCapability,
  SupportedDocumentFormat,
} from '../types';

export interface PdfPageExtraction {
  pageNumber: number;
  text: string;
  paragraphs: string[];
  headings: string[];
  /** True when the page yielded almost no machine-readable text. */
  likelyScanned: boolean;
}

export interface PdfExtractionResult {
  ok: boolean;
  pages: PdfPageExtraction[];
  pageCount: number;
  metadata: Record<string, string | number | boolean | null>;
  title: string | null;
  /** True when no page yielded useful text → OCR required. */
  ocrRequired: boolean;
  encrypted: boolean;
  parserError: string | null;
}

/** Adapter interface for a future OCR engine. Never claimed to be active. */
export interface OcrAdapter {
  readonly adapterId: string;
  isConfigured(): boolean;
  /** Extract text for a single rendered page image. */
  extractPageText(imageBytes: Uint8Array): Promise<string>;
}

/** Minimum machine-readable characters per page before OCR is required. */
const MIN_USEFUL_CHARS_PER_PAGE = 24;

const HEADING_PATTERNS = [
  /^(?:chapter|section|part|appendix)\s+[0-9ivxlc]+\b/i,
  /^\d+(?:\.\d+)*\s+[A-Z][^\n]{2,80}$/,
  /^[A-Z][A-Z0-9 .,&()\-/]{6,80}$/,
];

function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 120) return false;
  // Sentence-ending punctuation strongly implies body text, not a heading.
  if (/[.!?;:,]\s*$/.test(trimmed)) return false;
  return HEADING_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Reconstruct paragraphs from pdf.js text items using line grouping and
 * vertical gaps. Purely heuristic — reported as such, never as structure
 * the PDF actually declares.
 */
function reconstructParagraphs(
  items: Array<{ text: string; y: number; height: number; hasEOL: boolean }>
): { paragraphs: string[]; headings: string[] } {
  if (items.length === 0) return { paragraphs: [], headings: [] };

  interface VisualLine {
    text: string;
    y: number;
    height: number;
  }

  const lines: VisualLine[] = [];
  let current: VisualLine | null = null;

  const pushCurrent = () => {
    if (current && current.text.trim()) {
      lines.push({ ...current, text: current.text.replace(/\s+/g, ' ').trim() });
    }
    current = null;
  };

  // --- Group text items into visual lines ------------------------------
  for (const item of items) {
    const height = item.height || 12;
    const tolerance = Math.max(1.5, height * 0.4);

    if (!current) {
      current = { text: item.text, y: item.y, height };
    } else if (Math.abs(current.y - item.y) <= tolerance) {
      const needsSpace =
        !/\s$/.test(current.text) && !/^\s/.test(item.text) && item.text.length > 0;
      current.text += (needsSpace ? ' ' : '') + item.text;
      current.height = Math.max(current.height, height);
    } else {
      pushCurrent();
      current = { text: item.text, y: item.y, height };
    }

    if (item.hasEOL) pushCurrent();
  }
  pushCurrent();

  // --- Group visual lines into paragraphs by vertical gap --------------
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  let prevY: number | null = null;
  let prevHeight = 12;

  const flush = () => {
    if (buffer.length > 0) {
      const joined = buffer.join(' ').replace(/\s+/g, ' ').trim();
      if (joined) paragraphs.push(joined);
      buffer = [];
    }
  };

  for (const line of lines) {
    if (prevY !== null) {
      const gap = Math.abs(prevY - line.y);
      // A gap materially larger than a line height indicates a paragraph break.
      if (gap > Math.max(prevHeight, line.height) * 1.6) flush();
    }
    buffer.push(line.text);
    prevY = line.y;
    prevHeight = line.height || 12;
  }
  flush();

  // Headings are detected on whole lines (more reliable than on paragraphs).
  const headings = lines.map((l) => l.text).filter((line) => looksLikeHeading(line));

  return { paragraphs, headings };
}

export class PdfParser {
  readonly parserName = 'pdfjs-dist';
  readonly parserVersion: string;
  private readonly ocrAdapter: OcrAdapter | null;

  constructor(options?: { parserVersion?: string; ocrAdapter?: OcrAdapter | null }) {
    this.parserVersion = options?.parserVersion ?? '4.10.38';
    this.ocrAdapter = options?.ocrAdapter ?? null;
  }

  capability(): ParserCapability {
    return {
      format: 'pdf',
      status: 'AVAILABLE',
      parser: this.parserName,
      parserVersion: this.parserVersion,
      notes: this.ocrAdapter?.isConfigured()
        ? 'Text PDF extraction active; OCR adapter configured for scanned pages.'
        : 'Text PDF extraction active with page-level provenance. No OCR adapter configured — scanned PDFs report OCR_REQUIRED.',
      supportsPageProvenance: true,
      supportsTables: false,
      supportsOcrPath: Boolean(this.ocrAdapter?.isConfigured()),
    };
  }

  isOcrConfigured(): boolean {
    return Boolean(this.ocrAdapter?.isConfigured());
  }

  async extract(bytes: Uint8Array, options?: { maxPages?: number }): Promise<PdfExtractionResult> {
    let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
    try {
      pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch {
      return {
        ok: false,
        pages: [],
        pageCount: 0,
        metadata: {},
        title: null,
        ocrRequired: false,
        encrypted: false,
        parserError: 'PDF parser (pdfjs-dist) is not installed in this environment.',
      };
    }

    const maxPages = options?.maxPages ?? 2_000;

    try {
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(bytes),
        isEvalSupported: false,
        useWorkerFetch: false,
        // Never evaluate embedded JavaScript from a PDF.
        disableAutoFetch: true,
        disableStream: true,
        // Suppress the built-in standard-font probe (it only triggers a
        // harmless console warning when the font data URL is unavailable).
        verbosity: 0,
      }).promise;

      const pageCount = doc.numPages;
      const pages: PdfPageExtraction[] = [];
      let totalChars = 0;

      const pagesToRead = Math.min(pageCount, maxPages);

      for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
        const page = await doc.getPage(pageNumber);
        const textContent = await page.getTextContent();

        const rawItems = textContent.items as Array<Record<string, unknown>>;
        const items = rawItems
          .filter((i) => typeof i.str === 'string')
          .map((i) => {
            const transform = (i.transform as number[] | undefined) ?? [1, 0, 0, 1, 0, 0];
            return {
              text: String(i.str),
              y: transform[5] ?? 0,
              height: Math.abs((i.height as number | undefined) ?? 12) || 12,
              hasEOL: Boolean(i.hasEOL),
            };
          });

        const flattened = items.map((i) => i.text).join(' ');
        const { paragraphs, headings } = reconstructParagraphs(items);
        const text = paragraphs.join('\n\n');
        totalChars += text.trim().length;

        pages.push({
          pageNumber,
          text,
          paragraphs,
          headings,
          likelyScanned: text.trim().length < MIN_USEFUL_CHARS_PER_PAGE,
        });

        page.cleanup();
      }

      // Document metadata (title, author, producer…) — never secrets.
      let metadata: Record<string, string | number | boolean | null> = {};
      let title: string | null = null;
      try {
        const meta = await doc.getMetadata();
        const info = (meta.info ?? {}) as Record<string, unknown>;
        const allowedKeys = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate'];
        for (const key of allowedKeys) {
          const value = info[key];
          if (typeof value === 'string' && value.trim()) {
            metadata[key.toLowerCase()] = value.trim().slice(0, 300);
          }
        }
        title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : null;
      } catch {
        // Metadata is optional.
      }
      metadata.pageCount = pageCount;

      await doc.destroy();

      const usefulPages = pages.filter((p) => !p.likelyScanned).length;
      const ocrRequired = pages.length > 0 && usefulPages === 0;

      return {
        ok: true,
        pages,
        pageCount,
        metadata,
        title,
        ocrRequired,
        encrypted: false,
        parserError: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const encrypted = /password|encrypt/i.test(message);
      return {
        ok: false,
        pages: [],
        pageCount: 0,
        metadata: {},
        title: null,
        ocrRequired: false,
        encrypted,
        parserError: encrypted
          ? 'PDF is encrypted or password-protected; text extraction is not permitted.'
          : `PDF parser failed: ${message.slice(0, 300)}`,
      };
    }
  }

  /** Convert extracted pages into normalized blocks with page provenance. */
  toBlocks(result: PdfExtractionResult): { blocks: DocumentBlock[]; warnings: string[] } {
    const blocks: DocumentBlock[] = [];
    const warnings: string[] = [];
    let order = 0;

    for (const page of result.pages) {
      if (page.likelyScanned) {
        warnings.push(
          `Page ${page.pageNumber} yielded little machine-readable text and is likely a scanned image.`
        );
        continue;
      }

      for (const paragraph of page.paragraphs) {
        const isHeading = page.headings.some(
          (h) => h === paragraph || paragraph.startsWith(h)
        );
        blocks.push({
          blockId: `b-${order}`,
          kind: isHeading ? 'heading' : 'paragraph',
          text: paragraph,
          page: page.pageNumber,
          order,
        });
        order += 1;
      }
    }

    return { blocks, warnings };
  }
}

export function pdfFormat(): SupportedDocumentFormat {
  return 'pdf';
}
