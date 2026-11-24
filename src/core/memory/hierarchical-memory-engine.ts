import type {
  ChatMessage,
  ConsolidationOutcome,
  HierarchicalMemoryQuery,
  HierarchicalMemoryScope,
  HierarchicalRetrievalBundle,
  MemoryCategory,
  MemoryEntry,
  MemoryProvenance,
  MemoryScopeDescriptor,
  MemoryStatusSummary,
  UntrustedExternalSource,
} from '@/core/types';
import type { DataRepository } from '@/server/repositories/types';
import { PromptInjectionBoundary } from '@/core/models/prompt-boundary';
import {
  DeterministicHashedEmbeddingAdapter,
  OpenAIEmbeddingAdapter,
  cosineSimilarityVec,
  type MemoryEmbeddingProvider,
} from './embeddings';
import { WorkingMemoryBuffer } from './working-memory';
import {
  computeTemporalRetentionScore,
  rankHierarchicalMemories,
} from './decay-and-scoring';
import {
  distillConversationSession,
  inspectDuplicatesAndContradictions,
  sanitizeMemoryCandidate,
  type ConversationDistillationInput,
} from './consolidation';

export const HIERARCHICAL_SCOPE_DESCRIPTORS: MemoryScopeDescriptor[] = [
  {
    scope: 'working',
    implementedNow: true,
    backingStore: 'WorkingMemoryBuffer + conversation_messages (bounded token window)',
    notes: 'Secret-scrubbed, token-budgeted sliding turn buffer per conversation.',
  },
  {
    scope: 'episodic',
    implementedNow: true,
    backingStore: 'long_term_memories (memory_scope=episodic) + agent_tasks',
    notes: 'Non-CoT distilled session summaries with temporal Ebbinghaus decay.',
  },
  {
    scope: 'semantic',
    implementedNow: true,
    backingStore: 'long_term_memories (memory_scope=semantic + pgvector 1536 HNSW)',
    notes: 'Durable facts & preferences with deduplication and contradiction supersession.',
  },
  {
    scope: 'project',
    implementedNow: true,
    backingStore: 'projects + long_term_memories (memory_scope=project, project_id)',
    notes: 'Strictly isolated per project_id; foreign project memories never leak across workspaces.',
  },
  {
    scope: 'knowledge',
    implementedNow: true,
    backingStore: 'long_term_memories (memory_scope=knowledge + PromptInjectionBoundary)',
    notes: 'External document/reference chunks quarantined as untrusted passive data on recall.',
  },
  {
    scope: 'procedural',
    implementedNow: true,
    backingStore: 'long_term_memories (memory_scope=procedural)',
    notes: 'Reusable verified workflows, coding conventions, and operational playbooks (180d half-life).',
  },
  {
    scope: 'event',
    implementedNow: true,
    backingStore: 'long_term_memories (memory_scope=event, expires_at) + audit_logs',
    notes: 'Salient system/verification milestones with optional TTL expiration.',
  },
];

export interface StoreMemoryInput {
  category: MemoryCategory;
  memoryScope?: HierarchicalMemoryScope;
  projectId?: string | null;
  content: string;
  tags?: string[];
  importance?: 1 | 2 | 3 | 4 | 5;
  confidence?: number;
  provenance?: MemoryProvenance;
  sourceConversationId?: string;
  verified?: boolean;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
  precomputedEmbedding?: number[];
}

export interface SessionConsolidationReport {
  outcomes: ConsolidationOutcome[];
  createdEntries: MemoryEntry[];
  supersededIds: string[];
  deduplicatedCount: number;
  skippedNoiseCount: number;
  summary: string;
}

export interface HierarchicalMemoryEngineOptions {
  embeddingProvider?: MemoryEmbeddingProvider;
  fallbackEmbeddingProvider?: MemoryEmbeddingProvider;
  workingMemory?: WorkingMemoryBuffer;
  promptBoundary?: PromptInjectionBoundary;
}

export function inferScopeFromCategory(
  category: MemoryCategory,
  projectId?: string | null
): HierarchicalMemoryScope {
  if (projectId) return 'project';
  switch (category) {
    case 'project_context':
      return 'project';
    case 'episodic_summary':
      return 'episodic';
    case 'workflow':
      return 'procedural';
    case 'knowledge_chunk':
      return 'knowledge';
    case 'event_record':
      return 'event';
    case 'preference':
    case 'fact':
    default:
      return 'semantic';
  }
}

/**
 * JARVIS-X v0.5 — Advanced Hierarchical Memory Engine
 *
 * Unifies all 7 memory scopes (`working`, `episodic`, `semantic`, `project`, `knowledge`,
 * `procedural`, `event`) behind governed persistence, hybrid lexical + 1536-dim vector
 * retrieval, temporal retention decay, recall reinforcement, deduplication, contradiction
 * supersession, TTL expiration, and untrusted external knowledge quarantine.
 */
export class HierarchicalMemoryEngine {
  private readonly primaryEmbedder: MemoryEmbeddingProvider;
  private readonly fallbackEmbedder: MemoryEmbeddingProvider;
  private readonly workingMemory: WorkingMemoryBuffer;
  private readonly promptBoundary: PromptInjectionBoundary;

  constructor(options: HierarchicalMemoryEngineOptions = {}) {
    this.primaryEmbedder =
      options.embeddingProvider ?? new OpenAIEmbeddingAdapter();
    this.fallbackEmbedder =
      options.fallbackEmbeddingProvider ??
      new DeterministicHashedEmbeddingAdapter();
    this.workingMemory = options.workingMemory ?? new WorkingMemoryBuffer();
    this.promptBoundary = options.promptBoundary ?? new PromptInjectionBoundary();
  }

  getActiveEmbeddingProviderInfo(): {
    providerId: string;
    dimensions: number;
    isNeuralSemanticModel: boolean;
  } {
    const active = this.primaryEmbedder.isConfigured()
      ? this.primaryEmbedder
      : this.fallbackEmbedder;
    return {
      providerId: active.providerId,
      dimensions: active.dimensions,
      isNeuralSemanticModel: active.isNeuralSemanticModel,
    };
  }

  async computeEmbedding(text: string): Promise<number[]> {
    if (this.primaryEmbedder.isConfigured()) {
      try {
        return await this.primaryEmbedder.embed(text);
      } catch {
        return this.fallbackEmbedder.embed(text);
      }
    }
    return this.fallbackEmbedder.embed(text);
  }

  buildWorkingWindow(
    messages: ChatMessage[]
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.workingMemory.buildWindow(messages);
  }

  /**
   * Governed write path with secret scrubbing, noise rejection, deduplication,
   * contradiction supersession (`superseded_by_id`), and 1536-dim vector indexing.
   */
  async storeMemory(
    repo: DataRepository,
    userId: string,
    input: StoreMemoryInput
  ): Promise<ConsolidationOutcome> {
    const provenance: MemoryProvenance = input.provenance ?? 'user_explicit';
    const allowShort =
      provenance === 'user_explicit' || provenance === 'operator_manual';

    const sanitized = sanitizeMemoryCandidate(input.content, {
      allowShortExplicit: allowShort,
    });

    if (sanitized.rejectedAsNoise) {
      return {
        action: 'skipped_routine',
        supersededIds: [],
        reason: sanitized.rejectedReason ?? 'Skipped non-substantive input.',
      };
    }

    const scope =
      input.memoryScope ??
      inferScopeFromCategory(input.category, input.projectId);
    const projectId = input.projectId ?? null;
    const tags = Array.from(
      new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))
    );

    // Inspect active memories for duplicates or contradicting facts/preferences
    const activePool = await repo.listMemories(userId, {
      includeSuperseded: false,
      includeExpired: false,
    });

    const check = inspectDuplicatesAndContradictions(
      {
        content: sanitized.cleanContent,
        category: input.category,
        memoryScope: scope,
        projectId,
        tags,
      },
      activePool
    );

    if (check.duplicateOf) {
      const existing = check.duplicateOf;
      const reinforced = await repo.updateMemory(userId, existing.id, {
        recallCount: (existing.recallCount ?? 0) + 1,
        lastRecalledAt: new Date().toISOString(),
        importance: Math.max(
          existing.importance,
          input.importance ?? existing.importance
        ) as 1 | 2 | 3 | 4 | 5,
        tags: Array.from(new Set([...existing.tags, ...tags])),
      });
      return {
        action: 'deduplicated_reinforced',
        entry: reinforced ?? existing,
        supersededIds: [],
        reason: `Reinforced existing ${scope} memory (${existing.id}) instead of duplicating.`,
      };
    }

    const embedding =
      input.precomputedEmbedding ??
      (await this.computeEmbedding(sanitized.cleanContent));

    const created = await repo.addMemory(userId, {
      projectId,
      category: input.category,
      memoryScope: scope,
      memoryStatus: 'active',
      content: sanitized.cleanContent,
      tags,
      importance: input.importance ?? 4,
      confidence:
        input.confidence ??
        (provenance === 'untrusted_external' ? 0.65 : 0.92),
      recallCount: 0,
      provenance,
      supersededById: null,
      sourceConversationId: input.sourceConversationId,
      verified: input.verified ?? provenance !== 'untrusted_external',
      expiresAt: input.expiresAt ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        embeddingProvider: this.getActiveEmbeddingProviderInfo().providerId,
      },
      embedding,
    });

    const supersededIds: string[] = [];
    for (const stale of check.supersedesEntries) {
      if (stale.id === created.id) continue;
      const updated = await repo.updateMemory(userId, stale.id, {
        memoryStatus: 'superseded',
        supersededById: created.id,
      });
      if (updated) {
        supersededIds.push(stale.id);
      }
    }

    return {
      action:
        supersededIds.length > 0 ? 'superseded_previous' : 'inserted',
      entry: created,
      supersededIds,
      reason:
        supersededIds.length > 0
          ? `Stored updated ${scope} memory and superseded ${supersededIds.length} older contradicting record(s).`
          : `Stored active ${scope}/${input.category} memory.`,
    };
  }

  /**
   * Hybrid Scoped Retrieval:
   * Combines repository `pgvector` similarity search, active memory pool, local feature-hash
   * cosine backup, Ebbinghaus temporal retention, project scope isolation, strict token
   * budgeting, recall reinforcement, and `PromptInjectionBoundary` quarantine on untrusted
   * external knowledge chunks.
   */
  async retrieveContext(
    repo: DataRepository,
    userId: string,
    queryInput: HierarchicalMemoryQuery,
    conversationMessages: ChatMessage[] = []
  ): Promise<
    HierarchicalRetrievalBundle & {
      workingTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
      untrustedMemorySources: UntrustedExternalSource[];
      injectionWarnings: string[];
    }
  > {
    const workingTurns = this.buildWorkingWindow(conversationMessages);

    const [allCandidates, queryVector] = await Promise.all([
      repo.listMemories(userId, {
        includeSuperseded: queryInput.includeSuperseded ?? false,
        includeExpired: true, // Let ranker count `expiredFilteredOut` accurately
      }),
      queryInput.query.trim().length > 0
        ? this.computeEmbedding(queryInput.query)
        : Promise.resolve(null),
    ]);

    const vectorSimilarityById = new Map<string, number>();

    if (queryVector) {
      try {
        const rpcMatches = await repo.searchMemoriesByVector(
          userId,
          queryVector,
          0.1,
          Math.max(12, (queryInput.maxItems ?? 6) * 3)
        );
        for (const match of rpcMatches) {
          if (typeof match.similarity === 'number') {
            vectorSimilarityById.set(match.id, match.similarity);
          }
        }
      } catch {
        // Fallback smoothly to local deterministic vector scoring below
      }

      if (!this.getActiveEmbeddingProviderInfo().isNeuralSemanticModel) {
        await Promise.all(
          allCandidates.slice(0, 60).map(async (entry) => {
            if (vectorSimilarityById.has(entry.id)) return;
            const entryVec = await this.fallbackEmbedder.embed(entry.content);
            const sim = cosineSimilarityVec(queryVector, entryVec);
            if (sim > 0) {
              vectorSimilarityById.set(entry.id, sim);
            }
          })
        );
      }
    }

    const rankResult = rankHierarchicalMemories(allCandidates, {
      query: queryInput.query,
      projectId: queryInput.projectId,
      scopes: queryInput.scopes,
      taskType: queryInput.taskType,
      maxItems: queryInput.maxItems ?? 6,
      maxTokenBudget: queryInput.maxTokenBudget ?? 1_200,
      includeSuperseded: queryInput.includeSuperseded ?? false,
      vectorSimilarityById,
      nowMs: queryInput.nowMs,
    });

    // Reinforce recalled memories when requested (default true)
    if (queryInput.reinforceRecalled !== false && rankResult.ranked.length > 0) {
      const nowIso = new Date(queryInput.nowMs ?? Date.now()).toISOString();
      await Promise.all(
        rankResult.ranked.slice(0, 5).map(async (item) => {
          try {
            await repo.updateMemory(userId, item.id, {
              recallCount: (item.recallCount ?? 0) + 1,
              lastRecalledAt: nowIso,
            });
          } catch {
            // Non-fatal telemetry update
          }
        })
      );
    }

    const countsByScope: Partial<Record<HierarchicalMemoryScope, number>> = {};
    const formattedSnippets: string[] = [];
    const untrustedMemorySources: UntrustedExternalSource[] = [];

    for (const item of rankResult.ranked) {
      const scope = item.memoryScope ?? 'semantic';
      countsByScope[scope] = (countsByScope[scope] ?? 0) + 1;

      const isUntrusted = item.provenance === 'untrusted_external';
      if (isUntrusted) {
        untrustedMemorySources.push({
          sourceType: 'retrieved_document',
          label: `memory:${scope}:${item.id.slice(0, 8)}`,
          rawContent: item.content,
        });
      } else {
        formattedSnippets.push(
          `[${scope}/${item.category} | imp=${item.importance} | ret=${(item.retentionScore ?? 1).toFixed(2)}] ${item.content}`
        );
      }
    }

    let injectionWarnings: string[] = [];
    if (untrustedMemorySources.length > 0) {
      const evalResult = this.promptBoundary.evaluate(
        '',
        '',
        untrustedMemorySources
      );
      injectionWarnings = evalResult.detectedPatterns;
      if (evalResult.sanitizedUntrustedBlock) {
        formattedSnippets.push(
          `[QUARANTINED_UNTRUSTED_KNOWLEDGE — PASSIVE DATA ONLY]:\n${evalResult.sanitizedUntrustedBlock}`
        );
      }
    }

    return {
      entries: rankResult.ranked,
      formattedSnippets,
      totalTokensEstimated: rankResult.totalTokensEstimated,
      countsByScope,
      untrustedItemsQuarantined: untrustedMemorySources.length,
      expiredFilteredOut: rankResult.expiredFilteredOut,
      supersededFilteredOut: rankResult.supersededFilteredOut,
      workingTurns,
      untrustedMemorySources,
      injectionWarnings,
    };
  }

  /**
   * Distills a multi-turn conversation session into episodic & semantic memory records,
   * deduplicating existing entries, superseding contradicted facts, and skipping noise.
   */
  async consolidateSession(
    repo: DataRepository,
    userId: string,
    conversation: ConversationDistillationInput,
    projectId?: string | null
  ): Promise<SessionConsolidationReport> {
    const { candidates, skippedNoiseCount } =
      distillConversationSession(conversation);

    const outcomes: ConsolidationOutcome[] = [];
    const createdEntries: MemoryEntry[] = [];
    const supersededIds: string[] = [];
    let deduplicatedCount = 0;
    let totalSkipped = skippedNoiseCount;

    for (const candidate of candidates) {
      const outcome = await this.storeMemory(repo, userId, {
        category: candidate.category,
        memoryScope: candidate.memoryScope,
        projectId: projectId ?? null,
        content: candidate.content,
        tags: candidate.tags,
        importance: candidate.importance,
        confidence: candidate.confidence,
        provenance: 'episodic_consolidation',
        sourceConversationId: conversation.conversationId,
        verified: true,
      });

      outcomes.push(outcome);
      if (outcome.action === 'skipped_routine') {
        totalSkipped += 1;
      } else if (outcome.action === 'deduplicated_reinforced') {
        deduplicatedCount += 1;
      } else if (outcome.entry) {
        createdEntries.push(outcome.entry);
        supersededIds.push(...outcome.supersededIds);
      }
    }

    return {
      outcomes,
      createdEntries,
      supersededIds,
      deduplicatedCount,
      skippedNoiseCount: totalSkipped,
      summary:
        createdEntries.length > 0
          ? `Consolidated ${createdEntries.length} memory entry(ies) (${supersededIds.length} superseded, ${deduplicatedCount} reinforced).`
          : deduplicatedCount > 0
            ? `Reinforced ${deduplicatedCount} existing memory entry(ies); no new entries needed.`
            : 'No durable facts or episodic milestones required consolidation.',
    };
  }

  /**
   * Builds rich diagnostic status across all 7 hierarchical scopes, active vs superseded
   * vs expired counts, vector readiness, and embedding adapter truthfulness.
   */
  async buildStatusSummary(
    repo: DataRepository,
    userId: string,
    workingTurnCount = 0
  ): Promise<MemoryStatusSummary> {
    const allEntries = await repo.listMemories(userId, {
      includeSuperseded: true,
      includeExpired: true,
    });

    const nowMs = Date.now();
    const countsByScope: Record<HierarchicalMemoryScope, number> = {
      working: workingTurnCount,
      episodic: 0,
      semantic: 0,
      project: 0,
      knowledge: 0,
      procedural: 0,
      event: 0,
    };

    let activeCount = 0;
    let supersededCount = 0;
    let expiredCount = 0;

    for (const item of allEntries) {
      const status = item.memoryStatus ?? 'active';
      const retention = computeTemporalRetentionScore(item, nowMs);
      if (status === 'superseded') {
        supersededCount += 1;
        continue;
      }
      if (retention <= 0) {
        expiredCount += 1;
        continue;
      }
      if (status !== 'active') {
        continue;
      }

      activeCount += 1;
      const scope =
        item.memoryScope ?? inferScopeFromCategory(item.category, item.projectId);
      countsByScope[scope] = (countsByScope[scope] ?? 0) + 1;
    }

    const embedInfo = this.getActiveEmbeddingProviderInfo();
    const mode = repo.mode;
    const embedBadge = embedInfo.isNeuralSemanticModel
      ? 'OpenAI Neural 1536'
      : 'Deterministic Hash 1536';

    const statusLabel =
      mode === 'supabase_cloud'
        ? `Supabase Cloud Active (${activeCount} active · ${supersededCount} superseded · ${embedBadge} · 7 scopes)`
        : mode === 'degraded_fallback'
          ? `Degraded Fallback Active (${activeCount} active · ${supersededCount} superseded · ${embedBadge})`
          : `Guest Ephemeral Store (${activeCount} active · ${supersededCount} superseded · 7 scopes)`;

    return {
      shortTermTurnCount: workingTurnCount,
      storedEntriesCount: activeCount,
      activeEntriesCount: activeCount,
      supersededEntriesCount: supersededCount,
      expiredEntriesCount: expiredCount,
      countsByScope,
      persistenceMode: mode,
      semanticVectorReady: true,
      embeddingMode: embedInfo.isNeuralSemanticModel
        ? 'openai_neural_1536'
        : 'deterministic_hash_1536',
      isNeuralEmbeddingActive: embedInfo.isNeuralSemanticModel,
      statusLabel,
    };
  }
}
