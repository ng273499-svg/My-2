/**
 * JARVIS-X v1.1.0 — Git Intelligence (read-only)
 * Read-only git understanding: status, diff, branch, recent commits.
 * Mutation operations pass through permission controls. Never force push,
 * rewrite history, delete remote branches, or merge into production/main.
 */

import { execSync, execFileSync } from 'child_process';
import { SecretProtection } from './secret-protection';

export interface GitCommitInfo {
  hash: string;
  message: string;
  date: string;
}

export interface GitStatusInfo {
  currentBranch: string | null;
  isClean: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  stagedFiles: string[];
  statusSummary: string;
}

export class GitIntelligence {
  private readonly workspaceRoot: string;
  private readonly secretProtection: SecretProtection;

  constructor(workspaceRoot: string, secretProtection: SecretProtection) {
    this.workspaceRoot = workspaceRoot;
    this.secretProtection = secretProtection;
  }

  private runGit(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    try {
      const stdout = execFileSync('git', args, {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
      return { stdout, stderr: '', exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: '',
        stderr: err.stderr ? String(err.stderr) : String(err.message),
        exitCode: err.status ?? 1,
      };
    }
  }

  getCurrentBranch(): string | null {
    const result = this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (result.exitCode !== 0) return null;
    return result.stdout.trim() || null;
  }

  getStatus(): GitStatusInfo {
    const branch = this.getCurrentBranch();

    const statusResult = this.runGit(['status', '--porcelain']);
    const modified: string[] = [];
    const untracked: string[] = [];
    const staged: string[] = [];

    if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
      for (const line of statusResult.stdout.trim().split('\n')) {
        const xy = line.slice(0, 2);
        const path = line.slice(3).trim();
        if (xy[0] !== ' ' && xy[0] !== '?') staged.push(path);
        if (xy[1] !== ' ' && xy[1] !== '?') modified.push(path);
        if (xy === '??') untracked.push(path);
      }
    }

    const isClean = modified.length === 0 && untracked.length === 0 && staged.length === 0;
    const statusSummary = isClean
      ? `Working tree clean on branch "${branch ?? 'unknown'}".`
      : `Branch "${branch ?? 'unknown'}": ${modified.length} modified, ${untracked.length} untracked, ${staged.length} staged.`;

    return {
      currentBranch: branch,
      isClean,
      modifiedFiles: modified,
      untrackedFiles: untracked,
      stagedFiles: staged,
      statusSummary,
    };
  }

  getRecentCommits(limit: number = 10): GitCommitInfo[] {
    const result = this.runGit([
      'log',
      `-n${limit}`,
      '--pretty=format:%H|%s|%ci',
    ]);
    if (result.exitCode !== 0) return [];

    return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, ...rest] = line.split('|');
      const date = rest.pop() ?? '';
      const message = rest.join('|');
      return { hash, message, date };
    });
  }

  getDiff(filePath?: string): { diff: string; exitCode: number } {
    const args: string[] = ['diff', '--'];
    if (filePath) args.push(filePath);
    const result = this.runGit(args);
    const { sanitized } = this.secretProtection.redact(result.stdout);
    return { diff: sanitized, exitCode: result.exitCode };
  }

  getDiffBetweenBranches(branchA: string, branchB: string): { diff: string; exitCode: number } {
    const result = this.runGit(['diff', `${branchA}...${branchB}`, '--']);
    const { sanitized } = this.secretProtection.redact(result.stdout);
    return { diff: sanitized, exitCode: result.exitCode };
  }

  isRepository(): boolean {
    const result = this.runGit(['rev-parse', '--is-inside-work-tree']);
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }
}