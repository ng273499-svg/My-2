/**
 * JARVIS-X v1.1.0 — Safe Terminal Executor
 * Coding Agent → Command Proposal → Command Policy → Risk Classification →
 * Permission Check → Authorized Executor → bounded stdout/stderr → Result Parser.
 * Every command has: authorized working directory, timeout, output limit,
 * exit code, cancellation, structured result, audit metadata.
 * No privilege escalation or host-security bypass.
 */

import { execFile } from 'child_process';
import { SecretProtection } from './secret-protection';
import { PromptInjectionDefense } from './prompt-injection-defense';
import type { CommandProposal, CommandResult, CommandRisk } from './types';

const MAX_OUTPUT_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const ALLOWED_COMMANDS = [
  'npm', 'npx', 'node', 'pnpm', 'yarn',
  'python', 'python3', 'pip', 'pip3',
  'java', 'javac', 'mvn', 'gradle',
  'gcc', 'g++', 'clang', 'make', 'cmake',
  'dotnet',
  'go', 'gofmt',
  'cargo', 'rustc',
  'php', 'ruby', 'bundle',
  'dart', 'flutter',
  'tsc', 'vitest', 'jest', 'mocha',
  'git',
];

export class TerminalExecutor {
  private readonly workspaceRoot: string;
  private readonly secretProtection: SecretProtection;
  private readonly promptInjection: PromptInjectionDefense;
  private readonly activeProcesses = new Map<string, { controller: AbortController }>();

  constructor(workspaceRoot: string, secretProtection: SecretProtection, promptInjection: PromptInjectionDefense) {
    this.workspaceRoot = workspaceRoot;
    this.secretProtection = secretProtection;
    this.promptInjection = promptInjection;
  }

  /** Classify command risk level based on command and args. */
  classifyRisk(command: string, args: string[]): CommandRisk {
    const full = `${command} ${args.join(' ')}`.toLowerCase();

    // SENSITIVE: destructive, system-modifying, network-writing
    if (/\b(rm\s+-rf|format|mkfs|dd\s+|chmod\s+777|chown\s+|sudo\s+|su\s+|passwd|curl\s+-X\s+(POST|PUT|DELETE)|wget\s+--post)/i.test(full)) {
      return 'SENSITIVE';
    }

    // CONFIRMATION_REQUIRED: installs, builds that may modify system
    if (/\b(npm\s+install|pip\s+install|cargo\s+install|go\s+install|dotnet\s+install|apt-get|yum|brew\s+install|npm\s+run\s+build)/i.test(full)) {
      return 'CONFIRMATION_REQUIRED';
    }

    // LOW_RISK: test runners, typechecks, linters, read-only git
    if (/\b(tsc|vitest|jest|mocha|eslint|prettier|git\s+(status|diff|log|branch)|go\s+test|cargo\s+test|mvn\s+test|dotnet\s+test)/i.test(full)) {
      return 'LOW_RISK';
    }

    // SAFE_READ: read-only inspection
    return 'SAFE_READ';
  }

  /** Check if command is in the allowed list. */
  isAllowed(command: string): boolean {
    return ALLOWED_COMMANDS.includes(command);
  }

  /** Execute an authorized command with bounds. */
  async executeCommand(proposal: CommandProposal): Promise<CommandResult> {
    const startMs = Date.now();

    // Validate working directory is within workspace
    const resolvedCwd = proposal.cwd;
    if (!resolvedCwd.startsWith(this.workspaceRoot) && resolvedCwd !== this.workspaceRoot) {
      return {
        command: proposal.command,
        exitCode: null,
        stdout: '',
        stderr: 'Command working directory outside workspace root.',
        durationMs: 0,
        timedOut: false,
        truncated: false,
        riskLevel: proposal.riskLevel,
        redactedSecrets: 0,
      };
    }

    // Prompt-injection on command and args
    const cmdEval = this.promptInjection.sanitize(proposal.command);
    const argsEval = this.promptInjection.sanitize(proposal.args.join(' '));
    if (cmdEval.injectionAttemptDetected || argsEval.injectionAttemptDetected) {
      return {
        command: proposal.command,
        exitCode: null,
        stdout: '',
        stderr: 'Command rejected: prompt-injection pattern detected.',
        durationMs: 0,
        timedOut: false,
        truncated: false,
        riskLevel: proposal.riskLevel,
        redactedSecrets: 0,
      };
    }

    if (!this.isAllowed(proposal.command)) {
      return {
        command: proposal.command,
        exitCode: null,
        stdout: '',
        stderr: `Command "${proposal.command}" is not in the allowed command list.`,
        durationMs: 0,
        timedOut: false,
        truncated: false,
        riskLevel: proposal.riskLevel,
        redactedSecrets: 0,
      };
    }

    const processId = `${proposal.command}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const controller = new AbortController();
    this.activeProcesses.set(processId, { controller });

    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        controller.abort();
        resolve({
          command: proposal.command,
          exitCode: null,
          stdout: '',
          stderr: `Command timed out after ${proposal.timeoutMs}ms.`,
          durationMs: proposal.timeoutMs,
          timedOut: true,
          truncated: false,
          riskLevel: proposal.riskLevel,
          redactedSecrets: 0,
        });
      }, proposal.timeoutMs);

      const child = execFile(proposal.command, proposal.args, {
        cwd: proposal.cwd,
        encoding: 'utf8',
        // Headroom above our own truncation bound so we truncate, not ENOBUFS.
        maxBuffer: MAX_OUTPUT_BYTES * 4,
        signal: controller.signal,
      }, (execErr, stdout, stderr) => {
        clearTimeout(timer);
        this.activeProcesses.delete(processId);

        const durationMs = Date.now() - startMs;

        let out = stdout ?? '';
        let stderrOut = stderr ?? '';

        // Truncate output
        let truncated = false;
        if (Buffer.byteLength(out) > MAX_OUTPUT_BYTES) {
          out = out.slice(0, MAX_OUTPUT_BYTES) + '\n...[OUTPUT TRUNCATED]...';
          truncated = true;
        }
        if (Buffer.byteLength(stderrOut) > MAX_OUTPUT_BYTES) {
          stderrOut = stderrOut.slice(0, MAX_OUTPUT_BYTES) + '\n...[OUTPUT TRUNCATED]...';
          truncated = true;
        }

        // Redact secrets
        const { sanitized: safeOut, redactionCount: outRedacted } = this.secretProtection.redact(out);
        const { sanitized: safeErr, redactionCount: errRedacted } = this.secretProtection.redact(stderrOut);

        // Determine exit code from exec error
        let exitCode = 0;
        if (execErr) {
          const code = (execErr as any)?.code;
          exitCode = typeof code === 'number' ? code : 1;
        }

        // The watchdog fires at proposal.timeoutMs; treat a kill at the bound
        // as a real timeout rather than a generic failure.
        const timedOut =
          Boolean(execErr) &&
          ((execErr as any)?.killed === true ||
            (execErr as any)?.signal === 'SIGTERM' ||
            durationMs >= proposal.timeoutMs - 50);

        resolve({
          command: proposal.command,
          exitCode,
          stdout: safeOut,
          stderr: timedOut
            ? `Command timed out after ${proposal.timeoutMs}ms.`
            : safeErr,
          durationMs,
          timedOut,
          truncated,
          riskLevel: proposal.riskLevel,
          redactedSecrets: outRedacted + errRedacted,
        });
      });

      controller.signal.addEventListener('abort', () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
        clearTimeout(timer);
        this.activeProcesses.delete(processId);
        resolve({
          command: proposal.command,
          exitCode: null,
          stdout: '',
          stderr: 'Command cancelled by user.',
          durationMs: Date.now() - startMs,
          timedOut: false,
          truncated: false,
          riskLevel: proposal.riskLevel,
          redactedSecrets: 0,
        });
      }, { once: true });
    });
  }

  /** Propose a command (risk classification only, no execution). */
  propose(command: string, args: string[], cwd: string, reason: string, timeoutMs?: number): CommandProposal {
    return {
      command,
      args,
      cwd,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      riskLevel: this.classifyRisk(command, args),
      reason,
    };
  }

  cancel(processId: string): boolean {
    const entry = this.activeProcesses.get(processId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }
}