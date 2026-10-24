/**
 * JARVIS-X v1.3.0 — Web content extraction.
 *
 * Converts a fetched byte stream into structured, bounded evidence:
 *
 *   { title, canonicalUrl, author, publishedAt, updatedAt,
 *     mainText, headings, metadata, accessWallDetected, requiresJavaScript }
 *
 * Design rules:
 *   * No JavaScript is ever executed. A script-rendered page yields little or
 *     no text, and `requiresJavaScript` says so instead of pretending.
 *   * Publication and update dates are only returned when the page actually
 *     asserts one. No date is inferred, guessed or defaulted to "now".
 *   * Boilerplate (nav, cookie banners, share bars, comment scaffolding) is
 *     stripped before text is extracted.
 *   * Output size is capped so a pathological page cannot exhaust memory.
 */

export interface ExtractedPage {
  title: string;
  canonicalUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  mainText: string;
  headings: string[];
  metadata: Record<string, string>;
  /** True when the page itself signals that content is behind access control. */
  accessWallDetected: boolean;
  /** True when the page has almost no text but ships script-rendered markup. */
  requiresJavaScript: boolean;
  academic: AcademicHints | null;
  textLength: number;
}

export interface AcademicHints {
  doi: string | null;
  authors: string[];
  venue: string | null;
  citationCount: number | null;
  isPreprint: boolean;
  metadataOnly: boolean;
}

export interface ExtractionOptions {
  contentType?: string | null;
  baseUrl?: string;
  /** Hard cap on the extracted text length. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 60_000;

const STRIP_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'form',
  'nav',
  'header',
  'footer',
  'aside',
];

/** class/id fragments that identify navigational or consent furniture. */
const BOILERPLATE_TOKENS = [
  'cookie',
  'consent',
  'gdpr',
  'newsletter',
  'subscribe',
  'signup',
  'share',
  'social',
  'advert',
  'sponsor',
  'promo',
  'breadcrumb',
  'pagination',
  'sidebar',
  'related-',
  'recommended',
  'comment',
  'footer',
  'navbar',
  'menu',
  'modal',
  'popup',
  'banner',
];

const BLOCK_TAGS = [
  'p', 'div', 'section', 'article', 'main', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'tr', 'td', 'th', 'table', 'blockquote',
  'pre', 'figure', 'figcaption', 'hr', 'aside', 'header', 'footer', 'nav',
];

/* ==========================================================================
 * Public API
 * ======================================================================== */

export function extractWebContent(raw: string, options: ExtractionOptions = {}): ExtractedPage {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const contentType = (options.contentType ?? 'text/html').toLowerCase();

  if (contentType.includes('json')) {
    return extractJson(raw, maxChars);
  }
  if (contentType.includes('xml') && !contentType.includes('html')) {
    return extractPlain(raw, maxChars, 'xml');
  }
  if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
    return extractPlain(raw, maxChars, contentType);
  }

  return extractHtml(raw, options.baseUrl, maxChars);
}

/* ==========================================================================
 * HTML
 * ======================================================================== */

function extractHtml(raw: string, baseUrl: string | undefined, maxChars: number): ExtractedPage {
  const metadata = collectMetadata(raw);
  const jsonLd = collectJsonLd(raw);

  const title =
    firstNonEmpty([
      metadata['og:title'],
      metadata['twitter:title'],
      metadata['citation_title'],
      jsonLd.headline,
      extractTagText(raw, 'title'),
      extractFirstTagText(raw, 'h1'),
    ]) ?? 'Untitled page';

  const canonicalHref = extractLinkHref(raw, 'canonical') ?? metadata['og:url'] ?? null;

  const author = firstNonEmpty([
    metadata['author'],
    metadata['article:author'],
    metadata['citation_author'],
    jsonLd.author,
  ]);

  const publishedAt = firstNonEmpty([
    metadata['article:published_time'],
    metadata['citation_publication_date'],
    metadata['datepublished'],
    metadata['pubdate'],
    metadata['publish-date'],
    metadata['dc.date'],
    jsonLd.datePublished,
  ]);

  const updatedAt = firstNonEmpty([
    metadata['article:modified_time'],
    metadata['datemodified'],
    metadata['last-modified'],
    metadata['dateupdated'],
    jsonLd.dateModified,
  ]);

  const headings = extractHeadings(raw);

  // ---- Text extraction ----
  const stripped = stripNoise(raw);
  const candidates = [
    extractFirstTagHtml(stripped, 'article'),
    extractFirstTagHtml(stripped, 'main'),
    extractFirstTagHtml(stripped, 'body'),
  ].filter((value): value is string => Boolean(value));

  let mainText = '';
  for (const candidate of candidates) {
    const text = htmlToText(candidate);
    if (text.length > mainText.length) mainText = text;
  }
  if (!mainText) mainText = htmlToText(stripped);

  mainText = normaliseWhitespace(mainText).slice(0, maxChars);

  const requiresJavaScript =
    mainText.length < 240 &&
    /<script\b[^>]*src=|<div[^>]+id=["'](?:root|app|__next)["']|noscript/i.test(raw);

  const accessWallDetected =
    /"isaccessibleforfree"\s*:\s*false/i.test(raw) ||
    /subscribe (?:now )?to (?:continue|read)/i.test(mainText.slice(0, 4_000));

  const academic = extractAcademicHints(metadata, jsonLd, raw, mainText);

  return {
    title: clampText(decodeEntities(title).trim(), 300),
    canonicalUrl: canonicalHref ? resolveUrl(canonicalHref, baseUrl) : null,
    author: author ? clampText(decodeEntities(author).trim(), 200) : null,
    publishedAt: parseAssertedDate(publishedAt),
    updatedAt: parseAssertedDate(updatedAt),
    mainText,
    headings: headings.map((heading) => clampText(heading, 240)).slice(0, 40),
    metadata,
    accessWallDetected,
    requiresJavaScript,
    academic,
    textLength: mainText.length,
  };
}

/** Strip scripts, styles, boilerplate containers and comments. */
function stripNoise(html: string): string {
  let output = html;

  for (const tag of STRIP_TAGS) {
    output = output.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  // Comments (including conditional comments) carry no evidence.
  output = output.replace(/<!--[\s\S]*?-->/g, ' ');

  // Elements whose class/id marks them as furniture.
  const tokenPattern = BOILERPLATE_TOKENS.join('|');
  output = output.replace(
    new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\b(?:class|id)\\s*=\\s*["'][^"']*(?:${tokenPattern})[^"']*["'][^>]*>[\\s\\S]*?</\\1>`, 'gi'),
    ' '
  );

  return output;
}

function htmlToText(html: string): string {
  let text = html;

  // Preserve block boundaries as newlines so paragraphs survive.
  const blockPattern = BLOCK_TAGS.join('|');
  text = text.replace(new RegExp(`</?(?:${blockPattern})\\b[^>]*>`, 'gi'), '\n');
  text = text.replace(/<\/?[a-z][^>]*>/gi, ' ');

  text = decodeEntities(text);
  // Drop runs of horizontal whitespace but keep paragraph breaks.
  text = text.replace(/[ \t\f\v\u00a0]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const regex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null && headings.length < 60) {
    const text = normaliseWhitespace(decodeEntities(match[2].replace(/<[^>]+>/g, ' ')));
    if (text.length >= 2) headings.push(text);
  }
  return headings;
}

/* ==========================================================================
 * Metadata / JSON-LD
 * ======================================================================== */

function collectMetadata(html: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const head = html.slice(0, 200_000);
  const metaRegex = /<meta\b([^>]+)>/gi;
  let match: RegExpExecArray | null;

  while ((match = metaRegex.exec(head)) !== null) {
    const attrs = match[1];
    const key =
      readAttribute(attrs, 'property') ??
      readAttribute(attrs, 'name') ??
      readAttribute(attrs, 'itemprop') ??
      null;
    const content = readAttribute(attrs, 'content');
    if (key && content) {
      const normalized = key.toLowerCase();
      if (!metadata[normalized]) metadata[normalized] = content;
    }
  }

  return metadata;
}

interface JsonLdFields {
  headline: string | null;
  author: string | null;
  datePublished: string | null;
  dateModified: string | null;
  doi: string | null;
  venue: string | null;
  citationCount: string | null;
}

function collectJsonLd(html: string): JsonLdFields {
  const fields: JsonLdFields = {
    headline: null,
    author: null,
    datePublished: null,
    dateModified: null,
    doi: null,
    venue: null,
    citationCount: null,
  };

  const regex = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1].trim());
      applyJsonLd(parsed, fields);
    } catch {
      /* malformed JSON-LD is ignored, never guessed at */
    }
  }

  return fields;
}

function applyJsonLd(value: unknown, fields: JsonLdFields): void {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const record = node as Record<string, unknown>;

    const stringOf = (key: string): string | null => {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      return null;
    };

    if (!fields.headline) fields.headline = stringOf('headline') ?? stringOf('name');
    if (!fields.datePublished) fields.datePublished = stringOf('datePublished');
    if (!fields.dateModified) fields.dateModified = stringOf('dateModified');
    if (!fields.doi) {
      const identifier = record['identifier'];
      if (typeof identifier === 'string' && /10\.\d{4,9}\//.test(identifier)) fields.doi = identifier;
      if (identifier && typeof identifier === 'object') {
        const value2 = (identifier as Record<string, unknown>)['value'];
        if (typeof value2 === 'string' && /10\.\d{4,9}\//.test(value2)) fields.doi = value2;
      }
    }

    if (!fields.author) {
      const author = record['author'];
      if (typeof author === 'string') fields.author = author;
      else if (Array.isArray(author)) {
        const names = author
          .map((entry) => {
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object') return (entry as Record<string, unknown>)['name'];
            return null;
          })
          .filter((name): name is string => typeof name === 'string');
        if (names.length > 0) fields.author = names.join(', ');
      } else if (author && typeof author === 'object') {
        const name = (author as Record<string, unknown>)['name'];
        if (typeof name === 'string') fields.author = name;
      }
    }

    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child && typeof child === 'object') visit(child);
    }
  };

  visit(value);
}

function extractLinkHref(html: string, rel: string): string | null {
  const regex = /<link\b([^>]+)>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const relValue = readAttribute(match[1], 'rel');
    if (relValue && relValue.toLowerCase().split(/\s+/).includes(rel)) {
      const href = readAttribute(match[1], 'href');
      if (href) return href;
    }
  }
  return null;
}

function readAttribute(attrs: string, name: string): string | null {
  const regex = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = regex.exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function extractTagText(html: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = regex.exec(html);
  if (!match) return null;
  return normaliseWhitespace(decodeEntities(match[1].replace(/<[^>]+>/g, ' ')));
}

function extractFirstTagText(html: string, tag: string): string | null {
  return extractTagText(html, tag);
}

function extractFirstTagHtml(html: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = regex.exec(html);
  return match ? match[1] : null;
}

/* ==========================================================================
 * Plain text / JSON
 * ======================================================================== */

function extractPlain(raw: string, maxChars: number, flavour: string): ExtractedPage {
  const text = normaliseWhitespace(raw).slice(0, maxChars);
  return {
    title: flavour === 'xml' ? 'XML document' : 'Plain text document',
    canonicalUrl: null,
    author: null,
    publishedAt: null,
    updatedAt: null,
    mainText: text,
    headings: [],
    metadata: {},
    accessWallDetected: false,
    requiresJavaScript: false,
    academic: null,
    textLength: text.length,
  };
}

function extractJson(raw: string, maxChars: number): ExtractedPage {
  let pretty = raw.slice(0, maxChars);
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2).slice(0, maxChars);
  } catch {
    /* keep the raw slice when the document is not valid JSON */
  }

  return {
    title: 'JSON document',
    canonicalUrl: null,
    author: null,
    publishedAt: null,
    updatedAt: null,
    mainText: pretty,
    headings: [],
    metadata: {},
    accessWallDetected: false,
    requiresJavaScript: false,
    academic: null,
    textLength: pretty.length,
  };
}

/* ==========================================================================
 * Academic hints
 * ======================================================================== */

function extractAcademicHints(
  metadata: Record<string, string>,
  jsonLd: JsonLdFields,
  raw: string,
  mainText: string
): AcademicHints | null {
  const doiFromMeta = metadata['citation_doi'] ?? null;
  const doiFromBody = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i.exec(raw.slice(0, 200_000))?.[0] ?? null;
  const doi = doiFromMeta ?? jsonLd.doi ?? doiFromBody;

  const authorsFromMeta = metadata['citation_author']
    ? metadata['citation_author'].split(/[;,]/).map((value) => value.trim()).filter(Boolean)
    : [];

  const venue = metadata['citation_journal_title'] ?? metadata['citation_conference_title'] ?? jsonLd.venue ?? null;

  const citationCountRaw = metadata['citation_count'] ?? jsonLd.citationCount ?? null;
  const citationCount = citationCountRaw && /^\d+$/.test(citationCountRaw) ? Number(citationCountRaw) : null;

  const isArxiv = /arxiv\.org/i.test(raw.slice(0, 4_000));
  const isPreprint = isArxiv || /preprint/i.test(metadata['citation_type'] ?? '');

  const hasAbstractSection = /(?:^|\n)\s*abstract\b/i.test(mainText) || /<section[^>]+abstract/i.test(raw);
  // Metadata-only is the honest default: a link/abstract page is NOT the paper.
  const metadataOnly = mainText.length < 1_500 && !hasAbstractSection;

  if (!doi && authorsFromMeta.length === 0 && !venue && !isPreprint) return null;

  return {
    doi,
    authors: authorsFromMeta.slice(0, 20),
    venue,
    citationCount,
    isPreprint,
    metadataOnly,
  };
}

/* ==========================================================================
 * Dates — never invented
 * ======================================================================== */

const DATE_PATTERNS: RegExp[] = [
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/,
  /^(\d{4})-(\d{2})-(\d{2})$/,
  /^(\d{4})\/(\d{2})\/(\d{2})$/,
];

/**
 * Parse a date that the document explicitly asserts.
 *
 * Returns an ISO string, or null. There is deliberately no fallback: an
 * unparseable or absent date becomes UNKNOWN, never "today".
 */
export function parseAssertedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;

  for (const pattern of DATE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match) continue;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (year < 1990 || year > 2100) continue;

    const hours = match[4] ? Number(match[4]) : 0;
    const minutes = match[5] ? Number(match[5]) : 0;
    const seconds = match[6] ? Number(match[6]) : 0;
    if (hours > 23 || minutes > 59 || seconds > 59) continue;

    const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
    // Reject rollovers such as 2026-02-31.
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    return date.toISOString();
  }

  // A natural-language date is only accepted when it carries a full day.
  const natural = /^(?:published|updated|posted|modified)?\s*(?:on\s+)?([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})$/i.exec(trimmed);
  if (natural) {
    const parsed = new Date(`${natural[1]} ${natural[2]}, ${natural[3]} 00:00:00 UTC`);
    if (!Number.isNaN(parsed.getTime())) {
      const year = parsed.getUTCFullYear();
      if (year >= 1990 && year <= 2100) return parsed.toISOString();
    }
  }

  return null;
}

/* ==========================================================================
 * Text helpers
 * ======================================================================== */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  laquo: '«',
  raquo: '»',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const resolved = ENTITIES[entity.toLowerCase()];
    return resolved ?? match;
  });
}

function normaliseWhitespace(text: string): string {
  return text
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clampText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function resolveUrl(href: string, baseUrl: string | undefined): string | null {
  try {
    return baseUrl ? new URL(href, baseUrl).toString() : new URL(href).toString();
  } catch {
    return null;
  }
}
