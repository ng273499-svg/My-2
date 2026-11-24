import type {
  ContextSignals,
  PersonalityPreferences,
  ResponseStyle,
} from '@/core/types';
import type { ClassifiedIntent } from '@/core/modules/conversation-engine';

/**
 * Context & Emotion Engine
 * Infers situational signals (urgency, complexity, conversational cues) and selects an
 * appropriate response delivery style.
 *
 * Explicit boundary: Styles govern tone and vocal cadence only — JARVIS-X never claims
 * biological emotion or sentient subjective experience.
 */
export class ContextEmotionEngine {
  analyze(
    message: string,
    intent: ClassifiedIntent,
    preferences: PersonalityPreferences
  ): ContextSignals {
    const lower = message.toLowerCase();

    let detectedUrgency: ContextSignals['detectedUrgency'] = 'low';
    if (/\b(urgent|immediately|emergency|critical|asap|right now|alert)\b/.test(lower)) {
      detectedUrgency = 'high';
    } else if (/\b(soon|quick|priority|important|fast)\b/.test(lower)) {
      detectedUrgency = 'medium';
    }

    let userSentimentCue: ContextSignals['userSentimentCue'] = 'neutral';
    if (/\b(broken|stuck|frustrated|error|worried|issue|problem|help)\b/.test(lower)) {
      userSentimentCue = 'stressed';
    } else if (/\b(awesome|great|excited|amazing|love|brilliant)\b/.test(lower)) {
      userSentimentCue = 'positive';
    } else if (/\b(joke|witty|funny|humorous|banter)\b/.test(lower)) {
      userSentimentCue = 'playful';
    } else if (/\b(how|why|wonder|explore|what if|curious|explain)\b/.test(lower)) {
      userSentimentCue = 'curious';
    } else if (intent === 'sensitive_action') {
      userSentimentCue = 'cautious';
    }

    let domainComplexity: ContextSignals['domainComplexity'] = 'conversational';
    if (intent === 'sensitive_action') {
      domainComplexity = 'security_sensitive';
    } else if (intent === 'coding' || intent === 'diagnostics') {
      domainComplexity = 'technical';
    } else if (intent === 'automation' || intent === 'memory_write' || intent === 'memory_clear') {
      domainComplexity = 'operational';
    }

    const { style, rationale } = this.selectStyle(
      detectedUrgency,
      userSentimentCue,
      domainComplexity,
      preferences
    );

    return {
      detectedUrgency,
      userSentimentCue,
      domainComplexity,
      recommendedStyle: style,
      styleRationale: rationale,
      timestampIso: new Date().toISOString(),
    };
  }

  private selectStyle(
    urgency: ContextSignals['detectedUrgency'],
    cue: ContextSignals['userSentimentCue'],
    complexity: ContextSignals['domainComplexity'],
    preferences: PersonalityPreferences
  ): { style: ResponseStyle; rationale: string } {
    if (urgency === 'high') {
      return {
        style: 'urgency',
        rationale: 'High-priority cue detected — prioritizing crisp, direct operational clarity.',
      };
    }
    if (complexity === 'security_sensitive') {
      return {
        style: 'seriousness',
        rationale: 'Security-gated request — adopting measured, unambiguous verification tone.',
      };
    }
    if (cue === 'stressed') {
      return {
        style: 'concern',
        rationale: 'Troubleshooting cue detected — adopting steady, supportive diagnostic framing.',
      };
    }
    if (cue === 'playful' && preferences.witLevel !== 'minimal') {
      return {
        style: 'humor',
        rationale: 'Lighthearted cue detected — enabling dry, understated wit within professional bounds.',
      };
    }
    if (cue === 'positive') {
      return {
        style: 'excitement',
        rationale: 'Positive momentum detected — matching energy with composed enthusiasm.',
      };
    }
    if (cue === 'curious') {
      return {
        style: 'curiosity',
        rationale: 'Exploratory question detected — framing response for analytical discovery.',
      };
    }
    if (complexity === 'technical') {
      return {
        style: 'confidence',
        rationale: 'Technical engineering query — delivering structured architectural precision.',
      };
    }
    return {
      style: preferences.preferredResponseStyle || 'calm',
      rationale: `Using calibrated baseline delivery style (${preferences.preferredResponseStyle || 'calm'}).`,
    };
  }
}
