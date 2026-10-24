/**
 * JARVIS-X v1.2.0 — Document Security Gate
 *
 * Validates a document BEFORE any parser touches it: file size, extension,
 * MIME/type evidence, parser compatibility, suspicious mismatches, archive /
 * decompression risk and bounded resource usage.
 *
 * Documents are DATA. Macros, scripts and embedded programs are never executed.
 */

import type {
  DocumentSecurityLimits,
  DocumentSecurityVerdict,
  SupportedDocumentFormat,
} from './types';

export const DEFAULT_SECURITY_LIMITS: DocumentSecurityLimits = {
  maxBytes: 25 * 1024 * 1024, // 25 MB
  maxPages: 2_000,
  maxChunks: 4_000,
  maxExtractedChars: 6_000_000,
  allowedExtensions: [
    '.pdf',
    '.txt',
    '.md',
    '.mdx',
    '.docx',
    '.csv',
    '.tsv',
    '.json',
    '.html',
    '.htm',
    '.xml',
    '.yaml',
    '.yml',
    '.toml',
    // Source-code documents (read as data, never executed)
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rb',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.cs',
    '.php',
    '.sql',
    '.css',
    '.scss',
    '.vue',
    '.svelte',
    '.swift',
    '.c',
    '.h',
    '.cpp',
    '.hpp',
  ],
};

const EXTENSION_TO_FORMAT: Record<string, SupportedDocumentFormat> = {
  '.pdf': 'pdf',
  '.txt': 'txt',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.docx': 'docx',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
};

/** Source-code extensions — parsed as plain text, never executed. */
const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.cs', '.php', '.sql', '.css', '.scss', '.vue', '.svelte',
  '.swift', '.c', '.h', '.cpp', '.hpp',
];

for (const ext of CODE_EXTENSIONS) {
  EXTENSION_TO_FORMAT[ext] = 'code';
}

/** Extension-only formats that also carry a generic `text/*` MIME type. */
const TEXT_LIKE_FORMATS: SupportedDocumentFormat[] = [
  'txt',
  'markdown',
  'csv',
  'json',
  'html',
  'xml',
  'yaml',
  'toml',
  'code',
];

const EXECUTABLE_OR_ARCHIVE_EXTENSIONS = [
  '.exe',
  '.dll',
  '.sh',
  '.bat',
  '.cmd',
  '.ps1',
  '.jar',
  '.msi',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.iso',
];

export function formatFromExtension(fileName: string): SupportedDocumentFormat | null {
  const lower = fileName.toLowerCase();
  const match = /\.[a-z0-9]+$/.exec(lower);
  if (!match) return null;
  return EXTENSION_TO_FORMAT[match[0]] ?? null;
}

export function formatFromMime(mimeType: string): SupportedDocumentFormat | null {
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  switch (mime) {
    case 'application/pdf':
      return 'pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'text/csv':
    case 'text/tab-separated-values':
      return 'csv';
    case 'application/json':
    case 'text/json':
      return 'json';
    case 'text/markdown':
      return 'markdown';
    case 'text/html':
      return 'html';
    case 'application/xml':
    case 'text/xml':
      return 'xml';
    case 'application/yaml':
    case 'application/x-yaml':
    case 'text/yaml':
      return 'yaml';
    case 'application/toml':
    case 'text/toml':
      return 'toml';
    case 'text/plain':
      return 'txt';
    default:
      return null;
  }
}

/**
 * Sniff the true format from leading bytes. Used to detect a declared
 * extension/MIME that disagrees with the actual content.
 */
export function sniffMagicBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 5) {
    const head = String.fromCharCode(...bytes.slice(0, 5));
    if (head === '%PDF-') return 'pdf';
  }
  // DOCX (and all OOXML) is a ZIP container: PK\x03\x04
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'zip_container';
  }
  // Legacy OLE2 compound file (old .doc/.xls) — not supported, must be refused.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    return 'ole2';
  }
  return null;
}

export class DocumentSecurityGate {
  constructor(private readonly limits: DocumentSecurityLimits = DEFAULT_SECURITY_LIMITS) {}

  getLimits(): DocumentSecurityLimits {
    return this.limits;
  }

  /**
   * Validate a document payload. Returns an explicit allow/deny verdict with
   * every check recorded — never a silent pass.
   */
  validate(input: {
    fileName: string;
    mimeType: string;
    declaredSizeBytes?: number;
    /** Raw bytes when available; enables magic-byte verification. */
    bytes?: Uint8Array;
    /** Extracted text length when a caller already parsed (re-ingest path). */
    textCharCount?: number;
  }): DocumentSecurityVerdict {
    const checks: DocumentSecurityVerdict['checks'] = [];
    const lower = input.fileName.toLowerCase();
    const extMatch = /\.[a-z0-9]+$/.exec(lower);
    const ext = extMatch ? extMatch[0] : '';
    // Effective size: raw bytes when present, otherwise the declared UTF-8
    // text length (a text payload has no byte buffer to measure).
    const sizeBytes = input.bytes
      ? input.bytes.byteLength
      : input.declaredSizeBytes ?? input.textCharCount ?? 0;

    // --- 1. Extension presence & allow-list -----------------------------
    const extAllowed = Boolean(ext) && this.limits.allowedExtensions.includes(ext);
    checks.push({
      check: 'extension_allowed',
      passed: extAllowed,
      detail: extAllowed
        ? `Extension "${ext}" is allow-listed.`
        : `Extension "${ext || '(none)'}" is not allow-listed for document ingestion.`,
    });

    // --- 2. Executable / archive extension refusal -----------------------
    const executableExt = EXECUTABLE_OR_ARCHIVE_EXTENSIONS.includes(ext);
    checks.push({
      check: 'not_executable_or_archive',
      passed: !executableExt,
      detail: executableExt
        ? `Extension "${ext}" is executable/archive content and is refused outright.`
        : 'No executable or archive extension detected.',
    });

    // --- 3. Size bound ---------------------------------------------------
    const sizeOk = sizeBytes > 0 && sizeBytes <= this.limits.maxBytes;
    checks.push({
      check: 'size_within_limit',
      passed: sizeOk,
      detail: sizeOk
        ? `Size ${sizeBytes} bytes is within the ${this.limits.maxBytes} byte limit.`
        : sizeBytes === 0
          ? 'Document is empty (zero bytes).'
          : `Size ${sizeBytes} bytes exceeds the ${this.limits.maxBytes} byte limit.`,
    });

    // --- 4. Declared format resolution ----------------------------------
    const declaredFormat = formatFromExtension(input.fileName);
    const mimeFormat = formatFromMime(input.mimeType);
    checks.push({
      check: 'format_recognized',
      passed: Boolean(declaredFormat || mimeFormat),
      detail: declaredFormat
        ? `Resolved format "${declaredFormat}" from extension.`
        : mimeFormat
          ? `Resolved format "${mimeFormat}" from MIME type.`
          : 'Format could not be resolved from extension or MIME type.',
    });

    // --- 5. MIME / extension agreement ----------------------------------
    let mimeMismatch = false;
    if (declaredFormat && mimeFormat && declaredFormat !== mimeFormat) {
      // A generic text/* MIME alongside a specific text-like extension is normal.
      const benign =
        TEXT_LIKE_FORMATS.includes(declaredFormat) &&
        (input.mimeType.toLowerCase().startsWith('text/') ||
          input.mimeType.toLowerCase() === 'application/octet-stream');
      mimeMismatch = !benign;
    }
    checks.push({
      check: 'mime_extension_agree',
      passed: !mimeMismatch,
      detail: mimeMismatch
        ? `Declared extension "${declaredFormat}" disagrees with MIME "${input.mimeType}" (resolved "${mimeFormat}").`
        : 'Declared extension and MIME type are consistent.',
    });

    // --- 6. Magic-byte verification -------------------------------------
    let sniffed: string | null = null;
    let magicOk = true;
    if (input.bytes) {
      sniffed = sniffMagicBytes(input.bytes);

      if (sniffed === 'pdf' && declaredFormat !== 'pdf') {
        magicOk = false;
      }
      if (sniffed === 'zip_container' && declaredFormat && declaredFormat !== 'docx') {
        // A ZIP container declared as something other than DOCX is archive risk.
        magicOk = false;
      }
      if (sniffed === 'ole2') {
        // Legacy OLE2 (.doc/.xls) is not supported and carries archive risk.
        magicOk = false;
      }
      if (declaredFormat === 'pdf' && sniffed !== 'pdf') {
        magicOk = false;
      }
      if (declaredFormat === 'docx' && sniffed !== 'zip_container') {
        magicOk = false;
      }
    }
    checks.push({
      check: 'magic_bytes_match_declaration',
      passed: magicOk,
      detail: input.bytes
        ? `Magic-byte sniff: ${sniffed ?? 'plain/unknown'} vs declared "${declaredFormat ?? 'unknown'}".`
        : 'No raw bytes supplied; magic-byte verification skipped.',
    });

    // --- 7. Archive / decompression risk --------------------------------
    const archiveRisk =
      sniffed === 'zip_container' && declaredFormat !== 'docx' ? true : sniffed === 'ole2';
    checks.push({
      check: 'no_archive_decompression_risk',
      passed: !archiveRisk,
      detail: archiveRisk
        ? 'Content is an archive or legacy OLE2 container; decompression/embedded-object risk refused.'
        : 'No archive decompression risk detected.',
    });

    // --- 8. Extracted size bound (if already parsed) --------------------
    if (typeof input.textCharCount === 'number') {
      const charsOk = input.textCharCount <= this.limits.maxExtractedChars;
      checks.push({
        check: 'extracted_chars_within_limit',
        passed: charsOk,
        detail: charsOk
          ? `Extracted ${input.textCharCount} chars within the ${this.limits.maxExtractedChars} limit.`
          : `Extracted ${input.textCharCount} chars exceeds the ${this.limits.maxExtractedChars} limit.`,
      });
    }

    const failed = checks.filter((c) => !c.passed);
    const allowed = failed.length === 0;

    return {
      allowed,
      rejectionReason: allowed
        ? null
        : failed.map((c) => c.detail).join(' '),
      checks,
      detectedFormat: declaredFormat ?? mimeFormat,
      declaredFormat,
      mimeMismatch,
      archiveRisk,
      sizeBytes,
      maxAllowedBytes: this.limits.maxBytes,
    };
  }
}
