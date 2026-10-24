-- =============================================================================
-- JARVIS-X v0.6 — Real-Time Voice & Female Persona Preference Extensions
-- Additive, non-destructive columns & neutral response-style check updates
-- on public.preferences and public.conversation_messages (FORCE RLS preserved).
-- =============================================================================

ALTER TABLE public.preferences
  ADD COLUMN IF NOT EXISTS preferred_browser_voice_uri TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS voice_muted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.preferences
  DROP CONSTRAINT IF EXISTS preferences_preferred_response_style_check;

ALTER TABLE public.preferences
  ADD CONSTRAINT preferences_preferred_response_style_check CHECK (
    preferred_response_style IN (
      'neutral',
      'calm',
      'excitement',
      'concern',
      'curiosity',
      'confidence',
      'seriousness',
      'humor',
      'urgency'
    )
  );

ALTER TABLE public.conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_response_style_check;

ALTER TABLE public.conversation_messages
  ADD CONSTRAINT conversation_messages_response_style_check CHECK (
    response_style IN (
      'neutral',
      'calm',
      'excitement',
      'concern',
      'curiosity',
      'confidence',
      'seriousness',
      'humor',
      'urgency'
    )
  );

COMMENT ON COLUMN public.preferences.preferred_browser_voice_uri IS
  'Optional manually selected SpeechSynthesisVoice.voiceURI on the operator device/browser (NULL = automatic female-preferred voice discovery).';

COMMENT ON COLUMN public.preferences.voice_muted IS
  'Whether spoken TTS output is muted by the operator while preserving full text responses.';
