/**
 * JARVIS-X v1.2.0 — Document Lifecycle Store
 *
 * Owner-scoped document records with:
 *   INGESTING → READY | PARTIAL | OCR_REQUIRED | FAILED → REMOVED
 *
 * Content hashes detect duplicates and revisions. Deletion revokes all
 * retrievable state so removed content can never appear in later results.
 */

import crypto from 'crypto';
import type {
  DocumentChunk,
  DocumentLifecycleState,
  DocumentRemovalResult,
  NormalizedDocument,
} from './types';

export interface StoredDocument {
  document: NormalizedDocument;
  chunks: DocumentChunk[];
  lifecycle: DocumentLifecycleState;
  revision: number;
  updatedAt: string;
  /** Minimal audit trail retained after removal (never document content). */
  audit: Array<{ at: string; event: string }>;
}

export function hashBytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export class DocumentStore {
  /** ownerId → documentId → record. Outer map enforces tenant isolation. */
  private readonly byOwner = new Map<string, Map<string, StoredDocument>>();

  private ownerMap(ownerId: string): Map<string, StoredDocument> {
    const existing = this.byOwner.get(ownerId);
    if (existing) return existing;
    const created = new Map<string, StoredDocument>();
    this.byOwner.set(ownerId, created);
    return created;
  }

  put(document: NormalizedDocument, chunks: DocumentChunk[]): StoredDocument {
    const record: StoredDocument = {
      document,
      chunks,
      lifecycle: document.lifecycle,
      revision: 1,
      updatedAt: new Date().toISOString(),
      audit: [{ at: new Date().toISOString(), event: 'ingested' }],
    };
    this.ownerMap(document.ownerId).set(document.documentId, record);
    return record;
  }

  get(ownerId: string, documentId: string): StoredDocument | null {
    const record = this.byOwner.get(ownerId)?.get(documentId);
    if (!record) return null;
    // Defence in depth: never return a record owned by someone else.
    if (record.document.ownerId !== ownerId) return null;
    if (record.lifecycle === 'REMOVED') return null;
    return record;
  }

  /** Owner-scoped listing; removed documents are excluded. */
  list(ownerId: string, options?: { projectId?: string | null }): StoredDocument[] {
    const map = this.byOwner.get(ownerId);
    if (!map) return [];
    return [...map.values()]
      .filter((r) => r.document.ownerId === ownerId)
      .filter((r) => r.lifecycle !== 'REMOVED')
      .filter((r) =>
        options && options.projectId !== undefined
          ? r.document.projectId === options.projectId
          : true
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  findByContentHash(ownerId: string, contentHash: string): StoredDocument | null {
    const map = this.byOwner.get(ownerId);
    if (!map) return null;
    for (const record of map.values()) {
      if (record.document.ownerId !== ownerId) continue;
      if (record.lifecycle === 'REMOVED') continue;
      if (record.document.contentHash === contentHash) return record;
    }
    return null;
  }

  updateLifecycle(
    ownerId: string,
    documentId: string,
    lifecycle: DocumentLifecycleState
  ): boolean {
    const record = this.byOwner.get(ownerId)?.get(documentId);
    if (!record || record.document.ownerId !== ownerId) return false;
    record.lifecycle = lifecycle;
    record.document.lifecycle = lifecycle;
    record.updatedAt = new Date().toISOString();
    record.audit.push({ at: record.updatedAt, event: `lifecycle:${lifecycle}` });
    return true;
  }

  /**
   * Remove a document: revoke chunks, mark REMOVED and retain only minimal
   * audit metadata. Document content is dropped from the record.
   */
  remove(
    ownerId: string,
    documentId: string,
    revokeChunks: () => number,
    revokeMemory: () => number
  ): DocumentRemovalResult {
    const map = this.byOwner.get(ownerId);
    const record = map?.get(documentId);
    if (!record || record.document.ownerId !== ownerId) {
      return {
        ok: false,
        documentId,
        chunksRevoked: 0,
        memoryEntriesRevoked: 0,
        auditRetained: false,
        error: 'Document not found for this owner.',
      };
    }

    const chunksRevoked = revokeChunks();
    const memoryEntriesRevoked = revokeMemory();

    // Drop retrievable content but keep a minimal audit skeleton.
    record.chunks = [];
    record.document = {
      ...record.document,
      blocks: [],
      sections: [],
      tables: [],
      metadata: {},
      lifecycle: 'REMOVED',
      contentHash: record.document.contentHash,
      title: record.document.title,
      filename: record.document.filename,
    };
    record.lifecycle = 'REMOVED';
    record.updatedAt = new Date().toISOString();
    record.audit.push({ at: record.updatedAt, event: 'removed' });

    return {
      ok: true,
      documentId,
      chunksRevoked,
      memoryEntriesRevoked,
      auditRetained: true,
    };
  }

  countDocuments(ownerId: string): number {
    return this.list(ownerId).length;
  }

  clearOwner(ownerId: string): void {
    this.byOwner.delete(ownerId);
  }
}
