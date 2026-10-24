import {
  FEMALE_VOICE_PROFILES,
  type VoicePersonaProfile,
} from '@/core/modules/personality-engine';
import {
  OpenAISpeechAdapter,
  VoiceBargeInController,
  buildFemaleProsodyPlan,
  type FemaleProsodySynthesisPlan,
  type VoiceSessionMachineState,
  type VoiceSessionState,
} from '@/core/voice';
import type { DeliveryStyleInput, VoiceProsodyHint } from '@/core/types';

export type VoiceBargeInState = VoiceSessionState;

export interface SpeechToTextProvider {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  transcribeChunk(audioPcm: Uint8Array): Promise<{ text: string; isFinal: boolean }>;
}

export interface TextToSpeechProvider {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  synthesize(text: string, prosody: VoiceProsodyHint): Promise<Uint8Array>;
}

export interface VoiceEngineDiagnostics {
  neuralSttConnected: boolean;
  neuralTtsConnected: boolean;
  zeroCostBrowserModeDefault: boolean;
  bargeInControllerReady: boolean;
  bargeInState: VoiceBargeInState;
  sessionMachineState: VoiceSessionMachineState;
  bargeInInterruptionsCount: number;
  activeFemaleVoiceProfile: VoicePersonaProfile;
  availableProfiles: VoicePersonaProfile[];
  browserSpeechHint: string;
}

/**
 * Voice Engine (JARVIS-X v0.6 Real-Time Voice & Female Persona Engine)
 * Coordinates JARVIS-X female persona/style profiles (`Aria` / `Lyra`), bounded
 * 9-style provider-neutral prosody, explicit `VoiceSessionStateMachine`, full-duplex
 * barge-in interruption, and zero-cost Browser Web Speech discovery/playback (₹0 cost).
 * Never claims Aria or Lyra are real system voice binaries unless bound to a real engine.
 */
export class VoiceEngine {
  private sttProvider: SpeechToTextProvider | null = null;
  private ttsProvider: TextToSpeechProvider | null = null;
  private readonly defaultNeuralSpeech: OpenAISpeechAdapter;
  public readonly bargeInController: VoiceBargeInController;

  constructor(options?: { neuralSpeechAdapter?: OpenAISpeechAdapter }) {
    this.defaultNeuralSpeech = options?.neuralSpeechAdapter ?? new OpenAISpeechAdapter();
    this.bargeInController = new VoiceBargeInController();
  }

  registerSpeechToText(provider: SpeechToTextProvider): void {
    this.sttProvider = provider;
  }

  registerTextToSpeech(provider: TextToSpeechProvider): void {
    this.ttsProvider = provider;
  }

  startListening(): VoiceBargeInState {
    return this.bargeInController.startListening();
  }

  startSpeaking(turnId?: string): VoiceBargeInState {
    return this.bargeInController.startSpeaking(turnId);
  }

  triggerBargeInInterrupt(): VoiceBargeInState {
    return this.bargeInController.triggerBargeIn().newState;
  }

  resetBargeInState(): void {
    this.bargeInController.reset();
  }

  prepareFemaleSpeech(
    text: string,
    style: DeliveryStyleInput = 'calm',
    profileId = 'jarvis-x-aria-female-v1',
    muted = false
  ): FemaleProsodySynthesisPlan {
    return buildFemaleProsodyPlan(text, style, profileId, muted);
  }

  async synthesizeSpeechIfConfigured(
    text: string,
    style: DeliveryStyleInput = 'calm',
    profileId = 'jarvis-x-aria-female-v1'
  ): Promise<{
    plan: FemaleProsodySynthesisPlan;
    audioMp3Base64: string | null;
    providerMode: 'server_neural_tts' | 'browser_webspeech_fallback';
  }> {
    const plan = this.prepareFemaleSpeech(text, style, profileId);

    if (this.ttsProvider?.isConfigured()) {
      this.bargeInController.startSpeaking();
      const bytes = await this.ttsProvider.synthesize(plan.spokenScript, {
        style: plan.style,
        voiceProfileId: plan.voiceProfileId,
        speakingRate: plan.speakingRate,
        pitch: plan.pitch,
        volume: plan.volume,
        pitchContour: plan.pitchContour,
        clausePauseMs: plan.clausePauseMs,
      });
      return {
        plan,
        audioMp3Base64: Buffer.from(bytes).toString('base64'),
        providerMode: 'server_neural_tts',
      };
    }

    if (this.defaultNeuralSpeech.isConfigured()) {
      this.bargeInController.startSpeaking();
      const bytes = await this.defaultNeuralSpeech.synthesizeFemaleSpeech(plan);
      return {
        plan,
        audioMp3Base64: Buffer.from(bytes).toString('base64'),
        providerMode: 'server_neural_tts',
      };
    }

    return {
      plan,
      audioMp3Base64: null,
      providerMode: 'browser_webspeech_fallback',
    };
  }

  getDiagnostics(selectedProfileId = 'jarvis-x-aria-female-v1'): VoiceEngineDiagnostics {
    const profile =
      FEMALE_VOICE_PROFILES.find((p) => p.id === selectedProfileId) ??
      FEMALE_VOICE_PROFILES[0];

    const sttReady = Boolean(
      this.sttProvider?.isConfigured() ||
        this.defaultNeuralSpeech.isConfigured() ||
        process.env.SPEECH_STT_PROVIDER_URL
    );
    const ttsReady = Boolean(
      this.ttsProvider?.isConfigured() ||
        this.defaultNeuralSpeech.isConfigured() ||
        process.env.SPEECH_TTS_PROVIDER_URL
    );

    return {
      neuralSttConnected: sttReady,
      neuralTtsConnected: ttsReady,
      zeroCostBrowserModeDefault: !ttsReady,
      bargeInControllerReady: true,
      bargeInState: this.bargeInController.state,
      sessionMachineState: this.bargeInController.machineState,
      bargeInInterruptionsCount: this.bargeInController.totalInterruptions,
      activeFemaleVoiceProfile: {
        ...profile,
        providerBound: ttsReady,
      },
      availableProfiles: FEMALE_VOICE_PROFILES,
      browserSpeechHint: ttsReady
        ? 'Optional server neural speech adapter is configured alongside client barge-in.'
        : 'Zero-cost Browser Voice Mode (₹0 API cost): Aria/Lyra act as persona/prosody profiles; actual STT/TTS uses genuinely available browser SpeechRecognition & SpeechSynthesis voices where supported.',
    };
  }

  previewProsodyDescriptor(
    style: DeliveryStyleInput,
    profileId = 'jarvis-x-aria-female-v1'
  ): string {
    const plan = this.prepareFemaleSpeech('Ready.', style, profileId);
    const diag = this.getDiagnostics(profileId);
    return `${plan.personaName} · Style=${plan.style.toUpperCase()} (rate=${plan.speakingRate}x, pitch=${plan.pitch}) · Engine: ${
      diag.neuralTtsConnected
        ? 'Server Neural TTS'
        : 'Zero-Cost Browser SpeechSynthesis (where supported)'
    }`;
  }
}
