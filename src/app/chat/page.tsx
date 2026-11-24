import { JarvisChatScreen } from '@/components/JarvisChatScreen';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'JARVIS-X // Chat',
  description: 'Talk to JARVIS — one assistant, backed by the full JARVIS-X runtime.',
};

/** Alias route for the conversation surface — identical to `/`. */
export default function ChatPage() {
  return <JarvisChatScreen />;
}
