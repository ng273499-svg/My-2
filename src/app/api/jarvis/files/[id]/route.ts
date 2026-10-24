import { NextResponse } from 'next/server';
import { getJarvisCoreForRequest } from '@/server/runtime';

/**
 * JARVIS-X v1.2.0 — Single Document API
 *
 * GET    /api/jarvis/files/:id  → metadata, provenance, indexing status, citations
 * DELETE /api/jarvis/files/:id  → revoke retrievable chunks + memory mirrors
 *
 * Owner-only. Identity is resolved server-side; the `:id` is never used to widen
 * scope beyond the authenticated owner.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: { id: string };
}

export async function GET(request: Request, context: RouteContext) {
  const documentId = context.params?.id;
  if (!documentId || typeof documentId !== 'string' || documentId.length > 120) {
    return NextResponse.json(
      { ok: false, errorCode: 'INVALID_INPUT', error: 'A document id is required.' },
      { status: 400 }
    );
  }

  try {
    const { jarvis, actor } = await getJarvisCoreForRequest(request);

    if (!actor.authenticated) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: 'UNAUTHORIZED_ACCESS',
          error: 'Document access requires an authenticated owner session.',
        },
        { status: 401 }
      );
    }

    const outcome = await jarvis.getDocumentMetadata(documentId);
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, errorCode: 'NOT_FOUND', error: 'Document not found for this owner.' },
        { status: 404 }
      );
    }

    const citations = jarvis.documentEngine.documentCitations(actor.userId, documentId);

    return NextResponse.json({
      ok: true,
      document: outcome.document,
      citations: citations.slice(0, 12),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document lookup failed';
    return NextResponse.json({ ok: false, errorCode: 'LOOKUP_FAILED', error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const documentId = context.params?.id;
  if (!documentId || typeof documentId !== 'string' || documentId.length > 120) {
    return NextResponse.json(
      { ok: false, errorCode: 'INVALID_INPUT', error: 'A document id is required.' },
      { status: 400 }
    );
  }

  try {
    const { jarvis, actor, repository } = await getJarvisCoreForRequest(request);

    if (!actor.authenticated) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: 'UNAUTHORIZED_ACCESS',
          error: 'Document deletion requires an authenticated owner session.',
        },
        { status: 401 }
      );
    }

    const result = await jarvis.deleteDocument(documentId);
    if ('errorCode' in result) {
      return NextResponse.json(result, { status: 401 });
    }

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, errorCode: 'NOT_FOUND', error: result.error },
        { status: 404 }
      );
    }

    // Mirror the removal into durable storage (RLS-scoped, chunks cascade).
    try {
      const records = await repository.listIngestedDocuments(actor.userId, 200);
      const matching = records.find(
        (record) => (record.metadata as { documentId?: string })?.documentId === documentId
      );
      if (matching) {
        await repository.deleteIngestedDocument?.(actor.userId, matching.id);
      }
    } catch {
      // Durable cleanup is best-effort; retrievable state is already revoked.
    }

    return NextResponse.json({
      ok: true,
      documentId: result.documentId,
      chunksRevoked: result.chunksRevoked,
      memoryEntriesRevoked: result.memoryEntriesRevoked,
      auditRetained: result.auditRetained,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document deletion failed';
    return NextResponse.json({ ok: false, errorCode: 'DELETE_FAILED', error: message }, { status: 500 });
  }
}
