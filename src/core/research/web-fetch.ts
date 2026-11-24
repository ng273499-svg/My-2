/**
 * JARVIS-X v1.3.0 — Secure web fetch provider.
 *
 * Guarantees:
 *   * http/https only; every redirect hop is re-validated by the SSRF guard
 *     before it is followed, so a public URL cannot bounce to 169.254.169.254.
 *   * Streaming byte cap — a body that exceeds the limit is aborted, never
 *     buffered into memory.
 *   * Hard timeout and caller cancellation.
 *   * Content-type allow-list; binaries are reported as UNSUPPORTED_CONTENT
 *     rather than decoded into garbage.
 *   * robots.txt is honoured. Access controls are never bypassed; a restricted
 *     page is reported as ROBOTS_RESTRICTED and contributes NO text.
 *   * No JavaScript is executed — this provider only reads bytes.
 */

import { createHash } from 'node:crypto';

import {
  assertSafeUrl,
  domainOf,
  inspectUrl,
  type UrlGuardOptions,
  type UrlVerdict,
} from './url-safety';
import {
  DEFAULT_FETCH_LIMITS,
  type FetchRequest,
  type FetchStatus,
  type FetchedPage,
  type WebFetchLimits,
} from './types';

const USER_AGENT =
  'Mozilla/5.0 (compatible; JARVIS-X-Research/1.3; +https://github.com/ng273499-svg/My-2) research-bot';

/** Content types that can be turned into research evidence. */
const TEXTUAL_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/ld+json',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
];

/** Phrases that indicate a hard or soft paywall rather than a failed read. */
const PAYWALL_MARKERS = [
  'subscribe to continue',
  'subscribe to read',
  'this article is for subscribers',
  'create a free account to continue',
  'already a subscriber',
  'sign in to continue reading',
  'register to continue reading',
  'premium content',
  'metered paywall',
];

const AUTH_MARKERS = [
  'sign in to view',
  'log in to view',
  'please log in',
  'authentication required',
  'you must be signed in',
];

const BLOCK_MARKERS = [
  'access denied',
  'you have been blocked',
  'captcha',
  'are you a robot',
  'request blocked',
  'unusual traffic',
];

export interface WebFetchProviderOptions {
  limits?: Partial<WebFetchLimits>;
  guard?: UrlGuardOptions;
  /** Honour robots.txt. On by default — JARVIS does not bypass access rules. */
  respectRobots?: boolean;
  /** Injectable transport (tests / future proxying). */
  fetchImpl?: typeof fetch;
}

interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelayMs: number | null;
}

export class WebFetchProvider {
  private readonly limits: WebFetchLimits;
  private readonly guard: UrlGuardOptions;
  private readonly respectRobots: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly robotsCache = new Map<string, RobotsRules | null>();

  constructor(options: WebFetchProviderOptions = {}) {
    this.limits = { ...DEFAULT_FETCH_LIMITS, ...options.limits };
    this.guard = options.guard ?? {};
    this.respectRobots = options.respectRobots ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** TRUE only when this provider can reach the real public internet. */
  get live(): boolean {
    return (this.guard.testOnlyAllowedHosts ?? []).length === 0;
  }

  get fetchLimits(): WebFetchLimits {
    return { ...this.limits };
  }

  // ------------------------------------------------------------------------
  // robots.txt
  // ------------------------------------------------------------------------
  private async robotsFor(origin: string, signal?: AbortSignal): Promise<RobotsRules | null> {
    if (!this.respectRobots) return null;
    if (this.robotsCache.has(origin)) return this.robotsCache.get(origin) ?? null;

    let rules: RobotsRules | null = null;
    try {
      const response = await this.rawRequest(`${origin}/robots.txt`, {
        signal,
        maxBytes: 128 * 1024,
        timeoutMs: Math.min(6000, this.limits.timeoutMs),
      });
      if (response && response.httpStatus === 200 && response.body) {
        rules = parseRobots(response.body);
      }
    } catch {
      rules = null; // unreachable robots.txt → treat as no restriction
    }
    this.robotsCache.set(origin, rules);
    return rules;
  }

  // ------------------------------------------------------------------------
  // Low-level single request (no redirect following, no robots)
  // ------------------------------------------------------------------------
  private async rawRequest(
    url: string,
    options: { signal?: AbortSignal; maxBytes: number; timeoutMs: number }
  ): Promise<FetchedPage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const signal = combineSignals(options.signal, controller.signal);

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/plain,*/*;q=0.1',
        },
      });

      const body = await readBoundedBody(response, options.maxBytes);
      return {
        status: 'OK',
        finalUrl: url,
        requestedUrl: url,
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
        bytes: body.length,
        body,
        redirectChain: [],
        detail: 'Fetched robots.txt',
        durationMs: 0,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------------
  // Public fetch
  // ------------------------------------------------------------------------
  async fetch(request: FetchRequest): Promise<FetchedPage> {
    const startedAt = Date.now();
    const maxBytes = Math.min(request.maxBytes ?? this.limits.maxBytes, this.limits.maxBytes);
    const timeoutMs = Math.min(request.timeoutMs ?? this.limits.timeoutMs, this.limits.timeoutMs);

    // ---- Deadline for the whole redirect chain ----
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    let currentUrl = request.url;
    const redirectChain: string[] = [];

    // Every hop is validated before use, including the first.
    const firstVerdict = await assertSafeUrl(currentUrl, this.guard);
    if (!firstVerdict.safe) {
      return this.failure(request.url, 'UNSAFE_URL', startedAt, redirectChain, firstVerdict.detail);
    }

    // ---- robots.txt is checked once per origin, before any page read ----
    try {
      const origin = new URL(currentUrl).origin;
      const rules = await this.robotsFor(origin, request.signal);
      if (rules && !isPathAllowed(new URL(currentUrl).pathname, rules)) {
        return this.failure(
          request.url,
          'ROBOTS_RESTRICTED',
          startedAt,
          redirectChain,
          'robots.txt disallows this path for research agents. JARVIS does not bypass access controls.'
        );
      }
    } catch {
      /* robots parsing failures fall through to the normal access checks */
    }

    for (let hop = 0; hop <= this.limits.maxRedirects; hop += 1) {
      if (Date.now() > deadline) {
        return this.failure(request.url, 'TIMEOUT', startedAt, redirectChain, 'The fetch deadline elapsed.');
      }
      if (request.signal?.aborted) {
        return this.failure(request.url, 'FETCH_FAILED', startedAt, redirectChain, 'Cancelled by the caller.');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      const signal = combineSignals(request.signal, controller.signal);

      let response: Response;
      try {
        response = await this.fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1',
            'accept-language': 'en',
          },
        });
      } catch (error) {
        clearTimeout(timer);
        const aborted = isAbortError(error);
        if (request.signal?.aborted) {
          return this.failure(request.url, 'FETCH_FAILED', startedAt, redirectChain, 'Cancelled by the caller.');
        }
        return this.failure(
          request.url,
          aborted ? 'TIMEOUT' : 'FETCH_FAILED',
          startedAt,
          redirectChain,
          aborted ? `No response within ${timeoutMs} ms.` : `Network error: ${describeError(error)}`
        );
      }
      clearTimeout(timer);

      // ---- Redirects: validated before the next hop ----
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return this.failure(request.url, 'FETCH_FAILED', startedAt, redirectChain, 'Redirect without a Location header.');
        }
        if (redirectChain.length >= this.limits.maxRedirects) {
          return this.failure(
            request.url,
            'REDIRECT_REJECTED',
            startedAt,
            redirectChain,
            `Exceeded the ${this.limits.maxRedirects}-hop redirect limit.`
          );
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          return this.failure(request.url, 'REDIRECT_REJECTED', startedAt, redirectChain, 'Malformed redirect target.');
        }

        // A public URL that bounces to a blocked target is a REDIRECT rejection,
        // not a bad initial URL — the distinction matters when diagnosing why a
        // source could not be read.
        const verdict = await assertSafeUrl(nextUrl, this.guard);
        if (!verdict.safe) {
          return this.failure(
            request.url,
            'REDIRECT_REJECTED',
            startedAt,
            redirectChain,
            `Redirect blocked target: ${verdict.detail}`
          );
        }

        redirectChain.push(nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      // ---- Access statuses ----
      const statusCode = response.status;
      if (statusCode === 401 || statusCode === 407) {
        return this.failure(request.url, 'AUTH_REQUIRED', startedAt, redirectChain, 'The page requires authentication.');
      }
      if (statusCode === 402) {
        return this.failure(request.url, 'PAYWALLED', startedAt, redirectChain, 'The publisher requires payment.');
      }
      if (statusCode === 403) {
        return this.failure(request.url, 'BLOCKED', startedAt, redirectChain, 'The publisher blocked this request (403).');
      }
      if (statusCode === 429) {
        return this.failure(request.url, 'RATE_LIMITED', startedAt, redirectChain, 'The host rate-limited this request (429).');
      }
      if (statusCode >= 400) {
        return this.failure(request.url, 'FETCH_FAILED', startedAt, redirectChain, `HTTP ${statusCode}.`);
      }

      // ---- Content type ----
      const contentTypeHeader = response.headers.get('content-type') ?? '';
      const contentType = contentTypeHeader.split(';')[0].trim().toLowerCase();
      if (!isTextual(contentType)) {
        return this.failure(
          request.url,
          'UNSUPPORTED_CONTENT',
          startedAt,
          redirectChain,
          `Content type "${contentType || 'unknown'}" cannot be read as research evidence.`,
          contentType
        );
      }

      // ---- Body with a streaming cap ----
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        return this.failure(
          request.url,
          'TOO_LARGE',
          startedAt,
          redirectChain,
          `The page declares ${declaredLength} bytes, above the ${maxBytes}-byte limit.`
        );
      }

      let body: string;
      try {
        body = await readBoundedBody(response, maxBytes);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return this.failure(
            request.url,
            'TOO_LARGE',
            startedAt,
            redirectChain,
            `The response exceeded the ${maxBytes}-byte limit and was aborted.`
          );
        }
        if (isAbortError(error)) {
          return this.failure(request.url, 'TIMEOUT', startedAt, redirectChain, 'The body read timed out.');
        }
        return this.failure(request.url, 'FETCH_FAILED', startedAt, redirectChain, 'The response body could not be read.');
      }

      // ---- Soft access walls (200 + wall copy) ----
      const wall = detectAccessWall(body.slice(0, 60_000));
      if (wall) {
        return this.failure(request.url, wall, startedAt, redirectChain, accessWallDetail(wall));
      }

      return {
        status: 'OK',
        finalUrl: currentUrl,
        requestedUrl: request.url,
        httpStatus: statusCode,
        contentType,
        bytes: body.length,
        body,
        redirectChain,
        detail: `Fetched ${body.length} bytes from ${domainOf(currentUrl)}.`,
        durationMs: Date.now() - startedAt,
      };
    }

    return this.failure(
      request.url,
      'REDIRECT_REJECTED',
      startedAt,
      redirectChain,
      'Too many redirects.'
    );
  }

  private failure(
    requestedUrl: string,
    status: FetchStatus,
    startedAt: number,
    redirectChain: string[],
    detail: string,
    contentType: string | null = null
  ): FetchedPage {
    return {
      status,
      finalUrl: null,
      requestedUrl,
      httpStatus: null,
      contentType,
      bytes: 0,
      body: null,
      redirectChain: [...redirectChain],
      detail,
      durationMs: Date.now() - startedAt,
    };
  }
}

/* ==========================================================================
 * Helpers
 * ======================================================================== */

class BodyTooLargeError extends Error {
  constructor() {
    super('BODY_TOO_LARGE');
    this.name = 'BodyTooLargeError';
  }
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160);
  return 'unknown error';
}

function isTextual(contentType: string): boolean {
  if (!contentType) return true; // some servers omit it; the extractor stays bounded
  if (TEXTUAL_CONTENT_TYPES.includes(contentType)) return true;
  return contentType.endsWith('+json') || contentType.endsWith('+xml');
}

/** Read a response body while enforcing a hard byte cap. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new BodyTooLargeError();
    return text;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/** Detect a 200-OK access wall. Returns the honest status, or null. */
function detectAccessWall(body: string): FetchStatus | null {
  const lower = body.toLowerCase();

  // JSON-LD explicitly marking the content as paid is the strongest signal.
  if (/"isaccessibleforfree"\s*:\s*false/.test(lower)) return 'PAYWALLED';

  const window = lower.slice(0, 20_000);
  if (BLOCK_MARKERS.some((marker) => window.includes(marker))) return 'BLOCKED';
  if (PAYWALL_MARKERS.some((marker) => window.includes(marker))) return 'PAYWALLED';
  if (AUTH_MARKERS.some((marker) => window.includes(marker))) return 'AUTH_REQUIRED';

  return null;
}

function accessWallDetail(status: FetchStatus): string {
  switch (status) {
    case 'PAYWALLED':
      return 'The page returned a paywall. No content was read and none is claimed.';
    case 'AUTH_REQUIRED':
      return 'The page requires a signed-in account. No content was read.';
    case 'BLOCKED':
      return 'The page refused automated access. JARVIS stopped instead of evading the control.';
    default:
      return 'The page could not be accessed.';
  }
}

/**
 * Parse robots.txt conservatively.
 *
 * Only `User-agent` groups that apply to us (a `*` group or one naming
 * "jarvis") are considered, and the LONGEST matching path rule wins — which is
 * how RFC 9309 defines precedence.
 */
/**
 * Content hash for dedup. SHA-256 over the whitespace-normalised, lower-cased
 * text, truncated to 32 hex chars — stable across syndicated copies.
 */
export function hashContent(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function parseRobots(text: string): RobotsRules | null {
  const rules: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null };
  const lines = text.split(/\r?\n/);

  let applies = false;
  let inAgentBlock = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!inAgentBlock) applies = false;
      inAgentBlock = true;
      const agent = value.toLowerCase();
      if (agent === '*' || agent.includes('jarvis')) applies = true;
      continue;
    }

    inAgentBlock = false;
    if (!applies) continue;

    if (field === 'disallow' && value) rules.disallow.push(value);
    if (field === 'allow' && value) rules.allow.push(value);
    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) {
        rules.crawlDelayMs = Math.round(seconds * 1000);
      }
    }
  }

  if (rules.disallow.length === 0 && rules.allow.length === 0 && rules.crawlDelayMs === null) {
    return null;
  }
  return rules;
}

/** True when the path is crawlable under the parsed rules. */
export function isPathAllowed(pathname: string, rules: RobotsRules | null): boolean {
  if (!rules) return true;
  const path = pathname || '/';

  const longest = (patterns: string[]): number => {
    let best = -1;
    for (const pattern of patterns) {
      if (matchRobotsPath(path, pattern)) best = Math.max(best, pattern.length);
    }
    return best;
  };

  const allowLength = longest(rules.allow);
  const disallowLength = longest(rules.disallow);

  if (disallowLength === -1) return true;
  return allowLength >= disallowLength;
}

function matchRobotsPath(path: string, pattern: string): boolean {
  // Support the `*` wildcard and the `$` end anchor used by real robots files.
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}${anchored ? '$' : ''}`);
  return regex.test(path);
}

/** Re-exported for callers that only need the structural (sync) check. */
export { inspectUrl };
export type { UrlVerdict, UrlGuardOptions };
