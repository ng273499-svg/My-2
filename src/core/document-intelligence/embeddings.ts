/**
 * JARVIS-X v1.2.0 — Document Embedding Architecture
 *
 * Provider-neutral embeddings wired into the EXISTING memory/pgvector
 * architecture (1536 dimensions, cosine). Never presents a deterministic
 * hashing fallback as production-quality semantic understanding — the mode is
 * always reported honestly.
 */

import {
  DeterministicHashedEmbeddingAdapter,
  HIERARCHICAL_VECTOR_DIMENSIONS,
  OpenAIEmbeddingAdapter,
  cosineSimilarityVec,
  type MemoryEmbeddingProvider,
} from '@/core/memory/embeddings';
import type { EmbeddingMode, EmbeddingProvider, EmbeddingStatus } from './types';

export const DOCUMENT_EMBEDDING_DIMENSIONS = HIERARCHICAL_VECTOR_DIMENSIONS;

const HONEST_NOTES: Record<EmbeddingMode, string> = {
  neural:
    'Semantic embeddings are produced by a configured neural embedding provider.',
  deterministic_fallback:
    'Deterministic feature-hash vectors only. This is a zero-cost lexical/feature fallback, NOT production-grade semantic understanding. Retrieval quality depends on the keyword channel.',
  unavailable:
    'No embedding provider is available. Vector similarity is disabled; retrieval falls back to keyword and metadata channels only.',
};

/** Adapt any MemoryEmbeddingProvider into the document EmbeddingProvider. */
export class MemoryEmbeddingBridge implements EmbeddingProvider {
  constructor(private readonly inner: MemoryEmbeddingProvider) {}

  get providerId(): string {
    return this.inner.providerId;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  get mode(): EmbeddingMode {
    if (!this.inner.isConfigured()) return 'unavailable';
    return this.inner.isNeuralSemanticModel ? 'neural' : 'deterministic_fallback';
  }

  get isNeuralSemanticModel(): boolean {
    return this.inner.isNeuralSemanticModel;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  async embed(text: string): Promise<number[]> {
    return this.inner.embed(text);
  }
}

/**
 * Resolves the best configured embedding provider and exposes an honest status.
 */
export class DocumentEmbeddingService {
  private readonly providers: EmbeddingProvider[];
  private readonly deterministic: EmbeddingProvider;

  constructor(options?: { providers?: MemoryEmbeddingProvider[] }) {
    const neural = new OpenAIEmbeddingAdapter();
    const fallback = new DeterministicHashedEmbeddingAdapter();

    this.deterministic = new MemoryEmbeddingBridge(fallback);
    this.providers = options?.providers
      ? options.providers.map((p) => new MemoryEmbeddingBridge(p))
      : [new MemoryEmbeddingBridge(neural), this.deterministic];
  }

  /** The provider actually used right now. Never throws. */
  activeProvider(): EmbeddingProvider {
    for (const provider of this.providers) {
      if (provider.isConfigured()) return provider;
    }
    return this.deterministic;
  }

  status(): EmbeddingStatus {
    const provider = this.activeProvider();
    const mode: EmbeddingMode = provider.isConfigured() ? provider.mode : 'unavailable';
    return {
      mode,
      providerId: provider.providerId,
      dimensions: provider.dimensions,
      honestNote: HONEST_NOTES[mode],
    };
  }

  async embed(text: string): Promise<number[]> {
    const provider = this.activeProvider();
    try {
      return await provider.embed(text);
    } catch {
      // A failing neural provider must degrade honestly, not crash retrieval.
      return this.deterministic.embed(text);
    }
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      out.push(await this.embed(text));
    }
    return out;
  }

  similarity(a: number[], b: number[]): number {
    return cosineSimilarityVec(a, b);
  }
}
