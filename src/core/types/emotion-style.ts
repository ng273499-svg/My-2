import type { RoutingPolicyMode } from './model-router';

/**
 * Conversational response styles used by Personality Engine, Context & Emotion Engine,
 * and female-persona TTS prosody modulation.
 *
 * Architectural boundary: These represent calibrated expressive conversational and
 * vocal delivery styles — NEVER claims of sentient consciousness or biological emotion.
 */
export type ResponseStyle =
  | 'neutral'
  | 'calm'
  | 'excitement'
  | 'concern'
  | 'curiosity'
  | 'confidence'
  | 'seriousness'
  | 'humor'
  | 'urgency';

/**
 * Natural adjective aliases supported for style resolution alongside canonical `ResponseStyle` keys.
 */
export type DeliveryStyleInput =
  | ResponseStyle
  | 'excited'
  | 'concerned'
  | 'curious'
  | 'confident'
  | 'serious'
  | 'humorous'
  | 'urgent';

export interface VoiceProsodyHint {
  style: ResponseStyle;
  /** Safe bounded speaking rate multiplier (0.88 - 1.16) */
  speakingRate: number;
  /** Safe bounded pitch multiplier (0.88 - 1.14) where supported by engine */
  pitch?: number;
  /** Safe bounded playback volume (0.0 - 1.0) */
  volume?: number;
  /** Subtle pitch inflection profile */
  pitchContour: 'steady' | 'warm-lift' | 'measured-low' | 'inquisitive' | 'crisp-urgent';
  /** Pause cadence in ms between clauses/sentences */
  clausePauseMs: number;
  /** Target JARVIS persona/style profile identifier (not a claim of a bundled voice binary) */
  voiceProfileId: string;
}

export interface ContextSignals {
  detectedUrgency: 'low' | 'medium' | 'high';
  userSentimentCue: 'neutral' | 'positive' | 'stressed' | 'curious' | 'playful' | 'cautious';
  domainComplexity: 'conversational' | 'technical' | 'operational' | 'security_sensitive';
  recommendedStyle: ResponseStyle;
  styleRationale: string;
  timestampIso: string;
}

export interface PersonalityPreferences {
  preferredResponseStyle: ResponseStyle;
  voiceProfileId: string;
  preferredBrowserVoiceUri?: string | null;
  voiceMuted?: boolean;
  voiceAutoSpeak: boolean;
  voiceBargeInEnabled: boolean;
  witLevel: 'minimal' | 'subtle' | 'moderate';
  conciseness: 'brief' | 'balanced' | 'detailed';
  preferredModelProvider: string;
  routingPolicy?: RoutingPolicyMode;
  manualModelId?: string | null;
  proactiveAssistanceEnabled: boolean;
  crossDeviceSyncEnabled: boolean;
}
