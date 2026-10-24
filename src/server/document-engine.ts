import 'server-only';
import { DocumentIntelligenceEngine } from '@/core/document-intelligence';

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

export function getDocumentEngine(): DocumentIntelligenceEngine {
  if (!globalForDocuments.__jarvisDocumentEngine) {
    globalForDocuments.__jarvisDocumentEngine = new DocumentIntelligenceEngine();
  }
  return globalForDocuments.__jarvisDocumentEngine;
}

/** Test/reset hook — drops all in-process document state. */
export function resetDocumentEngineForTests(): void {
  globalForDocuments.__jarvisDocumentEngine = undefined;
}
