/**
 * JARVIS-X v1.1.0 — Evidence-Based Verification
 * A task is not complete just because code was generated. Verification uses
 * available evidence: patch applied, syntax valid, typecheck, lint, tests,
 * build, requested behavior, security checks.
 * Statuses: VERIFIED, PARTIALLY_VERIFIED, UNVERIFIED, FAILED.
 * Never claims VERIFIED without evidence.
 */

import { CodingEngine } from './index';
import { SecretProtection } from './secret-protection';
import type { CodingTaskResult } from './types';
import type { RuntimeVerificationStatus } from '@/core/types';

export class EvidenceVerifier {
  private readonly engine: CodingEngine;
  private readonly secretProtection: SecretProtection;

  constructor(engine: CodingEngine, secretProtection: SecretProtection) {
    this.engine = engine;
    this.secretProtection = secretProtection;
  }

  /** Verify a coding task result against available evidence. */
  async verify(result: CodingTaskResult): Promise<{ status: RuntimeVerificationStatus; warnings: string[] }> {
    const warnings: string[] = [];
    let status: RuntimeVerificationStatus = 'NOT_VERIFIABLE';

    const { testEvidence } = result;

    // Check all evidence dimensions
    const typecheckPassed = testEvidence.typecheckPassed;
    const testPassed = testEvidence.testPassed;
    const buildPassed = testEvidence.buildPassed;
    const noErrors = result.errors.length === 0;
    const noWarnings = result.warnings.length === 0;

    if (typecheckPassed && testPassed && buildPassed && noErrors && noWarnings) {
      status = 'VERIFIED';
    } else if (typecheckPassed || testPassed || buildPassed) {
      // At least one dimension passed — partial verification
      status = 'PARTIALLY_VERIFIED';
      if (!typecheckPassed) warnings.push('Typecheck did not pass.');
      if (!testPassed) warnings.push('Tests did not pass.');
      if (!buildPassed) warnings.push('Build did not pass.');
    } else if (result.status === 'FAILED') {
      status = 'FAILED_VERIFICATION';
      warnings.push('Task failed verification.');
    } else {
      status = 'NOT_VERIFIABLE';
      warnings.push('Insufficient evidence to verify task completion.');
    }

    // Security review: check for obvious risks in changed files
    const securityWarnings = await this.securityReview(result.changedFiles);
    warnings.push(...securityWarnings);

    // Never claim VERIFIED if there are secret leaks
    if (result.secretRedactions > 0 && status === 'VERIFIED') {
      status = 'PARTIALLY_VERIFIED';
      warnings.push('Secrets were redacted from output — review manually.');
    }

    return { status, warnings };
  }

  /** Security review of changed files (defensive, read-only). */
  async securityReview(changedFiles: string[]): Promise<string[]> {
    const warnings: string[] = [];
    const fs = await import('fs');
    const path = await import('path');

    const riskPatterns = [
      { name: 'hardcoded_secret', pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9]{10,}["']/i },
      { name: 'unsafe_eval', pattern: /\b(eval|exec)\s*\(/i },
      { name: 'dangerous_command', pattern: /\b(rm\s+-rf|format|dd\s+)\b/i },
      { name: 'sql_injection', pattern: /(SELECT|INSERT|UPDATE|DELETE).*\$\{|`.*\$\{.*`.*/i },
      { name: 'xss', pattern: /innerHTML\s*=/i },
      { name: 'path_traversal', pattern: /\.\.\/\.\.\//i },
    ];

    for (const file of changedFiles.slice(0, 10)) {
      const fullPath = path.resolve(this.engine.workspaceRoot, file);
      try {
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const risk of riskPatterns) {
          if (risk.pattern.test(content)) {
            warnings.push(`Security: possible ${risk.name} in ${file}.`);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return warnings;
  }

  /** Verify syntax of a TypeScript/JavaScript file. */
  verifySyntax(filePath: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    try {
      const fs = require('fs');
      const content = fs.readFileSync(filePath, 'utf8');
      // Basic brace/bracket balance check
      const openBraces = (content.match(/\{/g) || []).length;
      const closeBraces = (content.match(/\}/g) || []).length;
      const openParens = (content.match(/\(/g) || []).length;
      const closeParens = (content.match(/\)/g) || []).length;
      const openBrackets = (content.match(/\[/g) || []).length;
      const closeBrackets = (content.match(/\]/g) || []).length;

      if (openBraces !== closeBraces) errors.push('Unbalanced braces.');
      if (openParens !== closeParens) errors.push('Unbalanced parentheses.');
      if (openBrackets !== closeBrackets) errors.push('Unbalanced brackets.');
    } catch (err: any) {
      errors.push(err.message);
    }
    return { valid: errors.length === 0, errors };
  }
}