/**
 * JARVIS-X v1.3.0 — small, dependency-free text primitives shared by the
 * research pipeline. Everything here is deterministic and bounded.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
  'might', 'must', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'without', 'by', 'as',
  'about', 'into', 'over', 'under', 'between', 'through', 'during', 'before', 'after', 'above',
  'below', 'up', 'down', 'out', 'off', 'again', 'further', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'whose', 'it', 'its', 'they', 'them',
  'their', 'he', 'she', 'his', 'her', 'we', 'our', 'you', 'your', 'i', 'me', 'my', 'not', 'no',
  'nor', 'only', 'own', 'same', 'so', 'too', 'very', 'just', 'also', 'any', 'all', 'each',
  'every', 'some', 'such', 'more', 'most', 'other', 'another', 'both', 'either', 'neither',
  'according', 'says', 'said', 'say', 'states', 'stated', 'reported', 'reports', 'claims',
  'claimed', 'please', 'using', 'use', 'used', 'get', 'gets', 'got', 'make', 'makes', 'made',
]);

/** Words that flip the polarity of a statement. */
const NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'nothing', 'nobody', 'neither', 'nor', 'cannot', 'cant',
  "can't", "doesn't", "don't", "isn't", "aren't", "wasn't", "weren't", "won't", "wouldn't",
  "shouldn't", "couldn't", 'without', 'lacks', 'lacking', 'fails', 'failed', 'denies',
  'denied', 'refutes', 'refuted', 'disproves', 'disproved', 'false', 'incorrect', 'untrue',
  'invalid', 'myth', 'debunked', 'contrary', 'deprecated', 'removed', 'unsupported',
]);

/** Words that scope a statement to the past or an older release. */
const HISTORICAL_MARKERS = [
  'historically', 'previously', 'formerly', 'originally', 'used to', 'no longer',
  'deprecated', 'was true', 'in older versions', 'earlier versions', 'prior versions',
  'in version 1', 'in version 2', 'as of 20', 'back in 20', 'legacy',
];

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`*_>#|]/g, ' ')
    .split(/[^a-z0-9\u00c0-\u024f]+/)
    .filter((token) => token.length > 0);
}

/** Content-bearing terms, de-duplicated and ordered by first appearance. */
export function keyTerms(text: string, max = 40): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const token of tokenize(text)) {
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    output.push(token);
    if (output.length >= max) break;
  }

  return output;
}

export function termSet(text: string): Set<string> {
  return new Set(keyTerms(text, 200));
}

/** Jaccard similarity between two term sets. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Overlap relative to the SMALLER set — good for "is this passage about it?". */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.min(a.size, b.size);
}

export function hasNegation(text: string): boolean {
  for (const token of tokenize(text)) {
    if (NEGATIONS.has(token)) return true;
  }
  return false;
}

export function hasHistoricalScope(text: string): boolean {
  const lower = text.toLowerCase();
  return HISTORICAL_MARKERS.some((marker) => lower.includes(marker));
}

/** Split text into paragraphs, joining wrapped lines inside a paragraph. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
}

/** Split into sentences without a full NLP stack. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[])/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Chunk a long paragraph into bounded passages, preferring sentence
 * boundaries. Never mid-word.
 */
export function chunkText(text: string, maxChars = 600, overlapSentences = 0): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized.length > 0 ? [normalized] : [];

  const parts = sentences(normalized);
  if (parts.length <= 1) {
    // One giant sentence — hard-wrap on whitespace.
    const chunks: string[] = [];
    let buffer = '';
    for (const word of normalized.split(' ')) {
      if ((buffer + ' ' + word).trim().length > maxChars && buffer.length > 0) {
        chunks.push(buffer.trim());
        buffer = word;
      } else {
        buffer = `${buffer} ${word}`.trim();
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
    return chunks;
  }

  const chunks: string[] = [];
  let buffer = '';

  for (const sentence of parts) {
    if ((buffer + ' ' + sentence).trim().length > maxChars && buffer.length > 0) {
      chunks.push(buffer.trim());
      buffer = overlapSentences > 0 ? lastSentences(buffer, overlapSentences) : '';
    }
    buffer = `${buffer} ${sentence}`.trim();
  }
  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks;
}

function lastSentences(text: string, count: number): string {
  const parts = sentences(text);
  return parts.slice(Math.max(0, parts.length - count)).join(' ');
}

/** Trim a passage to a maximum length on a word boundary. */
export function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** Deterministic short hash for ids (FNV-1a, hex). */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Convert a question into a declarative claim candidate. */
export function claimFromQuestion(question: string): string {
  const cleaned = question
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\?+$/g, '')
    .replace(/\s+/g, ' ');

  const rewrites: Array<[RegExp, string]> = [
    [/^is it (?:true|correct|accurate) that\s+/i, ''],
    [/^(?:is|are|was|were|does|do|did|has|have|can|could|will|would)\s+/i, ''],
    [/^(?:what|which|who|whom|whose|where|when|why|how)\s+(?:is|are|was|were|does|do|did|has|have|can|could|will|would)\s+/i, ''],
    [/^(?:what|which|who|where|when|why|how)\s+/i, ''],
    [/^(?:tell me about|explain|describe|research|find|look up|compare)\s+/i, ''],
    [/^(?:the|a|an)\s+/i, ''],
  ];

  let output = cleaned;
  for (const [pattern, replacement] of rewrites) {
    const next = output.replace(pattern, '');
    if (next !== output && next.trim().length > 2) output = next;
  }

  return output.replace(/\s+/g, ' ').trim();
}

/** Remove trailing/leading punctuation from a sentence-level quote. */
export function cleanSentence(text: string): string {
  return text.replace(/^[\s\-–—•*>]+/, '').replace(/\s+$/, '').trim();
}
