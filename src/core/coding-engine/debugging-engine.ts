/**
 * JARVIS-X v1.1.0 — Debugging Engine
 * Parses and structures: compiler errors, TypeScript errors, stack traces,
 * test failures, lint failures, build failures, runtime errors, dependency errors.
 * Extracts useful evidence: file, line, symbol, category, command, exit code,
 * related files.
 */

import { SecretProtection } from './secret-protection';
import type { ParsedError } from './types';

export class DebuggingEngine {
  private readonly secretProtection: SecretProtection;

  constructor(secretProtection: SecretProtection) {
    this.secretProtection = secretProtection;
  }

  /** Collect errors from validation results into ParsedError array. */
  collectErrors(
    typecheckErrors: ParsedError[],
    testErrors: ParsedError[],
    buildErrors: ParsedError[]
  ): ParsedError[] {
    const all = [...typecheckErrors, ...testErrors, ...buildErrors];
    // Redact secrets from messages
    return all.map((e) => {
      const { sanitized } = this.secretProtection.redact(e.message);
      return { ...e, message: sanitized };
    });
  }

  /** Parse TypeScript compiler errors from stderr. */
  parseTypescriptErrors(stderr: string, command: string): ParsedError[] {
    const errors: ParsedError[] = [];
    // TS error pattern: file.ts(line,col): error TSxxxx: message
    const tsPattern = /([^\s]+\.tsx?)\s*\((\d+),\s*(\d+)\):\s*error\s+(TS\d+):\s*(.+)/gi;
    let match: RegExpExecArray | null;
    while ((match = tsPattern.exec(stderr)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2], 10) || null,
        column: parseInt(match[3], 10) || null,
        symbol: match[4],
        category: 'typescript',
        message: match[5].trim(),
        command,
        exitCode: 1,
        relatedFiles: [match[1]],
      });
    }
    // Fallback: generic error lines
    if (errors.length === 0) {
      for (const line of stderr.split('\n')) {
        if (/error/i.test(line) && /\.ts/i.test(line)) {
          errors.push({
            file: null,
            line: null,
            column: null,
            symbol: null,
            category: 'typescript',
            message: line.trim().slice(0, 200),
            command,
            exitCode: 1,
            relatedFiles: [],
          });
        }
      }
    }
    return errors.slice(0, 30);
  }

  /** Parse test failure output. */
  parseTestErrors(stderr: string, command: string): ParsedError[] {
    const errors: ParsedError[] = [];
    // vitest/jest pattern: ✕ or FAIL or Expected/Received
    const lines = stderr.split('\n');
    let currentFile: string | null = null;

    for (const line of lines) {
      const fileMatch = line.match(/([^\s]+\.(?:ts|tsx|js|jsx|test\.ts|spec\.ts))\s*[:\(](\d+)?/);
      if (fileMatch) {
        currentFile = fileMatch[1];
      }
      if (/✕|FAIL|Expected|Received|failed/i.test(line)) {
        errors.push({
          file: currentFile,
          line: null,
          column: null,
          symbol: null,
          category: 'test',
          message: line.trim().slice(0, 200),
          command,
          exitCode: 1,
          relatedFiles: currentFile ? [currentFile] : [],
        });
      }
    }

    if (errors.length === 0 && stderr.trim()) {
      errors.push({
        file: null,
        line: null,
        column: null,
        symbol: null,
        category: 'test',
        message: stderr.trim().slice(0, 200),
        command,
        exitCode: 1,
        relatedFiles: [],
      });
    }
    return errors.slice(0, 30);
  }

  /** Parse build failure output. */
  parseBuildErrors(stderr: string, command: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const lines = stderr.split('\n');

    for (const line of lines) {
      if (/error|Error|ERROR|fail|Fail|FAIL/i.test(line)) {
        const fileMatch = line.match(/([^\s]+\.[a-z]+)\s*[:\(](\d+)?/);
        errors.push({
          file: fileMatch?.[1] ?? null,
          line: fileMatch?.[2] ? parseInt(fileMatch[2], 10) : null,
          column: null,
          symbol: null,
          category: 'build',
          message: line.trim().slice(0, 200),
          command,
          exitCode: 1,
          relatedFiles: fileMatch ? [fileMatch[1]] : [],
        });
      }
    }

    if (errors.length === 0 && stderr.trim()) {
      errors.push({
        file: null,
        line: null,
        column: null,
        symbol: null,
        category: 'build',
        message: stderr.trim().slice(0, 200),
        command,
        exitCode: 1,
        relatedFiles: [],
      });
    }
    return errors.slice(0, 30);
  }

  /** Parse stack traces. */
  parseStackTrace(stack: string, command?: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const lines = stack.split('\n');
    const atPattern = /^\s*at\s+([^\s(]+)\s*\(([^\s:]+):(\d+):(\d+)\)/;

    for (const line of lines) {
      const m = atPattern.exec(line);
      if (m) {
        errors.push({
          file: m[2],
          line: parseInt(m[3], 10) || null,
          column: parseInt(m[4], 10) || null,
          symbol: m[1],
          category: 'runtime',
          message: line.trim().slice(0, 200),
          command: command ?? null,
          exitCode: 1,
          relatedFiles: [m[2]],
        });
      }
    }
    return errors.slice(0, 30);
  }
}