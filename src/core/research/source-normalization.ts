/**
 * JARVIS-X v1.3.0 — Source normalization and canonical de-duplication.
 *
 * Two jobs:
 *   1. Turn a fetched page into one normalized WebSource with stable identity.
 *   2. Collapse mirrors, syndicated copies and AMP variants so the same article
 *      is never counted twice as independent corroboration.
 *
 * De-duplication is deliberately conservative: two pages are only merged when
 * their canonical URLs match, their content hashes match, or their text
 * shingles overlap heavily. Topical similarity alone never merges sources.
 */

import { createHash } from 'node:crypto';
import { domainOf } from './url-safety';
import type { WebSource, WebSourceType, FetchedPage } from './types';
import type { ExtractedPage } from './web-extraction';
import { shortHash } from './text-utils';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'dclid', 'fbclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid',
  'ref', 'referrer', 'source', 'src', 'campaign', 'affiliate', 'aff_id',
  'spm', 'scid', 'trk', 'trk_contact', 'vero_id', 'wickedid', 'oly_enc_id',
]);

/** Parameters that legitimately change what is shown and must be preserved. */
const MEANINGFUL_PARAMS = new Set([
  'id', 'p', 'page', 'q', 'v', 't', 'issue', 'volume', 'article', 'section', 'lang',
]);

/**
 * Normalize a URL to its canonical research identity.
 *
 * Removes fragments, tracking parameters, AMP/print variants and trailing
 * slashes; lowercases scheme and host; drops default ports. Query parameters
 * that can change the document (id, page, q…) are preserved.
 */
export function canonicalizeUrl(rawUrl: string, canonicalHint?: string | null): string {
  const candidate = canonicalHint && looksAbsolute(canonicalHint) ? canonicalHint : rawUrl;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return rawUrl.trim().toLowerCase();
  }

  parsed.hash = '';
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');

  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80')
  ) {
    parsed.port = '';
  }

  // AMP / print / index variants of the same document.
  parsed.pathname = parsed.pathname
    .replace(/\/amp\/?$/i, '')
    .replace(/\/print\/?$/i, '')
    .replace(/\/index\.(?:html?|php|aspx?)$/i, '')
    .replace(/\.amp\.html?$/i, '');

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  const kept: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower)) continue;
    if (lower.startsWith('utm_')) continue;
    if (!MEANINGFUL_PARAMS.has(lower) && /^[a-z_]{1,3}$/.test(lower)) continue; // short opaque trackers
    kept.push([key, value]);
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]));

  parsed.search = '';
  for (const [key, value] of kept) parsed.searchParams.append(key, value);

  return parsed.toString();
}

function looksAbsolute(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/* ==========================================================================
 * Content hashing / dedup signatures
 * ======================================================================== */

/** Stable hash of the meaningful text — syndicated copies hash identically. */
export function contentHashOf(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

const SHINGLE_SIZE = 6;

/** Word n-gram signature used for near-duplicate detection. */
export function shingles(text: string, size = SHINGLE_SIZE): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 3_000);

  const output = new Set<string>();
  if (words.length < size) {
    if (words.length > 0) output.add(words.join(' '));
    return output;
  }
  for (let i = 0; i + size <= words.length; i += 1) {
    output.add(words.slice(i, i + size).join(' '));
  }
  return output;
}

export function shingleSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  let intersection = 0;
  for (const shingle of smaller) if (larger.has(shingle)) intersection += 1;
  return intersection / smaller.size;
}

/* ==========================================================================
 * Source construction
 * ======================================================================== */

export interface NormalizeSourceInput {
  /** Optional original request URL; `page.requestedUrl` is used when omitted. */
  requestedUrl?: string;
  page: FetchedPage;
  extracted: ExtractedPage;
  /** Text AFTER the web safety layer neutralised directives. */
  safeText: string;
  injectionFlagged: boolean;
  retrievedAt: string;
  searchSnippet?: string | null;
  academic?: WebSource['academic'];
}

export function normalizeSource(input: NormalizeSourceInput): WebSource {
  const { page, extracted, safeText } = input;
  const url = page.finalUrl ?? input.requestedUrl ?? page.requestedUrl;
  const canonicalUrl = canonicalizeUrl(url, extracted.canonicalUrl);
  const domain = domainOf(canonicalUrl);

  const inferred = inferSourceType(canonicalUrl, extracted, input.searchSnippet ?? null);
  const sourceType = inferred.type;

  const trustSignals: string[] = [...inferred.signals];
  if (input.injectionFlagged) trustSignals.push('prompt_injection_neutralised');
  if (extracted.publishedAt || extracted.updatedAt) trustSignals.push('date_asserted');
  else trustSignals.push('no_date_asserted');
  if (extracted.author) trustSignals.push('named_author');
  if (extracted.accessWallDetected) trustSignals.push('access_wall_copy');
  if (page.redirectChain.length > 0) trustSignals.push('redirected');
  if (extracted.academic?.metadataOnly) trustSignals.push('academic_metadata_only');
  if (extracted.requiresJavaScript) trustSignals.push('client_rendered');

  const freshnessSignals: string[] = [];
  if (extracted.updatedAt) freshnessSignals.push(`updated:${extracted.updatedAt}`);
  if (extracted.publishedAt) freshnessSignals.push(`published:${extracted.publishedAt}`);
  if (!extracted.publishedAt && !extracted.updatedAt) freshnessSignals.push('date_unknown');

  const contentHash = contentHashOf(safeText);

  return {
    // The id is derived from the URL that was actually retrieved, not from the
    // canonical URL: a mirror declares the original as canonical, and the two
    // records must stay distinguishable so the copy can be MARKED as a copy.
    sourceId: `src-${shortHash(`${url}:${contentHash}`)}`,
    url,
    canonicalUrl,
    domain,
    title: extracted.title,
    author: extracted.author,
    publishedAt: extracted.publishedAt,
    updatedAt: extracted.updatedAt,
    retrievedAt: input.retrievedAt,
    contentHash,
    sourceType,
    trustSignals,
    freshnessSignals,
    extractedText: safeText,
    provenance: 'WEB_SOURCE',
    fetchStatus: 'OK',
    academic: input.academic ?? extracted.academic ?? null,
    duplicateOf: null,
    independenceGroup: domain,
    quality: null,
  };
}

/** Failed fetches still produce a source record — with no text at all. */
export function normalizeUnreadableSource(
  requestedUrl: string,
  finalUrl: string | null,
  status: WebSource['fetchStatus'],
  retrievedAt: string,
  detail: string
): WebSource {
  const url = finalUrl ?? requestedUrl;
  const canonicalUrl = canonicalizeUrl(url);

  return {
    sourceId: `src-${shortHash(`${canonicalUrl}:${status}`)}`,
    url,
    canonicalUrl,
    domain: domainOf(canonicalUrl),
    title: `Inaccessible source (${status.toLowerCase().replace(/_/g, ' ')})`,
    author: null,
    publishedAt: null,
    updatedAt: null,
    retrievedAt,
    contentHash: '',
    sourceType: 'UNKNOWN',
    trustSignals: [`fetch_status:${status}`, detail.slice(0, 120)],
    freshnessSignals: ['date_unknown'],
    extractedText: '',
    provenance: 'WEB_SOURCE',
    fetchStatus: status,
    academic: null,
    duplicateOf: null,
    independenceGroup: domainOf(canonicalUrl),
    quality: null,
  };
}

/* ==========================================================================
 * Source type inference
 * ======================================================================== */

const STANDARDS_HOSTS = ['w3.org', 'ietf.org', 'rfc-editor.org', 'whatwg.org', 'unicode.org', 'iec.ch', 'iso.org', 'ieee.org', 'oasis-open.org'];
const ACADEMIC_HOSTS = ['arxiv.org', 'doi.org', 'pubmed.ncbi.nlm.nih.gov', 'nature.com', 'sciencedirect.com', 'springer.com', 'acm.org', 'ieee.org', 'biorxiv.org', 'researchgate.net', 'semanticscholar.org', 'openalex.org'];
const GOVERNMENT_SUFFIXES = ['.gov', '.gov.uk', '.gov.in', '.gc.ca', '.europa.eu', '.go.jp', '.gob.es'];
const ESTABLISHED_NEWS = ['reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'wsj.com', 'ft.com', 'theguardian.com', 'economist.com', 'bloomberg.com', 'npr.org', 'aljazeera.com', 'thehindu.com', 'indianexpress.com'];
const COMMUNITY_HOSTS = ['reddit.com', 'stackoverflow.com', 'stackexchange.com', 'quora.com', 'news.ycombinator.com', 'discourse.org', 'medium.com', 'substack.com'];
const VENDOR_DOC_HOSTS = ['docs.', 'developer.', 'developers.', 'api.', 'learn.', 'support.', 'help.'];

/**
 * Infer a source TYPE (not a trust verdict). Authority is always combined with
 * relevance and freshness later — a docs page is not automatically correct.
 */
export interface SourceTypeInference {
  type: WebSourceType;
  /** Named signals that produced the inference — never a hidden trust score. */
  signals: string[];
}

export function inferSourceType(
  url: string,
  extracted?: ExtractedPage | null,
  snippet?: string | null
): SourceTypeInference {
  const domain = domainOf(url);
  const path = safePath(url);
  const signals: string[] = [];

  const finish = (type: WebSourceType, signal: string): SourceTypeInference => {
    signals.push(signal);
    return { type, signals };
  };

  if (STANDARDS_HOSTS.some((host) => domain === host || domain.endsWith(`.${host}`))) {
    return finish('STANDARDS_BODY', `standards_host:${domain}`);
  }
  if (ACADEMIC_HOSTS.some((host) => domain === host || domain.endsWith(`.${host}`))) {
    return finish('ACADEMIC', `academic_host:${domain}`);
  }
  if (/^10\.\d{4,9}\//.test(extracted?.academic?.doi ?? '')) {
    return finish('ACADEMIC', 'doi_metadata');
  }
  if (GOVERNMENT_SUFFIXES.some((suffix) => domain.endsWith(suffix))) {
    return finish('GOVERNMENT_INSTITUTIONAL', `government_suffix:${domain}`);
  }
  if (COMMUNITY_HOSTS.some((host) => domain === host || domain.endsWith(`.${host}`))) {
    return finish('COMMUNITY_FORUM', `community_host:${domain}`);
  }
  if (ESTABLISHED_NEWS.some((host) => domain === host || domain.endsWith(`.${host}`))) {
    return finish('ESTABLISHED_REPORTING', `news_host:${domain}`);
  }

  // Official documentation / changelog / pricing pages on the vendor's own site.
  if (VENDOR_DOC_HOSTS.some((prefix) => domain.startsWith(prefix))) {
    return finish('PRIMARY_OFFICIAL', `vendor_docs_host:${domain}`);
  }
  if (/\/(?:docs?|documentation|reference|manual|guide|changelog|release-notes|spec)\b/i.test(path)) {
    return finish('PRIMARY_OFFICIAL', `documentation_path:${path.slice(0, 40)}`);
  }
  if (/\/(?:pricing|plans|product|features)\b/i.test(path)) {
    return finish('MANUFACTURER_CLAIM', `marketing_path:${path.slice(0, 40)}`);
  }

  const text = `${extracted?.mainText ?? ''} ${snippet ?? ''}`.slice(0, 4_000).toLowerCase();
  if (/\b(?:abstract|we present|we propose|this paper|et al\.|peer[- ]reviewed)\b/.test(text)) {
    return finish('ACADEMIC', 'academic_language');
  }
  if (/\b(?:press release|announces|announced today|our mission)\b/.test(text)) {
    return finish('MANUFACTURER_CLAIM', 'vendor_language');
  }
  if (/\b(?:forum|thread|posted by|replies)\b/.test(text)) {
    return finish('COMMUNITY_FORUM', 'forum_language');
  }
  if (domain.includes('wikipedia') || /\b(?:encyclopedia)\b/.test(text)) {
    return finish('SECONDARY_REPORTING', 'encyclopedia');
  }

  return finish('UNKNOWN', 'no_type_signal');
}

/**
 * Backwards-compatible alias. The American spelling is canonical; the British
 * one is kept because the v1.3 suites and downstream callers use it.
 */
export { canonicalizeUrl as canonicaliseUrl };

/**
 * Object-style normalizer used by callers that prefer validation + construction
 * in one step. It REFUSES to build a source from a page with no usable text —
 * an empty page must never become a citable source.
 */
export interface SourceNormalizationResult {
  source: WebSource | null;
  reason: string | null;
}

export class SourceNormalizer {
  private readonly minTextChars: number;

  constructor(options: { minTextChars?: number } = {}) {
    this.minTextChars = options.minTextChars ?? 40;
  }

  normalize(input: NormalizeSourceInput): SourceNormalizationResult {
    if (!input.page || input.page.status !== 'OK') {
      return { source: null, reason: `FETCH_${input.page?.status ?? 'UNKNOWN'}` };
    }
    const text = (input.safeText ?? '').trim();
    if (text.length < this.minTextChars) {
      return { source: null, reason: 'TEXT_TOO_SHORT' };
    }
    return { source: normalizeSource(input), reason: null };
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/* ==========================================================================
 * De-duplication
 * ======================================================================== */

const NEAR_DUPLICATE_THRESHOLD = 0.82;

/**
 * Collapse exact and near duplicates.
 *
 * The representative is the copy with the richest provenance (has a date, a
 * named author, higher source type) so the surviving record is the best one —
 * not merely the first one fetched.
 */
export function deduplicateSources(sources: WebSource[]): WebSource[] {
  const byCanonical = new Map<string, WebSource>();
  const ordered: WebSource[] = [];

  // ---- Pass 1: identical canonical URL ----
  // Duplicates are KEPT and marked. Dropping them silently would hide the fact
  // that two URLs point at one document, which is exactly what corroboration
  // must not double-count.
  for (const source of sources) {
    const key = source.canonicalUrl;
    const existing = byCanonical.get(key);
    if (!existing) {
      byCanonical.set(key, source);
      ordered.push(source);
      continue;
    }

    const winner = provenanceScore(source) > provenanceScore(existing) ? source : existing;
    const loser = winner === source ? existing : source;
    markDuplicate(loser, winner);
    if (winner === source) byCanonical.set(key, source);
    // The copy is retained (marked) rather than dropped: the report can then say
    // "3 URLs, 2 documents" instead of silently shrinking the corpus.
    ordered.push(source);
  }

  // ---- Pass 2: identical content hash ----
  const byHash = new Map<string, WebSource>();
  const afterHash: WebSource[] = [];

  for (const source of ordered) {
    afterHash.push(source);
    if (!source.contentHash) continue;

    const existing = byHash.get(source.contentHash);
    if (!existing) {
      byHash.set(source.contentHash, source);
      continue;
    }

    const winner = provenanceScore(source) > provenanceScore(existing) ? source : existing;
    const loser = winner === source ? existing : source;
    markDuplicate(loser, winner);
    byHash.set(source.contentHash, winner);
  }

  // ---- Pass 3: near-duplicate text across domains (syndication) ----
  const signatures = new Map<string, Set<string>>();
  for (const source of afterHash) {
    if (source.duplicateOf) continue;
    signatures.set(source.sourceId, shingles(source.extractedText));
  }

  for (let i = 0; i < afterHash.length; i += 1) {
    const a = afterHash[i];
    if (a.duplicateOf) continue;

    for (let j = i + 1; j < afterHash.length; j += 1) {
      const b = afterHash[j];
      if (b.duplicateOf) continue;

      const similarity = shingleSimilarity(
        signatures.get(a.sourceId) as Set<string>,
        signatures.get(b.sourceId) as Set<string>
      );
      if (similarity < NEAR_DUPLICATE_THRESHOLD) continue;

      const winner = provenanceScore(a) >= provenanceScore(b) ? a : b;
      const loser = winner === a ? b : a;
      markDuplicate(loser, winner);
    }
  }

  return afterHash;
}

/**
 * Record that `loser` is a copy of `winner`.
 *
 * Syndicated copies share the winner's independence group so they can never be
 * counted as a second independent voice, and consumers can still SEE that the
 * copy existed.
 */
function markDuplicate(loser: WebSource, winner: WebSource): void {
  if (loser.sourceId === winner.sourceId) return;
  loser.duplicateOf = winner.sourceId;
  loser.independenceGroup = winner.independenceGroup;
}

/** How complete and citable a source record is. Higher wins a dedup tie. */
function provenanceScore(source: WebSource): number {
  let score = 0;
  if (source.publishedAt) score += 3;
  if (source.updatedAt) score += 1;
  if (source.author) score += 1;
  score += typeRank(source.sourceType) * 2;
  score += Math.min(2, source.extractedText.length / 4_000);
  if (source.fetchStatus !== 'OK') score -= 5;
  return score;
}

function typeRank(type: WebSourceType): number {
  switch (type) {
    case 'PRIMARY_OFFICIAL':
      return 5;
    case 'STANDARDS_BODY':
      return 5;
    case 'GOVERNMENT_INSTITUTIONAL':
      return 4;
    case 'ACADEMIC':
      return 4;
    case 'ESTABLISHED_REPORTING':
      return 3;
    case 'SECONDARY_REPORTING':
      return 2;
    case 'MANUFACTURER_CLAIM':
      return 2;
    case 'COMMUNITY_FORUM':
      return 1;
    case 'OWNER_DOCUMENT':
      return 3;
    default:
      return 0;
  }
}

/**
 * Assign independence groups after de-duplication: two sources share a group
 * when one duplicates the other, or when they share a registered domain.
 */
export function assignIndependenceGroups(sources: WebSource[]): void {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));

  for (const source of sources) {
    if (source.duplicateOf) {
      const parent = byId.get(source.duplicateOf);
      source.independenceGroup = parent ? parent.independenceGroup : source.domain;
    } else if (!source.independenceGroup) {
      source.independenceGroup = source.domain;
    }
  }
}

/** Count distinct independence groups among non-duplicate sources. */
export function independentGroupCount(sources: WebSource[]): number {
  const groups = new Set<string>();
  for (const source of sources) {
    if (source.duplicateOf) continue;
    groups.add(source.independenceGroup);
  }
  return groups.size;
}

export { domainOf };
