import { PromptInjectionBoundary } from '@/core/models/prompt-boundary';
import { redactSecrets } from '@/core/models/provider-config';

export type SupportedDocumentFormat = 'markdown' | 'text' | 'csv' | 'json' | 'code';

export interface CsvColumnSummary {
  column: string;
  nonEmptyCount: number;
  numericCount: number;
  min?: number;
  max?: number;
  mean?: number;
}

export interface DocumentAnalysisResult {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  formatKind: SupportedDocumentFormat;
  lineCount: number;
  wordCount: number;
  tokenEstimate: number;
  headings: string[];
  codeSymbols: string[];
  csvSummary?: {
    rowCount: number;
    columns: string[];
    numericStats: CsvColumnSummary[];
    sampleRows: Record<string, string>[];
  };
  jsonSummary?: {
    valid: boolean;
    rootType: 'object' | 'array' | 'primitive' | 'invalid';
    recordCount: number;
    topLevelKeys: string[];
  };
  chunks: string[];
  injectionAttemptDetected: boolean;
  detectedInjectionPatterns: string[];
  quarantinedBlock: string;
  conciseSummary: string;
}

export function detectDocumentFormat(
  fileName: string,
  mimeType: string
): SupportedDocumentFormat | 'unsupported_binary' {
  const lower = fileName.toLowerCase();
  const mime = mimeType.toLowerCase();

  if (lower.endsWith('.pdf') || mime === 'application/pdf') {
    return 'unsupported_binary';
  }
  if (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    lower.endsWith('.docx') ||
    lower.endsWith('.zip')
  ) {
    return 'unsupported_binary';
  }
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || mime.includes('csv')) {
    return 'csv';
  }
  if (lower.endsWith('.json') || mime.includes('json')) {
    return 'json';
  }
  if (lower.endsWith('.md') || lower.endsWith('.mdx') || mime.includes('markdown')) {
    return 'markdown';
  }
  if (
    /\.(ts|tsx|js|jsx|py|sql|sh|yaml|yml|toml|rs|go|java|c|cpp)$/.test(lower)
  ) {
    return 'code';
  }
  return 'text';
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
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
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function analyzeCsvContent(text: string, isTsv: boolean): DocumentAnalysisResult['csvSummary'] {
  const delimiter = isTsv ? '\t' : ',';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { rowCount: 0, columns: [], numericStats: [], sampleRows: [] };
  }

  const columns = parseDelimitedLine(lines[0], delimiter).map(
    (c, idx) => c || `col_${idx + 1}`
  );
  const dataLines = lines.slice(1, 5001);
  const accum = columns.map((col) => ({
    column: col,
    nonEmptyCount: 0,
    numericValues: [] as number[],
  }));

  const sampleRows: Record<string, string>[] = [];

  for (let r = 0; r < dataLines.length; r += 1) {
    const cells = parseDelimitedLine(dataLines[r], delimiter);
    const rowObj: Record<string, string> = {};
    for (let c = 0; c < columns.length; c += 1) {
      const val = cells[c] ?? '';
      rowObj[columns[c]] = val;
      if (val !== '') {
        accum[c].nonEmptyCount += 1;
        const num = Number(val);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
          accum[c].numericValues.push(num);
        }
      }
    }
    if (sampleRows.length < 3) {
      sampleRows.push(rowObj);
    }
  }

  const numericStats: CsvColumnSummary[] = accum.map((a) => {
    if (a.numericValues.length === 0) {
      return {
        column: a.column,
        nonEmptyCount: a.nonEmptyCount,
        numericCount: 0,
      };
    }
    let min = a.numericValues[0];
    let max = a.numericValues[0];
    let sum = 0;
    for (const v of a.numericValues) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return {
      column: a.column,
      nonEmptyCount: a.nonEmptyCount,
      numericCount: a.numericValues.length,
      min: Number(min.toFixed(4)),
      max: Number(max.toFixed(4)),
      mean: Number((sum / a.numericValues.length).toFixed(4)),
    };
  });

  return {
    rowCount: dataLines.length,
    columns,
    numericStats,
    sampleRows,
  };
}

export function chunkDocumentForKnowledge(
  fileName: string,
  text: string,
  maxChunkChars = 900
): string[] {
  const safeText = redactSecrets(text).trim();
  if (!safeText) return [];

  const paragraphs = safeText.split(/\n{2,}/);
  const chunks: string[] = [];
  let buffer = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if ((buffer + '\n\n' + trimmed).length <= maxChunkChars) {
      buffer = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
    } else {
      if (buffer) {
        chunks.push(`[Source: ${fileName}] ${buffer}`);
        buffer = '';
      }
      if (trimmed.length <= maxChunkChars) {
        buffer = trimmed;
      } else {
        for (let i = 0; i < trimmed.length; i += maxChunkChars) {
          chunks.push(`[Source: ${fileName}] ${trimmed.slice(i, i + maxChunkChars)}`);
        }
      }
    }
    if (chunks.length >= 24) break;
  }

  if (buffer && chunks.length < 24) {
    chunks.push(`[Source: ${fileName}] ${buffer}`);
  }

  return chunks;
}

/**
 * Deterministic Document & Dataset Intelligence Engine (`file_intelligence`).
 * Analyzes uploaded Markdown, CSV/TSV, JSON, Code, and Plain Text documents locally,
 * profiles tabular/JSON schemas, chunks text for `knowledge` memory ingestion, and
 * quarantines untrusted content via `PromptInjectionBoundary`.
 */
export function analyzeStructuredDocument(input: {
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  textContent: string;
}): DocumentAnalysisResult {
  const detected = detectDocumentFormat(input.fileName, input.mimeType);
  const formatKind: SupportedDocumentFormat =
    detected === 'unsupported_binary' ? 'text' : detected;

  const boundedText = input.textContent.slice(0, 120_000);
  const lines = boundedText.split(/\r?\n/);
  const words = boundedText.trim() ? boundedText.trim().split(/\s+/) : [];
  const tokenEstimate = Math.max(1, Math.ceil(boundedText.length / 4));

  const headings = lines
    .filter((l) => /^#{1,4}\s+\S/.test(l.trim()))
    .slice(0, 16)
    .map((h) => h.trim().replace(/^#+\s+/, ''));

  const codeSymbols: string[] = [];
  if (formatKind === 'code') {
    const symRegex =
      /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|def|create\s+table(?:\s+if\s+not\s+exists)?)\s+([a-zA-Z0-9_.\-]+)/gi;
    let m: RegExpExecArray | null = symRegex.exec(boundedText);
    while (m && codeSymbols.length < 20) {
      codeSymbols.push(m[1]);
      m = symRegex.exec(boundedText);
    }
  }

  let csvSummary: DocumentAnalysisResult['csvSummary'];
  let jsonSummary: DocumentAnalysisResult['jsonSummary'];

  if (formatKind === 'csv') {
    csvSummary = analyzeCsvContent(
      boundedText,
      input.fileName.toLowerCase().endsWith('.tsv')
    );
  } else if (formatKind === 'json') {
    try {
      const parsed = JSON.parse(boundedText) as unknown;
      if (Array.isArray(parsed)) {
        const firstObj =
          parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null
            ? Object.keys(parsed[0] as Record<string, unknown>).slice(0, 20)
            : [];
        jsonSummary = {
          valid: true,
          rootType: 'array',
          recordCount: parsed.length,
          topLevelKeys: firstObj,
        };
      } else if (typeof parsed === 'object' && parsed !== null) {
        const keys = Object.keys(parsed as Record<string, unknown>);
        jsonSummary = {
          valid: true,
          rootType: 'object',
          recordCount: keys.length,
          topLevelKeys: keys.slice(0, 20),
        };
      } else {
        jsonSummary = {
          valid: true,
          rootType: 'primitive',
          recordCount: 1,
          topLevelKeys: [],
        };
      }
    } catch {
      jsonSummary = {
        valid: false,
        rootType: 'invalid',
        recordCount: 0,
        topLevelKeys: [],
      };
    }
  }

  const boundary = new PromptInjectionBoundary();
  const evalBoundary = boundary.evaluate('', '', [
    {
      sourceType: 'file',
      label: input.fileName,
      rawContent: boundedText,
    },
  ]);

  const chunks = chunkDocumentForKnowledge(input.fileName, boundedText);

  let conciseSummary = `Analyzed ${formatKind.toUpperCase()} document "${input.fileName}" (${lines.length} lines, ~${tokenEstimate} tokens, ${chunks.length} chunk(s)).`;
  if (csvSummary) {
    const numCols = csvSummary.numericStats
      .filter((s) => s.numericCount > 0)
      .map((s) => `${s.column}[mean=${s.mean}]`)
      .slice(0, 4);
    conciseSummary = `Analyzed CSV dataset "${input.fileName}": ${csvSummary.rowCount} row(s), ${csvSummary.columns.length} column(s) (${csvSummary.columns.slice(0, 6).join(', ')})${
      numCols.length > 0 ? ` · Numeric stats: ${numCols.join(', ')}` : ''
    }.`;
  } else if (jsonSummary) {
    conciseSummary = jsonSummary.valid
      ? `Analyzed JSON "${input.fileName}": valid ${jsonSummary.rootType} (${jsonSummary.recordCount} item(s)/key(s): ${jsonSummary.topLevelKeys.slice(0, 6).join(', ') || 'scalar'}).`
      : `Inspected JSON "${input.fileName}": invalid JSON syntax detected.`;
  } else if (headings.length > 0) {
    conciseSummary += ` Sections: ${headings.slice(0, 5).join(' · ')}.`;
  } else if (codeSymbols.length > 0) {
    conciseSummary += ` Symbols: ${codeSymbols.slice(0, 6).join(', ')}.`;
  }

  return {
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes ?? boundedText.length,
    formatKind,
    lineCount: lines.length,
    wordCount: words.length,
    tokenEstimate,
    headings,
    codeSymbols,
    csvSummary,
    jsonSummary,
    chunks,
    injectionAttemptDetected: evalBoundary.injectionAttemptDetected,
    detectedInjectionPatterns: evalBoundary.detectedPatterns,
    quarantinedBlock: evalBoundary.sanitizedUntrustedBlock ?? '',
    conciseSummary,
  };
}
