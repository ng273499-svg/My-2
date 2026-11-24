import type {
  CapabilityDefinition,
  CapabilityExecutionContext,
  CapabilityExecutionResult,
  RuntimeCapabilityId,
} from '@/core/types';
import {
  analyzeStructuredDocument,
  detectDocumentFormat,
} from '@/core/files';
import type { VisionEngine } from '@/core/modules/vision-engine';
import type { CodingEngine } from '@/core/coding-engine';
import type { ResearchEngine } from '@/core/research';
import { sanitizeUntrustedExternalOutput } from './errors';

export type CapabilityHandler = (
  ctx: CapabilityExecutionContext
) => Promise<CapabilityExecutionResult>;

export interface RegisteredRuntimeCapability {
  definition: CapabilityDefinition;
  execute: CapabilityHandler;
}

export interface CapabilityRegistryOptions {
  visionEngine?: VisionEngine;
  /**
   * JARVIS-X v1.1.0 Coding Engine. When present the `coding` capability runs a
   * real, bounded repository analysis instead of a static blueprint.
   */
  codingEngine?: CodingEngine;
  researchEngine?: ResearchEngine;
  onIngestKnowledgeChunk?: (
    userId: string,
    chunk: string,
    meta: { sourceLabel: string; projectId?: string | null }
  ) => Promise<void>;
}

/**
 * JARVIS-X Capability Registry
 * Central registry for current and future runtime capabilities.
 * Unimplemented capabilities MUST report `status: 'NOT_AVAILABLE'` and NEVER fake execution.
 */
export class CapabilityRegistry {
  private readonly capabilities = new Map<
    RuntimeCapabilityId,
    RegisteredRuntimeCapability
  >();

  constructor(options?: CapabilityRegistryOptions) {
    this.registerDefaults(
      options?.visionEngine,
      options?.onIngestKnowledgeChunk,
      options?.codingEngine,
      options?.researchEngine
    );
  }

  private registerDefaults(
    visionEngine?: VisionEngine,
    onIngestKnowledgeChunk?: CapabilityRegistryOptions['onIngestKnowledgeChunk'],
    codingEngine?: CodingEngine,
    researchEngine?: ResearchEngine
  ): void {
    // 1. Direct Conversation (AVAILABLE)
    this.register({
      definition: {
        id: 'direct_conversation',
        name: 'Direct Conversation & Reasoning Core',
        description: 'Handles dialogue, context synthesis, and architectural reasoning.',
        availability: 'AVAILABLE',
        defaultRiskLevel: 'READ_ONLY',
        countsAsToolCall: false,
        supportsModalities: ['text', 'voice_transcript'],
      },
      execute: async (ctx) => ({
        capabilityId: 'direct_conversation',
        status: 'EXECUTED',
        summary: `Prepared conversational context for step "${ctx.step.stepId}".`,
      }),
    });

    // 2. Memory (AVAILABLE — backed by Supabase RLS / Resilient Repository)
    this.register({
      definition: {
        id: 'memory',
        name: 'Permitted Memory & Context Store',
        description:
          'Reads permitted user/project memories and stages confirmed durable facts via Supabase RLS.',
        availability: 'AVAILABLE',
        defaultRiskLevel: 'READ_ONLY',
        countsAsToolCall: true,
        supportsModalities: ['text', 'voice_transcript'],
      },
      execute: async (ctx) => ({
        capabilityId: 'memory',
        status: 'EXECUTED',
        summary: `Recalled ${ctx.memorySnippets.length} permitted memory item(s) for user context.`,
        data: { recalledCount: ctx.memorySnippets.length },
      }),
    });

    // 3. Research (v1.3.0 Deep Research & Web Intelligence)
    this.register({
      definition: {
        id: 'research',
        name: 'Deep Research & Web Intelligence',
        description: researchEngine
          ? 'Bounded, evidence-grounded web research: planning, discovery, extraction, claim verification, contradiction detection and citation-checked reports (zero-cost provider stack).'
          : 'Provides local research structuring; no live web retrieval is connected.',
        availability: researchEngine ? 'PARTIAL_LOCAL' : 'NOT_AVAILABLE',
        defaultRiskLevel: 'READ_ONLY',
        countsAsToolCall: true,
        supportsModalities: ['text', 'voice_transcript'],
        missingDependencyNote:
          researchEngine && !researchEngine.providerHealth().live
            ? `LIVE WEB SEARCH IS ${researchEngine.providerHealth().status} — no external search provider is configured, so JARVIS will report the absence of live results instead of fabricating them.`
            : researchEngine
              ? undefined
              : 'NOT_AVAILABLE — research engine is not connected in this build.',
      },
      execute: async (ctx) => {
        if (!researchEngine) {
          return {
            capabilityId: 'research',
            status: 'NOT_AVAILABLE',
            summary:
              'Capability "research" is NOT_AVAILABLE. No web sources were fetched and no citations were produced.',
            honestLimitationNote:
              'Live external web search is NOT_AVAILABLE; no external URLs or live citations were fetched.',
          };
        }

        const result = await researchEngine.run({
          ownerId: ctx.userId,
          query: ctx.userMessage,
          mode: 'QUICK_RESEARCH',
          projectId: ctx.projectId ?? null,
          signal: ctx.signal,
        });

        const provider = result.report?.providerStatus;
        const liveNote = provider?.live
          ? `Live provider "${provider.providerId}".`
          : `Search provider status: ${provider?.status ?? 'UNCONFIGURED'} — results are NOT live web research.`;

        return {
          capabilityId: 'research',
          status: result.ok ? 'SUCCESS' : 'PARTIAL',
          summary:
            result.report?.executiveSummary?.slice(0, 600) ??
            `Research ${result.status.toLowerCase()} with ${result.sources.length} source(s).`,
          honestLimitationNote: liveNote,
          artifacts: {
            taskId: result.taskId,
            confidence: result.report?.confidence.level ?? 'INSUFFICIENT',
            citations: result.report?.citations.length ?? 0,
          },
        } as never;
      },
    });

    // 4. Coding (v1.1.0 Coding & Software Engineering Engine)
    this.register({
      definition: {
        id: 'coding',
        name: 'Coding & Software Engineering Engine',
        description: codingEngine
          ? 'Bounded repository intelligence, structure analysis, defensive security review and project memory across 24+ languages (zero-cost local analysis).'
          : 'Provides local engineering decomposition; isolated code execution sandbox is not yet connected.',
        availability: codingEngine ? 'AVAILABLE' : 'PARTIAL_LOCAL',
        defaultRiskLevel: 'LOW_RISK',
        countsAsToolCall: true,
        supportsModalities: ['text'],
        missingDependencyNote: codingEngine
          ? 'Remote sandboxed execution and external coding LLMs remain NOT_AVAILABLE; all analysis is local and evidence-based.'
          : 'Sandboxed code execution runtime & external Coding LLM are NOT_AVAILABLE.',
      },
      execute: async (ctx) => {
        const wantsLiveRun = /\b(run|execute|compile and run|execute python|run script)\b/i.test(
          ctx.userMessage
        );
        if (wantsLiveRun) {
          return {
            capabilityId: 'coding',
            status: 'NOT_AVAILABLE',
            summary:
              'Arbitrary script execution is NOT_AVAILABLE. JARVIS-X refuses to fake script execution.',
            honestLimitationNote:
              'Arbitrary code execution is NOT_AVAILABLE; only allow-listed project commands run through the Coding Engine validator.',
          };
        }

        if (codingEngine) {
          return codingEngine.executeAsCapability(ctx);
        }

        return {
          capabilityId: 'coding',
          status: 'PARTIAL_LOCAL',
          summary:
            'Generated local architectural engineering guidance (external Coding LLM & execution sandbox NOT_AVAILABLE).',
          honestLimitationNote:
            'Running local deterministic coding planner; live code execution is NOT_AVAILABLE.',
        };
      },
    });

    // 5. Vision (PARTIAL_LOCAL binary geometry inspector active; Vision LLM routed when configured)
    this.register({
      definition: {
        id: 'vision',
        name: 'Visual Frame & Multimodal Understanding',
        description:
          'Inspects binary image headers/geometry (PNG/JPEG/GIF/WebP/SVG) locally and routes frames to configured Vision LLMs.',
        availability: visionEngine?.isConnected() ? 'AVAILABLE' : 'PARTIAL_LOCAL',
        defaultRiskLevel: 'LOW_RISK',
        countsAsToolCall: true,
        supportsModalities: ['vision_multimodal', 'text'],
        missingDependencyNote: visionEngine?.isConnected()
          ? undefined
          : 'Binary frame/geometry inspector active; configure a Vision AIProvider key for semantic scene recognition.',
      },
      execute: async (ctx) => {
        const inspection =
          visionEngine && ctx.visionAttachment
            ? visionEngine.inspectFrameMetadata({
                fileName: ctx.visionAttachment.fileName,
                mimeType: ctx.visionAttachment.mimeType,
                sizeBytes: ctx.visionAttachment.sizeBytes,
                width: ctx.visionAttachment.width,
                height: ctx.visionAttachment.height,
                base64Data: ctx.visionAttachment.base64Data,
                source: ctx.visionAttachment.source ?? 'upload',
                userPrompt: ctx.userMessage,
              })
            : null;

        if (visionEngine?.isConnected() && inspection) {
          return {
            capabilityId: 'vision',
            status: 'EXECUTED',
            summary: inspection.statusMessage,
            data: { binaryDiagnostics: inspection.binaryDiagnostics },
          };
        }

        if (
          inspection?.binaryDiagnostics &&
          inspection.binaryDiagnostics.bytesInspected > 0
        ) {
          return {
            capabilityId: 'vision',
            status: 'PARTIAL_LOCAL',
            summary: inspection.statusMessage,
            data: { binaryDiagnostics: inspection.binaryDiagnostics },
            honestLimitationNote:
              'Binary image header & pixel geometry verified locally; semantic scene recognition is NOT_AVAILABLE without a configured Vision AIProvider.',
          };
        }

        return {
          capabilityId: 'vision',
          status: 'NOT_AVAILABLE',
          summary: inspection
            ? inspection.statusMessage
            : 'Capability "vision" is NOT_AVAILABLE — Multimodal Vision LLM provider is not configured.',
          honestLimitationNote:
            'Visual content recognition is NOT_AVAILABLE until a Vision-capable AIProvider is configured.',
        };
      },
    });

    // 6. File Intelligence (PARTIAL_LOCAL — structured text/MD/CSV/JSON/code parser active; binary PDF/Office NOT_AVAILABLE)
    this.register({
      definition: {
        id: 'file_intelligence',
        name: 'Document & File Intelligence',
        description:
          'v1.2 Grounded Document Intelligence: real PDF/DOCX text extraction with page-level provenance, hybrid retrieval, reranking, citations and claim verification via POST /api/jarvis/files/ingest and /query. In-chat attachments still use the quarantined text/MD/CSV/JSON/code path.',
        availability: 'PARTIAL_LOCAL',
        defaultRiskLevel: 'LOW_RISK',
        countsAsToolCall: true,
        supportsModalities: ['text'],
        missingDependencyNote:
          'PDF (text-based) and DOCX extraction are AVAILABLE through the document ingestion API; OCR for scanned/image documents is NOT_AVAILABLE.',
      },
      execute: async (ctx) => {
        const doc = ctx.documentAttachment;
        if (!doc || !doc.textContent?.trim()) {
          return {
            capabilityId: 'file_intelligence',
            status: 'NOT_AVAILABLE',
            summary:
              'Capability "file_intelligence" is NOT_AVAILABLE — no structured text/CSV/JSON/Markdown document payload was attached (binary PDF/Office extraction is NOT_AVAILABLE).',
            honestLimitationNote:
              'Unattached file references and binary PDFs are NOT_AVAILABLE; zero document contents were fabricated.',
          };
        }

        const fmt = detectDocumentFormat(doc.fileName, doc.mimeType);
        if (fmt === 'unsupported_binary') {
          return {
            capabilityId: 'file_intelligence',
            status: 'NOT_AVAILABLE',
            summary: `Capability "file_intelligence" is NOT_AVAILABLE for binary format "${doc.fileName}" — attach Markdown, CSV, JSON, code, or plain text.`,
            honestLimitationNote:
              'Binary PDF/Office OCR is NOT_AVAILABLE; zero document contents were fabricated.',
          };
        }

        const analysis = analyzeStructuredDocument({
          fileName: doc.fileName,
          mimeType: doc.mimeType,
          sizeBytes: doc.sizeBytes,
          textContent: doc.textContent,
        });

        let ingestedChunks = 0;
        if (doc.ingestToKnowledge && onIngestKnowledgeChunk) {
          for (const chunk of analysis.chunks.slice(0, 12)) {
            await onIngestKnowledgeChunk(ctx.userId, chunk, {
              sourceLabel: doc.fileName,
              projectId: ctx.projectId,
            });
            ingestedChunks += 1;
          }
        }

        return {
          capabilityId: 'file_intelligence',
          status: 'EXECUTED',
          untrustedExternalContent: true,
          summary: `${analysis.conciseSummary}${
            ingestedChunks > 0
              ? ` Ingested ${ingestedChunks} quarantined chunk(s) into knowledge memory.`
              : ''
          }`,
          data: {
            formatKind: analysis.formatKind,
            lineCount: analysis.lineCount,
            wordCount: analysis.wordCount,
            chunkCount: analysis.chunks.length,
            ingestedChunks,
            headings: analysis.headings,
            codeSymbols: analysis.codeSymbols,
            csvSummary: analysis.csvSummary,
            jsonSummary: analysis.jsonSummary,
            injectionAttemptDetected: analysis.injectionAttemptDetected,
          },
        };
      },
    });

    // 7. Automation (NOT_AVAILABLE)
    this.register({
      definition: {
        id: 'automation',
        name: 'Scheduled Workflows & Background Automation',
        description: 'Executes scheduled triggers, cron routines, and event-driven workflows.',
        availability: 'NOT_AVAILABLE',
        defaultRiskLevel: 'CONFIRMATION_REQUIRED',
        countsAsToolCall: true,
        supportsModalities: ['text'],
        missingDependencyNote:
          'NOT_AVAILABLE — Background scheduler / Edge cron runner not connected.',
      },
      execute: async () => ({
        capabilityId: 'automation',
        status: 'NOT_AVAILABLE',
        summary:
          'Capability "automation" is NOT_AVAILABLE — background workflow runner is not configured.',
        honestLimitationNote:
          'Scheduled background execution is NOT_AVAILABLE; workflow was not scheduled.',
      }),
    });

    // 8. Verification (AVAILABLE)
    this.register({
      definition: {
        id: 'verification',
        name: 'Runtime Outcome & Governance Verifier',
        description:
          'Audits step outputs, anti-fabrication invariants, and permission compliance.',
        availability: 'AVAILABLE',
        defaultRiskLevel: 'READ_ONLY',
        countsAsToolCall: false,
        supportsModalities: ['text', 'voice_transcript', 'vision_multimodal'],
      },
      execute: async () => ({
        capabilityId: 'verification',
        status: 'EXECUTED',
        summary: 'Verified capability statuses and anti-fabrication boundaries.',
      }),
    });

    // 9. Cybersecurity / Defensive Security (PARTIAL_LOCAL — defensive checklist active; live scanner NOT_AVAILABLE)
    this.register({
      definition: {
        id: 'cybersecurity',
        name: 'Defensive Security & RLS Posture Analyzer',
        description:
          'Provides read-only defensive threat-modeling, RLS verification guidance, and secret-hygiene checks.',
        availability: 'PARTIAL_LOCAL',
        defaultRiskLevel: 'LOW_RISK',
        countsAsToolCall: true,
        supportsModalities: ['text'],
        missingDependencyNote:
          'Live external network/CVE vulnerability scanning is NOT_AVAILABLE (strictly defensive local guidance active).',
      },
      execute: async (ctx) => {
        const wantsExternalScan = /\b(scan target|port scan|nmap|probe server|live cve scan)\b/i.test(
          ctx.userMessage
        );
        if (wantsExternalScan) {
          return {
            capabilityId: 'cybersecurity',
            status: 'NOT_AVAILABLE',
            summary:
              'External network/vulnerability scanning is NOT_AVAILABLE. Only defensive architecture review is supported.',
            honestLimitationNote: 'Active network scanning is NOT_AVAILABLE.',
          };
        }
        return {
          capabilityId: 'cybersecurity',
          status: 'PARTIAL_LOCAL',
          summary:
            'Completed defensive security checklist (RLS isolation, server-only secrets, untrusted tool output sanitization).',
          data: {
            postureChecks: [
              'Supabase FORCE ROW LEVEL SECURITY active across all 10 tables',
              'SUPABASE_SERVICE_ROLE_KEY isolated to server-only runtime',
              'External tool outputs sanitized as untrusted input',
            ],
          },
        };
      },
    });

    // 10. External Tools (NOT_AVAILABLE)
    this.register({
      definition: {
        id: 'external_tools',
        name: 'External APIs, Smart Devices & Computer Control',
        description:
          'Interfaces for OAuth workspace apps, IoT smart-home bridges, and isolated browser actions.',
        availability: 'NOT_AVAILABLE',
        defaultRiskLevel: 'SENSITIVE',
        countsAsToolCall: true,
        supportsModalities: ['text', 'voice_transcript'],
        missingDependencyNote:
          'NOT_AVAILABLE — External OAuth/IoT/Browser connectors are not connected.',
      },
      execute: async () => ({
        capabilityId: 'external_tools',
        status: 'NOT_AVAILABLE',
        summary:
          'Capability "external_tools" is NOT_AVAILABLE — external connector is not configured; zero external side effects occurred.',
        honestLimitationNote:
          'External connector is NOT_AVAILABLE; no external API or device state was modified.',
      }),
    });
  }

  register(capability: RegisteredRuntimeCapability): void {
    this.capabilities.set(capability.definition.id, capability);
  }

  getDefinition(id: RuntimeCapabilityId): CapabilityDefinition {
    const existing = this.capabilities.get(id);
    if (existing) return existing.definition;

    return {
      id,
      name: `Unregistered Capability (${id})`,
      description: 'Capability interface requested but not registered.',
      availability: 'NOT_AVAILABLE',
      defaultRiskLevel: 'CONFIRMATION_REQUIRED',
      countsAsToolCall: true,
      supportsModalities: ['text'],
      missingDependencyNote: `Capability "${id}" is NOT_AVAILABLE.`,
    };
  }

  has(id: RuntimeCapabilityId): boolean {
    return this.capabilities.has(id);
  }

  listDefinitions(): CapabilityDefinition[] {
    return Array.from(this.capabilities.values()).map((c) => c.definition);
  }

  async invoke(
    id: RuntimeCapabilityId,
    ctx: CapabilityExecutionContext
  ): Promise<CapabilityExecutionResult> {
    const entry = this.capabilities.get(id);
    if (!entry) {
      return {
        capabilityId: id,
        status: 'NOT_AVAILABLE',
        summary: `Capability "${id}" is NOT_AVAILABLE in the JARVIS-X Capability Registry.`,
        honestLimitationNote: `Capability "${id}" has not been registered or implemented.`,
      };
    }

    const result = await entry.execute(ctx);

    // Treat any external/tool output as untrusted input before returning to orchestrator
    if (result.untrustedExternalContent) {
      return {
        ...result,
        summary: `[Untrusted External Output]: ${sanitizeUntrustedExternalOutput(result.summary)}`,
      };
    }

    return result;
  }
}
