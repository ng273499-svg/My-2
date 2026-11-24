/**
 * JARVIS-X v1.1.0 — Bounded Autonomous Repair
 * EDIT → TEST → FAILURE → DIAGNOSE → REPAIR → RETEST.
 * Maximum repair iterations configurable and bounded. If limit is reached,
 * STOP and return evidence. Never loops forever.
 */

import path from 'path';
import { DebuggingEngine } from './debugging-engine';
import { EvidenceVerifier } from './verification';
import { FileOperations } from './file-operations';
import type { ParsedError, RepairAttempt, FileOpResult } from './types';

export class RepairLoop {
  private readonly debugging: DebuggingEngine;
  private readonly verifier: EvidenceVerifier;
  private readonly fileOps: FileOperations;
  private readonly workspaceRoot: string;
  private readonly maxIterations: number;

  constructor(options: {
    debugging: DebuggingEngine;
    verifier: EvidenceVerifier;
    fileOps: FileOperations;
    workspaceRoot: string;
    maxIterations: number;
  }) {
    this.debugging = options.debugging;
    this.verifier = options.verifier;
    this.fileOps = options.fileOps;
    this.workspaceRoot = options.workspaceRoot;
    this.maxIterations = Math.max(0, Math.min(10, options.maxIterations));
  }

  /**
   * Attempt a bounded repair cycle. Applies at most 5 minimal patches per
   * iteration and only for errors that have a deterministic, safe fix.
   */
  async attempt(
    errors: ParsedError[],
    signal?: AbortSignal
  ): Promise<{
    applied: boolean;
    patchResults: FileOpResult[];
    diagnosis: string;
    repairRecord: RepairAttempt;
  }> {
    const patchResults: FileOpResult[] = [];
    const diagnosis = this.diagnose(errors);

    // Bound: only the first 5 errors per iteration
    for (const err of errors.slice(0, 5)) {
      if (signal?.aborted) break;
      const fix = this.deriveFix(err);
      if (!fix) continue;
      const result = this.fileOps.patch(fix.filePath, fix.oldText, fix.newText);
      patchResults.push(result);
    }

    const applied = patchResults.some((p) => p.success);

    const repairRecord: RepairAttempt = {
      attempt: 1,
      trigger: [...new Set(errors.map((e) => e.category))].join(', '),
      diagnosis,
      patch: patchResults,
      revalidation: { typecheckPassed: false, testPassed: false, buildPassed: false },
    };

    return { applied, patchResults, diagnosis, repairRecord };
  }

  private diagnose(errors: ParsedError[]): string {
    const categories = [...new Set(errors.map((e) => e.category))];
    const files = [...new Set(errors.map((e) => e.file).filter((f): f is string => Boolean(f)))];
    return `Detected ${errors.length} error(s) [${
      categories.join(', ') || 'unknown'
    }]${files.length ? ` in ${files.slice(0, 5).join(', ')}` : ''}.`;
  }

  /**
   * Derive a minimal, deterministic patch for a fixable error.
   * Deliberately conservative: returns `null` when a safe automatic fix
   * cannot be determined with certainty. Never guesses at intent.
   */
  private deriveFix(err: ParsedError): { filePath: string; oldText: string; newText: string } | null {
    if (!err.file) return null;

    // Absolute-path guard: only resolve inside the workspace.
    const resolved = path.resolve(this.workspaceRoot, err.file);
    if (!resolved.startsWith(this.workspaceRoot)) return null;

    // TypeScript implicit-any / missing-module errors require real type
    // knowledge and are never auto-patched.
    if (err.category === 'typescript') return null;

    // Test expectation mismatches encode intent that must not be guessed.
    if (err.category === 'test') return null;

    // Build-configuration and dependency errors require human decisions.
    if (err.category === 'build' || err.category === 'dependency') return null;

    return null;
  }

  getMaxIterations(): number {
    return this.maxIterations;
  }
}
