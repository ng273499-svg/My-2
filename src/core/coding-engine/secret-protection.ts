/**
 * JARVIS-X v1.1.0 — Secret Protection
 * Redacts secrets from command output, logs, and model context.
 * Never exposes .env values, service-role keys, API keys, tokens, or private keys.
 */

const SECRET_PATTERNS = [
  // Exact env var names
  /(SUPABASE_SERVICE_ROLE_KEY\s*=\s*)(\S+)/gi,
  /(SUPABASE_ANON_KEY\s*=\s*)(\S+)/gi,
  /(OPENAI_API_KEY\s*=\s*)(\S+)/gi,
  /(ANTHROPIC_API_KEY\s*=\s*)(\S+)/gi,
  /(GEMINI_API_KEY\s*=\s*)(\S+)/gi,
  /(GROQ_API_KEY\s*=\s*)(\S+)/gi,
  /(JARVIS_STEP_UP_PASSCODE\s*=\s*)(\S+)/gi,
  // Bearer tokens
  /(Bearer\s+)([A-Za-z0-9\-_.~+/]{20,})/gi,
  // sk- keys (OpenAI/Anthropic style)
  /\b(sk-(?:proj-)?[A-Za-z0-9]{20,})\b/g,
  /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
  // sb_secret_ tokens
  /\b(sb_secret_[A-Za-z0-9_-]{16,})\b/g,
  // GitHub PATs
  /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
  // Generic API key assignments
  /(api[_-]?key\s*[:=]\s*)["']?([A-Za-z0-9\-_.]{20,})["']?/gi,
  // Private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----/gi,
];

export class SecretProtection {
  redact(text: string): { sanitized: string; redactionCount: number } {
    let count = 0;
    let sanitized = text;

    for (const pattern of SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, (match) => {
        count += 1;
        return '[REDACTED_SECRET]';
      });
    }

    return { sanitized, redactionCount: count };
  }

  redactObject<T extends Record<string, unknown>>(obj: T): { sanitized: T; redactionCount: number } {
    let count = 0;
    const sanitized = JSON.parse(JSON.stringify(obj)) as T;

    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const { sanitized: s, redactionCount: c } = this.redact(value);
        count += c;
        return s;
      }
      if (Array.isArray(value)) {
        return value.map((v) => walk(v));
      }
      if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          // Redact known sensitive key names
          if (/key|token|secret|password|passcode/i.test(k)) {
            count += 1;
            result[k] = '[REDACTED_SECRET]';
          } else {
            result[k] = walk(v);
          }
        }
        return result;
      }
      return value;
    };

    const walked = walk(sanitized) as T;
    return { sanitized: walked, redactionCount: count };
  }

  isSecretKeyName(key: string): boolean {
    return /(api[_-]?key|secret|token|password|passcode|private_key|service_role)/i.test(key);
  }
}