import type {
  ChatMessage,
  ConsolidationOutcome,
  HierarchicalMemoryQuery,
  HierarchicalMemoryScope,
  MemoryCategory,
  MemoryEntry,
  MemoryProvenance,
  MemoryStatusSummary,
} from '@/core/types';
import {
  HierarchicalMemoryEngine,
  inferScopeFromCategory,
  type HierarchicalMemoryEngineOptions,
  type SessionConsolidationReport,
  type StoreMemoryInput,
} from '@/core/memory';
import type {
  DataRepository,
  ListMemoriesFilter,
} from '@/server/repositories/types';

/**
 * Memory Manager (JARVIS-X v0.5 — Advanced Hierarchical Memory Engine)
 * Coordinates all 7 memory scopes (`working`, `episodic`, `semantic`, `project`,
 * `knowledge`, `procedural`, `event`), hybrid lexical + 1536-dim vector retrieval,
 * temporal retention decay, deduplication, contradiction supersession, and
 * untrusted knowledge quarantine.
 */
export class MemoryManager {
  public readonly engine: HierarchicalMemoryEngine;

  constructor(
    private readonly repository: DataRepository,
    engineOptions?: HierarchicalMemoryEngineOptions
  ) {
    this.engine = new HierarchicalMemoryEngine(engineOptions);
  }

  async getStatus(
    userId: string,
    shortTermTurnCount: number
  ): Promise<MemoryStatusSummary> {
    return this.engine.buildStatusSummary(
      this.repository,
      userId,
      shortTermTurnCount
    );
  }

  async listEntries(
    userId: string,
    filter?: ListMemoriesFilter
  ): Promise<MemoryEntry[]> {
    return this.repository.listMemories(userId, filter);
  }

  async recallRelevant(
    userId: string,
    query: string,
    options?: Omit<HierarchicalMemoryQuery, 'query'>
  ): Promise<MemoryEntry[]> {
    const bundle = await this.engine.retrieveContext(this.repository, userId, {
      query,
      ...options,
    });
    return bundle.entries;
  }

  async retrieveHierarchicalBundle(
    userId: string,
    queryInput: HierarchicalMemoryQuery,
    conversationMessages: ChatMessage[] = []
  ) {
    return this.engine.retrieveContext(
      this.repository,
      userId,
      queryInput,
      conversationMessages
    );
  }

  async searchByVector(
    userId: string,
    queryEmbedding: number[],
    matchThreshold = 0.72,
    matchCount = 8
  ): Promise<MemoryEntry[]> {
    return this.repository.searchMemoriesByVector(
      userId,
      queryEmbedding,
      matchThreshold,
      matchCount
    );
  }

  async storeMemory(
    userId: string,
    content: string,
    category: MemoryCategory = 'fact',
    tags: string[] = ['user-noted'],
    sourceConversationId?: string,
    embedding?: number[],
    options?: {
      memoryScope?: HierarchicalMemoryScope;
      projectId?: string | null;
      importance?: 1 | 2 | 3 | 4 | 5;
      confidence?: number;
      provenance?: MemoryProvenance;
      expiresAt?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Promise<MemoryEntry> {
    const outcome = await this.storeMemoryWithOutcome(userId, {
      category,
      memoryScope:
        options?.memoryScope ??
        inferScopeFromCategory(category, options?.projectId),
      projectId: options?.projectId ?? null,
      content,
      tags,
      importance: options?.importance ?? 4,
      confidence: options?.confidence,
      provenance: options?.provenance ?? 'user_explicit',
      sourceConversationId,
      expiresAt: options?.expiresAt ?? null,
      metadata: options?.metadata,
      precomputedEmbedding: embedding,
    });

    if (!outcome.entry) {
      throw new Error(outcome.reason);
    }
    return outcome.entry;
  }

  async storeMemoryWithOutcome(
    userId: string,
    input: StoreMemoryInput
  ): Promise<ConsolidationOutcome> {
    return this.engine.storeMemory(this.repository, userId, input);
  }

  async consolidateConversation(
    userId: string,
    conversationId: string,
    options?: { title?: string; projectId?: string | null }
  ): Promise<SessionConsolidationReport> {
    const [conv, messages] = await Promise.all([
      this.repository.getConversation(userId, conversationId),
      this.repository.getMessages(userId, conversationId),
    ]);
    return this.engine.consolidateSession(
      this.repository,
      userId,
      {
        conversationId,
        title: options?.title ?? conv?.title ?? 'Command Session',
        messages,
      },
      options?.projectId ?? conv?.projectId ?? null
    );
  }

  async ingestKnowledgeChunk(
    userId: string,
    content: string,
    options?: {
      sourceLabel?: string;
      projectId?: string | null;
      tags?: string[];
      importance?: 1 | 2 | 3 | 4 | 5;
    }
  ): Promise<ConsolidationOutcome> {
    return this.engine.storeMemory(this.repository, userId, {
      category: 'knowledge_chunk',
      memoryScope: 'knowledge',
      projectId: options?.projectId ?? null,
      content,
      tags: Array.from(
        new Set(['knowledge-chunk', ...(options?.tags ?? [])])
      ),
      importance: options?.importance ?? 3,
      confidence: 0.72,
      provenance: 'untrusted_external',
      verified: false,
      metadata: {
        sourceLabel: options?.sourceLabel ?? 'external_document',
        quarantineRequired: true,
      },
    });
  }

  async recordSalientEvent(
    userId: string,
    content: string,
    options?: {
      ttlHours?: number;
      projectId?: string | null;
      tags?: string[];
      importance?: 1 | 2 | 3 | 4 | 5;
    }
  ): Promise<ConsolidationOutcome> {
    const expiresAt =
      options?.ttlHours && options.ttlHours > 0
        ? new Date(Date.now() + options.ttlHours * 3_600_000).toISOString()
        : null;

    return this.engine.storeMemory(this.repository, userId, {
      category: 'event_record',
      memoryScope: 'event',
      projectId: options?.projectId ?? null,
      content,
      tags: Array.from(new Set(['event', ...(options?.tags ?? [])])),
      importance: options?.importance ?? 3,
      confidence: 0.95,
      provenance: 'system_seed',
      verified: true,
      expiresAt,
    });
  }

  async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    return this.repository.deleteMemory(userId, memoryId);
  }
}
