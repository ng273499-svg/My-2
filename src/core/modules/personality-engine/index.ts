import {
  buildProviderNeutralProsody,
  normalizeDeliveryStyle,
} from '@/core/voice';
import type {
  DeliveryStyleInput,
  PersonalityPreferences,
  ResponseStyle,
  VoiceProsodyHint,
} from '@/core/types';

export interface VoicePersonaProfile {
  id: string;
  name: string;
  timbreDescription: string;
  genderPresentation: 'female';
  /**
   * Honest architectural marker: Aria and Lyra are JARVIS-X persona/prosody profiles,
   * NOT bundled named system voices unless an external neural provider is linked.
   */
  isPersonaStyleProfileOnly: boolean;
  providerBound: boolean;
}

export const FEMALE_VOICE_PROFILES: VoicePersonaProfile[] = [
  {
    id: 'jarvis-x-aria-female-v1',
    name: 'Aria Persona Profile (Calm Articulate)',
    timbreDescription:
      'Persona & prosody profile: intelligent, calm, composed cadence mapped onto an available device/browser voice.',
    genderPresentation: 'female',
    isPersonaStyleProfileOnly: true,
    providerBound: false,
  },
  {
    id: 'jarvis-x-lyra-female-v1',
    name: 'Lyra Persona Profile (Crisp Tactical)',
    timbreDescription:
      'Persona & prosody profile: crisp, focused technical briefing cadence mapped onto an available device/browser voice.',
    genderPresentation: 'female',
    isPersonaStyleProfileOnly: true,
    providerBound: false,
  },
];

/**
 * Personality Engine (JARVIS-X v0.6)
 * Defines JARVIS-X's consistent female persona layer (intelligent, calm, highly capable,
 * concise, confident, friendly, professional, occasionally witty when appropriate) and
 * maps expressive conversational styles into bounded, provider-neutral prosody hints.
 *
 * Explicit boundary: Expressive styles are conversational framing only — JARVIS-X never
 * claims genuine human emotions or consciousness.
 */
export class PersonalityEngine {
  buildSystemDirective(
    styleInput: DeliveryStyleInput,
    preferences: PersonalityPreferences
  ): string {
    const style = normalizeDeliveryStyle(styleInput);
    const witInstruction =
      preferences.witLevel === 'minimal'
        ? 'Keep humor minimal; prioritize crisp precision.'
        : preferences.witLevel === 'moderate'
          ? 'Include occasional dry, intelligent wit when appropriate without sacrificing clarity.'
          : 'Remain friendly, composed, and occasionally subtly witty while staying concise.';

    return [
      'Identity: JARVIS-X — an intelligent, calm, highly capable, concise, confident, friendly, and professional personal multimodal AI assistant.',
      `Active Delivery Style: ${style.toUpperCase()} (expressive conversational style only; never claim biological human emotions, sentience, or consciousness).`,
      `Conciseness Preference: ${preferences.conciseness}.`,
      witInstruction,
      'Integrity Rule: Never claim an unconfigured integration, external API, named voice binary, or device action succeeded if it is not actually available and verified.',
    ].join('\n');
  }

  buildVoiceProsodyHint(
    styleInput: DeliveryStyleInput,
    voiceProfileId: string,
    muted = false
  ): VoiceProsodyHint {
    const prosody = buildProviderNeutralProsody({
      style: styleInput,
      voiceProfileId,
      muted,
    });

    return {
      style: prosody.deliveryStyle,
      voiceProfileId: prosody.personaProfileId,
      speakingRate: prosody.rate,
      pitch: prosody.pitch,
      volume: prosody.volume,
      pitchContour: prosody.pitchContour,
      clausePauseMs: prosody.clausePauseMs,
    };
  }

  styleLeadIn(
    styleInput: DeliveryStyleInput,
    witLevel: PersonalityPreferences['witLevel']
  ): string {
    const style: ResponseStyle = normalizeDeliveryStyle(styleInput);
    switch (style) {
      case 'urgency':
        return 'Priority acknowledged.';
      case 'seriousness':
        return 'Security protocol active.';
      case 'concern':
        return 'Let’s isolate that cleanly.';
      case 'excitement':
        return 'Gladly — strong trajectory here.';
      case 'curiosity':
        return 'Interesting angle to examine.';
      case 'humor':
        return witLevel === 'minimal'
          ? 'Understood.'
          : 'All primary thrusters nominal — metaphorically speaking, of course.';
      case 'confidence':
        return 'Systems aligned.';
      case 'neutral':
        return 'Ready.';
      case 'calm':
      default:
        return 'At your service.';
    }
  }
}
