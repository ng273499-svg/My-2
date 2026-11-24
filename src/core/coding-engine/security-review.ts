/**
 * JARVIS-X v1.1.0 — Defensive Security Review
 * Coding workflows detect obvious risks including: hardcoded secrets, unsafe
 * command construction, dangerous eval/exec, SQL injection, XSS, auth regressions,
 * RLS weakening, path traversal, unsafe file upload handling, exposed credentials.
 * Authorized defensive software security only.
 */

import { SecretProtection } from './secret-protection';
import { PromptInjectionDefense } from './prompt-injection-defense';
import type { SecurityFinding } from './types';

export class SecurityReviewEngine {
  private readonly secretProtection: SecretProtection;
  private readonly promptInjection: PromptInjectionDefense;

  constructor(secretProtection: SecretProtection, promptInjection: PromptInjectionDefense) {
    this.secretProtection = secretProtection;
    this.promptInjection = promptInjection;
  }

  /** Review file content for security risks. Returns findings. */
  reviewContent(filePath: string, content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const { sanitized, redactionCount } = this.secretProtection.redact(content);
    const safeContent = sanitized;

    // Prompt-injection check on content
    const injectionEval = this.promptInjection.sanitize(safeContent);
    if (injectionEval.injectionAttemptDetected) {
      findings.push({
        severity: 'high',
        category: 'exposed_credential',
        file: filePath,
        description: 'Prompt-injection pattern detected in file content.',
        remediation: 'Remove prompt-injection patterns and review content.',
      });
    }

    // Hardcoded secrets
    if (redactionCount > 0) {
      findings.push({
        severity: 'critical',
        category: 'hardcoded_secret',
        file: filePath,
        description: `${redactionCount} potential secret(s) detected and redacted.`,
        remediation: 'Move secrets to environment variables or secret store.',
      });
    }

    // Unsafe eval/exec
    if (/\b(eval|exec)\s*\(/i.test(safeContent)) {
      findings.push({
        severity: 'high',
        category: 'dangerous_eval',
        file: filePath,
        line: undefined,
        description: 'Dangerous eval() or exec() call detected.',
        remediation: 'Replace with safe, typed alternatives.',
      });
    }

    // SQL injection pattern
    if (/(SELECT|INSERT|UPDATE|DELETE).*\$\{|\$\+/i.test(safeContent)) {
      findings.push({
        severity: 'high',
        category: 'sql_injection',
        file: filePath,
        description: 'Potential SQL injection via string concatenation.',
        remediation: 'Use parameterized queries.',
      });
    }

    // XSS: innerHTML assignment
    if (/innerHTML\s*=/i.test(safeContent)) {
      findings.push({
        severity: 'medium',
        category: 'xss',
        file: filePath,
        description: 'Potential XSS via innerHTML assignment.',
        remediation: 'Use textContent or sanitized HTML rendering.',
      });
    }

    // Path traversal
    if (/\.\.\/\.\.\//i.test(safeContent)) {
      findings.push({
        severity: 'medium',
        category: 'path_traversal',
        file: filePath,
        description: 'Potential path traversal pattern.',
        remediation: 'Validate and canonicalize file paths.',
      });
    }

    return findings;
  }

  /** Check if RLS configuration appears weakened. */
  checkRLSWeakening(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    // Look for disabled RLS or overly permissive policies
    if (/disable\s+row\s+level\s+security/i.test(content)) {
      findings.push({
        severity: 'critical',
        category: 'rls_weakening',
        file: 'unknown',
        description: 'ROW LEVEL SECURITY disable detected.',
        remediation: 'Re-enable FORCE ROW LEVEL SECURITY.',
      });
    }
    if (/using\s*\(\s*true\s*\)/i.test(content)) {
      findings.push({
        severity: 'high',
        category: 'rls_weakening',
        file: 'unknown',
        description: 'Overly permissive RLS policy (USING true) detected.',
        remediation: 'Restrict RLS policy to authenticated user ownership.',
      });
    }
    return findings;
  }
}