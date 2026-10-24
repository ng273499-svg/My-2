import { JarvisDashboard } from '@/components/JarvisDashboard';
import { DEFAULT_CONVERSATION_ID } from '@/core/utils/uuid';
import { getGuestJarvisCore } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'JARVIS-X // HUD Dashboard',
  description: 'Full JARVIS-X command HUD: runtime telemetry, specialists, research & engineering.',
};

export default async function DashboardPage() {
  const jarvis = getGuestJarvisCore();
  const [snapshot, messages] = await Promise.all([
    jarvis.getSystemSnapshot(DEFAULT_CONVERSATION_ID),
    jarvis.getConversationMessages(DEFAULT_CONVERSATION_ID),
  ]);

  return (
    <JarvisDashboard
      initialSnapshot={snapshot}
      initialMessages={messages}
    />
  );
}
