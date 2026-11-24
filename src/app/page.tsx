import { JarvisChatScreen } from '@/components/JarvisChatScreen';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'JARVIS-X // Chat',
  description: 'Talk to JARVIS — one assistant, backed by the full JARVIS-X runtime.',
};

/**
 * The site root renders the conversation surface directly (HTTP 200, no
 * redirect) so preview proxies, link previews and plain iframes all work.
 * The full command HUD lives at /dashboard and is unchanged.
 */
export default function ChatHomePage() {
  return <JarvisChatScreen />;
}
