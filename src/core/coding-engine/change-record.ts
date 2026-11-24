/**
 * JARVIS-X v1.1.0 — Change Record & Rollback
 * Tracks JARVIS-created changes: created/modified/deleted files, previous
 * hashes/content, resulting hashes. Provides safe rollback where technically
 * feasible. Never overwrites unrelated user edits.
 */

import { SecretProtection } from './secret-protection';
import type { ChangeRecord, ChangeLog, FileOpKind } from './types';

export class ChangeLogImpl implements ChangeLog {
  public readonly secretProtection: SecretProtection;
  public changes: ChangeRecord[] = [];

  constructor(secretProtection: SecretProtection) {
    this.secretProtection = secretProtection;
  }

  record(change: Omit<ChangeRecord, 'changeId' | 'timestamp' | 'reverted'>): void {
    const { sanitized: safePrev, redactionCount: pRedacted } = this.secretProtection.redact(change.previousContent ?? '');
    const { sanitized: safeNew, redactionCount: nRedacted } = this.secretProtection.redact(change.newContent ?? '');

    const record: ChangeRecord = {
      changeId: `change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      kind: change.kind,
      path: change.path,
      previousHash: change.previousHash,
      newHash: change.newHash,
      previousContent: pRedacted > 0 ? '[REDACTED_SECRET]' : safePrev,
      newContent: nRedacted > 0 ? '[REDACTED_SECRET]' : safeNew,
      reverted: false,
    };
    this.changes.push(record);
  }

  get changesList(): ChangeRecord[] {
    return [...this.changes];
  }

  canRollback(changeId: string): boolean {
    const change = this.changes.find((c) => c.changeId === changeId);
    if (!change) return false;
    if (change.reverted) return false;
    if (change.kind === 'DELETE') return false; // Cannot recreate deleted file without content
    if (!change.previousContent) return false; // No previous state to restore
    return true;
  }

  async rollback(changeId: string): Promise<{ success: boolean; error?: string }> {
    const change = this.changes.find((c) => c.changeId === changeId);
    if (!change) return { success: false, error: 'Change not found.' };
    if (change.reverted) return { success: false, error: 'Change already reverted.' };
    if (change.kind === 'DELETE') return { success: false, error: 'Cannot rollback DELETE without previous content.' };
    if (!change.previousContent) return { success: false, error: 'No previous content to restore.' };

    // Mark as reverted (actual file restoration handled by caller via FileOperations)
    change.reverted = true;
    return { success: true };
  }

  getUnrevertedChanges(): ChangeRecord[] {
    return this.changes.filter((c) => !c.reverted);
  }

  clear(): void {
    this.changes = [];
  }
}

// Re-export as the typed ChangeLog interface implementation
export { ChangeLogImpl as ChangeLog };