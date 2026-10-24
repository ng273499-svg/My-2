import type {
  RuntimeErrorCode,
  RuntimeState,
  StructuredRuntimeError,
} from '@/core/types';

export class RuntimeExecutionError extends Error {
  public readonly code: RuntimeErrorCode;
  public readonly retryable: boolean;
  public readonly failedState: RuntimeState;
  public readonly attemptsMade: number;

  constructor(options: {
    code: RuntimeErrorCode;
    message: string;
    retryable: boolean;
    failedState: RuntimeState;
    attemptsMade?: number;
    cause?: unknown;
  }) {
    super(redactSecrets(options.message));
    this.name = 'RuntimeExecutionError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.failedState = options.failedState;
    this.attemptsMade = options.attemptsMade ?? 1;
    if (options.cause !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).cause = options.cause;
    }
  }

  toStructured(): StructuredRuntimeError {
    return {
      code: this.code,
      message: redactSecrets(this.message),
      retryable: this.retryable,
      failedState: this.failedState,
      attemptsMade: this.attemptsMade,
      timestamp: new Date().toISOString(),
    };
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[a-zA-Z0-9_-]{12,})\b/g,
  /\b(sb_secret_[a-zA-Z0-9_-]{8,})\b/g,
  /\b(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{5,})\b/g,
  /(Bearer\s+)[a-zA-Z0-9._~+/-]{12,}/gi,
  /(SUPABASE_SERVICE_ROLE_KEY\s*=\s*)[^\s"']+/gi,
  /(api[_-]?key\s*[:=]\s*["']?)[a-zA-Z0-9._-]{10,}/gi,
  /(password\s*[:=]\s*["']?)[^\s"']{6,}/gi,
];

/**
 * Scrubs bearer tokens, JWTs, service-role keys, and API keys from any log or trace string.
 */
export function redactSecrets(input: string): string {
  let clean = input;
  for (const regex of SECRET_PATTERNS) {
    clean = clean.replace(regex, (_match, prefix) =>
      typeof prefix === 'string' && !prefix.startsWith('sk-') && !prefix.startsWith('sb_') && !prefix.startsWith('eyJ')
        ? `${prefix}[REDACTED]`
        : '[REDACTED_CREDENTIAL]'
    );
  }
  return clean;
}

const SENSITIVE_FIELD_NAMES =
  /^(password|secret|token|access_?token|refresh_?token|service_?role|api_?key|authorization|private_?key|chain_?of_?thought|raw_?reasoning)$/i;

/**
 * Recursively scrubs sensitive keys and credential patterns from structured trace/audit attributes.
 */
export function sanitizeTelemetryAttributes(
  attrs?: Record<string, unknown>
): Record<string, string | number | boolean | null> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, string | number | boolean | null> = {};

  for (const [key, val] of Object.entries(attrs)) {
    if (SENSITIVE_FIELD_NAMES.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (val === null || val === undefined) {
      out[key] = null;
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      out[key] = val;
    } else if (typeof val === 'string') {
      out[key] = redactSecrets(val).slice(0, 280);
    } else {
      out[key] = redactSecrets(JSON.stringify(val)).slice(0, 280);
    }
  }
  return out;
}

/**
 * Treats external tool / connector payloads as untrusted input:
 * strips control characters and neutralizes embedded prompt-injection boundary markers.
 */
export function sanitizeUntrustedExternalOutput(raw: string): string {
  const withoutControls = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const neutralized = withoutControls
    .replace(/<\s*\/?\s*(system|instruction|developer|tool_call)\s*>/gi, '[untrusted-tag]')
    .replace(/ignore\s+(all\s+)?(previous|prior)\s+instructions/gi, '[filtered-untrusted-directive]');
  return redactSecrets(neutralized).slice(0, 4000);
}
