import type { ProviderConfigState } from '@/core/types';

/**
 * Redacts potential API keys, Bearer tokens, JWTs, or secret credentials from
 * error strings, telemetry summaries, and trace attributes before storage or display.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-ant-[A-Za-z0-9_\-]{8,}\b/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/\bsk-[A-Za-z0-9_\-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bAIza[0-9A-Za-z_\-]{16,}\b/g, '[REDACTED_GEMINI_KEY]')
    .replace(/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/(api[_-]?key|x-api-key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

export interface ServerProviderCredentials {
  openaiApiKey?: string;
  openaiBaseUrl: string;
  anthropicApiKey?: string;
  anthropicBaseUrl: string;
  geminiApiKey?: string;
  geminiBaseUrl: string;
  compatibleApiKey?: string;
  compatibleBaseUrl?: string;
  compatibleModelId?: string;
}

/**
 * Resolves AI provider configuration strictly from server-side environment variables.
 * Never reads `NEXT_PUBLIC_*` variables for provider credentials so secrets can
 * never be inlined into browser bundles by Next.js.
 */
export function resolveServerProviderCredentials(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}
): ServerProviderCredentials {
  const clean = (val?: string) => {
    const trimmed = val?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  };

  return {
    openaiApiKey: clean(env.OPENAI_API_KEY),
    openaiBaseUrl: clean(env.OPENAI_BASE_URL) ?? 'https://api.openai.com/v1',
    anthropicApiKey: clean(env.ANTHROPIC_API_KEY),
    anthropicBaseUrl: clean(env.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com/v1',
    geminiApiKey: clean(env.GEMINI_API_KEY),
    geminiBaseUrl:
      clean(env.GEMINI_BASE_URL) ?? 'https://generativelanguage.googleapis.com/v1beta',
    compatibleApiKey: clean(env.COMPATIBLE_OPENAI_API_KEY),
    compatibleBaseUrl: clean(env.COMPATIBLE_OPENAI_BASE_URL),
    compatibleModelId: clean(env.COMPATIBLE_OPENAI_MODEL_ID),
  };
}

export function getProviderConfigState(hasRequiredCredentials: boolean): ProviderConfigState {
  return hasRequiredCredentials ? 'CONFIGURED' : 'UNCONFIGURED';
}
