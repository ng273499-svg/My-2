import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  analyzeStructuredDocument,
  detectDocumentFormat,
} from '@/core/files';
import { getJarvisCoreForRequest } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const AnalyzeFileSchema = z.object({
  fileName: z.string().min(1).max(160),
  mimeType: z.string().max(120).default('text/plain'),
  sizeBytes: z.number().nonnegative().optional(),
  textContent: z.string().min(1).max(120_000),
  projectId: z.string().uuid().nullable().optional(),
  ingestToKnowledge: z.boolean().optional(),
});

export async function GET(request: Request) {
  try {
    const { actor, repository, jarvis } = await getJarvisCoreForRequest(request);
    const documents = await repository.listIngestedDocuments(actor.userId, 25);

    // v1.2: live document-intelligence state for the authenticated owner only.
    const workspace = actor.authenticated ? jarvis.listDocuments() : null;
    const liveDocuments =
      workspace && 'documents' in workspace ? workspace.documents : [];

    return NextResponse.json({
      ok: true,
      documents,
      // In-process grounded intelligence state (honest about parser coverage).
      intelligence: {
        version: '1.2.0-document-intelligence',
        documents: liveDocuments,
        embedding: jarvis.documentEngine.embeddingStatus(),
        rerankingMode: jarvis.documentEngine.reranking.mode,
        parserCapabilities: jarvis.documentEngine.parserCapabilities(),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to list ingested documents';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = AnalyzeFileSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'Invalid document analysis payload.' },
        { status: 400 }
      );
    }

    const fmt = detectDocumentFormat(parsed.data.fileName, parsed.data.mimeType);
    if (fmt === 'unsupported_binary') {
      return NextResponse.json(
        {
          ok: false,
          status: 'NOT_AVAILABLE',
          error: `Binary document extraction ("${parsed.data.fileName}") is NOT_AVAILABLE. Attach Markdown, CSV, JSON, code, or plain text.`,
        },
        { status: 422 }
      );
    }

    const { actor, jarvis, repository } = await getJarvisCoreForRequest(request);
    const analysis = analyzeStructuredDocument({
      fileName: parsed.data.fileName,
      mimeType: parsed.data.mimeType,
      sizeBytes: parsed.data.sizeBytes,
      textContent: parsed.data.textContent,
    });

    const ingestedIds: string[] = [];
    if (parsed.data.ingestToKnowledge) {
      for (const chunk of analysis.chunks.slice(0, 12)) {
        const outcome = await jarvis.memoryManager.ingestKnowledgeChunk(
          actor.userId,
          chunk,
          {
            sourceLabel: parsed.data.fileName,
            projectId: parsed.data.projectId ?? null,
            tags: ['file-intelligence', analysis.formatKind],
          }
        );
        if (outcome.entry) {
          ingestedIds.push(outcome.entry.id);
        }
      }
    }

    const dbFormatKind: 'markdown' | 'text' | 'csv' | 'json' | 'code' =
      analysis.formatKind;

    const recordedDocument = await repository.recordIngestedDocument(actor.userId, {
      projectId: parsed.data.projectId ?? null,
      fileName: analysis.fileName,
      mimeType: analysis.mimeType,
      formatKind: dbFormatKind,
      sizeBytes: analysis.sizeBytes,
      chunkCount: analysis.chunks.length,
      injectionFlagged: analysis.injectionAttemptDetected,
      summary: analysis.conciseSummary,
      metadata: {
        lineCount: analysis.lineCount,
        wordCount: analysis.wordCount,
        headings: analysis.headings.slice(0, 12),
        codeSymbols: analysis.codeSymbols.slice(0, 12),
        ingestedMemoryIds: ingestedIds,
      },
    });

    const snapshot = await jarvis.getSystemSnapshot();
    return NextResponse.json({
      ok: true,
      documentRecord: recordedDocument,
      analysis: {
        fileName: analysis.fileName,
        formatKind: analysis.formatKind,
        lineCount: analysis.lineCount,
        wordCount: analysis.wordCount,
        tokenEstimate: analysis.tokenEstimate,
        headings: analysis.headings,
        codeSymbols: analysis.codeSymbols,
        csvSummary: analysis.csvSummary,
        jsonSummary: analysis.jsonSummary,
        chunkCount: analysis.chunks.length,
        ingestedMemoryIds: ingestedIds,
        injectionAttemptDetected: analysis.injectionAttemptDetected,
        conciseSummary: analysis.conciseSummary,
      },
      snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'File analysis failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
