import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';
import { DEFAULT_SECURITY_LIMITS, formatFromExtension } from '@/core/document-intelligence/security-gate';
import type { IngestedDocumentFormatKind } from '@/server/repositories/types';

/**
 * JARVIS-X v1.2.0 — Grounded Document Ingestion API
 *
 * POST /api/jarvis/files/ingest
 *
 * Accepts either multipart/form-data (real browser file upload) or a JSON body
 * carrying UTF-8 text. Owner identity is ALWAYS resolved server-side from the
 * authenticated session — a client-supplied owner ID is rejected outright, never
 * trusted.
 *
 * Document content is DATA, never code: nothing here executes, evaluates, or
 * follows instructions found inside a document.
 */

export const dynamic = 'force-dynamic';
// Parsing PDF/DOCX is CPU-bound; keep the runtime in Node, not Edge.
export const runtime = 'nodejs';

const JsonIngestSchema = z.object({
  fileName: z.string().min(1).max(200),
  mimeType: z.string().max(160).default('text/plain'),
  /** Plain UTF-8 text content (text/markdown/csv/json/code/html/xml/yaml/toml). */
  textContent: z.string().max(DEFAULT_SECURITY_LIMITS.maxBytes).optional(),
  /** Base64-encoded bytes for binary formats (pdf/docx). */
  contentBase64: z.string().max(DEFAULT_SECURITY_LIMITS.maxBytes * 2).optional(),
  projectId: z.string().uuid().nullable().optional(),
  source: z.enum(['upload', 'camera', 'workspace', 'url_import']).optional(),
  /** Explicitly rejected: the workspace is server-bound and identity is server-resolved. */
  ownerId: z.undefined().optional(),
  userId: z.undefined().optional(),
});

const FORMAT_KIND_BY_FORMAT: Record<string, IngestedDocumentFormatKind> = {
  markdown: 'markdown',
  text: 'text',
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

function formatKindFor(fileName: string): IngestedDocumentFormatKind {
  const format = formatFromExtension(fileName);
  return (format && FORMAT_KIND_BY_FORMAT[format]) || 'text';
}

export async function POST(request: Request) {
  // --- Early size guard (before buffering the body) ----------------------
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > DEFAULT_SECURITY_LIMITS.maxBytes * 2) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: 'FILE_TOO_LARGE',
        error: `Upload exceeds the ${Math.round(
          DEFAULT_SECURITY_LIMITS.maxBytes / (1024 * 1024)
        )} MB document limit.`,
      },
      { status: 413 }
    );
  }

  let fileName = '';
  let mimeType = 'application/octet-stream';
  let bytes: Uint8Array | undefined;
  let textContent: string | undefined;
  let projectId: string | null = null;
  let source: 'upload' | 'camera' | 'workspace' | 'url_import' = 'upload';

  try {
    const contentType = request.headers.get('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json(
          { ok: false, errorCode: 'INVALID_INPUT', error: 'A "file" field is required.' },
          { status: 400 }
        );
      }
      fileName = file.name;
      mimeType = file.type || 'application/octet-stream';
      bytes = new Uint8Array(await file.arrayBuffer());

      const projectField = form.get('projectId');
      if (typeof projectField === 'string' && projectField.trim()) {
        const parsedProject = z.string().uuid().safeParse(projectField.trim());
        if (!parsedProject.success) {
          return NextResponse.json(
            { ok: false, errorCode: 'INVALID_INPUT', error: 'projectId must be a UUID.' },
            { status: 400 }
          );
        }
        projectId = parsedProject.data;
      }
      const sourceField = form.get('source');
      if (typeof sourceField === 'string') {
        const parsedSource = z
          .enum(['upload', 'camera', 'workspace', 'url_import'])
          .safeParse(sourceField);
        if (parsedSource.success) source = parsedSource.data;
      }
      const textField = form.get('textContent');
      if (typeof textField === 'string' && textField.length > 0) {
        textContent = textField;
      }
    } else {
      let json: unknown;
      try {
        json = await request.json();
      } catch {
        return NextResponse.json(
          { ok: false, errorCode: 'INVALID_INPUT', error: 'Body must be JSON or form-data.' },
          { status: 400 }
        );
      }
      const parsed = JsonIngestSchema.safeParse(json);
      if (!parsed.success) {
        return NextResponse.json(
          {
            ok: false,
            errorCode: 'INVALID_INPUT',
            error: parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          },
          { status: 400 }
        );
      }
      fileName = parsed.data.fileName;
      mimeType = parsed.data.mimeType;
      projectId = parsed.data.projectId ?? null;
      source = parsed.data.source ?? 'upload';
      textContent = parsed.data.textContent;
      if (parsed.data.contentBase64) {
        try {
          bytes = new Uint8Array(Buffer.from(parsed.data.contentBase64, 'base64'));
        } catch {
          return NextResponse.json(
            { ok: false, errorCode: 'INVALID_INPUT', error: 'contentBase64 is not valid base64.' },
            { status: 400 }
          );
        }
      }
    }
  } catch {
    return NextResponse.json(
      { ok: false, errorCode: 'INVALID_INPUT', error: 'Request body could not be read.' },
      { status: 400 }
    );
  }

  if (!bytes && !textContent) {
    return NextResponse.json(
      { ok: false, errorCode: 'INVALID_INPUT', error: 'No document content was supplied.' },
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
          error:
            'Document ingestion requires an authenticated owner session. Guest/voice-only sessions are never granted document access.',
        },
        { status: 401 }
      );
    }

    const result = await jarvis.ingestDocument({
      fileName,
      mimeType,
      bytes,
      textContent,
      projectId,
      source,
    });

    if ('errorCode' in result) {
      return NextResponse.json(result, { status: 401 });
    }

    // --- Persist the record + chunks (best-effort, RLS-scoped) -----------
    let recordedId: string | null = null;
    if (result.ok && result.documentId) {
      try {
        const stored = await repository.recordIngestedDocument(actor.userId, {
          projectId,
          fileName,
          mimeType,
          formatKind: formatKindFor(fileName),
          sizeBytes: bytes?.byteLength ?? textContent?.length ?? 0,
          chunkCount: result.chunkCount,
          injectionFlagged: false,
          summary: `${result.format ?? 'document'} · ${result.pageCount} page(s) · ${result.chunkCount} chunk(s) · ${result.lifecycle}`,
          metadata: {
            documentId: result.documentId,
            lifecycle: result.lifecycle,
            parser: result.parser,
            ocrRequired: result.ocrRequired,
          },
          contentHash: result.contentHash,
          pageCount: result.pageCount,
          lifecycle: result.lifecycle,
          parser: result.parser,
          embeddingMode: result.embeddingStatus.mode,
          ocrRequired: result.ocrRequired,
          pageProvenanceAvailable: result.format === 'pdf',
          trustLevel: 'untrusted_external',
        });
        recordedId = stored.id;

        const chunks = jarvis.documentEngine.index.allForOwner(actor.userId).filter(
          (c) => c.documentId === result.documentId
        );
        if (chunks.length > 0) {
          await repository.recordDocumentChunks?.(
            actor.userId,
            recordedId,
            chunks.slice(0, 500).map((chunk) => ({
              projectId: chunk.projectId,
              chunkIndex: chunk.order,
              chunkKey: chunk.chunkId,
              section: chunk.section,
              headingPath: chunk.headingPath,
              page: chunk.page,
              pageStart: chunk.pageRange?.[0] ?? null,
              pageEnd: chunk.pageRange?.[1] ?? null,
              textContent: chunk.text,
              charCount: chunk.charCount,
              tokenEstimate: chunk.tokenEstimate,
              contentHash: chunk.contentHash,
              trustLevel: chunk.trustLevel,
            }))
          );
        }
      } catch {
        // Persistence is degraded, not fatal: the in-process index remains
        // authoritative for this session and the response says so.
        result.warnings.push(
          'Document was ingested into the in-process index but could not be persisted to the durable store.'
        );
      }
    }

    const httpStatus =
      result.ok
        ? 200
        : result.lifecycle === 'OCR_REQUIRED'
          ? 422
          : 400;

    return NextResponse.json(
      {
        ok: result.ok,
        errorCode: result.ok ? undefined : result.lifecycle,
        error: result.ok ? undefined : result.errors[0],
        persistedRecordId: recordedId,
        ingestion: {
          documentId: result.documentId,
          lifecycle: result.lifecycle,
          format: result.format,
          pageCount: result.pageCount,
          chunkCount: result.chunkCount,
          contentHash: result.contentHash,
          parser: result.parser,
          ocrRequired: result.ocrRequired,
          duplicateOf: result.duplicateOf,
          durationMs: result.durationMs,
          warnings: result.warnings,
          errors: result.errors,
        },
        // Honest embedding reporting — never presented as production semantics.
        embedding: result.embeddingStatus,
        // Import-compatible field for the pre-existing v1.0 client.
        status: result.ok ? 'INGESTED' : result.lifecycle,
      },
      { status: httpStatus }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document ingestion failed';
    return NextResponse.json({ ok: false, errorCode: 'INGEST_FAILED', error: message }, { status: 500 });
  }
}
