import { NextResponse } from 'next/server';
import { DEFAULT_CONVERSATION_ID, normalizeConversationId } from '@/core/utils/uuid';
import { getJarvisCoreForRequest } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const conversationId = normalizeConversationId(
      searchParams.get('conversationId') || DEFAULT_CONVERSATION_ID
    );
    const { jarvis } = await getJarvisCoreForRequest(request);
    const [snapshot, messages] = await Promise.all([
      jarvis.getSystemSnapshot(conversationId),
      jarvis.getConversationMessages(conversationId),
    ]);

    return NextResponse.json({
      ok: true,
      conversationId,
      snapshot,
      messages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected telemetry error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
