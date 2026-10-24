/**
 * JARVIS-X v1.3.0 — Provider-neutral search.
 *
 * Four honest statuses, one rule: a provider that cannot search REAL sources
 * says so and returns nothing.
 *
 *   AVAILABLE     a real external index answered
 *   DEGRADED      a real index answered, with reduced quality/results
 *   UNCONFIGURED  no real provider is configured (the zero-cost default)
 *   UNAVAILABLE   a configured provider could not be reached
 *
 * The default stack is UNCONFIGURED. There is no mandatory paid search API, and
 * the deterministic adapter is explicitly labelled `live: false` so it can
 * never be mistaken for real research.
 */

import type {
  ResearchFailureCode,
  SearchProviderHealth,
  SearchProviderStatus,
  SearchQueryInput,
  SearchResponse,
  SearchResult,
} from './types';
import { inspectUrl } from './url-safety';

export interface SearchProvider {
  readonly providerId: string;
  readonly label: string;
  /** TRUE only when it talks to a real external service. */
  readonly live: boolean;
  health(): SearchProviderHealth;
  search(input: SearchQueryInput): Promise<SearchResponse>;
}

/* ==========================================================================
 * Unconfigured (the zero-cost default)
 * ======================================================================== */

export class UnconfiguredSearchProvider implements SearchProvider {
  readonly providerId = 'unconfigured';
  readonly label = 'No live search provider configured';
  readonly live = false;

  health(): SearchProviderHealth {
    return {
      providerId: this.providerId,
      label: this.label,
      status: 'UNCONFIGURED',
      live: false,
      detail:
        'LIVE web search is UNCONFIGURED. JARVIS will report the absence of web evidence instead of inventing sources.',
      zeroCost: true,
    };
  }

  async search(input: SearchQueryInput): Promise<SearchResponse> {
    void input;
    return {
      ok: false,
      providerId: this.providerId,
      live: false,
      results: [],
      status: 'UNCONFIGURED',
      detail: 'No search provider is configured, so no query was sent anywhere.',
      errorCode: 'SEARCH_UNAVAILABLE',
    };
  }
}

/* ==========================================================================
 * Deterministic fixture (development / tests only)
 * ======================================================================== */

export interface FixtureDocument {
  url: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
  body: string;
}

export interface FixtureSearchOptions {
  documents: FixtureDocument[];
  /** Minimum term-overlap score for a fixture to be returned (0..1). */
  minScore?: number;
}

/**
 * A deterministic, offline adapter used for development and audits.
 *
 * It is ALWAYS `live: false`. The engine records that flag and the report states
 * plainly that the evidence is synthetic — it can never be presented as real web
 * research.
 */
export class FixtureSearchProvider implements SearchProvider {
  readonly providerId = 'fixture:non-live';
  readonly label = 'Deterministic fixture index (NON-LIVE)';
  readonly live = false;

  private readonly documents: FixtureDocument[];
  private readonly minScore: number;

  constructor(options: FixtureSearchOptions) {
    this.documents = options.documents;
    this.minScore = options.minScore ?? 0.12;
  }

  health(): SearchProviderHealth {
    return {
      providerId: this.providerId,
      label: this.label,
      status: 'AVAILABLE',
      live: false,
      detail:
        'Deterministic offline fixture index. Results are synthetic and NON-LIVE; they must never be presented as real web research.',
      zeroCost: true,
    };
  }

  async search(input: SearchQueryInput): Promise<SearchResponse> {
    const queryTerms = terms(input.query);
    const scored: Array<{ document: FixtureDocument; score: number }> = [];

    for (const document of this.documents) {
      const haystack = terms(`${document.title} ${document.snippet} ${document.body}`);
      const score = overlap(queryTerms, haystack);
      if (score >= this.minScore) scored.push({ document, score });
    }

    scored.sort((a, b) => b.score - a.score || a.document.url.localeCompare(b.document.url));

    const results: SearchResult[] = scored.slice(0, input.limit).map(({ document }) => ({
      url: document.url,
      title: document.title,
      snippet: document.snippet,
      publishedAt: document.publishedAt,
      academic: null,
    }));

    return {
      ok: true,
      providerId: this.providerId,
      live: false,
      results,
      status: 'AVAILABLE',
      detail: `${results.length} synthetic result(s) from the NON-LIVE fixture index. These are not web research.`,
    };
  }
}

/* ==========================================================================
 * SearxNG (self-hostable, zero-cost)
 * ======================================================================== */

export interface SearxngOptions {
  /** Base URL of a SearxNG instance owned by the operator. */
  baseUrl: string;
  /** Optional bearer token when the instance is protected. */
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * SearxNG adapter — a zero-cost, self-hostable metasearch front end.
 *
 * Only used when the operator explicitly configures it. Results are marked live
 * only when the HTTP response is valid; a failure degrades to UNAVAILABLE and
 * returns no results rather than falling back to invented data.
 */
export class SearxngSearchProvider implements SearchProvider {
  readonly providerId = 'searxng';
  readonly label = 'SearxNG (self-hosted)';
  readonly live = true;

  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private lastStatus: SearchProviderStatus = 'AVAILABLE';

  constructor(options: SearxngOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  health(): SearchProviderHealth {
    return {
      providerId: this.providerId,
      label: this.label,
      status: this.lastStatus,
      live: true,
      detail:
        this.lastStatus === 'AVAILABLE'
          ? 'Self-hosted SearxNG instance configured for real web search (zero API cost).'
          : 'SearxNG is configured but the last request did not succeed.',
      zeroCost: true,
    };
  }

  async search(input: SearchQueryInput): Promise<SearchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = input.signal ? mergeSignals(input.signal, controller.signal) : controller.signal;

    try {
      const url = new URL(`${this.baseUrl}/search`);
      url.searchParams.set('q', input.query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '1');
      url.searchParams.set('language', 'en');
      if (input.scholarlyOnly) url.searchParams.set('categories', 'science');

      const response = await this.fetchImpl(url.toString(), {
        headers: {
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        signal,
      });

      if (!response.ok) {
        this.lastStatus = response.status === 429 ? 'DEGRADED' : 'UNAVAILABLE';
        return {
          ok: false,
          providerId: this.providerId,
          live: true,
          results: [],
          status: this.lastStatus,
          detail: `SearxNG responded with HTTP ${response.status}.`,
          errorCode: 'SEARCH_UNAVAILABLE',
        };
      }

      const payload = (await response.json()) as { results?: unknown[] };
      const raw = Array.isArray(payload.results) ? payload.results : [];
      const results: SearchResult[] = [];

      for (const entry of raw) {
        if (results.length >= input.limit) break;
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;

        const resultUrl = typeof record.url === 'string' ? record.url : null;
        if (!resultUrl) continue;

        // Provider output is untrusted input: validate before it is ever fetched.
        const verdict = inspectUrl(resultUrl);
        if (!verdict.safe) continue;

        results.push({
          url: resultUrl,
          title: typeof record.title === 'string' ? record.title.slice(0, 400) : resultUrl,
          snippet: typeof record.content === 'string' ? record.content.slice(0, 1_200) : '',
          publishedAt: typeof record.publishedDate === 'string' ? record.publishedDate : null,
          academic: null,
        });
      }

      this.lastStatus = results.length > 0 ? 'AVAILABLE' : 'DEGRADED';

      return {
        ok: true,
        providerId: this.providerId,
        live: true,
        results,
        status: this.lastStatus,
        detail:
          results.length > 0
            ? `${results.length} live result(s) from the self-hosted SearxNG instance.`
            : 'The instance answered but returned no usable result.',
      };
    } catch (error) {
      this.lastStatus = 'UNAVAILABLE';
      return {
        ok: false,
        providerId: this.providerId,
        live: true,
        results: [],
        status: 'UNAVAILABLE',
        detail: `SearxNG request failed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`,
        errorCode: 'SEARCH_UNAVAILABLE',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ==========================================================================
 * Factory
 * ======================================================================== */

export interface SearchProviderEnv {
  SEARXNG_URL?: string;
  SEARXNG_TOKEN?: string;
  /** Explicit opt-in for the deterministic adapter (never in production). */
  JARVIS_RESEARCH_FIXTURE?: string;
}

/**
 * Resolve the provider stack from the environment.
 *
 * Order: an explicitly configured SearxNG instance wins. Otherwise the stack is
 * UNCONFIGURED — there is deliberately no silent fallback to synthetic results.
 */
export function createSearchProviderFromEnv(
  env: SearchProviderEnv = process.env as SearchProviderEnv
): SearchProvider[] {
  const providers: SearchProvider[] = [];

  if (env.SEARXNG_URL && /^https?:\/\//i.test(env.SEARXNG_URL)) {
    providers.push(
      new SearxngSearchProvider({
        baseUrl: env.SEARXNG_URL,
        token: env.SEARXNG_TOKEN,
      })
    );
  }

  if (env.JARVIS_RESEARCH_FIXTURE === '1') {
    // Explicitly opt-in, still labelled non-live.
    providers.push(new FixtureSearchProvider({ documents: [] }));
  }

  providers.push(new UnconfiguredSearchProvider());
  return providers;
}

/* ==========================================================================
 * Helpers
 * ======================================================================== */

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3)
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const token of a) if (b.has(token)) hits += 1;
  return hits / a.size;
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

/** Assert a provider is telling the truth about being live. */
export function assertProviderHonest(provider: SearchProvider, response: SearchResponse): void {
  if (response.live && !provider.live) {
    throw new Error(
      `Provider "${provider.providerId}" claimed live results but is registered as non-live. Refusing to treat synthetic results as real research.`
    );
  }
}

export type { ResearchFailureCode };
