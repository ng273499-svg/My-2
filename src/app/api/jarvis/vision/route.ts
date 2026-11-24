import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const VisionInspectSchema = z.object({
  fileName: z.string().min(1).max(160),
  mimeType: z.string().min(1).max(80),
  sizeBytes: z.number().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  base64Data: z.string().max(5_600_000).optional(),
  source: z.enum(['upload', 'camera_preview']).optional(),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = VisionInspectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'Invalid vision frame payload.' },
        { status: 400 }
      );
    }

    const { jarvis } = await getJarvisCoreForRequest(request);
    const inspection = jarvis.visionEngine.inspectFrameMetadata({
      ...parsed.data,
      source: parsed.data.source ?? 'upload',
    });

    return NextResponse.json({
      ok: true,
      inspection,
      cloudVisionConfigured: inspection.providerConnected,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Vision frame inspection failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
