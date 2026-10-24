import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DEFAULT_CONVERSATION_ID, normalizeConversationId } from '@/core/utils/uuid';
import { getJarvisCoreForRequest } from '@/server/runtime';

const PermissionResolveSchema = z.object({
  requestId: z.string().min(1),
  approve: z.boolean(),
  stepUpPasscode: z.string().max(120).optional(),
  conversationId: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = PermissionResolveSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'Invalid permission decision payload.' },
        { status: 400 }
      );
    }

    const { jarvis } = await getJarvisCoreForRequest(request);
    const convId = normalizeConversationId(
      parsed.data.conversationId || DEFAULT_CONVERSATION_ID
    );
    const result = await jarvis.resolvePermissionDecision(parsed.data);

    if (!result.resolved) {
      const snapshot = await jarvis.getSystemSnapshot(convId);
      return NextResponse.json(
        {
          ok: false,
          decision: result.decision,
          error: result.errorReason || 'Authorization failed.',
          snapshot,
        },
        { status: 403 }
      );
    }

    const snapshot = await jarvis.getSystemSnapshot(convId);

    return NextResponse.json({
      ok: true,
      result,
      snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected permission error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
