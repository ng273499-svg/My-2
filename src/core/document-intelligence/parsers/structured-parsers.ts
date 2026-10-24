/**
 * JARVIS-X v1.2.0 — Text & Structured-Data Intelligence
 *
 * Text-like formats (txt, markdown, code, html, xml, yaml, toml) plus CSV/TSV
 * and JSON. Bounded previews only — enormous datasets are never dumped into
 * model context.
 */

import type { DocumentBlock, DocumentTable, ParserCapability } from '../types';

export interface StructuredExtractionResult {
  ok: boolean;
  blocks: DocumentBlock[];
  tables: DocumentTable[];
  metadata: Record<string, string | number | boolean | null>;
  title: string | null;
  warnings: string[];
  parserError: string | null;
}

const MAX_PREVIEW_ROWS = 200;
const MAX_BLOCK_CHARS = 4_000;

function pushBlock(
  blocks: DocumentBlock[],
  kind: DocumentBlock['kind'],
  text: string,
  extra?: { page?: number; level?: number }
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  blocks.push({
    blockId: `b-${blocks.length}`,
    kind,
    text: trimmed.length > MAX_BLOCK_CHARS ? trimmed.slice(0, MAX_BLOCK_CHARS) : trimmed,
    level: extra?.level,
    page: extra?.page,
    order: blocks.length,
  });
}

/* ---------------------------------------------------------------------------
 * Text-like formats
 * ------------------------------------------------------------------------- */

const MARKDOWN_HEADING = /^(#{1,6})\s+(.+)$/;
const SETEXT_UNDERLINE = /^(=+|-+)\s*$/;

export function parseTextLike(
  text: string,
  format: 'txt' | 'markdown' | 'code' | 'html' | 'xml' | 'yaml' | 'toml'
): StructuredExtractionResult {
  const blocks: DocumentBlock[] = [];
  const lines = text.split(/\r?\n/);
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    pushBlock(blocks, 'paragraph', buffer.join(' ').replace(/\s+/g, ' '));
    buffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Markdown ATX headings
    if (format === 'markdown') {
      const md = MARKDOWN_HEADING.exec(line);
      if (md) {
        flush();
        pushBlock(blocks, 'heading', md[2], { level: md[1].length });
        continue;
      }
      // Setext headings: "Title" followed by "===" or "---"
      const next = lines[i + 1];
      if (line.trim() && next && SETEXT_UNDERLINE.test(next.trim())) {
        flush();
        pushBlock(blocks, 'heading', line.trim(), { level: next.trim().startsWith('=') ? 1 : 2 });
        i += 1;
        continue;
      }
      // Fenced code
      if (/^```/.test(line.trim())) {
        flush();
        const codeLines: string[] = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          codeLines.push(lines[i]);
          i += 1;
        }
        pushBlock(blocks, 'code', codeLines.join('\n'));
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        flush();
        pushBlock(blocks, 'list', line.replace(/^\s*[-*+\d.]+\s+/, ''));
        continue;
      }
    }

    // HTML headings
    if (format === 'html') {
      const h = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i.exec(text);
      if (h && line.includes(`<h${h[1]}`)) {
        flush();
        pushBlock(blocks, 'heading', stripHtml(h[2]), { level: Number(h[1]) });
        continue;
      }
    }

    if (!line.trim()) {
      flush();
      continue;
    }
    buffer.push(format === 'code' ? line : line.trim());
  }
  flush();

  if (format === 'html') {
    // Ensure body text is captured even when no headings exist.
    if (!blocks.some((b) => b.kind === 'paragraph')) {
      const bodyText = stripHtml(text);
      if (bodyText.trim()) pushBlock(blocks, 'paragraph', bodyText);
    }
  }

  const firstHeading = blocks.find((b) => b.kind === 'heading');
  const firstParagraph = blocks.find((b) => b.kind === 'paragraph');

  return {
    ok: true,
    blocks,
    tables: [],
    metadata: { lineCount: lines.length, blockCount: blocks.length },
    title: (firstHeading?.text ?? firstParagraph?.text ?? null)?.slice(0, 200) ?? null,
    warnings: [],
    parserError: null,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------------------------------------------------------------------
 * CSV / TSV
 * ------------------------------------------------------------------------- */

export function splitDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((c) => c.trim());
}

export interface CsvParseResult extends StructuredExtractionResult {
  csvSummary?: {
    rowCount: number;
    columnCount: number;
    columns: string[];
    columnTypes: Record<string, 'numeric' | 'text' | 'empty'>;
    numericStats: Array<{ column: string; count: number; min: number; max: number; mean: number }>;
    previewRowCount: number;
    truncated: boolean;
  };
}

export function parseCsv(text: string, delimiter?: string): CsvParseResult {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim =
    delimiter ?? (firstLine.includes('\t') ? '\t' : firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');

  const rawLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) {
    return {
      ok: false,
      blocks: [],
      tables: [],
      metadata: {},
      title: null,
      warnings: [],
      parserError: 'CSV contains no data rows.',
    };
  }

  const parseRow = (line: string): string[] => {
    if (line.includes('"') && delim !== '\t') return splitDelimitedLine(line, delim);
    return line.split(delim).map((c) => c.trim());
  };

  const header = parseRow(rawLines[0]);
  const allRows = rawLines.slice(1).map(parseRow);
  const preview = allRows.slice(0, MAX_PREVIEW_ROWS);
  const truncated = allRows.length > preview.length;

  // Column typing & safe numeric statistics
  const columnTypes: Record<string, 'numeric' | 'text' | 'empty'> = {};
  const numericStats: Array<{ column: string; count: number; min: number; max: number; mean: number }> = [];

  header.forEach((column, idx) => {
    const values = allRows.map((r) => r[idx]).filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (values.length === 0) {
      columnTypes[column] = 'empty';
      return;
    }
    const numeric = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (numeric.length === values.length && values.length > 0) {
      columnTypes[column] = 'numeric';
      const sum = numeric.reduce((a, b) => a + b, 0);
      numericStats.push({
        column,
        count: numeric.length,
        min: Math.min(...numeric),
        max: Math.max(...numeric),
        mean: Number((sum / numeric.length).toFixed(6)),
      });
    } else {
      columnTypes[column] = 'text';
    }
  });

  const blocks: DocumentBlock[] = [];
  const tables: DocumentTable[] = [
    {
      tableId: 't-0',
      headers: header,
      rows: preview,
      truncated,
    },
  ];

  // Header block (searchable)
  pushBlock(blocks, 'table', `Columns: ${header.join(', ')}`);

  // Row chunks so individual rows are lexically retrievable (bounded).
  for (let i = 0; i < preview.length; i += 1) {
    const row = preview[i];
    const rendered = header
      .map((h, idx) => `${h}=${row[idx] ?? ''}`)
      .filter((pair) => !pair.endsWith('='))
      .join('; ');
    if (rendered) pushBlock(blocks, 'table', `Row ${i + 1}: ${rendered}`);
  }

  const warnings: string[] = [];
  if (truncated) {
    warnings.push(
      `CSV preview truncated to ${preview.length} of ${allRows.length} rows; full dataset was not loaded into context.`
    );
  }

  return {
    ok: true,
    blocks,
    tables,
    metadata: {
      rowCount: allRows.length,
      columnCount: header.length,
      delimiter: delim === '\t' ? 'tab' : delim,
      previewRowCount: preview.length,
      truncated,
    },
    title: null,
    warnings,
    parserError: null,
    csvSummary: {
      rowCount: allRows.length,
      columnCount: header.length,
      columns: header,
      columnTypes,
      numericStats,
      previewRowCount: preview.length,
      truncated,
    },
  };
}

/* ---------------------------------------------------------------------------
 * JSON
 * ------------------------------------------------------------------------- */

export interface JsonProfile {
  valid: boolean;
  rootType: 'object' | 'array' | 'primitive' | 'invalid';
  topLevelKeys: string[];
  maxDepth: number;
  arrayLengths: Record<string, number>;
  keyCount: number;
  truncated: boolean;
}

export function profileJson(value: unknown, maxKeys = 100, maxDepth = 8): JsonProfile {
  if (value === null || value === undefined) {
    return { valid: true, rootType: 'primitive', topLevelKeys: [], maxDepth: 0, arrayLengths: {}, keyCount: 0, truncated: false };
  }
  const rootType: JsonProfile['rootType'] = Array.isArray(value)
    ? 'array'
    : typeof value === 'object'
      ? 'object'
      : 'primitive';

  const topLevelKeys = rootType === 'object' ? Object.keys(value as object).slice(0, maxKeys) : [];
  const arrayLengths: Record<string, number> = {};
  let keyCount = 0;
  let observedDepth = 0;

  const walk = (node: unknown, depth: number) => {
    if (depth > maxDepth) return;
    observedDepth = Math.max(observedDepth, depth);
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 50)) walk(item, depth + 1);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        keyCount += 1;
        if (Array.isArray(v)) arrayLengths[k] = v.length;
        walk(v, depth + 1);
      }
    }
  };
  walk(value, 1);

  return {
    valid: true,
    rootType,
    topLevelKeys,
    maxDepth: observedDepth,
    arrayLengths,
    keyCount,
    truncated: keyCount > maxKeys,
  };
}

export function parseJson(text: string): StructuredExtractionResult & { jsonProfile?: JsonProfile } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      blocks: [],
      tables: [],
      metadata: {},
      title: null,
      warnings: [],
      parserError: `JSON is not valid: ${err instanceof Error ? err.message : 'parse error'}`,
    };
  }

  const profile = profileJson(parsed);
  const blocks: DocumentBlock[] = [];

  pushBlock(
    blocks,
    'paragraph',
    `JSON ${profile.rootType} with ${profile.keyCount} key(s); top-level keys: ${profile.topLevelKeys.slice(0, 40).join(', ') || '(none)'}`
  );

  // Bounded structured chunks: emit each top-level entry separately.
  if (profile.rootType === 'object') {
    for (const key of profile.topLevelKeys.slice(0, 50)) {
      const value = (parsed as Record<string, unknown>)[key];
      const serialized = safeStringify(value).slice(0, MAX_BLOCK_CHARS);
      pushBlock(blocks, 'code', `${key}: ${serialized}`);
    }
  } else if (profile.rootType === 'array') {
    const arr = parsed as unknown[];
    for (let i = 0; i < Math.min(arr.length, 50); i += 1) {
      pushBlock(blocks, 'code', `[${i}]: ${safeStringify(arr[i]).slice(0, MAX_BLOCK_CHARS)}`);
    }
  } else {
    pushBlock(blocks, 'paragraph', safeStringify(parsed).slice(0, MAX_BLOCK_CHARS));
  }

  return {
    ok: true,
    blocks,
    tables: [],
    metadata: {
      rootType: profile.rootType,
      keyCount: profile.keyCount,
      maxDepth: profile.maxDepth,
    },
    title: null,
    warnings: profile.truncated
      ? ['JSON has many keys; structured chunks were bounded to the first 50 top-level entries.']
      : [],
    parserError: null,
    jsonProfile: profile,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ---------------------------------------------------------------------------
 * Capability reporting
 * ------------------------------------------------------------------------- */

export function textParserCapability(
  format: 'txt' | 'markdown' | 'code' | 'html' | 'xml' | 'yaml' | 'toml' | 'csv' | 'json'
): ParserCapability {
  const note =
    format === 'csv'
      ? 'Headers, row count, column typing, safe numeric statistics and bounded previews.'
      : format === 'json'
        ? 'Schema/profile, keys, nesting, arrays and bounded structured chunks.'
        : 'Structure-aware text extraction with heading detection.';
  return {
    format,
    status: 'AVAILABLE',
    parser: 'jarvis-native-structured-parser',
    parserVersion: '1.2.0',
    notes: note,
    supportsPageProvenance: false,
    supportsTables: format === 'csv',
    supportsOcrPath: false,
  };
}
