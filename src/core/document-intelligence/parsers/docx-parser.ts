/**
 * JARVIS-X v1.2.0 — DOCX Intelligence
 *
 * Extracts paragraphs, headings, lists, tables and section structure with
 * provenance. Uses `mammoth` (free, open-source) to convert DOCX to HTML,
 * then walks that HTML into normalized blocks.
 *
 * Macros / embedded scripts are never executed — mammoth only reads OOXML text.
 */

import type { DocumentBlock, DocumentTable, ParserCapability } from '../types';

export interface DocxExtractionResult {
  ok: boolean;
  blocks: DocumentBlock[];
  tables: DocumentTable[];
  metadata: Record<string, string | number | boolean | null>;
  title: string | null;
  warnings: string[];
  parserError: string | null;
}

interface HtmlToken {
  type: 'open' | 'close' | 'text';
  tag?: string;
  text?: string;
}

const TOKEN_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>|([^<]+)/g;

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const re = new RegExp(TOKEN_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    const full = match[0];
    if (match[1]) {
      tokens.push({
        type: full.startsWith('</') ? 'close' : 'open',
        tag: match[1].toLowerCase(),
      });
    } else if (match[2]) {
      const text = decodeEntities(match[2]);
      if (text.trim()) tokens.push({ type: 'text', text });
    }
  }
  return tokens;
}

/** Walk mammoth's predictable HTML into normalized blocks and tables. */
export function walkDocxHtml(html: string): {
  blocks: DocumentBlock[];
  tables: DocumentTable[];
} {
  const tokens = tokenizeHtml(html);
  const blocks: DocumentBlock[] = [];
  const tables: DocumentTable[] = [];

  let order = 0;
  let listDepth = 0;
  let listBuffer: string[] = [];
  let headingLevel: number | null = null;
  let headingBuffer = '';
  let paragraphBuffer = '';

  let inTable = false;
  let tableCounter = 0;
  let tableRows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';

  const pushBlock = (kind: DocumentBlock['kind'], text: string, level?: number) => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    blocks.push({ blockId: `b-${order}`, kind, text: trimmed, level, order });
    order += 1;
  };

  const flushList = () => {
    for (const item of listBuffer) pushBlock('list', item);
    listBuffer = [];
  };

  const flushParagraph = () => {
    if (paragraphBuffer.trim()) pushBlock('paragraph', paragraphBuffer);
    paragraphBuffer = '';
  };

  const finalizeTable = () => {
    if (tableRows.length > 0) {
      const headers = tableRows[0] ?? [];
      const rows = tableRows.slice(1, 51);
      tables.push({
        tableId: `t-${tableCounter}`,
        headers,
        rows,
        truncated: tableRows.length - 1 > rows.length,
      });
      tableCounter += 1;
      const rendered = [headers.join(' | '), ...rows.map((r) => r.join(' | '))]
        .filter((r) => r.length > 0)
        .join('\n');
      pushBlock('table', rendered);
    }
    tableRows = [];
    currentRow = [];
    inTable = false;
  };

  for (const token of tokens) {
    if (token.type === 'open' && token.tag) {
      const tag = token.tag;
      if (/^h[1-6]$/.test(tag)) {
        flushParagraph();
        flushList();
        headingLevel = Number(tag[1]);
        headingBuffer = '';
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        flushParagraph();
        listDepth += 1;
        continue;
      }
      if (tag === 'table') {
        flushParagraph();
        flushList();
        inTable = true;
        tableRows = [];
        continue;
      }
      if (tag === 'tr' && inTable) {
        currentRow = [];
        continue;
      }
      if ((tag === 'td' || tag === 'th') && inTable) {
        currentCell = '';
        continue;
      }
      continue;
    }

    if (token.type === 'close' && token.tag) {
      const tag = token.tag;
      if (/^h[1-6]$/.test(tag)) {
        pushBlock('heading', headingBuffer, headingLevel ?? Number(tag[1]));
        headingLevel = null;
        headingBuffer = '';
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        listDepth = Math.max(0, listDepth - 1);
        if (listDepth === 0) flushList();
        continue;
      }
      if ((tag === 'td' || tag === 'th') && inTable) {
        currentRow.push(currentCell.replace(/\s+/g, ' ').trim());
        currentCell = '';
        continue;
      }
      if (tag === 'tr' && inTable) {
        if (currentRow.length > 0) tableRows.push(currentRow);
        currentRow = [];
        continue;
      }
      if (tag === 'table') {
        finalizeTable();
        continue;
      }
      if (tag === 'p') {
        flushParagraph();
        continue;
      }
      if (tag === 'li') {
        flushList();
        continue;
      }
      continue;
    }

    if (token.type === 'text' && token.text) {
      if (inTable) {
        currentCell += ` ${token.text}`;
        continue;
      }
      if (headingLevel !== null) {
        headingBuffer += ` ${token.text}`;
        continue;
      }
      if (listDepth > 0) {
        listBuffer.push(token.text);
        continue;
      }
      paragraphBuffer += ` ${token.text}`;
    }
  }

  flushParagraph();
  flushList();
  if (inTable) finalizeTable();

  return { blocks, tables };
}

export class DocxParser {
  readonly parserName = 'mammoth';
  readonly parserVersion: string;

  constructor(options?: { parserVersion?: string }) {
    this.parserVersion = options?.parserVersion ?? '1.9.0';
  }

  capability(): ParserCapability {
    return {
      format: 'docx',
      status: 'AVAILABLE',
      parser: this.parserName,
      parserVersion: this.parserVersion,
      notes:
        'Paragraph, heading, list and table extraction with structural provenance. Macros and embedded scripts are never executed.',
      supportsPageProvenance: false,
      supportsTables: true,
      supportsOcrPath: false,
    };
  }

  async extract(bytes: Uint8Array): Promise<DocxExtractionResult> {
    let mammoth: typeof import('mammoth');
    try {
      mammoth = await import('mammoth');
    } catch {
      return {
        ok: false,
        blocks: [],
        tables: [],
        metadata: {},
        title: null,
        warnings: [],
        parserError: 'DOCX parser (mammoth) is not installed in this environment.',
      };
    }

    try {
      const buffer = Buffer.from(bytes);
      const result = await mammoth.convertToHtml({ buffer });
      const html = result.value ?? '';
      const warnings = (result.messages ?? [])
        .filter((m) => m.type === 'warning' || m.type === 'error')
        .map((m) => String(m.message).slice(0, 200))
        .slice(0, 10);

      const { blocks, tables } = walkDocxHtml(html);
      const firstHeading = blocks.find((b) => b.kind === 'heading');
      const firstParagraph = blocks.find((b) => b.kind === 'paragraph');

      return {
        ok: true,
        blocks,
        tables,
        metadata: { blockCount: blocks.length, tableCount: tables.length },
        title: (firstHeading?.text ?? firstParagraph?.text ?? null)?.slice(0, 200) ?? null,
        warnings,
        parserError: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        blocks: [],
        tables: [],
        metadata: {},
        title: null,
        warnings: [],
        parserError: `DOCX parser failed: ${message.slice(0, 300)}`,
      };
    }
  }
}
