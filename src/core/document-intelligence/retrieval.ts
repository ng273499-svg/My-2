/**
 * JARVIS-X v1.2.0 — Hybrid Retrieval
 *
 * Combines six independent signals instead of relying on vector similarity
 * alone:
 *   A. semantic / vector similarity
 *   B. keyword / BM25 full-text relevance
 *   C. metadata filters (heading, section, title, intent boosts)
 *   D. project / document scope
 *   E. recency (only where appropriate)
 *   F. trust / provenance
 *
 * Owner isolation is enforced as a hard pre-filter: another user's chunks are
 * never candidates, regardless of score.
 */

import type {
  DocumentChunk,
  EmbeddingStatus,
  RetrievalScope,
  RetrievalWeights,
  ScoredChunk,
} from './types';
import { DocumentEmbeddingService } from './embeddings';
import { understandQuery } from './query-understanding';

export const DEFAULT_WEIGHTS: RetrievalWeights = {
  vector: 0.38,
  keyword: 0.32,
  metadata: 0.14,
  recency: 0.06,
  trust: 0.10,
};

interface IndexedChunk {
  chunk: DocumentChunk;
  embedding: number[] | null;
  terms: string[];
  termCounts: Map<string, number>;
  length: number;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'to', 'in', 'on',
  'at', 'by', 'for', 'with', 'about', 'from', 'as', 'into', 'it', 'its',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-.\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * In-memory, owner-scoped chunk index. Every query is filtered by ownerId
 * before scoring and before any chunk leaves this class.
 */
export class DocumentIndex {
  private readonly byOwner = new Map<string, Map<string, IndexedChunk>>();
  readonly embeddingService: DocumentEmbeddingService;

  constructor(embeddingService: DocumentEmbeddingService) {
    this.embeddingService = embeddingService;
  }

  embeddingStatus(): EmbeddingStatus {
    return this.embeddingService.status();
  }

  async addChunks(chunks: DocumentChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const terms = tokenize(chunk.text);
      const termCounts = new Map<string, number>();
      for (const t of terms) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);

      let embedding: number[] | null = null;
      try {
        embedding = await this.embeddingService.embed(chunk.text);
      } catch {
        embedding = null;
      }

      const ownerMap = this.byOwner.get(chunk.ownerId) ?? new Map<string, IndexedChunk>();
      ownerMap.set(chunk.chunkId, {
        chunk,
        embedding,
        terms,
        termCounts,
        length: terms.length,
      });
      this.byOwner.set(chunk.ownerId, ownerMap);
    }
  }

  /** Revoke every chunk belonging to a document (deletion path). */
  removeDocument(ownerId: string, documentId: string): number {
    const ownerMap = this.byOwner.get(ownerId);
    if (!ownerMap) return 0;
    let removed = 0;
    for (const [chunkId, indexed] of ownerMap.entries()) {
      if (indexed.chunk.documentId === documentId) {
        ownerMap.delete(chunkId);
        removed += 1;
      }
    }
    return removed;
  }

  hasDocument(ownerId: string, documentId: string): boolean {
    const ownerMap = this.byOwner.get(ownerId);
    if (!ownerMap) return false;
    for (const indexed of ownerMap.values()) {
      if (indexed.chunk.documentId === documentId) return true;
    }
    return false;
  }

  countChunks(ownerId: string, documentId?: string): number {
    const ownerMap = this.byOwner.get(ownerId);
    if (!ownerMap) return 0;
    if (!documentId) return ownerMap.size;
    let count = 0;
    for (const indexed of ownerMap.values()) {
      if (indexed.chunk.documentId === documentId) count += 1;
    }
    return count;
  }

  /** Owner-scoped candidate pool with all scope filters applied. */
  candidates(scope: RetrievalScope): IndexedChunk[] {
    const ownerMap = this.byOwner.get(scope.ownerId);
    if (!ownerMap) return [];

    return [...ownerMap.values()].filter((indexed) => {
      const chunk = indexed.chunk;
      // Hard owner isolation (defence in depth — the map is already owner-scoped).
      if (chunk.ownerId !== scope.ownerId) return false;

      if (scope.documentIds && scope.documentIds.length > 0) {
        return scope.documentIds.includes(chunk.documentId);
      }
      if (scope.projectId && !scope.includeAllProjects) {
        return chunk.projectId === scope.projectId;
      }
      return true;
    });
  }

  allForOwner(ownerId: string): DocumentChunk[] {
    const ownerMap = this.byOwner.get(ownerId);
    if (!ownerMap) return [];
    return [...ownerMap.values()]
      .filter((i) => i.chunk.ownerId === ownerId)
      .map((i) => i.chunk);
  }

  clearOwner(ownerId: string): void {
    this.byOwner.delete(ownerId);
  }
}

export interface HybridRetrieveOptions {
  topK?: number;
  candidateLimit?: number;
  weights?: Partial<RetrievalWeights>;
  nowIso?: string;
}

export class HybridRetriever {
  constructor(private readonly index: DocumentIndex) {}

  async retrieve(
    query: string,
    scope: RetrievalScope,
    options: HybridRetrieveOptions = {}
  ): Promise<{
    scored: ScoredChunk[];
    understanding: ReturnType<typeof understandQuery>;
    embeddingStatus: EmbeddingStatus;
    diagnostics: string[];
    candidateCount: number;
    scoredCount: number;
  }> {
    const understanding = understandQuery(query);
    const embeddingStatus = this.index.embeddingStatus();

    const diagnostics: string[] = [];
    const pool = this.index.candidates(scope);
    const candidateCount = pool.length;

    if (pool.length === 0) {
      diagnostics.push('No authorized chunks matched the retrieval scope.');
      return { scored: [], understanding, embeddingStatus, diagnostics, candidateCount, scoredCount: 0 };
    }

    const weights: RetrievalWeights = { ...DEFAULT_WEIGHTS, ...options.weights };
    const now = options.nowIso ? new Date(options.nowIso).getTime() : Date.now();

    // --- BM25 corpus statistics (over the scoped pool only) --------------
    const N = pool.length;
    const avgdl = pool.reduce((sum, i) => sum + i.length, 0) / N || 1;
    const df = new Map<string, number>();
    for (const indexed of pool) {
      for (const term of new Set(indexed.terms)) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }

    const k1 = 1.5;
    const b = 0.75;
    const queryTerms = understanding.keywords.length ? understanding.keywords : tokenize(query);

    // --- A. query embedding (once) --------------------------------------
    let queryEmbedding: number[] | null = null;
    if (embeddingStatus.mode !== 'unavailable') {
      try {
        queryEmbedding = await this.index.embeddingService.embed(query);
      } catch {
        queryEmbedding = null;
        diagnostics.push('Query embedding failed; vector channel skipped.');
      }
    }

    const scored: ScoredChunk[] = pool.map((indexed) => {
      const chunk = indexed.chunk;

      // --- A. vector similarity ---
      let vectorScore = 0;
      if (queryEmbedding && indexed.embedding) {
        const raw = this.index.embeddingService.similarity(queryEmbedding, indexed.embedding);
        // Cosine ∈ [-1,1] → clamp to [0,1].
        vectorScore = Math.max(0, Math.min(1, raw));
      }

      // --- B. keyword / BM25 ---
      let keywordRaw = 0;
      for (const term of queryTerms) {
        const tf = indexed.termCounts.get(term) ?? 0;
        if (tf === 0) continue;
        const termDf = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - termDf + 0.5) / (termDf + 0.5));
        const denom = tf + k1 * (1 - b + (b * indexed.length) / avgdl);
        keywordRaw += idf * ((tf * (k1 + 1)) / denom);
      }
      const keywordScore = keywordRaw > 0 ? keywordRaw / (keywordRaw + 4) : 0;

      // --- C. metadata score ---
      let metadataScore = 0;
      const headingHaystack = `${chunk.section ?? ''} ${chunk.headingPath.join(' ')}`.toLowerCase();
      for (const term of queryTerms) {
        if (headingHaystack.includes(term)) metadataScore += 0.25;
      }
      if (understanding.intent === 'table_data' && chunk.text.includes('Row ')) metadataScore += 0.2;
      if (
        understanding.intent === 'code_documentation' &&
        /(function|class|interface|api|endpoint)/i.test(chunk.text)
      ) {
        metadataScore += 0.2;
      }
      if (understanding.intent === 'summarization') {
        if (chunk.section) metadataScore += 0.1;
        if (chunk.order < 10) metadataScore += 0.1;
      }
      if (understanding.entities.some((e) => chunk.text.includes(e))) metadataScore += 0.3;
      metadataScore = Math.min(1, metadataScore);

      // --- E. recency ---
      const ingestedMs = new Date(chunk.ingestedAt).getTime();
      const ageDays = Number.isFinite(ingestedMs)
        ? Math.max(0, (now - ingestedMs) / 86_400_000)
        : 999;
      const recencyScore = 1 / (1 + ageDays / 30); // half-life ≈ 30 days

      // --- F. trust ---
      const trustScore =
        chunk.trustLevel === 'system_verified'
          ? 1
          : chunk.trustLevel === 'user_authorized'
            ? 0.8
            : 0.4;

      const hybridScore =
        weights.vector * vectorScore +
        weights.keyword * keywordScore +
        weights.metadata * metadataScore +
        weights.recency * recencyScore +
        weights.trust * trustScore;

      return {
        chunk,
        vectorScore,
        keywordScore,
        metadataScore,
        recencyScore,
        trustScore,
        hybridScore,
      };
    });

    scored.sort((x, y) => y.hybridScore - x.hybridScore);

    if (embeddingStatus.mode === 'unavailable') {
      diagnostics.push('Vector channel disabled — embedding provider unavailable.');
    } else if (embeddingStatus.mode === 'deterministic_fallback') {
      diagnostics.push(
        'Vector channel uses deterministic feature hashing (zero-cost fallback), not neural semantics.'
      );
    }

    const candidateLimit = options.candidateLimit ?? 40;
    return {
      scored: scored.slice(0, candidateLimit),
      scoredCount: Math.min(scored.length, candidateLimit),
      understanding,
      embeddingStatus,
      diagnostics,
      candidateCount,
    };
  }
}
