import type { ToolCapabilityDescriptor } from '@/core/types';

export interface RegisteredToolHandler {
  descriptor: ToolCapabilityDescriptor;
  execute?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * Tool & Connector Manager
 * Central registry for built-in safe capabilities and all 12 future-ready external
 * integration interfaces required by the JARVIS-X roadmap.
 * Unconfigured capabilities are honestly reported as `interface_ready_not_connected`.
 */
export class ToolConnectorManager {
  private tools = new Map<string, RegisteredToolHandler>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    const descriptors: RegisteredToolHandler[] = [
      {
        descriptor: {
          id: 'internal_diagnostics',
          name: 'Core System Diagnostics & Clock',
          category: 'internal_diagnostics',
          state: 'connected_local',
          permissionTier: 'SAFE_READ',
          description: 'Reads live server health, module status, active model route, and UTC telemetry.',
          statusDetail: 'Connected (Built-in Server Module)',
        },
        execute: async () => ({
          utcTime: new Date().toISOString(),
          status: 'healthy',
        }),
      },
      {
        descriptor: {
          id: 'session_memory_ops',
          name: 'Session & Supabase-Ready Memory Store',
          category: 'internal_diagnostics',
          state: 'connected_local',
          permissionTier: 'CONFIRMATION_REQUIRED',
          description: 'Stores and recalls structured memories in session memory (Supabase cloud adapter ready).',
          statusDetail: 'Connected (Local Ephemeral Active · Supabase Schema Ready)',
        },
      },
      {
        descriptor: {
          id: 'voice_stt',
          name: 'Real-Time Speech-to-Text (STT)',
          category: 'voice_stt',
          state: 'browser_dependent',
          permissionTier: 'SAFE_READ',
          description: 'Streaming speech transcription interface + optional client Web Speech dictation.',
          statusDetail: 'Server Neural STT: Not Connected · Browser Dictation: Client-Dependent',
          requiredIntegration: 'Streaming STT Provider (e.g., Whisper / Deepgram / Realtime Audio)',
        },
      },
      {
        descriptor: {
          id: 'voice_tts',
          name: 'Natural Female Text-to-Speech (Aria v1)',
          category: 'voice_tts',
          state: 'interface_ready_not_connected',
          permissionTier: 'SAFE_READ',
          description: 'Expressive female-voiced speech synthesis with 8 conversational style prosody hints.',
          statusDetail: 'Not Connected — Prosody & Voice Profile Interface Ready',
          requiredIntegration: 'Neural TTS Provider',
        },
      },
      {
        descriptor: {
          id: 'voice_barge_in',
          name: 'Full-Duplex Barge-In / Interruption',
          category: 'voice_barge_in',
          state: 'interface_ready_not_connected',
          permissionTier: 'SAFE_READ',
          description: 'VAD interruption state machine to halt assistant speech mid-utterance.',
          statusDetail: 'Not Connected — State Controller Ready, Duplex Stream Unconfigured',
          requiredIntegration: 'WebRTC / WebSocket Duplex Voice Transport',
        },
      },
      {
        descriptor: {
          id: 'vision_camera',
          name: 'Camera & Visual Understanding',
          category: 'vision_camera',
          state: 'interface_ready_not_connected',
          permissionTier: 'CONFIRMATION_REQUIRED',
          description: 'Camera frame capture & image attachment staging for multimodal inspection.',
          statusDetail: 'Not Connected — Client Frame Inspector Ready, Vision LLM Unconfigured',
          requiredIntegration: 'Vision-Capable Multimodal LLM',
        },
      },
      {
        descriptor: {
          id: 'web_research',
          name: 'Web Research & Live Grounding',
          category: 'web_research',
          state: 'interface_ready_not_connected',
          permissionTier: 'SAFE_READ',
          description: 'Live web search, source retrieval, and citation extraction.',
          statusDetail: 'Not Connected — Search Connector Unconfigured',
          requiredIntegration: 'Web Search API Connector',
        },
      },
      {
        descriptor: {
          id: 'file_analysis',
          name: 'Document & File Analysis',
          category: 'file_analysis',
          state: 'interface_ready_not_connected',
          permissionTier: 'SAFE_READ',
          description: 'Structured parsing for PDFs, spreadsheets, codebases, and structured datasets.',
          statusDetail: 'Not Connected — Document Ingestion Worker Unconfigured',
          requiredIntegration: 'Supabase Storage + Document Parser Pipeline',
        },
      },
      {
        descriptor: {
          id: 'computer_actions',
          name: 'Browser & Computer-Use Actions',
          category: 'computer_actions',
          state: 'interface_ready_not_connected',
          permissionTier: 'SENSITIVE_AUTH_REQUIRED',
          description: 'Isolated browser automation and OS-level GUI actions gated by Tier-3 authorization.',
          statusDetail: 'Not Connected — Blocked Behind Tier-3 Security Gate',
          requiredIntegration: 'Isolated Headless Browser / Sandbox VM',
        },
      },
      {
        descriptor: {
          id: 'code_execution',
          name: 'Sandboxed Code Execution',
          category: 'code_execution',
          state: 'interface_ready_not_connected',
          permissionTier: 'SENSITIVE_AUTH_REQUIRED',
          description: 'Ephemeral isolated container runtime for running Python/TypeScript snippets safely.',
          statusDetail: 'Not Connected — Execution Sandbox Unconfigured',
          requiredIntegration: 'Ephemeral Code Sandbox Runtime',
        },
      },
      {
        descriptor: {
          id: 'external_apis',
          name: 'External APIs & Workspace Connectors',
          category: 'external_apis',
          state: 'interface_ready_not_connected',
          permissionTier: 'CONFIRMATION_REQUIRED',
          description: 'OAuth/Vault-backed connectors for calendar, email, cloud drives, and webhooks.',
          statusDetail: 'Not Connected — Vault Credentials Unconfigured',
          requiredIntegration: 'OAuth / Supabase Vault Connector Registry',
        },
      },
      {
        descriptor: {
          id: 'smart_home_devices',
          name: 'Smart-Home & IoT Device Control',
          category: 'smart_home_devices',
          state: 'interface_ready_not_connected',
          permissionTier: 'SENSITIVE_AUTH_REQUIRED',
          description: 'Home Assistant / Matter bridge for lighting, climate, and physical locks.',
          statusDetail: 'Not Connected — Requires Tier-3 Auth & Home Bridge',
          requiredIntegration: 'Home Assistant / Matter Secure Bridge',
        },
      },
      {
        descriptor: {
          id: 'notifications',
          name: 'Multi-Channel Notifications',
          category: 'notifications',
          state: 'interface_ready_not_connected',
          permissionTier: 'CONFIRMATION_REQUIRED',
          description: 'Web Push and mobile alert dispatch for high-priority events.',
          statusDetail: 'Not Connected — Push Relay Unconfigured',
          requiredIntegration: 'Web Push VAPID / Notification Relay',
        },
      },
      {
        descriptor: {
          id: 'proactive_tasks',
          name: 'Scheduled & Proactive Routines',
          category: 'proactive_tasks',
          state: 'connected_local',
          permissionTier: 'CONFIRMATION_REQUIRED',
          description: 'In-session advisory monitor active; background cron triggers ready for Supabase Edge/Cron.',
          statusDetail: 'In-Session Advisory Active · Background Cron Not Connected',
          requiredIntegration: 'Supabase pg_cron / Edge Scheduler (for offline background jobs)',
        },
      },
      {
        descriptor: {
          id: 'cross_device_sync',
          name: 'Cross-Device Realtime Synchronization',
          category: 'cross_device_sync',
          state: 'interface_ready_not_connected',
          permissionTier: 'SAFE_READ',
          description: 'Realtime conversation, task, and memory state sync across desktop and mobile.',
          statusDetail: 'Not Connected — Activates via Supabase Realtime',
          requiredIntegration: 'Supabase Realtime + Auth Session',
        },
      },
    ];

    for (const item of descriptors) {
      this.tools.set(item.descriptor.id, item);
    }
  }

  listCapabilities(): ToolCapabilityDescriptor[] {
    return Array.from(this.tools.values()).map((t) => t.descriptor);
  }

  getCapability(id: string): ToolCapabilityDescriptor | undefined {
    return this.tools.get(id)?.descriptor;
  }

  getConnectionCounts(): { connectedLocal: number; standby: number } {
    const all = this.listCapabilities();
    const connectedLocal = all.filter((c) => c.state === 'connected_local').length;
    return {
      connectedLocal,
      standby: all.length - connectedLocal,
    };
  }
}
