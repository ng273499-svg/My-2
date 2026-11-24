'use client';

import {
  StreamingVoiceSentenceAccumulator,
  VoiceSessionStateMachine,
  buildProviderNeutralProsody,
  splitIntoSpeakableChunks,
  type VoiceErrorCode,
  type VoiceSessionMachineState,
} from '@/core/voice';
import type {
  DeliveryStyleInput,
  ModelStreamChunk,
  ResponseStyle,
} from '@/core/types';

// =============================================================================
// 1. Browser Capability Detection (Zero-Cost Mode, Honest Reporting)
// =============================================================================
export interface BrowserVoiceCapabilities {
  sttSupported: boolean;
  ttsSupported: boolean;
  micPermissionApiSupported: boolean;
  waveformAnalyserSupported: boolean;
  mode: 'full_browser_voice' | 'stt_only' | 'tts_only' | 'unsupported';
  statusSummary: string;
}

export interface BrowserSpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onresult:
    | ((event: {
        resultIndex?: number;
        results: ArrayLike<{
          isFinal?: boolean;
          0: { transcript: string; confidence?: number };
          length: number;
        }>;
      }) => void)
    | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}

export type BrowserSpeechRecognitionConstructor =
  new () => BrowserSpeechRecognitionLike;

export function getSpeechRecognitionConstructor(
  win: unknown = typeof window !== 'undefined' ? window : undefined
): BrowserSpeechRecognitionConstructor | null {
  if (!win || typeof win !== 'object') return null;
  const w = win as {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function detectBrowserVoiceCapabilities(
  win: unknown = typeof window !== 'undefined' ? window : undefined,
  nav: unknown = typeof navigator !== 'undefined' ? navigator : undefined
): BrowserVoiceCapabilities {
  if (!win || typeof win !== 'object') {
    return {
      sttSupported: false,
      ttsSupported: false,
      micPermissionApiSupported: false,
      waveformAnalyserSupported: false,
      mode: 'unsupported',
      statusSummary: 'Voice APIs unavailable outside browser runtime.',
    };
  }

  const w = win as {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const n = (nav ?? {}) as {
    mediaDevices?: { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> };
  };

  const sttSupported = Boolean(getSpeechRecognitionConstructor(win));
  const ttsSupported = Boolean(
    w.speechSynthesis &&
      (typeof w.SpeechSynthesisUtterance !== 'undefined' ||
        typeof SpeechSynthesisUtterance !== 'undefined')
  );
  const micPermissionApiSupported = Boolean(
    typeof n.mediaDevices?.getUserMedia === 'function'
  );
  const waveformAnalyserSupported = Boolean(w.AudioContext || w.webkitAudioContext);

  const mode: BrowserVoiceCapabilities['mode'] =
    sttSupported && ttsSupported
      ? 'full_browser_voice'
      : sttSupported
        ? 'stt_only'
        : ttsSupported
          ? 'tts_only'
          : 'unsupported';

  const statusSummary =
    mode === 'full_browser_voice'
      ? 'Zero-cost Browser STT & SpeechSynthesis ready (₹0 paid APIs).'
      : mode === 'tts_only'
        ? 'Browser SpeechSynthesis ready; SpeechRecognition STT unsupported in this browser (text input remains active).'
        : mode === 'stt_only'
          ? 'Browser SpeechRecognition ready; SpeechSynthesis TTS unavailable.'
          : 'Browser SpeechRecognition & SpeechSynthesis unsupported on this device/browser — full text console remains active.';

  return {
    sttSupported,
    ttsSupported,
    micPermissionApiSupported,
    waveformAnalyserSupported,
    mode,
    statusSummary,
  };
}

// =============================================================================
// 2. Real Device/Browser TTS Voice Discovery & Female-Preferring Selection
// =============================================================================
export interface DiscoveredBrowserVoice {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
  isDefault: boolean;
  femaleHintMatched: boolean;
}

const FEMALE_PRESENTING_VOICE_HINTS = [
  'samantha',
  'ava',
  'allison',
  'victoria',
  'karen',
  'moira',
  'tessa',
  'serena',
  'martha',
  'zira',
  'aria',
  'jenny',
  'sonia',
  'libby',
  'natasha',
  'fiona',
  'veena',
  'susan',
  'hazel',
  'catherine',
  'female',
  'woman',
  'google uk english female',
];

const EXPLICIT_MALE_VOICE_HINTS = [
  'alex',
  'daniel',
  'david',
  'fred',
  'jorge',
  'luca',
  'male',
  'man',
  'mark',
  'oliver',
  'rishi',
  'thomas',
  'google uk english male',
];

export function isFemalePresentingVoiceName(name: string): boolean {
  const lower = name.toLowerCase();
  if (EXPLICIT_MALE_VOICE_HINTS.some((m) => new RegExp(`\\b${m}\\b`, 'i').test(lower))) {
    return false;
  }
  return FEMALE_PRESENTING_VOICE_HINTS.some((hint) => lower.includes(hint));
}

export function discoverBrowserVoices(
  synth?: Pick<SpeechSynthesis, 'getVoices'> | null
): DiscoveredBrowserVoice[] {
  const targetSynth =
    synth !== undefined
      ? synth
      : typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'
        ? window.speechSynthesis
        : null;
  if (!targetSynth || typeof targetSynth.getVoices !== 'function') return [];
  const rawVoices = targetSynth.getVoices() ?? [];
  return rawVoices.map((v) => ({
    voiceURI: v.voiceURI || v.name,
    name: v.name,
    lang: v.lang || 'en-US',
    localService: Boolean(v.localService),
    isDefault: Boolean(v.default),
    femaleHintMatched: isFemalePresentingVoiceName(v.name),
  }));
}

export interface VoiceSelectionResult {
  selectedVoice: SpeechSynthesisVoice | null;
  descriptor: DiscoveredBrowserVoice | null;
  selectionReason:
    | 'manual_user_preference'
    | 'auto_female_preferred'
    | 'auto_english_fallback'
    | 'auto_system_fallback'
    | 'no_voices_available';
  preferredVoiceMissing: boolean;
}

/**
 * Selects an actually available `SpeechSynthesisVoice` from the active browser/device:
 * 1. Exact manual `preferredVoiceUri` if present on device
 * 2. Suitable female-presenting English voice if available on device
 * 3. Best available English system voice
 * 4. First available system voice
 * Never assumes any named voice exists, and never claims Aria/Lyra are real system voices.
 */
export function selectBestAvailableBrowserVoice(
  rawVoices: SpeechSynthesisVoice[],
  preferredVoiceUri?: string | null,
  personaProfileId = 'jarvis-x-aria-female-v1'
): VoiceSelectionResult {
  if (!rawVoices || rawVoices.length === 0) {
    return {
      selectedVoice: null,
      descriptor: null,
      selectionReason: 'no_voices_available',
      preferredVoiceMissing: Boolean(
        preferredVoiceUri && preferredVoiceUri !== 'auto'
      ),
    };
  }

  const toDescriptor = (v: SpeechSynthesisVoice): DiscoveredBrowserVoice => ({
    voiceURI: v.voiceURI || v.name,
    name: v.name,
    lang: v.lang || 'en-US',
    localService: Boolean(v.localService),
    isDefault: Boolean(v.default),
    femaleHintMatched: isFemalePresentingVoiceName(v.name),
  });

  let preferredVoiceMissing = false;
  if (preferredVoiceUri && preferredVoiceUri !== 'auto') {
    const exact = rawVoices.find(
      (v) => v.voiceURI === preferredVoiceUri || v.name === preferredVoiceUri
    );
    if (exact) {
      return {
        selectedVoice: exact,
        descriptor: toDescriptor(exact),
        selectionReason: 'manual_user_preference',
        preferredVoiceMissing: false,
      };
    }
    preferredVoiceMissing = true;
  }

  const englishVoices = rawVoices.filter((v) => /^en(-|_|$)/i.test(v.lang || ''));
  const candidatePool = englishVoices.length > 0 ? englishVoices : rawVoices;

  const femaleCandidates = candidatePool.filter((v) =>
    isFemalePresentingVoiceName(v.name)
  );

  if (femaleCandidates.length > 0) {
    const isLyra = personaProfileId === 'jarvis-x-lyra-female-v1';
    const ranked = [...femaleCandidates].sort((a, b) => {
      const score = (v: SpeechSynthesisVoice) => {
        let s = 0;
        if (v.localService) s += 4;
        const lower = v.name.toLowerCase();
        if (isLyra && /(victoria|karen|serena|jenny|sonia)/i.test(lower)) s += 3;
        if (!isLyra && /(samantha|ava|aria|allison|moira)/i.test(lower)) s += 3;
        if (/en[-_]us|en[-_]gb|en[-_]in/i.test(v.lang)) s += 2;
        return s;
      };
      return score(b) - score(a);
    });
    const best = ranked[0];
    return {
      selectedVoice: best,
      descriptor: toDescriptor(best),
      selectionReason: 'auto_female_preferred',
      preferredVoiceMissing,
    };
  }

  if (englishVoices.length > 0) {
    const bestEn =
      englishVoices.find((v) => v.default && v.localService) ??
      englishVoices.find((v) => v.localService) ??
      englishVoices.find((v) => v.default) ??
      englishVoices[0];
    return {
      selectedVoice: bestEn,
      descriptor: toDescriptor(bestEn),
      selectionReason: 'auto_english_fallback',
      preferredVoiceMissing,
    };
  }

  const fallback = rawVoices.find((v) => v.default) ?? rawVoices[0];
  return {
    selectedVoice: fallback,
    descriptor: toDescriptor(fallback),
    selectionReason: 'auto_system_fallback',
    preferredVoiceMissing,
  };
}

// =============================================================================
// 3. Local Browser Voice Preference Persistence (Settings Only — Zero Audio/Text)
// =============================================================================
const LOCAL_VOICE_PREFS_STORAGE_KEY = 'jarvis-x-voice-prefs-v06';

export interface CachedBrowserVoicePrefs {
  preferredBrowserVoiceUri?: string | null;
  voiceMuted?: boolean;
  voiceAutoSpeak?: boolean;
  voiceProfileId?: string;
}

export function loadCachedVoicePreferences(): CachedBrowserVoicePrefs {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(LOCAL_VOICE_PREFS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      preferredBrowserVoiceUri:
        typeof parsed.preferredBrowserVoiceUri === 'string'
          ? parsed.preferredBrowserVoiceUri
          : parsed.preferredBrowserVoiceUri === null
            ? null
            : undefined,
      voiceMuted:
        typeof parsed.voiceMuted === 'boolean' ? parsed.voiceMuted : undefined,
      voiceAutoSpeak:
        typeof parsed.voiceAutoSpeak === 'boolean'
          ? parsed.voiceAutoSpeak
          : undefined,
      voiceProfileId:
        typeof parsed.voiceProfileId === 'string'
          ? parsed.voiceProfileId
          : undefined,
    };
  } catch {
    return {};
  }
}

export function saveCachedVoicePreferences(patch: CachedBrowserVoicePrefs): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const existing = loadCachedVoicePreferences();
    const merged: CachedBrowserVoicePrefs = { ...existing, ...patch };
    window.localStorage.setItem(
      LOCAL_VOICE_PREFS_STORAGE_KEY,
      JSON.stringify(merged)
    );
  } catch {
    // Ignore storage quota / private mode restrictions gracefully
  }
}

// =============================================================================
// 4. Non-Overlapping Sentence-Chunk Browser Speech Synthesizer
// =============================================================================
export interface BrowserSpeechProsodyOptions {
  style?: DeliveryStyleInput | ResponseStyle;
  voiceProfileId?: string;
  preferredBrowserVoiceUri?: string | null;
  muted?: boolean;
  speakingRate?: number;
  volume?: number;
  onStart?: (voiceInfo: DiscoveredBrowserVoice | null) => void;
  onEnd?: () => void;
  onInterrupted?: () => void;
  onError?: (reason: string) => void;
}

let activePlaybackGeneration = 0;
let activeInterChunkTimer: ReturnType<typeof setTimeout> | null = null;
let activeInterruptedCallback: (() => void) | null = null;

function clearInterChunkTimer(): void {
  if (activeInterChunkTimer !== null) {
    clearTimeout(activeInterChunkTimer);
    activeInterChunkTimer = null;
  }
}

export function isBrowserSpeechSynthesisSupported(): boolean {
  return detectBrowserVoiceCapabilities().ttsSupported;
}

/**
 * Immediately cancels any active or queued browser speech playback and prevents
 * pending sentence chunks from overlapping.
 */
export function cancelBrowserSpeech(): boolean {
  activePlaybackGeneration += 1;
  clearInterChunkTimer();
  const interruptedCb = activeInterruptedCallback;
  activeInterruptedCallback = null;

  if (!isBrowserSpeechSynthesisSupported()) {
    interruptedCb?.();
    return false;
  }

  const wasActive = Boolean(
    window.speechSynthesis.speaking || window.speechSynthesis.pending
  );
  window.speechSynthesis.cancel();
  if (wasActive) {
    interruptedCb?.();
  }
  return wasActive;
}

export function speakWithFemalePersona(
  rawText: string,
  options: BrowserSpeechProsodyOptions = {}
): boolean {
  // Always cancel any prior utterance first so assistant speech NEVER overlaps
  cancelBrowserSpeech();

  if (options.muted) {
    return false;
  }

  if (
    !isBrowserSpeechSynthesisSupported() ||
    typeof SpeechSynthesisUtterance === 'undefined'
  ) {
    options.onError?.('Speech synthesis is unavailable in this browser.');
    return false;
  }

  const chunks = splitIntoSpeakableChunks(rawText);
  if (chunks.length === 0) return false;

  const generation = ++activePlaybackGeneration;
  activeInterruptedCallback = options.onInterrupted ?? null;

  const rawVoices = window.speechSynthesis.getVoices() ?? [];
  const selection = selectBestAvailableBrowserVoice(
    rawVoices,
    options.preferredBrowserVoiceUri,
    options.voiceProfileId
  );

  const prosody = buildProviderNeutralProsody({
    style: options.style,
    voiceProfileId: options.voiceProfileId,
    muted: Boolean(options.muted),
    rateOverride: options.speakingRate,
    volumeOverride: options.volume,
  });

  let chunkIndex = 0;
  let notifiedStart = false;

  const speakNextChunk = () => {
    if (generation !== activePlaybackGeneration) return;
    if (chunkIndex >= chunks.length) {
      activeInterruptedCallback = null;
      options.onEnd?.();
      return;
    }

    const textChunk = chunks[chunkIndex];
    chunkIndex += 1;

    const utterance = new SpeechSynthesisUtterance(textChunk);
    if (selection.selectedVoice) {
      utterance.voice = selection.selectedVoice;
      if (selection.selectedVoice.lang) {
        utterance.lang = selection.selectedVoice.lang;
      }
    }
    utterance.rate = prosody.rate;
    utterance.pitch = prosody.pitch;
    utterance.volume = prosody.volume;

    utterance.onstart = () => {
      if (generation !== activePlaybackGeneration) return;
      if (!notifiedStart) {
        notifiedStart = true;
        options.onStart?.(selection.descriptor);
      }
    };

    utterance.onend = () => {
      if (generation !== activePlaybackGeneration) return;
      if (chunkIndex >= chunks.length) {
        activeInterruptedCallback = null;
        options.onEnd?.();
        return;
      }
      const pauseMs = Math.min(260, Math.max(40, Math.round(prosody.clausePauseMs * 0.45)));
      activeInterChunkTimer = setTimeout(() => {
        activeInterChunkTimer = null;
        speakNextChunk();
      }, pauseMs);
    };

    utterance.onerror = (ev) => {
      if (generation !== activePlaybackGeneration) return;
      activeInterruptedCallback = null;
      if (ev.error === 'canceled' || ev.error === 'interrupted') {
        options.onInterrupted?.();
      } else {
        options.onError?.(`Speech playback error (${ev.error || 'unknown'}).`);
      }
      options.onEnd?.();
    };

    window.speechSynthesis.speak(utterance);
  };

  speakNextChunk();
  return true;
}

// =============================================================================
// 5. Full Real-Time Browser Voice Session Controller (STT + TTS + Barge-In)
// =============================================================================
export interface RecognizedSpeechTurn {
  transcript: string;
  confidence?: number;
  durationMs: number;
  bargeInTriggered: boolean;
  languageCode: string;
}

export interface BrowserVoiceControllerSnapshot {
  state: VoiceSessionMachineState;
  capabilities: BrowserVoiceCapabilities;
  interimTranscript: string;
  finalTranscript: string;
  discoveredVoices: DiscoveredBrowserVoice[];
  selectedVoice: DiscoveredBrowserVoice | null;
  voiceSelectionReason: VoiceSelectionResult['selectionReason'];
  preferredVoiceMissing: boolean;
  micLevels: number[] | undefined;
  errorCode: VoiceErrorCode | null;
  errorMessage: string | null;
  bargeInCount: number;
  rawAudioPersisted: false;
}

export interface BrowserVoiceSessionControllerOptions {
  languageCode?: string;
  recognitionTimeoutMs?: number;
  preferredBrowserVoiceUri?: string | null;
  voiceProfileId?: string;
  muted?: boolean;
  win?: unknown;
  nav?: unknown;
  doc?: Document | null;
  onStateChange?: (snapshot: BrowserVoiceControllerSnapshot) => void;
  onFinalTranscript?: (turn: RecognizedSpeechTurn) => void | Promise<void>;
}

export class BrowserVoiceSessionController {
  public readonly machine = new VoiceSessionStateMachine('IDLE');

  private readonly win: unknown;
  private readonly nav: unknown;
  private readonly doc: Document | null;
  private languageCode: string;
  private readonly recognitionTimeoutMs: number;
  private preferredVoiceUri: string | null;
  private voiceProfileId: string;
  private muted: boolean;
  private readonly onStateChange?: (snapshot: BrowserVoiceControllerSnapshot) => void;
  private readonly onFinalTranscript?: (
    turn: RecognizedSpeechTurn
  ) => void | Promise<void>;

  private capabilities: BrowserVoiceCapabilities;
  private discoveredVoices: DiscoveredBrowserVoice[] = [];
  private interimTranscript = '';
  private finalTranscript = '';
  private micLevels: number[] | undefined = undefined;

  private recognition: BrowserSpeechRecognitionLike | null = null;
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private rafId: number | null = null;
  private recognitionTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStartLock = false;
  private destroyed = false;
  private sessionStartedAtMs = 0;
  private currentSessionBargeIn = false;
  private streamAccumulator = new StreamingVoiceSentenceAccumulator();

  private readonly handleVoicesChangedBound: () => void;
  private readonly handleVisibilityChangeBound: () => void;

  constructor(options: BrowserVoiceSessionControllerOptions = {}) {
    this.win = options.win ?? (typeof window !== 'undefined' ? window : undefined);
    this.nav =
      options.nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
    this.doc =
      options.doc !== undefined
        ? options.doc
        : typeof document !== 'undefined'
          ? document
          : null;
    this.languageCode = options.languageCode ?? 'en-US';
    this.recognitionTimeoutMs = options.recognitionTimeoutMs ?? 12_000;
    this.preferredVoiceUri = options.preferredBrowserVoiceUri ?? null;
    this.voiceProfileId = options.voiceProfileId ?? 'jarvis-x-aria-female-v1';
    this.muted = Boolean(options.muted);
    this.onStateChange = options.onStateChange;
    this.onFinalTranscript = options.onFinalTranscript;

    this.capabilities = detectBrowserVoiceCapabilities(this.win, this.nav);
    this.handleVoicesChangedBound = () => {
      if (this.destroyed) return;
      this.refreshVoices();
      this.emit();
    };
    this.handleVisibilityChangeBound = () => {
      if (this.destroyed) return;
      if (this.doc && this.doc.visibilityState === 'hidden') {
        this.stopListening('page_hidden');
        this.stopSpeaking('page_hidden');
      }
    };

    this.refreshVoices();
    this.attachListeners();
    // Privacy guarantee: NEVER auto-start microphone on construction!
  }

  private getSpeechSynth(): SpeechSynthesis | null {
    if (!this.win || typeof this.win !== 'object') return null;
    return (this.win as { speechSynthesis?: SpeechSynthesis }).speechSynthesis ?? null;
  }

  private attachListeners(): void {
    const synth = this.getSpeechSynth();
    if (synth && typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', this.handleVoicesChangedBound);
    } else if (synth && 'onvoiceschanged' in synth) {
      synth.onvoiceschanged = this.handleVoicesChangedBound;
    }

    if (this.doc && typeof this.doc.addEventListener === 'function') {
      this.doc.addEventListener('visibilitychange', this.handleVisibilityChangeBound);
    }
  }

  refreshVoices(): DiscoveredBrowserVoice[] {
    const synth = this.getSpeechSynth();
    this.discoveredVoices = discoverBrowserVoices(synth);
    return this.discoveredVoices;
  }

  updatePreferences(patch: {
    preferredBrowserVoiceUri?: string | null;
    voiceProfileId?: string;
    muted?: boolean;
    languageCode?: string;
  }): void {
    if (patch.preferredBrowserVoiceUri !== undefined) {
      this.preferredVoiceUri = patch.preferredBrowserVoiceUri;
    }
    if (patch.voiceProfileId !== undefined) {
      this.voiceProfileId = patch.voiceProfileId;
    }
    if (patch.muted !== undefined) {
      this.muted = patch.muted;
      if (this.muted && this.machine.state === 'SPEAKING') {
        this.stopSpeaking('operator_muted');
      }
    }
    if (patch.languageCode !== undefined) {
      this.languageCode = patch.languageCode;
    }
    this.emit();
  }

  getSnapshot(): BrowserVoiceControllerSnapshot {
    const synth = this.getSpeechSynth();
    const rawVoices = synth && typeof synth.getVoices === 'function' ? synth.getVoices() : [];
    const selection = selectBestAvailableBrowserVoice(
      rawVoices,
      this.preferredVoiceUri,
      this.voiceProfileId
    );

    return {
      state: this.machine.state,
      capabilities: this.capabilities,
      interimTranscript: this.interimTranscript,
      finalTranscript: this.finalTranscript,
      discoveredVoices: this.discoveredVoices,
      selectedVoice: selection.descriptor,
      voiceSelectionReason: selection.selectionReason,
      preferredVoiceMissing: selection.preferredVoiceMissing,
      micLevels: this.machine.state === 'LISTENING' ? this.micLevels : undefined,
      errorCode: this.machine.error?.code ?? null,
      errorMessage: this.machine.error?.message ?? null,
      bargeInCount: this.machine.totalInterruptions,
      rawAudioPersisted: false,
    };
  }

  private emit(): void {
    if (this.destroyed) return;
    this.onStateChange?.(this.getSnapshot());
  }

  private releaseCaptureHardware(): void {
    if (this.recognitionTimer !== null) {
      clearTimeout(this.recognitionTimer);
      this.recognitionTimer = null;
    }
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        // Ignore already-stopped recognition instance
      }
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors
        }
      });
      this.mediaStream = null;
    }
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      ctx.close().catch(() => undefined);
    }
    this.micLevels = undefined;
  }

  /**
   * Explicitly starts microphone listening upon operator action.
   * Performs immediate barge-in speech cancellation if assistant is currently SPEAKING.
   */
  async startListening(): Promise<boolean> {
    if (this.destroyed || this.pendingStartLock) {
      return false;
    }

    this.capabilities = detectBrowserVoiceCapabilities(this.win, this.nav);
    const SpeechRecCtor = getSpeechRecognitionConstructor(this.win);

    if (!this.capabilities.sttSupported || !SpeechRecCtor) {
      cancelBrowserSpeech();
      this.machine.markUnsupported(
        'SpeechRecognition API is unsupported in this browser. Full text interaction remains active.'
      );
      this.emit();
      return false;
    }

    // Barge-In: immediately cancel any active spoken output before opening mic
    const wasSpeaking = this.machine.state === 'SPEAKING';
    if (wasSpeaking) {
      cancelBrowserSpeech();
    }

    const lock = this.machine.beginMicPermissionRequest('operator_start_listening');
    if (!lock.acquired || lock.sessionToken === null) {
      return false;
    }

    this.pendingStartLock = true;
    this.currentSessionBargeIn = wasSpeaking || lock.bargeInTriggered;
    this.interimTranscript = '';
    this.finalTranscript = '';
    this.emit();

    const sessionToken = lock.sessionToken;

    try {
      // Request explicit microphone permission if mediaDevices API is available
      const n = (this.nav ?? {}) as {
        mediaDevices?: {
          getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
        };
      };

      if (typeof n.mediaDevices?.getUserMedia === 'function') {
        const stream = await n.mediaDevices.getUserMedia({ audio: true });
        if (this.destroyed || this.machine.state !== 'REQUESTING_MIC_PERMISSION') {
          stream.getTracks().forEach((t) => t.stop());
          this.pendingStartLock = false;
          return false;
        }
        this.mediaStream = stream;
        this.startWaveformMetering(stream);
      }

      const rec = new SpeechRecCtor();
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = this.languageCode;
      this.recognition = rec;
      this.sessionStartedAtMs = Date.now();

      let capturedFinalText = '';
      let capturedConfidence: number | undefined;
      let handledTerminalEvent = false;

      this.recognitionTimer = setTimeout(() => {
        if (handledTerminalEvent || this.destroyed) return;
        handledTerminalEvent = true;
        this.releaseCaptureHardware();
        this.machine.failWithError(
          'RECOGNITION_TIMEOUT',
          'No speech recognized before timeout. Tap microphone when ready to speak.'
        );
        this.emit();
      }, this.recognitionTimeoutMs);

      rec.onresult = (event) => {
        if (this.destroyed || handledTerminalEvent) return;
        let interim = '';
        let finalText = '';
        for (let i = 0; i < event.results.length; i += 1) {
          const res = event.results[i];
          const alt = res?.[0];
          if (!alt) continue;
          if (res.isFinal) {
            finalText += alt.transcript;
            if (typeof alt.confidence === 'number') {
              capturedConfidence = alt.confidence;
            }
          } else {
            interim += alt.transcript;
          }
        }

        if (interim.trim()) {
          this.interimTranscript = interim.trim();
        }
        if (finalText.trim()) {
          capturedFinalText = finalText.trim();
          this.finalTranscript = capturedFinalText;
          this.interimTranscript = '';
        }
        this.emit();
      };

      rec.onerror = (ev) => {
        if (this.destroyed || handledTerminalEvent) return;
        handledTerminalEvent = true;
        this.releaseCaptureHardware();

        const errStr = (ev.error || '').toLowerCase();
        if (errStr === 'aborted') {
          this.machine.reset('recognition_aborted');
          this.emit();
          return;
        }

        const mapped: { code: VoiceErrorCode; message: string } =
          errStr === 'not-allowed' || errStr === 'service-not-allowed'
            ? {
                code: 'MIC_PERMISSION_DENIED',
                message:
                  'Microphone permission was denied. Grant browser microphone access or type your directive.',
              }
            : errStr === 'audio-capture'
              ? {
                  code: 'MIC_HARDWARE_MISSING',
                  message:
                    'No working microphone hardware was detected on this device.',
                }
              : errStr === 'no-speech'
                ? {
                    code: 'RECOGNITION_TIMEOUT',
                    message: 'No speech detected. Microphone closed cleanly.',
                  }
                : {
                    code: 'RECOGNITION_SERVICE_ERROR',
                    message: `Speech recognition service error (${ev.error || 'unknown'}).`,
                  };

        this.machine.failWithError(mapped.code, mapped.message);
        this.emit();
      };

      rec.onend = () => {
        if (this.destroyed || handledTerminalEvent) return;
        handledTerminalEvent = true;
        const durationMs = Math.max(1, Date.now() - this.sessionStartedAtMs);
        const textToDispatch =
          capturedFinalText.trim() || this.interimTranscript.trim();

        this.releaseCaptureHardware();
        this.interimTranscript = '';

        if (textToDispatch) {
          this.finalTranscript = textToDispatch;
          this.machine.completeListeningToProcessing(sessionToken);
          this.emit();
          Promise.resolve(
            this.onFinalTranscript?.({
              transcript: textToDispatch,
              confidence: capturedConfidence,
              durationMs,
              bargeInTriggered: this.currentSessionBargeIn,
              languageCode: this.languageCode,
            })
          ).catch(() => {
            if (!this.destroyed) {
              this.machine.failWithError(
                'VOICE_ENGINE_ERROR',
                'Failed to dispatch recognized voice transcript.'
              );
              this.emit();
            }
          });
        } else {
          this.machine.reset('listening_ended_empty');
          this.emit();
        }
      };

      this.machine.confirmListeningStarted(sessionToken);
      rec.start();
      this.pendingStartLock = false;
      this.emit();
      return true;
    } catch (err) {
      this.pendingStartLock = false;
      this.releaseCaptureHardware();

      const errName =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: string }).name)
          : '';
      if (/NotAllowedError|PermissionDeniedError|SecurityError/i.test(errName)) {
        this.machine.failWithError(
          'MIC_PERMISSION_DENIED',
          'Microphone permission was denied by the browser or operator.'
        );
      } else if (/NotFoundError|DevicesNotFoundError|NotReadableError/i.test(errName)) {
        this.machine.failWithError(
          'MIC_HARDWARE_MISSING',
          'No accessible microphone hardware was found on this device.'
        );
      } else {
        this.machine.failWithError(
          'RECOGNITION_UNAVAILABLE',
          'Unable to start browser speech recognition.'
        );
      }
      this.emit();
      return false;
    }
  }

  private startWaveformMetering(stream: MediaStream): void {
    if (!this.win || typeof this.win !== 'object') return;
    const w = this.win as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioCtx = w.AudioContext ?? w.webkitAudioContext;
    if (!AudioCtx || typeof requestAnimationFrame !== 'function') return;

    try {
      const ctx = new AudioCtx();
      this.audioCtx = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const sampleLoop = () => {
        if (this.destroyed || this.machine.state !== 'LISTENING') return;
        analyser.getByteFrequencyData(dataArray);
        this.micLevels = Array.from(dataArray.slice(0, 24)).map((v) => v / 255);
        this.emit();
        this.rafId = requestAnimationFrame(sampleLoop);
      };
      sampleLoop();
    } catch {
      // Optional metering degradation — recognition continues cleanly
    }
  }

  stopListening(reason = 'operator_stop_listening'): void {
    this.pendingStartLock = false;
    this.releaseCaptureHardware();
    this.interimTranscript = '';
    if (
      this.machine.state === 'LISTENING' ||
      this.machine.state === 'REQUESTING_MIC_PERMISSION'
    ) {
      this.machine.reset(reason);
      this.emit();
    }
  }

  async toggleListening(): Promise<boolean> {
    if (
      this.machine.state === 'LISTENING' ||
      this.machine.state === 'REQUESTING_MIC_PERMISSION'
    ) {
      this.stopListening('operator_toggle_off');
      return false;
    }
    return this.startListening();
  }

  markRuntimeProcessingComplete(): void {
    if (this.machine.state === 'PROCESSING') {
      this.machine.transitionTo('IDLE', 'runtime_turn_completed');
      this.emit();
    }
  }

  speakResponse(
    rawText: string,
    options: Omit<BrowserSpeechProsodyOptions, 'preferredBrowserVoiceUri' | 'muted'> & {
      turnId?: string;
    } = {}
  ): boolean {
    if (this.destroyed || this.muted) {
      this.markRuntimeProcessingComplete();
      return false;
    }

    const started = speakWithFemalePersona(rawText, {
      ...options,
      voiceProfileId: options.voiceProfileId ?? this.voiceProfileId,
      preferredBrowserVoiceUri: this.preferredVoiceUri,
      muted: this.muted,
      onStart: (voiceInfo) => {
        if (this.destroyed) return;
        if (
          this.machine.state === 'IDLE' ||
          this.machine.state === 'PROCESSING' ||
          this.machine.state === 'ERROR' ||
          this.machine.state === 'UNSUPPORTED'
        ) {
          this.machine.transitionTo('SPEAKING', 'tts_utterance_started', {
            turnId: options.turnId ?? null,
          });
          this.emit();
        }
        options.onStart?.(voiceInfo);
      },
      onInterrupted: () => {
        options.onInterrupted?.();
      },
      onEnd: () => {
        if (!this.destroyed && this.machine.state === 'SPEAKING') {
          this.machine.transitionTo('IDLE', 'tts_utterance_completed');
          this.emit();
        }
        options.onEnd?.();
      },
      onError: (msg) => {
        if (!this.destroyed) {
          this.machine.failWithError('SPEECH_SYNTHESIS_UNAVAILABLE', msg);
          this.emit();
        }
        options.onError?.(msg);
      },
    });

    if (!started && this.machine.state === 'PROCESSING') {
      this.machine.transitionTo('IDLE', 'tts_skipped');
      this.emit();
    } else if (started && this.machine.canTransitionTo('SPEAKING')) {
      this.machine.transitionTo('SPEAKING', 'tts_queued', {
        turnId: options.turnId ?? null,
      });
      this.emit();
    }

    return started;
  }

  /**
   * Streaming-ready hook consuming provider-neutral `ModelStreamChunk` deltas.
   */
  consumeModelStreamChunk(chunk: ModelStreamChunk): string[] {
    return this.streamAccumulator.pushChunk(chunk);
  }

  stopSpeaking(reason = 'operator_stop_voice'): boolean {
    this.streamAccumulator.reset();
    const cancelled = cancelBrowserSpeech();
    if (this.machine.state === 'SPEAKING' || this.machine.state === 'PROCESSING') {
      this.machine.interruptActiveSpeech(reason);
      this.emit();
    }
    return cancelled;
  }

  destroy(): void {
    this.destroyed = true;
    this.pendingStartLock = false;
    this.releaseCaptureHardware();
    cancelBrowserSpeech();

    const synth = this.getSpeechSynth();
    if (synth && typeof synth.removeEventListener === 'function') {
      synth.removeEventListener('voiceschanged', this.handleVoicesChangedBound);
    } else if (synth && 'onvoiceschanged' in synth && synth.onvoiceschanged === this.handleVoicesChangedBound) {
      synth.onvoiceschanged = null;
    }

    if (this.doc && typeof this.doc.removeEventListener === 'function') {
      this.doc.removeEventListener(
        'visibilitychange',
        this.handleVisibilityChangeBound
      );
    }

    this.machine.reset('controller_destroyed');
  }
}
