import type { ChatMessage } from '@/core/types';

export type ClassifiedIntent =
  | 'greeting'
  | 'diagnostics'
  | 'memory_read'
  | 'memory_write'
  | 'memory_clear'
  | 'research'
  | 'coding'
  | 'design'
  | 'automation'
  | 'sensitive_action'
  | 'vision_inquiry'
  | 'voice_inquiry'
  | 'general_assistance';

export interface ParsedTurnContext {
  conversationId: string;
  normalizedMessage: string;
  intent: ClassifiedIntent;
  extractedMemoryFact?: string;
  recentTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Conversation Engine
 * Manages dialogue continuity, turn normalization, and deterministic intent classification
 * prior to planning, routing, and permission evaluation.
 */
export class ConversationEngine {
  classifyIntent(message: string, hasVisionAttachment = false): ClassifiedIntent {
    const text = message.trim();

    if (hasVisionAttachment || /\b(camera|photo|image|vision|look at this|screenshot)\b/i.test(text)) {
      return 'vision_inquiry';
    }
    if (/\b(voice|microphone|speak aloud|tts|stt|barge[- ]?in)\b/i.test(text)) {
      return 'voice_inquiry';
    }
    if (
      /\b(unlock|lock door|disarm|delete all|wipe|execute shell|run bash|transfer funds|smart[- ]?home|thermostat|lights on|lights off|browser control)\b/i.test(
        text
      )
    ) {
      return 'sensitive_action';
    }
    if (/\b(clear memories|wipe memory|delete memory)\b/i.test(text)) {
      return 'memory_clear';
    }
    if (/\b(remember that|save to memory|store in memory|note that my|remember my)\b/i.test(text)) {
      return 'memory_write';
    }
    if (/\b(what do you remember|list memories|memory status|recall)\b/i.test(text)) {
      return 'memory_read';
    }
    if (/\b(status|diagnostics|architecture|modules|capabilities|what works|connected)\b/i.test(text)) {
      return 'diagnostics';
    }
    if (/\b(research|investigate|compare sources|find papers|web search)\b/i.test(text)) {
      return 'research';
    }
    if (/\b(code|typescript|python|refactor|implement|api route|sql|bug)\b/i.test(text)) {
      return 'coding';
    }
    if (/\b(design|ui|ux|wireframe|color palette|layout|typography)\b/i.test(text)) {
      return 'design';
    }
    if (/\b(automate|workflow|schedule task|cron|webhook)\b/i.test(text)) {
      return 'automation';
    }
    if (/^(hi|hello|hey|good morning|good evening|greetings|jarvis)\b/i.test(text) && text.length < 48) {
      return 'greeting';
    }
    return 'general_assistance';
  }

  extractMemoryCandidate(message: string): string | undefined {
    const match = message.match(
      /(?:remember that|save to memory:?|store in memory:?|note that|remember)\s+(.+)/i
    );
    return match?.[1]?.trim();
  }

  prepareTurn(
    conversationId: string,
    rawMessage: string,
    history: ChatMessage[],
    hasVisionAttachment = false
  ): ParsedTurnContext {
    const normalizedMessage = rawMessage.trim();
    const intent = this.classifyIntent(normalizedMessage, hasVisionAttachment);
    const extractedMemoryFact =
      intent === 'memory_write' ? this.extractMemoryCandidate(normalizedMessage) : undefined;

    const recentTurns = history
      .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } =>
        m.role === 'user' || m.role === 'assistant'
      )
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    return {
      conversationId,
      normalizedMessage,
      intent,
      extractedMemoryFact,
      recentTurns,
    };
  }
}
