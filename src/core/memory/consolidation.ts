import type {
  ChatMessage,
  HierarchicalMemoryScope,
  MemoryCategory,
  MemoryEntry,
} from '@/core/types';
import { redactSecrets } from '@/core/models/provider-config';
import { tokenizeMemoryQuery } from './decay-and-scoring';

const PRIVATE_COT_REGEX =
  /<(think|thinking|reasoning|scratchpad)>[\s\S]*?<\/\1>|\[chain[-_\s]?of[-_\s]?thought\][\s\S]*?(\n\n|$)/gi;

const TRIVIAL_NOISE_PATTERNS = [
  /^(hi|hello|hey|yo|sup|ok|okay|k|thanks|thank you|thx|got it|cool|nice|sure|yes|no|yep|nope|test|testing)[.!?\s]*$/i,
];

export interface SanitizedMemoryCandidate {
  cleanContent: string;
  rejectedAsNoise: boolean;
  rejectedReason?: string;
  secretsRedacted: boolean;
}

/**
 * Strips private chain-of-thought tags, scrubs secrets/API keys, and rejects
 * trivial conversational acknowledgments or pure-credential strings from polluting memory.
 */
export function sanitizeMemoryCandidate(
  rawContent: string,
  options: { allowShortExplicit?: boolean } = {}
): SanitizedMemoryCandidate {
  const withoutCot = rawContent
    .replace(PRIVATE_COT_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const redacted = redactSecrets(withoutCot).trim();
  const secretsRedacted = redacted !== withoutCot;

  // Reject if content was purely a raw credential/secret after redaction
  const strippedPlaceholders = redacted.replace(/\[REDACTED_[A-Z_]+\]/g, '').trim();
  if (secretsRedacted && strippedPlaceholders.length < 10) {
    return {
      cleanContent: redacted,
      rejectedAsNoise: true,
      rejectedReason: 'Candidate consisted primarily of sensitive credentials/secrets.',
      secretsRedacted: true,
    };
  }

  const minLen = options.allowShortExplicit ? 5 : 12;
  if (redacted.length < minLen) {
    return {
      cleanContent: redacted,
      rejectedAsNoise: true,
      rejectedReason: 'Candidate is below minimum substantive memory length.',
      secretsRedacted,
    };
  }

  for (const pat of TRIVIAL_NOISE_PATTERNS) {
    if (pat.test(redacted)) {
      return {
        cleanContent: redacted,
        rejectedAsNoise: true,
        rejectedReason:
          'Routine conversational acknowledgment excluded from durable memory.',
        secretsRedacted,
      };
    }
  }

  return {
    cleanContent: redacted,
    rejectedAsNoise: false,
    secretsRedacted,
  };
}

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  setA.forEach((tok) => {
    if (setB.has(tok)) intersection += 1;
  });
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extracts canonical subject-attribute keys from structured preference/fact statements
 * so updated facts supersede contradicting older facts rather than coexisting ambiguously.
 */
export function extractSubjectValuePair(
  content: string
): { subjectKey: string; valueNorm: string } | null {
  const cleaned = content.trim().replace(/[.!]+$/, '');

  // Pattern 1: "<Subject> is / := / : <Value>"
  const kvMatch = cleaned.match(
    /^(?:my\s+|user(?:'s)?\s+|our\s+|the\s+|preferred\s+|default\s+|current\s+|primary\s+)?([a-zA-Z0-9_\-\s]{3,45}?)\s*(?::|=|\bis\s+(?:now\s+)?|\bchanged\s+to\s+|\bswitched\s+to\s+)\s*([a-zA-Z0-9_\-./\s]{1,60})$/i
  );
  if (kvMatch) {
    const rawSubject = kvMatch[1]
      .toLowerCase()
      .replace(/\b(preferred|default|current|active|primary|my|our|user|the)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const rawVal = kvMatch[2].toLowerCase().replace(/\s+/g, ' ').trim();
    if (rawSubject.length >= 3 && rawVal.length >= 1) {
      return { subjectKey: rawSubject, valueNorm: rawVal };
    }
  }

  // Pattern 2: "User prefers / Always use <X> for <Y>"
  const prefForMatch = cleaned.match(
    /^(?:user\s+prefers|i\s+prefer|always\s+use|we\s+use)\s+([a-zA-Z0-9_\-./\s]{2,40}?)\s+(?:for|as|in)\s+([a-zA-Z0-9_\-\s]{3,40})$/i
  );
  if (prefForMatch) {
    const val = prefForMatch[1].toLowerCase().replace(/\s+/g, ' ').trim();
    const subject = prefForMatch[2]
      .toLowerCase()
      .replace(/\b(my|our|the|all)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (subject.length >= 3 && val.length >= 1) {
      return { subjectKey: subject, valueNorm: val };
    }
  }

  return null;
}

export interface DeduplicationAndSupersessionCheck {
  duplicateOf: MemoryEntry | null;
  supersedesEntries: MemoryEntry[];
}

/**
 * Inspects active memories within the same scope & project boundary to detect:
 * 1. Exact or near-identical duplicates (`duplicateOf`) so we reinforce instead of duplicating.
 * 2. Contradicting older facts/preferences (`supersedesEntries`) that share a `topic:<key>` tag
 *    or canonical subject-attribute key with a changed value.
 */
export function inspectDuplicatesAndContradictions(
  candidate: {
    content: string;
    category: MemoryCategory;
    memoryScope: HierarchicalMemoryScope;
    projectId?: string | null;
    tags: string[];
  },
  existingActive: MemoryEntry[]
): DeduplicationAndSupersessionCheck {
  const normCandidate = normalizeForDedup(candidate.content);
  const candidateTokens = tokenizeMemoryQuery(candidate.content);
  const candidatePair = extractSubjectValuePair(candidate.content);
  const candidateTopicTags = candidate.tags
    .filter((t) => t.toLowerCase().startsWith('topic:'))
    .map((t) => t.toLowerCase());

  const supersedesEntries: MemoryEntry[] = [];

  for (const existing of existingActive) {
    if ((existing.memoryStatus ?? 'active') !== 'active') continue;
    const existingScope = existing.memoryScope ?? 'semantic';
    const existingProj = existing.projectId ?? null;
    const candidateProj = candidate.projectId ?? null;

    if (existingProj !== candidateProj) continue;

    // 1. Exact or near-exact duplicate check within same scope
    if (existingScope === candidate.memoryScope) {
      const normExisting = normalizeForDedup(existing.content);
      if (normExisting === normCandidate) {
        return { duplicateOf: existing, supersedesEntries: [] };
      }
      const jaccard = jaccardSimilarity(
        candidateTokens,
        tokenizeMemoryQuery(existing.content)
      );
      if (jaccard >= 0.88) {
        return { duplicateOf: existing, supersedesEntries: [] };
      }
    }

    // 2. Explicit topic-tag supersession (`topic:package-manager`, `topic:deploy-region`)
    if (
      existingScope === candidate.memoryScope &&
      candidateTopicTags.length > 0 &&
      existing.tags.some((t) => candidateTopicTags.includes(t.toLowerCase()))
    ) {
      supersedesEntries.push(existing);
      continue;
    }

    // 3. Structured subject-value contradiction supersession in durable fact/preference/project scopes
    if (
      candidatePair &&
      (candidate.memoryScope === 'semantic' ||
        candidate.memoryScope === 'project' ||
        candidate.memoryScope === 'procedural') &&
      existingScope === candidate.memoryScope
    ) {
      const existingPair = extractSubjectValuePair(existing.content);
      if (
        existingPair &&
        existingPair.subjectKey === candidatePair.subjectKey &&
        existingPair.valueNorm !== candidatePair.valueNorm
      ) {
        supersedesEntries.push(existing);
      }
    }
  }

  return {
    duplicateOf: null,
    supersedesEntries,
  };
}

export interface DistilledSessionCandidate {
  category: MemoryCategory;
  memoryScope: HierarchicalMemoryScope;
  content: string;
  tags: string[];
  importance: 1 | 2 | 3 | 4 | 5;
  confidence: number;
}

export interface ConversationDistillationInput {
  conversationId: string;
  title?: string;
  messages: ChatMessage[];
}

/**
 * Distills a multi-turn conversation into compact, non-CoT episodic & semantic
 * candidates while filtering out routine chat noise and redacting secrets.
 */
export function distillConversationSession(
  conversation: ConversationDistillationInput
): {
  candidates: DistilledSessionCandidate[];
  skippedNoiseCount: number;
} {
  let skippedNoiseCount = 0;
  const substantiveUserGoals: string[] = [];
  const verifiedAssistantOutcomes: string[] = [];
  const extractedExplicitFacts: DistilledSessionCandidate[] = [];

  for (const msg of conversation.messages) {
    if (msg.role === 'user') {
      const sanitized = sanitizeMemoryCandidate(msg.content);
      if (sanitized.rejectedAsNoise) {
        skippedNoiseCount += 1;
        continue;
      }
      substantiveUserGoals.push(sanitized.cleanContent);

      // Detect high-confidence durable preference/fact statements spoken by user
      const pair = extractSubjectValuePair(sanitized.cleanContent);
      if (
        pair &&
        /\b(prefer|preferred|default|always use|switched to|changed to|primary)\b/i.test(
          sanitized.cleanContent
        )
      ) {
        const isWorkflow = /\b(workflow|pipeline|always run|step)\b/i.test(
          sanitized.cleanContent
        );
        extractedExplicitFacts.push({
          category: isWorkflow
            ? 'workflow'
            : /\b(prefer|preferred)\b/i.test(sanitized.cleanContent)
              ? 'preference'
              : 'fact',
          memoryScope: isWorkflow ? 'procedural' : 'semantic',
          content: sanitized.cleanContent.slice(0, 280),
          tags: [
            'consolidated',
            `topic:${pair.subjectKey.replace(/\s+/g, '-').slice(0, 32)}`,
          ],
          importance: 4,
          confidence: 0.88,
        });
      }
    } else if (msg.role === 'assistant') {
      const sanitized = sanitizeMemoryCandidate(msg.content);
      if (!sanitized.rejectedAsNoise) {
        const firstSentence =
          sanitized.cleanContent.split(/(?<=[.!?])\s+/)[0] ?? '';
        if (firstSentence.length >= 16) {
          const ver = msg.verification?.outcome ?? 'verified';
          verifiedAssistantOutcomes.push(
            `${firstSentence.slice(0, 140)} (${ver})`
          );
        }
      }
    }
  }

  const candidates: DistilledSessionCandidate[] = [...extractedExplicitFacts];

  // Produce a compact Episodic Summary only when substantive exchange occurred
  if (substantiveUserGoals.length >= 1 && conversation.messages.length >= 2) {
    const title = redactSecrets(conversation.title || 'Session').slice(0, 60);
    const goalsSummary = substantiveUserGoals
      .slice(-3)
      .map((g) => g.slice(0, 110))
      .join(' -> ');
    const outcomeSummary =
      verifiedAssistantOutcomes.slice(-2).join('; ') || 'Session progressed';

    const episodicText =
      `[Episode: ${title}] Objectives: ${goalsSummary} | Outcomes: ${outcomeSummary}`.slice(
        0,
        460
      );

    const keywordTags = Array.from(
      new Set(tokenizeMemoryQuery(goalsSummary).slice(0, 4))
    );

    candidates.push({
      category: 'episodic_summary',
      memoryScope: 'episodic',
      content: episodicText,
      tags: ['episodic', 'session-distillation', ...keywordTags],
      importance: substantiveUserGoals.length >= 2 ? 4 : 3,
      confidence: 0.86,
    });
  }

  return {
    candidates,
    skippedNoiseCount,
  };
}
