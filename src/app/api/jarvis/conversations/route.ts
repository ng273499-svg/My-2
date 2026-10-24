import { NextResponse } from 'next/server';
import { z } from 'zod';
import { normalizeConversationId } from '@/core/utils/uuid';
import { getJarvisCoreForRequest } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const CreateConversationSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  projectId: z.string().uuid().nullable().optional(),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const { jarvis } = await getJarvisCoreForRequest(request);

    if (id) {
      const convId = normalizeConversationId(id);
      const [conversation, messages] = await Promise.all([
        jarvis.getConversation(convId),
        jarvis.getConversationMessages(convId),
      ]);
      return NextResponse.json({
        ok: true,
        conversation,
        messages,
      });
    }

    const conversations = await jarvis.listConversations();
    return NextResponse.json({
      ok: true,
      conversations,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to retrieve conversations';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = CreateConversationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'Invalid conversation creation payload.' },
        { status: 400 }
      );
    }

    const { jarvis } = await getJarvisCoreForRequest(request);
    const conversation = await jarvis.createConversation(parsed.data);
    const snapshot = await jarvis.getSystemSnapshot(conversation.id);

    return NextResponse.json({
      ok: true,
      conversation,
      snapshot,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create conversation';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
