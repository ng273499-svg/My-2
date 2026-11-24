import type {
  DeliveryStyleInput,
  ModelStreamChunk,
  ResponseStyle,
  VoiceProsodyHint,
} from '@/core/types';
import {
  redactSecrets,
  resolveServerProviderCredentials,
} from '@/core/models/provider-config';

// =============================================================================
// 1. Explicit Voice Session State Machine (Section 8)
// =============================================================================
export type VoiceSessionMachineState =
  | 'IDLE'
  | 'REQUESTING_MIC_PERMISSION'
  | 'LISTENING'
  | 'PROCESSING'
  | 'SPEAKING'
  | 'INTERRUPTING'
  | 'ERROR'
  | 'UNSUPPORTED';

export type VoiceErrorCode =
  | 'BROWSER_STT_UNSUPPORTED'
  | 'MIC_PERMISSION_DENIED'
  | 'MIC_HARDWARE_MISSING'
  | 'RECOGNITION_UNAVAILABLE'
  | 'RECOGNITION_TIMEOUT'
  | 'RECOGNITION_SERVICE_ERROR'
  | 'SPEECH_SYNTHESIS_UNAVAILABLE'
  | 'VOICE_ENGINE_ERROR';

export interface VoiceStateTransitionRecord {
  from: VoiceSessionMachineState;
  to: VoiceSessionMachineState;
  reason: string;
  timestamp: string;
}

export const LEGAL_VOICE_STATE_TRANSITIONS: Record<
  VoiceSessionMachineState,
  readonly VoiceSessionMachineState[]
> = {
  IDLE: [
    'REQUESTING_MIC_PERMISSION',
    'LISTENING',
    'PROCESSING',
    'SPEAKING',
    'ERROR',
    'UNSUPPORTED',
  ],
  REQUESTING_MIC_PERMISSION: ['LISTENING', 'IDLE', 'ERROR', 'UNSUPPORTED'],
  LISTENING: ['PROCESSING', 'IDLE', 'INTERRUPTING', 'ERROR', 'UNSUPPORTED'],
  PROCESSING: ['SPEAKING', 'IDLE', 'INTERRUPTING', 'ERROR'],
  SPEAKING: ['INTERRUPTING', 'IDLE', 'ERROR'],
  INTERRUPTING: [
    'IDLE',
    'REQUESTING_MIC_PERMISSION',
    'LISTENING',
    'PROCESSING',
    'ERROR',
  ],
  ERROR: ['IDLE', 'REQUESTING_MIC_PERMISSION', 'LISTENING', 'SPEAKING', 'UNSUPPORTED'],
  UNSUPPORTED: ['IDLE', 'SPEAKING', 'ERROR'],
};

export class IllegalVoiceStateTransitionError extends Error {
  public readonly from: VoiceSessionMachineState;
  public readonly to: VoiceSessionMachineState;

  constructor(from: VoiceSessionMachineState, to: VoiceSessionMachineState) {
    super(`Illegal voice session transition: ${from} -> ${to}`);
    this.name = 'IllegalVoiceStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Deterministic Voice Session State Machine enforcing legal transitions,
 * single-session microphone locks, rapid-tap protection, and barge-in tracking.
 */
export class VoiceSessionStateMachine {
  private current: VoiceSessionMachineState = 'IDLE';
  private activeTurnId: string | null = null;
  private activeSessionToken: number | null = null;
  private nextSessionToken = 1;
  private interruptionCount = 0;
  private lastError: { code: VoiceErrorCode; message: string } | null = null;
  private history: VoiceStateTransitionRecord[] = [];

  constructor(initialState: VoiceSessionMachineState = 'IDLE') {
    this.current = initialState;
  }

  get state(): VoiceSessionMachineState {
    return this.current;
  }

  get activeSpeechTurnId(): string | null {
    return this.activeTurnId;
  }

  get totalInterruptions(): number {
    return this.interruptionCount;
  }

  get error(): { code: VoiceErrorCode; message: string } | null {
    return this.lastError;
  }

  get transitions(): readonly VoiceStateTransitionRecord[] {
    return this.history;
  }

  get hasActiveListeningSession(): boolean {
    return (
      this.activeSessionToken !== null &&
      (this.current === 'REQUESTING_MIC_PERMISSION' || this.current === 'LISTENING')
    );
  }

  canTransitionTo(next: VoiceSessionMachineState): boolean {
    if (next === this.current) return true;
    return LEGAL_VOICE_STATE_TRANSITIONS[this.current].includes(next);
  }

  transitionTo(
    next: VoiceSessionMachineState,
    reason = 'state_update',
    options?: { turnId?: string | null; errorCode?: VoiceErrorCode; errorMessage?: string }
  ): VoiceSessionMachineState {
    if (next === this.current) {
      if (options?.turnId !== undefined) {
        this.activeTurnId = options.turnId;
      }
      return this.current;
    }

    if (!this.canTransitionTo(next)) {
      throw new IllegalVoiceStateTransitionError(this.current, next);
    }

    const prev = this.current;
    this.current = next;

    if (next === 'INTERRUPTING') {
      this.interruptionCount += 1;
      this.activeTurnId = null;
    } else if (options?.turnId !== undefined) {
      this.activeTurnId = options.turnId;
    } else if (next === 'IDLE') {
      this.activeTurnId = null;
      this.activeSessionToken = null;
    }

    if (next === 'ERROR') {
      this.activeSessionToken = null;
      this.lastError = {
        code: options?.errorCode ?? 'VOICE_ENGINE_ERROR',
        message: options?.errorMessage ?? reason,
      };
    } else if (next === 'UNSUPPORTED') {
      this.activeSessionToken = null;
      this.lastError = {
        code: options?.errorCode ?? 'BROWSER_STT_UNSUPPORTED',
        message: options?.errorMessage ?? reason,
      };
    } else {
      this.lastError = null;
    }

    this.history.push({
      from: prev,
      to: next,
      reason,
      timestamp: new Date().toISOString(),
    });
    if (this.history.length > 50) {
      this.history.shift();
    }

    return this.current;
  }

  /**
   * Acquires an exclusive listening session token to prevent duplicate concurrent
   * microphone/recognition sessions on rapid repeated taps.
   * If currently SPEAKING, automatically executes legal SPEAKING -> INTERRUPTING -> REQUESTING_MIC_PERMISSION!
   */
  beginMicPermissionRequest(reason = 'operator_mic_tap'): {
    acquired: boolean;
    sessionToken: number | null;
    bargeInTriggered: boolean;
  } {
    if (this.hasActiveListeningSession) {
      return {
        acquired: false,
        sessionToken: null,
        bargeInTriggered: false,
      };
    }

    let bargeInTriggered = false;
    if (this.current === 'SPEAKING' || this.current === 'PROCESSING') {
      this.transitionTo('INTERRUPTING', 'barge_in_before_listening');
      bargeInTriggered = true;
    } else if (this.current === 'UNSUPPORTED') {
      return {
        acquired: false,
        sessionToken: null,
        bargeInTriggered: false,
      };
    }

    this.transitionTo('REQUESTING_MIC_PERMISSION', reason);
    const token = this.nextSessionToken++;
    this.activeSessionToken = token;
    return {
      acquired: true,
      sessionToken: token,
      bargeInTriggered,
    };
  }

  confirmListeningStarted(sessionToken: number): boolean {
    if (this.activeSessionToken !== sessionToken) {
      return false;
    }
    if (this.current === 'REQUESTING_MIC_PERMISSION' || this.current === 'IDLE') {
      this.transitionTo('LISTENING', 'microphone_and_recognition_active');
      return true;
    }
    return false;
  }

  completeListeningToProcessing(sessionToken?: number, turnId?: string): boolean {
    if (
      sessionToken !== undefined &&
      this.activeSessionToken !== null &&
      this.activeSessionToken !== sessionToken
    ) {
      return false;
    }
    this.activeSessionToken = null;
    if (this.current === 'LISTENING') {
      this.transitionTo('PROCESSING', 'final_transcript_captured', {
        turnId: turnId ?? null,
      });
      return true;
    }
    return false;
  }

  interruptActiveSpeech(reason = 'operator_barge_in'): boolean {
    if (this.current === 'SPEAKING' || this.current === 'PROCESSING') {
      this.transitionTo('INTERRUPTING', reason);
      this.transitionTo('IDLE', 'interruption_completed');
      return true;
    }
    return false;
  }

  failWithError(code: VoiceErrorCode, message: string): VoiceSessionMachineState {
    this.activeSessionToken = null;
    if (this.current === 'UNSUPPORTED') return this.current;
    return this.transitionTo('ERROR', message, {
      errorCode: code,
      errorMessage: message,
    });
  }

  markUnsupported(reason: string): VoiceSessionMachineState {
    this.activeSessionToken = null;
    if (this.current === 'SPEAKING' || this.current === 'PROCESSING') {
      this.transitionTo('INTERRUPTING', 'abort_for_unsupported');
      this.transitionTo('IDLE', 'reset_before_unsupported');
    } else if (this.current === 'INTERRUPTING') {
      this.transitionTo('IDLE', 'reset_before_unsupported');
    }
    return this.transitionTo('UNSUPPORTED', reason);
  }

  reset(reason = 'session_reset'): VoiceSessionMachineState {
    this.activeSessionToken = null;
    this.activeTurnId = null;
    if (this.current === 'IDLE') return 'IDLE';
    if (this.canTransitionTo('IDLE')) {
      return this.transitionTo('IDLE', reason);
    }
    // Safe two-hop recovery if needed
    this.current = 'IDLE';
    return 'IDLE';
  }
}

// =============================================================================
// 2. Delivery Style Normalization & Bounded Provider-Neutral Prosody (Sections 5 & 6)
// =============================================================================
export const DELIVERY_STYLE_ALIASES: Record<DeliveryStyleInput, ResponseStyle> = {
  neutral: 'neutral',
  calm: 'calm',
  excitement: 'excitement',
  excited: 'excitement',
  concern: 'concern',
  concerned: 'concern',
  curiosity: 'curiosity',
  curious: 'curiosity',
  confidence: 'confidence',
  confident: 'confidence',
  seriousness: 'seriousness',
  serious: 'seriousness',
  humor: 'humor',
  humorous: 'humor',
  urgency: 'urgency',
  urgent: 'urgency',
};

export function normalizeDeliveryStyle(
  style?: DeliveryStyleInput | string | null
): ResponseStyle {
  if (!style) return 'calm';
  const key = style.toLowerCase().trim() as DeliveryStyleInput;
  return DELIVERY_STYLE_ALIASES[key] ?? 'calm';
}

export interface ProviderNeutralProsody {
  deliveryStyle: ResponseStyle;
  personaProfileId: string;
  personaDisplayName: string;
  isPersonaStyleOnly: true;
  rate: number; // Bounded [0.88, 1.16]
  pitch: number; // Bounded [0.88, 1.14]
  pitchSupported: boolean;
  volume: number; // Bounded [0.0, 1.0]
  clausePauseMs: number; // Bounded [150, 320]
  pitchContour: VoiceProsodyHint['pitchContour'];
}

const STYLE_PITCH_OFFSET: Record<ResponseStyle, number> = {
  neutral: 0.0,
  calm: -0.01,
  excitement: 0.06,
  concern: -0.04,
  curiosity: 0.03,
  confidence: 0.01,
  seriousness: -0.04,
  humor: 0.04,
  urgency: 0.02,
};

const STYLE_RATE_MAP: Record<ResponseStyle, number> = {
  neutral: 1.0,
  calm: 0.98,
  excitement: 1.07,
  concern: 0.94,
  curiosity: 1.02,
  confidence: 1.01,
  seriousness: 0.95,
  humor: 1.03,
  urgency: 1.11,
};

const STYLE_PAUSE_MAP: Record<ResponseStyle, number> = {
  neutral: 240,
  calm: 260,
  excitement: 190,
  concern: 300,
  curiosity: 230,
  confidence: 220,
  seriousness: 310,
  humor: 240,
  urgency: 155,
};

const STYLE_CONTOUR_MAP: Record<ResponseStyle, VoiceProsodyHint['pitchContour']> = {
  neutral: 'steady',
  calm: 'steady',
  excitement: 'warm-lift',
  concern: 'measured-low',
  curiosity: 'inquisitive',
  confidence: 'steady',
  seriousness: 'measured-low',
  humor: 'warm-lift',
  urgency: 'crisp-urgent',
};

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export function buildProviderNeutralProsody(options: {
  style?: DeliveryStyleInput;
  voiceProfileId?: string;
  muted?: boolean;
  pitchSupported?: boolean;
  rateOverride?: number;
  volumeOverride?: number;
}): ProviderNeutralProsody {
  const deliveryStyle = normalizeDeliveryStyle(options.style);
  const isLyra = options.voiceProfileId === 'jarvis-x-lyra-female-v1';
  const basePitch = isLyra ? 1.04 : 0.99;
  const rawPitch = basePitch + (STYLE_PITCH_OFFSET[deliveryStyle] ?? 0);
  const rawRate =
    options.rateOverride ??
    (STYLE_RATE_MAP[deliveryStyle] ?? 1.0) * (isLyra ? 1.02 : 1.0);
  const rawVolume = options.muted
    ? 0
    : (options.volumeOverride ?? (deliveryStyle === 'urgency' ? 0.98 : 0.94));

  return {
    deliveryStyle,
    personaProfileId: isLyra
      ? 'jarvis-x-lyra-female-v1'
      : 'jarvis-x-aria-female-v1',
    personaDisplayName: isLyra
      ? 'Lyra Persona Profile (Crisp Tactical Cadence)'
      : 'Aria Persona Profile (Calm Articulate Cadence)',
    isPersonaStyleOnly: true,
    rate: Number(clamp(rawRate, 0.88, 1.16).toFixed(2)),
    pitch: Number(clamp(rawPitch, 0.88, 1.14).toFixed(2)),
    pitchSupported: options.pitchSupported ?? true,
    volume: Number(clamp(rawVolume, 0.0, 1.0).toFixed(2)),
    clausePauseMs: Math.round(
      clamp(STYLE_PAUSE_MAP[deliveryStyle] ?? 240, 150, 320)
    ),
    pitchContour: STYLE_CONTOUR_MAP[deliveryStyle] ?? 'steady',
  };
}

// =============================================================================
// 3. Spoken Text Normalization & Streaming Sentence Chunking (Section 9)
// =============================================================================
export function formatTextForSpokenDelivery(rawText: string, maxChars = 900): string {
  const safe = redactSecrets(rawText)
    .replace(/```[\s\S]*?```/g, ' Code block displayed on console. ')
    .replace(/<\/?untrusted_external_data[^>]*>/gi, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (uuid) => `record ${uuid.slice(0, 6)}`
    )
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\n)\s*[-*•]\s+/g, '. ')
    .replace(/(^|\n)\s*#+\s*/g, '')
    .replace(/(^|\n)\s*>\s*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.\s*\./g, '.')
    .trim();

  if (safe.length <= maxChars) return safe;
  const sliced = safe.slice(0, maxChars);
  const lastPeriod = Math.max(
    sliced.lastIndexOf('. '),
    sliced.lastIndexOf('! '),
    sliced.lastIndexOf('? ')
  );
  return lastPeriod > 120 ? `${sliced.slice(0, lastPeriod + 1)}` : `${sliced.trim()}...`;
}

/**
 * Splits normalized spoken text into safe sentence/clause chunks for progressive
 * low-latency browser TTS playback with instant inter-chunk barge-in cancellation.
 */
export function splitIntoSpeakableChunks(
  rawText: string,
  maxChunkLength = 220
): string[] {
  const cleaned = formatTextForSpokenDelivery(rawText, 1200);
  if (!cleaned) return [];

  const rawSentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const sentence of rawSentences) {
    if (sentence.length <= maxChunkLength) {
      chunks.push(sentence);
    } else {
      // Split long sentences on commas/semicolons/em-dashes safely
      const subParts = sentence
        .split(/(?<=[,;—:])\s+/)
        .map((p) => p.trim())
        .filter(Boolean);
      let current = '';
      for (const part of subParts) {
        if (!current) {
          current = part;
        } else if (current.length + 1 + part.length <= maxChunkLength) {
          current = `${current} ${part}`;
        } else {
          chunks.push(current);
          current = part;
        }
      }
      if (current) chunks.push(current);
    }
  }

  return chunks;
}

/**
 * Streaming-Ready Sentence Accumulator consuming provider-neutral `ModelStreamChunk`
 * deltas from `RuntimeModelRouter.streamWithRouting(...)` and emitting speakable
 * sentences as soon as punctuation boundaries arrive.
 */
export class StreamingVoiceSentenceAccumulator {
  private buffer = '';

  pushChunk(chunk: ModelStreamChunk): string[] {
    if (chunk.type === 'delta') {
      this.buffer += chunk.textDelta;
      const ready: string[] = [];
      let boundaryMatch = this.buffer.match(/^(.*?[.!?])\s+(.*)$/s);
      while (boundaryMatch) {
        const normalized = formatTextForSpokenDelivery(boundaryMatch[1], 300);
        if (normalized) ready.push(normalized);
        this.buffer = boundaryMatch[2];
        boundaryMatch = this.buffer.match(/^(.*?[.!?])\s+(.*)$/s);
      }
      return ready;
    }

    if (chunk.type === 'done') {
      return this.flush();
    }

    return [];
  }

  flush(): string[] {
    const remainder = formatTextForSpokenDelivery(this.buffer, 400);
    this.buffer = '';
    return remainder ? [remainder] : [];
  }

  reset(): void {
    this.buffer = '';
  }
}

/**
 * Provider-neutral realtime voice transport contract so future WebRTC/WebSocket
 * providers can plug in without modifying JarvisCoreRuntime, Memory, Permissions, or HUD.
 */
export interface VoiceTransportAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly requiresPaidApiKey: boolean;
  isAvailable(): boolean;
  cancelActivePlayback(): void;
}

// =============================================================================
// 4. Backward-Compatible Prosody Plan & Barge-In Controller
// =============================================================================
export type VoiceSessionState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'interrupted';

export interface FemaleProsodySynthesisPlan {
  voiceProfileId: string;
  personaName: string;
  isPersonaProfileOnly: true;
  genderPresentation: 'female';
  style: ResponseStyle;
  spokenScript: string;
  speakableChunks: string[];
  speakingRate: number;
  pitch: number;
  volume: number;
  clausePauseMs: number;
  pitchContour: VoiceProsodyHint['pitchContour'];
  openaiVoiceId: 'nova' | 'shimmer';
}

export function buildFemaleProsodyPlan(
  rawText: string,
  style: DeliveryStyleInput = 'calm',
  voiceProfileId = 'jarvis-x-aria-female-v1',
  muted = false
): FemaleProsodySynthesisPlan {
  const prosody = buildProviderNeutralProsody({
    style,
    voiceProfileId,
    muted,
  });
  const spokenScript = formatTextForSpokenDelivery(rawText);
  const speakableChunks = splitIntoSpeakableChunks(rawText);
  const isLyra = prosody.personaProfileId === 'jarvis-x-lyra-female-v1';

  return {
    voiceProfileId: prosody.personaProfileId,
    personaName: prosody.personaDisplayName,
    isPersonaProfileOnly: true,
    genderPresentation: 'female',
    style: prosody.deliveryStyle,
    spokenScript,
    speakableChunks,
    speakingRate: prosody.rate,
    pitch: prosody.pitch,
    volume: prosody.volume,
    clausePauseMs: prosody.clausePauseMs,
    pitchContour: prosody.pitchContour,
    openaiVoiceId: isLyra ? 'shimmer' : 'nova',
  };
}

export class VoiceBargeInController {
  public readonly machine = new VoiceSessionStateMachine();
  private legacyState: VoiceSessionState = 'idle';
  private activeTurnId: string | null = null;
  private interruptionCount = 0;
  private lastTransitionAt: string = new Date().toISOString();

  get state(): VoiceSessionState {
    return this.legacyState;
  }

  get machineState(): VoiceSessionMachineState {
    return this.machine.state;
  }

  get activeSpeechTurnId(): string | null {
    return this.activeTurnId;
  }

  get totalInterruptions(): number {
    return this.interruptionCount;
  }

  get updatedAt(): string {
    return this.lastTransitionAt;
  }

  startListening(): VoiceSessionState {
    if (this.legacyState === 'speaking') {
      this.interruptionCount += 1;
      this.activeTurnId = null;
      if (this.machine.canTransitionTo('INTERRUPTING')) {
        this.machine.transitionTo('INTERRUPTING', 'barge_in_start_listening');
      }
    }
    if (this.machine.canTransitionTo('LISTENING')) {
      this.machine.transitionTo('LISTENING', 'listening_started');
    }
    this.legacyState = 'listening';
    this.lastTransitionAt = new Date().toISOString();
    return this.legacyState;
  }

  markProcessing(turnId?: string): VoiceSessionState {
    if (this.machine.canTransitionTo('PROCESSING')) {
      this.machine.transitionTo('PROCESSING', 'processing_turn', {
        turnId: turnId ?? null,
      });
    }
    this.legacyState = 'processing';
    this.activeTurnId = turnId ?? null;
    this.lastTransitionAt = new Date().toISOString();
    return this.legacyState;
  }

  startSpeaking(turnId?: string): VoiceSessionState {
    if (this.machine.state === 'INTERRUPTING' || this.machine.state === 'LISTENING') {
      this.machine.reset('prepare_for_speaking');
    }
    if (this.machine.canTransitionTo('SPEAKING')) {
      this.machine.transitionTo('SPEAKING', 'speech_playback_started', {
        turnId: turnId ?? this.activeTurnId,
      });
    }
    this.legacyState = 'speaking';
    this.activeTurnId = turnId ?? this.activeTurnId;
    this.lastTransitionAt = new Date().toISOString();
    return this.legacyState;
  }

  triggerBargeIn(): {
    previousState: VoiceSessionState;
    newState: VoiceSessionState;
    interruptedTurnId: string | null;
    interrupted: boolean;
  } {
    const prev = this.legacyState;
    const interruptedTurnId = this.activeTurnId;
    if (prev === 'speaking' || prev === 'processing') {
      this.legacyState = 'interrupted';
      this.interruptionCount += 1;
      this.activeTurnId = null;
      this.lastTransitionAt = new Date().toISOString();
      if (this.machine.canTransitionTo('INTERRUPTING')) {
        this.machine.transitionTo('INTERRUPTING', 'operator_barge_in');
      }
      return {
        previousState: prev,
        newState: 'interrupted',
        interruptedTurnId,
        interrupted: true,
      };
    }
    return {
      previousState: prev,
      newState: prev,
      interruptedTurnId: null,
      interrupted: false,
    };
  }

  reset(): VoiceSessionState {
    this.machine.reset('controller_reset');
    this.legacyState = 'idle';
    this.activeTurnId = null;
    this.lastTransitionAt = new Date().toISOString();
    return this.legacyState;
  }
}

export interface OpenAISpeechAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Optional Server-Only Neural Speech Adapter.
 * Reports `isConfigured() = false` honestly when `OPENAI_API_KEY` is absent;
 * JARVIS-X requires ₹0 paid API keys and uses Browser Web Speech by default.
 */
export class OpenAISpeechAdapter {
  public readonly id = 'openai-neural-speech';
  public readonly name = 'Optional Server Neural TTS Adapter';

  private readonly explicitKey?: string;
  private readonly explicitBaseUrl?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAISpeechAdapterOptions = {}) {
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

  async synthesizeFemaleSpeech(
    plan: FemaleProsodySynthesisPlan
  ): Promise<Uint8Array> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('Server Neural TTS provider is UNCONFIGURED.');
    }

    const res = await this.fetchFn(`${this.getBaseUrl()}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: plan.openaiVoiceId,
        input: plan.spokenScript,
        speed: Math.min(1.2, Math.max(0.85, plan.speakingRate)),
        response_format: 'mp3',
      }),
    });

    if (!res.ok) {
      throw new Error(`Neural TTS returned HTTP ${res.status}`);
    }

    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
}
