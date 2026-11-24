import type {
  HierarchicalMemoryScope,
  MemoryEntry,
} from '@/core/types';

const BASE_HALF_LIFE_DAYS: Record<HierarchicalMemoryScope, number> = {
  procedural: 180,
  semantic: 120,
  project: 90,
  knowledge: 90,
  episodic: 30,
  event: 14,
  working: 1,
};

const MS_PER_DAY = 86_400_000;

export function tokenizeMemoryQuery(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Computes Ebbinghaus-inspired temporal retention (`0..1`) combining:
 * - Scope-calibrated base half-life (procedural/semantic decay slowly; episodic/event decay faster)
 * - Importance scaling (`1..5` stretches half-life from `0.8x` to `1.6x`)
 * - Recall reinforcement (`recallCount` + recent `lastRecalledAt` strengthen retention)
 * - Strict TTL expiration (`expiresAt <= nowMs` returns `0`)
 */
export function computeTemporalRetentionScore(
  entry: MemoryEntry,
  nowMs = Date.now()
): number {
  if (entry.expiresAt) {
    const expMs = Date.parse(entry.expiresAt);
    if (!Number.isNaN(expMs) && expMs <= nowMs) {
      return 0;
    }
  }

  const scope: HierarchicalMemoryScope = entry.memoryScope ?? 'semantic';
  const baseHalfLife = BASE_HALF_LIFE_DAYS[scope] ?? 90;
  const importanceMultiplier = 0.6 + Math.min(5, Math.max(1, entry.importance)) * 0.2;
  const effectiveHalfLifeDays = baseHalfLife * importanceMultiplier;

  // Measure age from most recent recall if recalled, else creation time
  const anchorIso = entry.lastRecalledAt || entry.createdAt;
  const anchorMs = Date.parse(anchorIso);
  const ageDays = Number.isNaN(anchorMs)
    ? 0
    : Math.max(0, (nowMs - anchorMs) / MS_PER_DAY);

  const rawDecay = Math.pow(0.5, ageDays / effectiveHalfLifeDays);
  const recallBoost = Math.min(0.25, Math.log1p(entry.recallCount ?? 0) * 0.07);

  return Number(Math.min(1, Math.max(0.05, rawDecay + recallBoost)).toFixed(4));
}

function computeScopeTaskAffinity(
  scope: HierarchicalMemoryScope,
  taskType?: string
): number {
  if (!taskType) return 0;
  switch (taskType) {
    case 'coding':
      if (scope === 'procedural' || scope === 'project') return 0.16;
      if (scope === 'semantic') return 0.08;
      return 0;
    case 'planning':
      if (scope === 'project' || scope === 'episodic') return 0.16;
      if (scope === 'procedural') return 0.1;
      return 0;
    case 'research':
    case 'knowledge_retrieval':
    case 'file_task':
      if (scope === 'knowledge' || scope === 'project') return 0.18;
      if (scope === 'semantic') return 0.08;
      return 0;
    case 'automation':
      if (scope === 'procedural' || scope === 'event') return 0.16;
      return 0;
    default:
      if (scope === 'semantic') return 0.1;
      if (scope === 'episodic') return 0.05;
      return 0;
  }
}

export interface RankMemoriesInput {
  query: string;
  projectId?: string | null;
  scopes?: HierarchicalMemoryScope[];
  taskType?: string;
  maxItems?: number;
  maxTokenBudget?: number;
  includeSuperseded?: boolean;
  vectorSimilarityById?: Map<string, number>;
  nowMs?: number;
}

export interface RankMemoriesOutput {
  ranked: MemoryEntry[];
  totalTokensEstimated: number;
  expiredFilteredOut: number;
  supersededFilteredOut: number;
}

/**
 * Ranks hierarchical memory candidates using hybrid lexical + vector similarity +
 * scope/task affinity + project isolation + importance + confidence + temporal retention,
 * packing winners strictly within `maxItems` and `maxTokenBudget`.
 */
export function rankHierarchicalMemories(
  entries: MemoryEntry[],
  input: RankMemoriesInput
): RankMemoriesOutput {
  const nowMs = input.nowMs ?? Date.now();
  const maxItems = Math.max(1, input.maxItems ?? 6);
  const maxTokenBudget = Math.max(16, input.maxTokenBudget ?? 1_200);
  const queryTokens = tokenizeMemoryQuery(input.query);
  const lowerQuery = input.query.trim().toLowerCase();

  let expiredFilteredOut = 0;
  let supersededFilteredOut = 0;
  const scored: Array<{ entry: MemoryEntry; score: number }> = [];

  for (const entry of entries) {
    const status = entry.memoryStatus ?? 'active';
    if (!input.includeSuperseded && status !== 'active') {
      supersededFilteredOut += 1;
      continue;
    }

    const retentionScore = computeTemporalRetentionScore(entry, nowMs);
    if (retentionScore <= 0) {
      expiredFilteredOut += 1;
      continue;
    }

    const scope: HierarchicalMemoryScope = entry.memoryScope ?? 'semantic';
    if (input.scopes && input.scopes.length > 0 && !input.scopes.includes(scope)) {
      continue;
    }

    // Strict Project Scope Isolation:
    // Any memory bound to a specific non-null `projectId` is ONLY eligible when
    // `input.projectId` matches that exact projectId.
    if (entry.projectId) {
      if (!input.projectId || entry.projectId !== input.projectId) {
        continue;
      }
    }

    // 1. Lexical token & tag overlap (0..1)
    let lexicalScore = 0;
    if (queryTokens.length > 0) {
      const hay = `${entry.content} ${entry.tags.join(' ')} ${entry.category} ${scope}`.toLowerCase();
      let hits = 0;
      for (const tok of queryTokens) {
        if (hay.includes(tok)) hits += 1;
      }
      lexicalScore = hits / queryTokens.length;
      if (lowerQuery.length >= 6 && entry.content.toLowerCase().includes(lowerQuery)) {
        lexicalScore = Math.min(1, lexicalScore + 0.25);
      }
    } else {
      lexicalScore = 0.25;
    }

    // 2. Vector similarity (0..1)
    const vecSim =
      input.vectorSimilarityById?.get(entry.id) ??
      (typeof entry.similarity === 'number' ? Math.max(0, entry.similarity) : 0);

    // Relevance blend: take strong signal from either lexical or semantic vector match
    const relevanceCore = Math.max(
      lexicalScore,
      vecSim,
      lexicalScore * 0.55 + vecSim * 0.45
    );

    // 3. Scope, project, importance, confidence, and retention signals
    const scopeBoost = computeScopeTaskAffinity(scope, input.taskType);
    const projectMatchBoost =
      input.projectId && entry.projectId === input.projectId ? 0.18 : 0;
    const importanceScore = (Math.min(5, Math.max(1, entry.importance)) / 5) * 0.16;
    const confidenceScore = Math.min(1, Math.max(0, entry.confidence ?? 0.9)) * 0.08;
    const retentionWeighted = retentionScore * 0.18;

    const composite = Number(
      (
        relevanceCore * 0.55 +
        scopeBoost +
        projectMatchBoost +
        importanceScore +
        confidenceScore +
        retentionWeighted
      ).toFixed(4)
    );

    scored.push({
      entry: {
        ...entry,
        memoryScope: scope,
        memoryStatus: status,
        similarity: vecSim > 0 ? Number(vecSim.toFixed(4)) : entry.similarity,
        retentionScore,
        compositeScore: composite,
      },
      score: composite,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // Filter out pure zero-relevance noise when query had tokens, while keeping top fallback context if needed
  const relevantPool =
    queryTokens.length > 0
      ? scored.filter((s) => s.score >= 0.28)
      : scored;
  const candidatePool = relevantPool.length > 0 ? relevantPool : scored.slice(0, 2);

  // Enforce strict context token budget & maxItems
  const ranked: MemoryEntry[] = [];
  let totalTokensEstimated = 0;

  for (const item of candidatePool) {
    if (ranked.length >= maxItems) break;
    const itemTokens = Math.max(4, Math.ceil(item.entry.content.length / 4));
    if (ranked.length > 0 && totalTokensEstimated + itemTokens > maxTokenBudget) {
      continue;
    }
    if (ranked.length === 0 && itemTokens > maxTokenBudget) {
      // Truncate single oversized item safely rather than exceeding hard token budget
      const maxChars = maxTokenBudget * 4;
      ranked.push({
        ...item.entry,
        content: `${item.entry.content.slice(0, Math.max(32, maxChars - 3))}...`,
      });
      totalTokensEstimated += maxTokenBudget;
      break;
    }
    ranked.push(item.entry);
    totalTokensEstimated += itemTokens;
  }

  return {
    ranked,
    totalTokensEstimated,
    expiredFilteredOut,
    supersededFilteredOut,
  };
}
