/**
 * JARVIS-X v1.2.0 — Parser Registry
 *
 * Extensible format → parser resolution with HONEST capability reporting.
 * A format whose parser is unavailable returns a capability status and an
 * empty extraction — content is never fabricated.
 */

import type {
  DocumentBlock,
  DocumentTable,
  FutureDocumentFormat,
  ParserCapability,
  SupportedDocumentFormat,
} from '../types';
import { formatFromExtension, formatFromMime } from '../security-gate';
import { PdfParser, type OcrAdapter } from './pdf-parser';
import { DocxParser } from './docx-parser';
import {
  parseCsv,
  parseJson,
  parseTextLike,
  textParserCapability,
  type CsvParseResult,
  type JsonProfile,
} from './structured-parsers';

export interface ExtractionOutcome {
  ok: boolean;
  blocks: DocumentBlock[];
  tables: DocumentTable[];
  metadata: Record<string, string | number | boolean | null>;
  title: string | null;
  pageCount: number;
  pageProvenanceAvailable: boolean;
  ocrRequired: boolean;
  parser: string;
  parserVersion: string;
  warnings: string[];
  parserError: string | null;
  csvSummary?: CsvParseResult['csvSummary'];
  jsonProfile?: JsonProfile;
}

export class ParserRegistry {
  private readonly pdf: PdfParser;
  private readonly docx: DocxParser;

  constructor(options?: { ocrAdapter?: OcrAdapter | null }) {
    this.pdf = new PdfParser({ ocrAdapter: options?.ocrAdapter ?? null });
    this.docx = new DocxParser();
  }

  /** Report every supported format plus reserved future adapters. */
  capabilities(): ParserCapability[] {
    const caps: ParserCapability[] = [this.pdf.capability(), this.docx.capability()];

    for (const format of [
      'txt',
      'markdown',
      'code',
      'html',
      'xml',
      'yaml',
      'toml',
      'csv',
      'json',
    ] as const) {
      caps.push(textParserCapability(format));
    }

    for (const future of ['xlsx', 'pptx', 'odt', 'epub'] as FutureDocumentFormat[]) {
      caps.push({
        format: future,
        status: 'NOT_INSTALLED',
        parser: 'reserved-adapter',
        parserVersion: '0.0.0',
        notes: `${future.toUpperCase()} extraction is reserved for a future release; no parser is configured and no content will be fabricated.`,
        supportsPageProvenance: false,
        supportsTables: false,
        supportsOcrPath: false,
      });
    }

    return caps;
  }

  resolveFormat(fileName: string, mimeType: string): SupportedDocumentFormat | null {
    return formatFromExtension(fileName) ?? formatFromMime(mimeType);
  }

  isOcrConfigured(): boolean {
    return this.pdf.isOcrConfigured();
  }

  async extract(
    format: SupportedDocumentFormat,
    input: { bytes?: Uint8Array; textContent?: string; fileName: string; mimeType: string }
  ): Promise<ExtractionOutcome> {
    switch (format) {
      case 'pdf': {
        if (!input.bytes) {
          return this.failure('pdf', 'PDF extraction requires raw bytes; no bytes were supplied.');
        }
        const result = await this.pdf.extract(input.bytes);
        if (!result.ok) {
          return this.failure('pdf', result.parserError ?? 'PDF extraction failed.');
        }
        const { blocks, warnings } = this.pdf.toBlocks(result);
        return {
          ok: true,
          blocks,
          tables: [],
          metadata: result.metadata,
          title: result.title ?? this.titleFromFileName(input.fileName),
          pageCount: result.pageCount,
          pageProvenanceAvailable: true,
          ocrRequired: result.ocrRequired,
          parser: this.pdf.parserName,
          parserVersion: this.pdf.parserVersion,
          warnings: result.ocrRequired
            ? [
                'No page yielded machine-readable text: this PDF appears to be scanned imagery.',
                'OCR is required before contents can be read. JARVIS-X will not infer scanned page contents.',
                ...warnings,
              ]
            : warnings,
          parserError: null,
        };
      }

      case 'docx': {
        if (!input.bytes) {
          return this.failure('docx', 'DOCX extraction requires raw bytes; no bytes were supplied.');
        }
        const result = await this.docx.extract(input.bytes);
        if (!result.ok) {
          return this.failure('docx', result.parserError ?? 'DOCX extraction failed.');
        }
        return {
          ok: true,
          blocks: result.blocks,
          tables: result.tables,
          metadata: result.metadata,
          title: result.title ?? this.titleFromFileName(input.fileName),
          pageCount: 0,
          pageProvenanceAvailable: false,
          ocrRequired: false,
          parser: this.docx.parserName,
          parserVersion: this.docx.parserVersion,
          warnings: result.warnings,
          parserError: null,
        };
      }

      case 'csv': {
        const text = this.requireText(input);
        if (text === null) return this.failure('csv', 'CSV extraction requires text content.');
        const result = parseCsv(text);
        return {
          ok: result.ok,
          blocks: result.blocks,
          tables: result.tables,
          metadata: result.metadata,
          title: this.titleFromFileName(input.fileName),
          pageCount: 0,
          pageProvenanceAvailable: false,
          ocrRequired: false,
          parser: 'jarvis-native-structured-parser',
          parserVersion: '1.2.0',
          warnings: result.warnings,
          parserError: result.parserError,
          csvSummary: result.csvSummary,
        };
      }

      case 'json': {
        const text = this.requireText(input);
        if (text === null) return this.failure('json', 'JSON extraction requires text content.');
        const result = parseJson(text);
        return {
          ok: result.ok,
          blocks: result.blocks,
          tables: result.tables,
          metadata: result.metadata,
          title: this.titleFromFileName(input.fileName),
          pageCount: 0,
          pageProvenanceAvailable: false,
          ocrRequired: false,
          parser: 'jarvis-native-structured-parser',
          parserVersion: '1.2.0',
          warnings: result.warnings,
          parserError: result.parserError,
          jsonProfile: result.jsonProfile,
        };
      }

      case 'txt':
      case 'markdown':
      case 'code':
      case 'html':
      case 'xml':
      case 'yaml':
      case 'toml': {
        const text = this.requireText(input);
        if (text === null) {
          return this.failure(format, `${format} extraction requires text content.`);
        }
        const result = parseTextLike(text, format);
        return {
          ok: true,
          blocks: result.blocks,
          tables: result.tables,
          metadata: result.metadata,
          title: result.title ?? this.titleFromFileName(input.fileName),
          pageCount: 0,
          pageProvenanceAvailable: false,
          ocrRequired: false,
          parser: 'jarvis-native-structured-parser',
          parserVersion: '1.2.0',
          warnings: result.warnings,
          parserError: result.parserError,
        };
      }

      default:
        return this.failure(
          format,
          `No parser is available for format "${format}". Content was not read and will not be fabricated.`
        );
    }
  }

  private requireText(input: { textContent?: string }): string | null {
    if (typeof input.textContent === 'string') return input.textContent;
    return null;
  }

  private titleFromFileName(fileName: string): string {
    const base = fileName.replace(/\.[^.]+$/, '');
    return base.replace(/[_-]+/g, ' ').trim() || fileName;
  }

  private failure(format: string, message: string): ExtractionOutcome {
    return {
      ok: false,
      blocks: [],
      tables: [],
      metadata: {},
      title: null,
      pageCount: 0,
      pageProvenanceAvailable: false,
      ocrRequired: false,
      parser: 'unavailable',
      parserVersion: '0.0.0',
      warnings: [],
      parserError: `${format}: ${message}`,
    };
  }
}

export { PdfParser, DocxParser };
export type { OcrAdapter };
export * from './structured-parsers';
