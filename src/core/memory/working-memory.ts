import type { ChatMessage } from '@/core/types';
import { redactSecrets } from '@/core/models/provider-config';

export interface WorkingMemoryOptions {
  maxTurns?: number;
  maxTokenBudget?: number;
}

/**
 * Working Memory Scope (`working`)
 * Maintains a bounded, secret-scrubbed, token-capped sliding turn window for active
 * conversations without polluting durable long-term storage.
 */
export class WorkingMemoryBuffer {
  private readonly maxTurns: number;
  private readonly maxTokenBudget: number;

  constructor(options: WorkingMemoryOptions = {}) {
    this.maxTurns = Math.max(2, options.maxTurns ?? 12);
    this.maxTokenBudget = Math.max(128, options.maxTokenBudget ?? 2_400);
  }

  buildWindow(
    messages: ChatMessage[]
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const eligible = messages.filter(
      (m): m is ChatMessage & { role: 'user' | 'assistant' } =>
        (m.role === 'user' || m.role === 'assistant') && Boolean(m.content?.trim())
    );

    // Deduplicate accidental consecutive identical turns
    const deduped: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const msg of eligible) {
      const safeContent = redactSecrets(msg.content.trim());
      const prev = deduped[deduped.length - 1];
      if (prev && prev.role === msg.role && prev.content === safeContent) {
        continue;
      }
      deduped.push({ role: msg.role, content: safeContent });
    }

    // Pack from newest backward within both turn limit and token budget
    const selectedReversed: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let tokensUsed = 0;

    for (
      let i = deduped.length - 1;
      i >= 0 && selectedReversed.length < this.maxTurns;
      i -= 1
    ) {
      const turn = deduped[i];
      const estTokens = Math.max(1, Math.ceil(turn.content.length / 4));
      if (selectedReversed.length > 0 && tokensUsed + estTokens > this.maxTokenBudget) {
        break;
      }
      selectedReversed.push(turn);
      tokensUsed += estTokens;
    }

    return selectedReversed.reverse();
  }
}
