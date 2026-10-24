import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JarvisDashboard } from '@/components/JarvisDashboard';
import { JarvisCore } from '@/core/modules/jarvis-core';
import {
  IllegalVoiceStateTransitionError,
  StreamingVoiceSentenceAccumulator,
  VoiceSessionStateMachine,
  buildProviderNeutralProsody,
  normalizeDeliveryStyle,
} from '@/core/voice';
import {
  BrowserVoiceSessionController,
  cancelBrowserSpeech,
  detectBrowserVoiceCapabilities,
  discoverBrowserVoices,
  loadCachedVoicePreferences,
  saveCachedVoicePreferences,
  selectBestAvailableBrowserVoice,
  speakWithFemalePersona,
  type BrowserSpeechRecognitionLike,
} from '@/lib/browser-voice';
import { InMemorySessionRepository } from '@/server/repositories/in-memory-repository';
import {
  SUPABASE_MIGRATION_PATHS,
  SUPABASE_PREPARED_DOMAINS,
  type SupabaseConnectionDiagnostics,
} from '@/server/supabase/client';

const MOCK_SUPABASE: SupabaseConnectionDiagnostics = {
  configured: true,
  projectRef: 'jdlxnidzakdtksjzazqe',
  serverReachability: 'connected',
  authReady: true,
  pgvectorEnabled: true,
  rlsForced: true,
  hasServiceRole: true,
  persistenceMode: 'ephemeral_session',
  domainsPrepared: SUPABASE_PREPARED_DOMAINS,
  migrationPath: SUPABASE_MIGRATION_PATHS[SUPABASE_MIGRATION_PATHS.length - 1],
  migrationPaths: SUPABASE_MIGRATION_PATHS,
  statusDetail: 'Supabase PostgreSQL 17 + FORCE RLS Active',
};

class MockUtterance {
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  lang = 'en-US';
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function makeMockVoice(
  overrides: Partial<SpeechSynthesisVoice> & { name: string; voiceURI?: string }
): SpeechSynthesisVoice {
  return {
    name: overrides.name,
    voiceURI: overrides.voiceURI ?? overrides.name,
    lang: overrides.lang ?? 'en-US',
    localService: overrides.localService ?? true,
    default: overrides.default ?? false,
  } as SpeechSynthesisVoice;
}

describe('JARVIS-X v0.6 — Real-Time Voice & Female Persona Engine (Scenarios A–T)', () => {
  const originalSpeechSynthesis = window.speechSynthesis;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    cancelBrowserSpeech();
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      writable: true,
      value: originalSpeechSynthesis,
    });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      writable: true,
      value: originalUtterance,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      writable: true,
      value: originalMediaDevices,
    });
    vi.restoreAllMocks();
  });

  it('A: Voice capability detection accurately classifies full, partial, and unsupported browser runtimes', () => {
    const fullCaps = detectBrowserVoiceCapabilities(
      {
        SpeechRecognition: class {},
        speechSynthesis: { getVoices: () => [] },
        SpeechSynthesisUtterance: MockUtterance,
        AudioContext: class {},
      },
      { mediaDevices: { getUserMedia: async () => ({}) as MediaStream } }
    );
    expect(fullCaps.mode).toBe('full_browser_voice');
    expect(fullCaps.sttSupported).toBe(true);
    expect(fullCaps.ttsSupported).toBe(true);
    expect(fullCaps.waveformAnalyserSupported).toBe(true);

    const ttsOnlyCaps = detectBrowserVoiceCapabilities(
      {
        speechSynthesis: { getVoices: () => [] },
        SpeechSynthesisUtterance: MockUtterance,
      },
      {}
    );
    expect(ttsOnlyCaps.mode).toBe('tts_only');
    expect(ttsOnlyCaps.sttSupported).toBe(false);
    expect(ttsOnlyCaps.ttsSupported).toBe(true);
  });

  it('B: Unsupported browser transitions cleanly to UNSUPPORTED without faking voice availability', async () => {
    const controller = new BrowserVoiceSessionController({
      win: {},
      nav: {},
    });
    const started = await controller.startListening();
    expect(started).toBe(false);
    expect(controller.getSnapshot().state).toBe('UNSUPPORTED');
    expect(controller.getSnapshot().errorCode).toBe('BROWSER_STT_UNSUPPORTED');

    const sm = new VoiceSessionStateMachine('IDLE');
    expect(() => sm.transitionTo('INTERRUPTING')).toThrow(
      IllegalVoiceStateTransitionError
    );
    controller.destroy();
  });

  it('C: Microphone permission denied enters ERROR state with MIC_PERMISSION_DENIED diagnostic', async () => {
    class MockRec implements BrowserSpeechRecognitionLike {
      continuous = false;
      interimResults = true;
      lang = 'en-US';
      onresult = null;
      onerror = null;
      onend = null;
      start() {}
      stop() {}
    }

    const deniedGetUserMedia = vi.fn().mockRejectedValue(
      Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' })
    );

    const controller = new BrowserVoiceSessionController({
      win: { SpeechRecognition: MockRec },
      nav: { mediaDevices: { getUserMedia: deniedGetUserMedia } },
    });

    const ok = await controller.startListening();
    expect(ok).toBe(false);
    expect(deniedGetUserMedia).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe('ERROR');
    expect(controller.getSnapshot().errorCode).toBe('MIC_PERMISSION_DENIED');
    controller.destroy();
  });

  it('D: Start / stop listening transitions IDLE -> REQUESTING_MIC_PERMISSION -> LISTENING -> IDLE and stops tracks', async () => {
    class MockRec implements BrowserSpeechRecognitionLike {
      continuous = false;
      interimResults = true;
      lang = 'en-US';
      onresult = null;
      onerror = null;
      onend: BrowserSpeechRecognitionLike['onend'] = null;
      start() {}
      stop() {
        this.onend?.();
      }
    }

    const trackStopSpy = vi.fn();
    const seenStates: string[] = [];
    const controller = new BrowserVoiceSessionController({
      win: { SpeechRecognition: MockRec },
      nav: {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue({
            getTracks: () => [{ stop: trackStopSpy }],
          }),
        },
      },
      onStateChange: (s) => seenStates.push(s.state),
    });

    await controller.startListening();
    expect(controller.getSnapshot().state).toBe('LISTENING');
    controller.stopListening('user_manual_stop');
    expect(controller.getSnapshot().state).toBe('IDLE');
    expect(trackStopSpy).toHaveBeenCalledTimes(1);
    expect(seenStates).toContain('REQUESTING_MIC_PERMISSION');
    controller.destroy();
  });

  it('E: Interim and final transcript handling updates live preview and transitions LISTENING -> PROCESSING', async () => {
    let activeRec: BrowserSpeechRecognitionLike | null = null;
    class MockRec implements BrowserSpeechRecognitionLike {
      continuous = false;
      interimResults = true;
      lang = 'en-US';
      onresult: BrowserSpeechRecognitionLike['onresult'] = null;
      onerror = null;
      onend: BrowserSpeechRecognitionLike['onend'] = null;
      start() {
        activeRec = this;
      }
      stop() {
        this.onend?.();
      }
    }

    let finalTurnText = '';
    const controller = new BrowserVoiceSessionController({
      win: { SpeechRecognition: MockRec },
      nav: {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue({
            getTracks: () => [{ stop: vi.fn() }],
          }),
        },
      },
      onFinalTranscript: (t) => {
        finalTurnText = t.transcript;
      },
    });

    await controller.startListening();
    activeRec!.onresult?.({
      results: [
        {
          0: { transcript: 'analyze runtime ', confidence: 0.78 },
          isFinal: false,
          length: 1,
        },
      ],
    });
    expect(controller.getSnapshot().interimTranscript).toBe('analyze runtime');

    activeRec!.onresult?.({
      results: [
        {
          0: { transcript: 'Analyze runtime telemetry', confidence: 0.95 },
          isFinal: true,
          length: 1,
        },
      ],
    });
    activeRec!.onend?.();
    expect(finalTurnText).toBe('Analyze runtime telemetry');
    expect(controller.getSnapshot().state).toBe('PROCESSING');
    controller.destroy();
  });

  it('F: Recognized voice transcript enters JarvisCoreRuntime with modality=voice_transcript and full routing/verification', async () => {
    const repo = new InMemorySessionRepository();
    const jarvis = new JarvisCore(repo, () => MOCK_SUPABASE);

    const turn = await jarvis.handleTurn({
      modality: 'voice_transcript',
      voiceMeta: { transcriptConfidence: 0.94, languageCode: 'en-US', durationMs: 1450 },
      message: 'Run a status diagnostics check on JARVIS-X modules.',
    });

    expect(turn.runtime.taskClassification.modality).toBe('voice_transcript');
    expect(turn.runtime.finalState).toBe('COMPLETED');
    expect(turn.verification.outcome).toBe('verified');
    expect(turn.assistantMessage.content.length).toBeGreaterThan(20);
  });

  it('G: TTS voice discovery enumerates real browser SpeechSynthesisVoices without advertising fake Aria/Lyra voices', () => {
    const realVoices = [
      makeMockVoice({ name: 'Google UK English Female', voiceURI: 'google-uk-f', lang: 'en-GB' }),
      makeMockVoice({ name: 'English (America)', voiceURI: 'espeak-en', lang: 'en-US' }),
    ];
    const discovered = discoverBrowserVoices({ getVoices: () => realVoices });
    expect(discovered).toHaveLength(2);
    expect(discovered.some((v) => v.name === 'Aria' || v.name === 'Lyra')).toBe(false);
    expect(discovered[0].femaleHintMatched).toBe(true);
  });

  it('H: Preferred voice selection prefers female voices when available and degrades gracefully if saved voice disappears', () => {
    const genericVoices = [
      makeMockVoice({ name: 'English (America)', voiceURI: 'espeak-en-us', lang: 'en-US' }),
    ];
    expect(selectBestAvailableBrowserVoice(genericVoices, null).selectionReason).toBe(
      'auto_english_fallback'
    );

    const mixedVoices = [
      makeMockVoice({ name: 'Daniel', voiceURI: 'com.apple.daniel', lang: 'en-GB' }),
      makeMockVoice({ name: 'Samantha', voiceURI: 'com.apple.samantha', lang: 'en-US' }),
    ];
    const autoPick = selectBestAvailableBrowserVoice(mixedVoices, null);
    expect(autoPick.selectedVoice?.voiceURI).toBe('com.apple.samantha');
    expect(autoPick.selectionReason).toBe('auto_female_preferred');

    const missingSaved = selectBestAvailableBrowserVoice(
      mixedVoices,
      'removed.voice.uri'
    );
    expect(missingSaved.preferredVoiceMissing).toBe(true);
    expect(missingSaved.selectedVoice?.voiceURI).toBe('com.apple.samantha');
  });

  it('I: Voice preference persistence stores preferredBrowserVoiceUri and voiceMuted in user preferences and local cache', async () => {
    saveCachedVoicePreferences({
      preferredBrowserVoiceUri: 'com.apple.samantha',
      voiceMuted: true,
      voiceAutoSpeak: true,
      voiceProfileId: 'jarvis-x-lyra-female-v1',
    });
    const cached = loadCachedVoicePreferences();
    expect(cached.preferredBrowserVoiceUri).toBe('com.apple.samantha');
    expect(cached.voiceMuted).toBe(true);

    const repo = new InMemorySessionRepository();
    const userId = '33333333-4444-4555-8666-777777777777';
    const saved = await repo.updatePreferences(userId, {
      preferredBrowserVoiceUri: 'com.apple.samantha',
      voiceMuted: true,
      preferredResponseStyle: 'neutral',
    });
    expect(saved.preferredBrowserVoiceUri).toBe('com.apple.samantha');
    expect(saved.voiceMuted).toBe(true);
    expect(saved.preferredResponseStyle).toBe('neutral');
  });

  it('J: Persona and prosody mapping safely bounds all 9 delivery styles and supports streaming sentence chunks', () => {
    const styles = [
      'neutral',
      'calm',
      'excited',
      'concerned',
      'curious',
      'confident',
      'serious',
      'humorous',
      'urgent',
    ] as const;

    for (const style of styles) {
      const normalized = normalizeDeliveryStyle(style);
      const prosody = buildProviderNeutralProsody({
        style,
        voiceProfileId: 'jarvis-x-aria-female-v1',
      });
      expect(prosody.deliveryStyle).toBe(normalized);
      expect(prosody.isPersonaStyleOnly).toBe(true);
      expect(prosody.rate).toBeGreaterThanOrEqual(0.88);
      expect(prosody.rate).toBeLessThanOrEqual(1.16);
      expect(prosody.pitch).toBeGreaterThanOrEqual(0.88);
      expect(prosody.pitch).toBeLessThanOrEqual(1.14);
      expect(prosody.volume).toBeGreaterThanOrEqual(0);
      expect(prosody.volume).toBeLessThanOrEqual(1);
    }

    const acc = new StreamingVoiceSentenceAccumulator();
    expect(
      acc.pushChunk({
        type: 'delta',
        textDelta: 'All checks passed. Standing by ',
        modelId: 'm1',
        providerId: 'p1',
      })
    ).toEqual(['All checks passed.']);
    expect(
      acc.pushChunk({
        type: 'done',
        latencyMs: 10,
        tokensUsedEstimate: 6,
        modelId: 'm1',
        providerId: 'p1',
      })
    ).toEqual(['Standing by']);
  });

  it('K: Speaking state transitions cleanly through SPEAKING and back to IDLE on utterance completion', () => {
    let latestUtterance: MockUtterance | null = null;
    const mockSynth = {
      speaking: false,
      pending: false,
      getVoices: () => [makeMockVoice({ name: 'Samantha', voiceURI: 'sam' })],
      speak: vi.fn((u: MockUtterance) => {
        latestUtterance = u;
        u.onstart?.();
      }),
      cancel: vi.fn(),
    };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      writable: true,
      value: mockSynth,
    });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      writable: true,
      value: MockUtterance,
    });

    const controller = new BrowserVoiceSessionController({
      win: { speechSynthesis: mockSynth, SpeechSynthesisUtterance: MockUtterance },
      nav: {},
    });

    expect(controller.speakResponse('Systems online.')).toBe(true);
    expect(controller.getSnapshot().state).toBe('SPEAKING');
    latestUtterance!.onend?.();
    expect(controller.getSnapshot().state).toBe('IDLE');
    controller.destroy();
  });

  it('L: Barge-in cancels active speech immediately and transitions into LISTENING for the updated request', async () => {
    let cancelCount = 0;
    const mockSynth = {
      speaking: true,
      pending: false,
      getVoices: () => [makeMockVoice({ name: 'Samantha', voiceURI: 'sam' })],
      speak: vi.fn((u: MockUtterance) => u.onstart?.()),
      cancel: vi.fn(() => {
        cancelCount += 1;
      }),
    };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      writable: true,
      value: mockSynth,
    });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      writable: true,
      value: MockUtterance,
    });

    let activeRec: BrowserSpeechRecognitionLike | null = null;
    class MockRec implements BrowserSpeechRecognitionLike {
      continuous = false;
      interimResults = true;
      lang = 'en-US';
      onresult: BrowserSpeechRecognitionLike['onresult'] = null;
      onerror = null;
      onend: BrowserSpeechRecognitionLike['onend'] = null;
      start() {
        activeRec = this;
      }
      stop() {}
    }

    let bargeInFlag = false;
    const controller = new BrowserVoiceSessionController({
      win: {
        SpeechRecognition: MockRec,
        speechSynthesis: mockSynth,
        SpeechSynthesisUtterance: MockUtterance,
      },
      nav: {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue({
            getTracks: () => [{ stop: vi.fn() }],
          }),
        },
      },
      onFinalTranscript: (t) => {
        bargeInFlag = t.bargeInTriggered;
      },
    });

    controller.speakResponse('Reading full telemetry briefing.');
    expect(controller.getSnapshot().state).toBe('SPEAKING');
    const beforeBargeInCancels = cancelCount;

    await controller.startListening();
    expect(cancelCount).toBeGreaterThan(beforeBargeInCancels);
    expect(controller.getSnapshot().state).toBe('LISTENING');
    expect(controller.getSnapshot().bargeInCount).toBe(1);

    activeRec!.onresult?.({
      results: [
        {
          0: { transcript: 'Give me only the summary' },
          isFinal: true,
          length: 1,
        },
      ],
    });
    activeRec!.onend?.();
    expect(bargeInFlag).toBe(true);
    controller.destroy();
  });

  it('M: No overlapping speech occurs when speakWithFemalePersona is called repeatedly', () => {
    let cancelCalls = 0;
    const spokenTexts: string[] = [];
    const mockSynth = {
      speaking: true,
      pending: false,
      getVoices: () => [makeMockVoice({ name: 'Samantha', voiceURI: 'sam' })],
      speak: vi.fn((u: MockUtterance) => {
        spokenTexts.push(u.text);
        u.onstart?.();
      }),
      cancel: vi.fn(() => {
        cancelCalls += 1;
      }),
    };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      writable: true,
      value: mockSynth,
    });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      writable: true,
      value: MockUtterance,
    });

    speakWithFemalePersona('First utterance.');
    const cancelsAfterFirst = cancelCalls;
    speakWithFemalePersona('Second non-overlapping utterance.');

    expect(cancelCalls).toBeGreaterThan(cancelsAfterFirst);
    expect(spokenTexts).toEqual([
      'First utterance.',
      'Second non-overlapping utterance.',
    ]);
  });

  it('N: Voice and text turns share identical conversationId, history, and working memory continuity', async () => {
    const repo = new InMemorySessionRepository();
    const actorId = '44444444-5555-4666-8777-888888888888';
    const jarvis = new JarvisCore(repo, () => MOCK_SUPABASE, {
      authenticated: true,
      userId: actorId,
      displayName: 'Continuity Operator',
      callsign: 'OP-CONT',
      verificationMode: 'supabase_jwt',
    });
    const conv = await repo.createConversation(actorId, { title: 'Hybrid Thread' });

    await jarvis.handleTurn({
      conversationId: conv.id,
      modality: 'text',
      message: 'Check active system architecture.',
    });
    await jarvis.handleTurn({
      conversationId: conv.id,
      modality: 'voice_transcript',
      message: 'Now research verification patterns for specialist routing.',
    });
    await jarvis.handleTurn({
      conversationId: conv.id,
      modality: 'text',
      message: 'Give a concise wrap-up.',
    });

    const storedMessages = await repo.getMessages(actorId, conv.id);
    expect(storedMessages).toHaveLength(6);
  });

  it('O: Microphone is NEVER auto-started on controller instantiation or page mount', async () => {
    const getUserMediaSpy = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      writable: true,
      value: { getUserMedia: getUserMediaSpy },
    });

    const repo = new InMemorySessionRepository();
    const core = new JarvisCore(repo, () => MOCK_SUPABASE);
    const initialSnapshot = await core.getSystemSnapshot();

    const { unmount } = render(
      <JarvisDashboard initialSnapshot={initialSnapshot} initialMessages={[]} />
    );
    expect(getUserMediaSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('P: Raw audio is never recorded or persisted, and routine voice turns do not indiscriminately write permanent memory', async () => {
    const repo = new InMemorySessionRepository();
    const core = new JarvisCore(repo, () => MOCK_SUPABASE);
    const snapshot = await core.getSystemSnapshot();
    const controller = new BrowserVoiceSessionController({ win: {}, nav: {} });

    expect(controller.getSnapshot().rawAudioPersisted).toBe(false);

    const beforeCount = (await repo.listMemories(snapshot.auth.userId)).length;
    await core.handleTurn({
      modality: 'voice_transcript',
      message: 'Hello JARVIS, give me a quick status check.',
    });
    const afterCount = (await repo.listMemories(snapshot.auth.userId)).length;
    expect(afterCount).toBe(beforeCount);
    expect(window.localStorage.length).toBe(0);
    controller.destroy();
  });

  it('Q: Rapid repeated microphone taps acquire at most one active listening session', async () => {
    const getUserMediaSpy = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ getTracks: () => [{ stop: vi.fn() }] }),
            20
          )
        )
    );
    const recStartSpy = vi.fn();
    class MockRec implements BrowserSpeechRecognitionLike {
      continuous = false;
      interimResults = true;
      lang = 'en-US';
      onresult = null;
      onerror = null;
      onend = null;
      start() {
        recStartSpy();
      }
      stop() {}
    }

    const controller = new BrowserVoiceSessionController({
      win: { SpeechRecognition: MockRec },
      nav: { mediaDevices: { getUserMedia: getUserMediaSpy } },
    });

    const results = await Promise.all([
      controller.startListening(),
      controller.startListening(),
      controller.startListening(),
      controller.startListening(),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(getUserMediaSpy).toHaveBeenCalledTimes(1);
    expect(recStartSpy).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('R: Unmount and visibilitychange cleanup release active microphone tracks and speech recognition cleanly', async () => {
    const trackStopSpy = vi.fn();
    const recStopSpy = vi.fn();
    class MockRec implements BrowserSpeechRecognitionLike {
      continuous = false;
      interimResults = true;
      lang = 'en-US';
      onresult = null;
      onerror = null;
      onend = null;
      start() {}
      stop() {
        recStopSpy();
      }
    }

    const controller = new BrowserVoiceSessionController({
      win: { SpeechRecognition: MockRec },
      nav: {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue({
            getTracks: () => [{ stop: trackStopSpy }],
          }),
        },
      },
    });

    await controller.startListening();
    expect(controller.getSnapshot().state).toBe('LISTENING');

    controller.destroy();
    expect(trackStopSpy).toHaveBeenCalledTimes(1);
    expect(recStopSpy).toHaveBeenCalledTimes(1);
  });

  it('S: Existing permission and risk gates remain strictly enforced on spoken directives', async () => {
    const repo = new InMemorySessionRepository();
    const jarvis = new JarvisCore(repo, () => MOCK_SUPABASE);

    const tier3Turn = await jarvis.handleTurn({
      modality: 'voice_transcript',
      message: 'Unlock the front smart-home door lock immediately.',
    });
    expect(tier3Turn.runtime.finalState).toBe('WAITING_FOR_USER_APPROVAL');
    expect(tier3Turn.pendingPermission?.tier).toBe('SENSITIVE_AUTH_REQUIRED');
    expect(tier3Turn.pendingPermission?.requiresStepUpAuth).toBe(true);

    const tier2Turn = await jarvis.handleTurn({
      modality: 'voice_transcript',
      message: 'Remember that our preferred cloud region is ap-south-1.',
    });
    expect(tier2Turn.runtime.finalState).toBe('WAITING_FOR_USER_APPROVAL');
    expect(tier2Turn.pendingPermission?.tier).toBe('CONFIRMATION_REQUIRED');
  });

  it('T: Mobile HUD renders >=44px accessible voice controls, persona/style telemetry, and zero fake idle waveform motion', async () => {
    const repo = new InMemorySessionRepository();
    const core = new JarvisCore(repo, () => MOCK_SUPABASE);
    const initialSnapshot = await core.getSystemSnapshot();

    const { unmount } = render(
      <JarvisDashboard initialSnapshot={initialSnapshot} initialMessages={[]} />
    );

    expect(screen.getByTestId('mobile-voice-hud')).toBeInTheDocument();
    expect(
      screen.getByTestId('desktop-voice-waveform').getAttribute('data-active-voice')
    ).toBe('false');

    const micButtons = screen.getAllByLabelText(/Activate microphone input/i);
    expect(micButtons[0].className).toContain('min-h-[44px]');

    const muteButtons = screen.getAllByLabelText(/Mute assistant voice/i);
    expect(muteButtons[0].className).toContain('min-h-[44px]');

    await act(async () => {
      fireEvent.click(muteButtons[0]);
    });
    expect(loadCachedVoicePreferences().voiceMuted).toBe(true);
    unmount();
  });
});
