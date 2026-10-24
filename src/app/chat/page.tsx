import { JarvisChat } from '@/components/JarvisChat';
import { DEFAULT_CONVERSATION_ID } from '@/core/utils/uuid';
import { getGuestJarvisCore } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'JARVIS-X // Chat',
  description: 'Talk to JARVIS — one assistant, backed by the full JARVIS-X runtime.',
};

export default async function ChatPage() {
  const jarvis = getGuestJarvisCore();

  const [messages, conversations] = await Promise.all([
    jarvis.getConversationMessages(DEFAULT_CONVERSATION_ID),
    jarvis.listConversations(),
  ]);

  return (
    <JarvisChat
      initialMessages={messages}
      initialConversations={conversations}
      initialConversationId={DEFAULT_CONVERSATION_ID}
    />
  );
}
