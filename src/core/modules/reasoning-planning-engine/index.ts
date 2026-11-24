import type { PermissionTier, SpecialistDomain } from '@/core/types';
import type { ClassifiedIntent } from '@/core/modules/conversation-engine';

export interface ExecutionPlan {
  conciseSummary: string;
  steps: string[];
  recommendedSpecialist?: SpecialistDomain;
  requiredToolId?: string;
  permissionTier: PermissionTier;
  actionCode: string;
  targetResource: string;
}

/**
 * Reasoning & Planning Engine
 * Produces concise, user-facing execution plans and classifies operational risk.
 * Architectural invariant: Never exposes raw/private chain-of-thought — emits only
 * structured, concise operational summaries suitable for the Agent Activity Panel.
 */
export class ReasoningPlanningEngine {
  createPlan(intent: ClassifiedIntent, userMessage: string): ExecutionPlan {
    switch (intent) {
      case 'sensitive_action':
        return {
          conciseSummary:
            'Identified high-impact external/device operation; routing through Tier-3 security gate first.',
          steps: [
            'Classify external/device actuation boundary',
            'Enforce explicit step-up authorization check',
            'Verify connector availability before execution',
          ],
          recommendedSpecialist: 'automation',
          requiredToolId: 'smart_home_devices',
          permissionTier: 'SENSITIVE_AUTH_REQUIRED',
          actionCode: 'EXTERNAL_SENSITIVE_EXECUTION',
          targetResource: userMessage.slice(0, 72),
        };

      case 'memory_write':
        return {
          conciseSummary:
            'Detected persistent memory write request; staging Tier-2 confirmation before modifying memory store.',
          steps: [
            'Extract structured fact candidate from message',
            'Request operator confirmation prior to memory mutation',
            'Commit verified entry via Memory Manager',
          ],
          recommendedSpecialist: 'memory',
          permissionTier: 'CONFIRMATION_REQUIRED',
          actionCode: 'MEMORY_STORE_WRITE',
          targetResource: 'Memory Store (Session / Supabase)',
        };

      case 'memory_clear':
        return {
          conciseSummary:
            'Detected destructive memory purge request; enforcing Tier-3 sensitive authorization.',
          steps: [
            'Scope affected memory records',
            'Require explicit step-up verification prior to deletion',
          ],
          recommendedSpecialist: 'memory',
          permissionTier: 'SENSITIVE_AUTH_REQUIRED',
          actionCode: 'MEMORY_PURGE_SENSITIVE',
          targetResource: 'All Session/Stored Memories',
        };

      case 'memory_read':
        return {
          conciseSummary: 'Querying active memory index and summarizing stored context.',
          steps: [
            'Dispatch Memory Agent for read-only recall',
            'Synthesize matching facts and report persistence backend status',
          ],
          recommendedSpecialist: 'memory',
          permissionTier: 'SAFE_READ',
          actionCode: 'MEMORY_READ',
          targetResource: 'Memory Store',
        };

      case 'research':
        return {
          conciseSummary:
            'Routing inquiry to Research Agent interface and checking web retrieval connector state.',
          steps: [
            'Decompose research topic into verifiable sub-questions',
            'Check Web Research connector status',
            'Return structured research brief outline',
          ],
          recommendedSpecialist: 'research',
          requiredToolId: 'web_research',
          permissionTier: 'SAFE_READ',
          actionCode: 'SPECIALIST_RESEARCH_BRIEF',
          targetResource: 'Research Agent Interface',
        };

      case 'coding':
        return {
          conciseSummary:
            'Routing technical task to Coding Agent interface and verifying model/sandbox readiness.',
          steps: [
            'Map architectural requirements & module interfaces',
            'Check external Coding LLM & Execution Sandbox status',
            'Deliver structured technical guidance',
          ],
          recommendedSpecialist: 'coding',
          requiredToolId: 'code_execution',
          permissionTier: 'SAFE_READ',
          actionCode: 'SPECIALIST_CODING_PLAN',
          targetResource: 'Coding Agent Interface',
        };

      case 'design':
        return {
          conciseSummary:
            'Dispatching UI/UX inquiry to Design Agent interface for layout and visual system review.',
          steps: [
            'Assess spatial hierarchy and responsive constraints',
            'Synthesize structured UX checklist',
          ],
          recommendedSpecialist: 'design',
          permissionTier: 'SAFE_READ',
          actionCode: 'SPECIALIST_DESIGN_REVIEW',
          targetResource: 'Design Agent Interface',
        };

      case 'automation':
        return {
          conciseSummary:
            'Staging workflow automation request behind confirmation gate and inspecting connectors.',
          steps: [
            'Validate automation trigger and target connector',
            'Request operator confirmation before scheduling workflow',
          ],
          recommendedSpecialist: 'automation',
          requiredToolId: 'proactive_tasks',
          permissionTier: 'CONFIRMATION_REQUIRED',
          actionCode: 'WORKFLOW_AUTOMATION_STAGE',
          targetResource: 'Automation Pipeline',
        };

      case 'vision_inquiry':
        return {
          conciseSummary:
            'Checking Vision Engine & multimodal provider connection status for visual inspection.',
          steps: [
            'Inspect submitted visual metadata via Vision Engine',
            'Report multimodal model connection status honestly',
          ],
          requiredToolId: 'vision_camera',
          permissionTier: 'SAFE_READ',
          actionCode: 'VISION_PIPELINE_CHECK',
          targetResource: 'Vision Engine',
        };

      case 'voice_inquiry':
        return {
          conciseSummary:
            'Inspecting Voice Engine (STT, natural female TTS profile, and barge-in readiness).',
          steps: [
            'Check server neural STT/TTS adapter configuration',
            'Summarize Aria female voice prosody calibration',
          ],
          requiredToolId: 'voice_tts',
          permissionTier: 'SAFE_READ',
          actionCode: 'VOICE_PIPELINE_CHECK',
          targetResource: 'Voice Engine',
        };

      case 'diagnostics':
        return {
          conciseSummary:
            'Running read-only system telemetry audit across all 14 core modules and data layers.',
          steps: [
            'Inspect module health, active router, and Supabase adapter status',
            'Verify unconfigured vs active capabilities via Verification Agent',
          ],
          recommendedSpecialist: 'verification',
          requiredToolId: 'internal_diagnostics',
          permissionTier: 'SAFE_READ',
          actionCode: 'SYSTEM_DIAGNOSTICS_READ',
          targetResource: 'JARVIS-X Core Diagnostics',
        };

      case 'greeting':
      case 'general_assistance':
      default:
        return {
          conciseSummary:
            'Synthesizing contextual response using active persona calibration and session memory.',
          steps: [
            'Recall relevant session memory context',
            'Route through active foundation model adapter',
            'Run post-turn verification check',
          ],
          permissionTier: 'SAFE_READ',
          actionCode: 'CONVERSATION_TURN',
          targetResource: 'Conversation Engine',
        };
    }
  }
}
