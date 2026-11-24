import 'server-only';
import { ResearchEngine } from '@/core/research';
import { createSearchProviderFromEnv, UnconfiguredSearchProvider } from '@/core/research/search-provider';
import { WebFetchProvider } from '@/core/research/web-fetch';

/**
 * JARVIS-X v1.3.0 — Process-wide Deep Research engine.
 *
 * Configuration is read from the environment ONLY:
 *   SEARXNG_URL   — self-hosted meta-search (zero cost)
 *   SEARXNG_TOKEN — optional bearer token for a gated instance
 *
 * If neither is present the provider stack resolves to UNCONFIGURED. That is
 * the honest state: JARVIS has no live search index, and it says so instead of
 * inventing results.
 *
 * Credentials never leave the server: nothing here is exported to the client
 * bundle, and the provider objects are never serialized into API responses.
 */

const globalForResearch = globalThis as unknown as {
  __jarvisResearchEngine?: ResearchEngine;
};

export function getResearchEngine(): ResearchEngine {
  if (!globalForResearch.__jarvisResearchEngine) {
    globalForResearch.__jarvisResearchEngine = new ResearchEngine({
      searchProvider: buildProvider(),
      fetchProvider: new WebFetchProvider(),
    });
  }
  return globalForResearch.__jarvisResearchEngine;
}

function buildProvider() {
  // createSearchProviderFromEnv always ends with the honest UNCONFIGURED
  // provider, so this can never silently become a paid service. A real
  // instance is used only when SEARXNG_URL is actually configured.
  const providers = createSearchProviderFromEnv();
  const live = providers.find((provider) => provider.live);
  return live ?? new UnconfiguredSearchProvider();
}

/** Test/reset hook — drops all in-process research task state. */
export function resetResearchEngineForTests(): void {
  globalForResearch.__jarvisResearchEngine = undefined;
}
