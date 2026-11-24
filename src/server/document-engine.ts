import 'server-only';
import { DocumentIntelligenceEngine } from '@/core/document-intelligence';
import type { SupportedDocumentFormat } from '@/core/document-intelligence/types';
import type { DataRepository } from '@/server/repositories/types';

/**
 * JARVIS-X v1.2.0 — Process-wide Grounded Document Intelligence engine.
 *
 * The engine itself is stateless with respect to *authorization*: every call is
 * scoped by a server-resolved `ownerId`, and the internal store/index are
 * partitioned by owner before any read. A client can never widen its scope by
 * supplying an owner identifier — routes always inject the authenticated
 * actor's ID.
 *
 * A single instance is kept per server process so ingested documents survive
 * across requests without duplicating state per request-scoped JarvisCore.
 */

const globalForDocuments = globalThis as unknown as {
  __jarvisDocumentEngine?: DocumentIntelligenceEngine;
};

/** In-process guard so hydration runs at most once per owner per process. */
const globalForHydration = globalThis as unknown as {
  __jarvisHydratedOwners?: Set<string>;
};

function hydratedOwners(): Set<string> {
  if (!globalForHydration.__jarvisHydratedOwners) {
    globalForHydration.__jarvisHydratedOwners = new Set<string>();
  }
  return globalForHydration.__jarvisHydratedOwners;
}

export function getDocumentEngine(): DocumentIntelligenceEngine {
  if (!globalForDocuments.__jarvisDocumentEngine) {
    globalForDocuments.__jarvisDocumentEngine = new DocumentIntelligenceEngine();
  }
  return globalForDocuments.__jarvisDocumentEngine;
}

const PERSISTED_FORMATS: Record<string, SupportedDocumentFormat> = {
  markdown: 'markdown',
  text: 'txt',
  csv: 'csv',
  json: 'json',
  code: 'code',
  pdf: 'pdf',
  docx: 'docx',
  html: 'html',
  xml: 'xml',
  yaml: 'yaml',
  toml: 'toml',
};

/**
 * Rebuild the owner's retrievable index from durable storage.
 *
 * The in-process vector/keyword index is intentionally ephemeral, while the
 * document and chunk rows are durable and RLS-scoped. Without this step a server
 * restart would leave previously ingested (and still stored) documents
 * un-retrievable — the user would be told their own document has no evidence.
 *
 * Only the caller's own rows are ever read: `repository` is already bound to the
 * authenticated request, and every query filters on `userId`.
 */
export async function ensureDocumentsHydrated(
  engine: DocumentIntelligenceEngine,
  userId: string,
  repository: DataRepository
): Promise<{ hydratedDocuments: number; hydratedChunks: number }> {
  const owners = hydratedOwners();

  if (!userId) return { hydratedDocuments: 0, hydratedChunks: 0 };
  if (owners.has(userId)) return { hydratedDocuments: 0, hydratedChunks: 0 };
  if (engine.hasIndexedDocuments(userId)) {
    owners.add(userId);
    return { hydratedDocuments: 0, hydratedChunks: 0 };
  }

  let hydratedDocuments = 0;
  let hydratedChunks = 0;

  try {
    const records = (await repository.listIngestedDocuments?.(userId, 50)) ?? [];

    for (const record of records) {
      const metadata = (record.metadata ?? {}) as { documentId?: string };
      const documentId = metadata.documentId;
      if (!documentId) continue;

      const rows = (await repository.listDocumentChunks?.(userId, record.id, 500)) ?? [];
      if (rows.length === 0) continue;

      const result = await engine.hydrateDocument({
        ownerId: userId,
        documentId,
        filename: record.fileName,
        mimeType: record.mimeType,
        format: PERSISTED_FORMATS[record.formatKind] ?? 'txt',
        title: record.fileName,
        projectId: record.projectId,
        pageCount: record.pageCount ?? 0,
        contentHash: record.contentHash ?? '',
        ingestedAt: record.createdAt,
        lifecycle: record.lifecycle ?? 'READY',
        parser: record.parser ?? 'persisted',
        parserVersion: record.parserVersion ?? 'unknown',
        pageProvenanceAvailable: record.pageProvenanceAvailable ?? false,
        ocrRequired: record.ocrRequired ?? false,
        chunks: rows.map((row) => ({
          chunkKey: row.chunkKey,
          chunkIndex: row.chunkIndex,
          section: row.section,
          headingPath: row.headingPath,
          page: row.page,
          pageStart: row.pageStart,
          pageEnd: row.pageEnd,
          textContent: row.textContent,
          charCount: row.charCount,
          tokenEstimate: row.tokenEstimate,
          contentHash: row.contentHash,
          trustLevel: row.trustLevel,
        })),
      });

      if (result.hydrated) {
        hydratedDocuments += 1;
        hydratedChunks += result.chunkCount;
      }
    }
  } catch {
    // Hydration is best-effort: a degraded store must not break the request.
    return { hydratedDocuments, hydratedChunks };
  }

  owners.add(userId);
  return { hydratedDocuments, hydratedChunks };
}

/** Test/reset hook — drops all in-process document state. */
export function resetDocumentEngineForTests(): void {
  globalForDocuments.__jarvisDocumentEngine = undefined;
  hydratedOwners().clear();
}
