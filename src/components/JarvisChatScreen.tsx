import { JarvisChat } from '@/components/JarvisChat';
import { DEFAULT_CONVERSATION_ID } from '@/core/utils/uuid';
import { getGuestJarvisCore } from '@/server/runtime';

/**
 * Server wrapper that loads the opening conversation state and hands it to the
 * client chat surface. Shared by `/` and `/chat` so both routes serve the exact
 * same experience with no duplicated wiring.
 */
export async function JarvisChatScreen() {
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
