/**
 * JARVIS-X v1.1.0 — Professional File Operations
 * Secure workspace operations: READ, CREATE, PATCH, RENAME, DELETE.
 * Enforces workspace-root restrictions. Rejects path traversal and
 * unauthorized system paths. Prefers minimal PATCH operations.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SecretProtection } from './secret-protection';
import { PromptInjectionDefense } from './prompt-injection-defense';
import type { FileOpResult, FileOpKind } from './types';

export class FileOperations {
  private readonly workspaceRoot: string;
  private readonly secretProtection: SecretProtection;
  private readonly promptInjection: PromptInjectionDefense;

  constructor(workspaceRoot: string, secretProtection: SecretProtection, promptInjection: PromptInjectionDefense) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.secretProtection = secretProtection;
    this.promptInjection = promptInjection;
  }

  /** Resolve and validate that a path is within the workspace root. */
  private resolveSafePath(requestedPath: string): { safePath: string; relPath: string; error?: string } {
    // Prompt-injection boundary on the path string
    const pathEval = this.promptInjection.sanitize(requestedPath);
    if (pathEval.injectionAttemptDetected) {
      return { safePath: '', relPath: '', error: 'Path traversal or injection pattern detected.' };
    }

    const resolved = path.resolve(this.workspaceRoot, requestedPath);
    const rel = path.relative(this.workspaceRoot, resolved);

    // Reject path traversal (.. escaping workspace)
    if (rel.startsWith('..') || path.isAbsolute(requestedPath) && !requestedPath.startsWith(this.workspaceRoot)) {
      return { safePath: '', relPath: '', error: 'Path outside workspace root rejected.' };
    }

    // Reject null bytes
    if (requestedPath.includes('\0')) {
      return { safePath: '', relPath: '', error: 'Null byte in path rejected.' };
    }

    return { safePath: resolved, relPath: rel };
  }

  read(filePath: string): FileOpResult {
    const safe = this.resolveSafePath(filePath);
    if (safe.error) return { kind: 'READ', path: filePath, success: false, error: safe.error };

    try {
      if (!fs.existsSync(safe.safePath)) {
        return { kind: 'READ', path: filePath, success: false, error: 'File not found.' };
      }
      const stat = fs.statSync(safe.safePath);
      if (!stat.isFile()) {
        return { kind: 'READ', path: filePath, success: false, error: 'Path is not a file.' };
      }
      const content = fs.readFileSync(safe.safePath, 'utf8');
      return { kind: 'READ', path: filePath, success: true, newContent: content, bytesChanged: Buffer.byteLength(content) };
    } catch (err: any) {
      return { kind: 'READ', path: filePath, success: false, error: err.message };
    }
  }

  create(filePath: string, content: string): FileOpResult {
    const safe = this.resolveSafePath(filePath);
    if (safe.error) return { kind: 'CREATE', path: filePath, success: false, error: safe.error };

    // Prompt-injection on content
    const contentEval = this.promptInjection.sanitize(content);
    const safeContent = contentEval.sanitized;

    try {
      const dir = path.dirname(safe.safePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(safe.safePath)) {
        return { kind: 'CREATE', path: filePath, success: false, error: 'File already exists. Use PATCH to modify.' };
      }
      fs.writeFileSync(safe.safePath, safeContent, 'utf8');
      return { kind: 'CREATE', path: filePath, success: true, newContent: safeContent, bytesChanged: Buffer.byteLength(safeContent) };
    } catch (err: any) {
      return { kind: 'CREATE', path: filePath, success: false, error: err.message };
    }
  }

  patch(filePath: string, oldText: string, newText: string): FileOpResult {
    const safe = this.resolveSafePath(filePath);
    if (safe.error) return { kind: 'PATCH', path: filePath, success: false, error: safe.error };

    // Prompt-injection on both old and new text
    const oldEval = this.promptInjection.sanitize(oldText);
    const newEval = this.promptInjection.sanitize(newText);
    const safeOld = oldEval.sanitized;
    const safeNew = newEval.sanitized;

    try {
      if (!fs.existsSync(safe.safePath)) {
        return { kind: 'PATCH', path: filePath, success: false, error: 'File not found.' };
      }
      const current = fs.readFileSync(safe.safePath, 'utf8');

      if (!current.includes(safeOld)) {
        return { kind: 'PATCH', path: filePath, success: false, error: 'Search text not found in file. Patch aborted.' };
      }

      const updated = current.replace(safeOld, safeNew);
      fs.writeFileSync(safe.safePath, updated, 'utf8');

      return {
        kind: 'PATCH',
        path: filePath,
        success: true,
        previousContent: current,
        newContent: updated,
        bytesChanged: Math.abs(Buffer.byteLength(updated) - Buffer.byteLength(current)),
      };
    } catch (err: any) {
      return { kind: 'PATCH', path: filePath, success: false, error: err.message };
    }
  }

  rename(oldPath: string, newPath: string): FileOpResult {
    const safeOld = this.resolveSafePath(oldPath);
    if (safeOld.error) return { kind: 'RENAME', path: oldPath, success: false, error: safeOld.error };

    const safeNew = this.resolveSafePath(newPath);
    if (safeNew.error) return { kind: 'RENAME', path: oldPath, success: false, error: safeNew.error };

    try {
      if (!fs.existsSync(safeOld.safePath)) {
        return { kind: 'RENAME', path: oldPath, success: false, error: 'Source file not found.' };
      }
      if (fs.existsSync(safeNew.safePath)) {
        return { kind: 'RENAME', path: oldPath, success: false, error: 'Destination already exists.' };
      }
      const dir = path.dirname(safeNew.safePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.renameSync(safeOld.safePath, safeNew.safePath);
      return { kind: 'RENAME', path: oldPath, success: true, newContent: newPath };
    } catch (err: any) {
      return { kind: 'RENAME', path: oldPath, success: false, error: err.message };
    }
  }

  delete(filePath: string): FileOpResult {
    const safe = this.resolveSafePath(filePath);
    if (safe.error) return { kind: 'DELETE', path: filePath, success: false, error: safe.error };

    try {
      if (!fs.existsSync(safe.safePath)) {
        return { kind: 'DELETE', path: filePath, success: false, error: 'File not found.' };
      }
      const content = fs.readFileSync(safe.safePath, 'utf8');
      fs.unlinkSync(safe.safePath);
      return { kind: 'DELETE', path: filePath, success: true, previousContent: content };
    } catch (err: any) {
      return { kind: 'DELETE', path: filePath, success: false, error: err.message };
    }
  }

  hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}