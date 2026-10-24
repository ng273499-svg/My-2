import { resolveServerProviderCredentials } from '@/core/models/provider-config';

export const HIERARCHICAL_VECTOR_DIMENSIONS = 1536;

export interface MemoryEmbeddingProvider {
  readonly providerId: string;
  readonly dimensions: number;
  readonly isNeuralSemanticModel: boolean;
  isConfigured(): boolean;
  embed(text: string): Promise<number[]>;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'have',
  'are',
  'was',
  'were',
  'will',
  'into',
  'your',
  'our',
  'you',
]);

function fnv1a32(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function cosineSimilarityVec(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Zero-cost deterministic 1536-dimensional signed feature-hash vectorizer.
 * Compatible with PostgreSQL `pgvector(1536)` HNSW cosine indexing (`<=>`) out-of-the-box.
 * Honestly marked `isNeuralSemanticModel = false` so JARVIS-X never fabricates cloud neural
 * embedding availability when external API keys are absent.
 */
export class DeterministicHashedEmbeddingAdapter implements MemoryEmbeddingProvider {
  public readonly providerId = 'deterministic-feature-hash-1536';
  public readonly dimensions = HIERARCHICAL_VECTOR_DIMENSIONS;
  public readonly isNeuralSemanticModel = false;

  isConfigured(): boolean {
    return true;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Float64Array(this.dimensions);
    const cleaned = text.toLowerCase().replace(/[^a-z0-9_\-\s]/g, ' ');
    const tokens = cleaned
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

    // Unigrams (weight 1.0), bigrams (weight 0.75), character 4-grams (weight 0.35)
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      this.accumulateFeature(vec, `u:${tok}`, 1.0);

      if (i + 1 < tokens.length) {
        this.accumulateFeature(vec, `b:${tok}_${tokens[i + 1]}`, 0.75);
      }

      if (tok.length >= 4) {
        for (let c = 0; c <= tok.length - 4; c += 1) {
          this.accumulateFeature(vec, `g:${tok.slice(c, c + 4)}`, 0.35);
        }
      }
    }

    if (tokens.length === 0 && text.trim().length > 0) {
      this.accumulateFeature(vec, `raw:${text.trim().toLowerCase()}`, 1.0);
    }

    // L2 normalize to unit sphere for accurate cosine similarity
    let normSq = 0;
    for (let i = 0; i < vec.length; i += 1) {
      normSq += vec[i] * vec[i];
    }
    const norm = Math.sqrt(normSq);
    const out = new Array<number>(this.dimensions);
    if (norm === 0) {
      out.fill(0);
      out[0] = 1;
      return out;
    }

    for (let i = 0; i < this.dimensions; i += 1) {
      out[i] = Number((vec[i] / norm).toFixed(6));
    }
    return out;
  }

  private accumulateFeature(vec: Float64Array, feature: string, weight: number): void {
    const idxHash = fnv1a32(feature, 0x811c9dc5);
    const signHash = fnv1a32(feature, 0x9e3779b9);
    const bucket = idxHash % this.dimensions;
    const sign = (signHash & 1) === 0 ? 1 : -1;
    vec[bucket] += sign * weight;
  }
}

export interface OpenAIEmbeddingAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Isolated OpenAI `text-embedding-3-small` (`1536` dimensions) adapter.
 * Reports `isConfigured() = false` when `OPENAI_API_KEY` is absent on the server.
 */
export class OpenAIEmbeddingAdapter implements MemoryEmbeddingProvider {
  public readonly providerId = 'openai-text-embedding-3-small';
  public readonly dimensions = HIERARCHICAL_VECTOR_DIMENSIONS;
  public readonly isNeuralSemanticModel = true;

  private readonly explicitKey?: string;
  private readonly explicitBaseUrl?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAIEmbeddingAdapterOptions = {}) {
    this.explicitKey = options.apiKey;
    this.explicitBaseUrl = options.baseUrl;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private getApiKey(): string | undefined {
    if (this.explicitKey !== undefined) {
      return this.explicitKey.trim() || undefined;
    }
    return resolveServerProviderCredentials().openaiApiKey;
  }

  private getBaseUrl(): string {
    return (
      this.explicitBaseUrl?.trim() ||
      resolveServerProviderCredentials().openaiBaseUrl
    ).replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  async embed(text: string): Promise<number[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OpenAIEmbeddingAdapter is UNCONFIGURED on server.');
    }

    const res = await this.fetchFn(`${this.getBaseUrl()}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text.slice(0, 8_000),
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI embeddings returned HTTP ${res.status}`);
    }

    const payload = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const emb = payload.data?.[0]?.embedding;
    if (!Array.isArray(emb) || emb.length !== this.dimensions) {
      throw new Error('Malformed embedding vector returned by provider.');
    }
    return emb;
  }
}
