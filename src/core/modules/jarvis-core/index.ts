import { CodingEngine, createCodingEngine } from '@/core/coding-engine';
import {
  DocumentIntelligenceEngine,
  type MemoryIngestSink,
} from '@/core/document-intelligence';
import { ResearchEngine, RESEARCH_ENGINE_VERSION, RESEARCH_MODES } from '@/core/research';
import type { ResearchMode } from '@/core/research/types';
import type { CodingTaskInput, CodingTaskResult } from '@/core/coding-engine';
import { AIModelRouter } from '@/core/modules/ai-model-router';
import { ContextEmotionEngine } from '@/core/modules/context-emotion-engine';
import { ConversationEngine } from '@/core/modules/conversation-engine';
import { MemoryManager } from '@/core/modules/memory-manager';
import { PermissionSecurityManager } from '@/core/modules/permission-security-manager';
import { PersonalityEngine } from '@/core/modules/personality-engine';
import { ProactiveMonitoringEngine } from '@/core/modules/proactive-monitoring-engine';
import { ReasoningPlanningEngine } from '@/core/modules/reasoning-planning-engine';
import { SpecialistAgentManager } from '@/core/modules/specialist-agent-manager';
import { ToolConnectorManager } from '@/core/modules/tool-connector-manager';
import { VerificationEngine } from '@/core/modules/verification-engine';
import { VisionEngine } from '@/core/modules/vision-engine';
import { VoiceEngine } from '@/core/modules/voice-engine';
import {
  CapabilityRegistry,
  JarvisCoreRuntime,
  RuntimeMemoryBridge,
  RuntimeModelRouter,
  RuntimeVerificationLayer,
  SpecialistRegistry,
  mapRiskToPermissionTier,
} from '@/core/runtime';
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_GUEST_USER_ID,
  generateUuid,
  normalizeConversationId,
} from '@/core/utils/uuid';
import type {
  ArchitectureModuleStatus,
  AuthSessionStatus,
  ChatMessage,
  ConversationSummary,
  JarvisSystemSnapshot,
  PermissionRequest,
  ResponseStyle,
  RuntimeRequest,
  RuntimeTaskMetadata,
  TurnRequest,
  TurnResponse,
} from '@/core/types';
import type { ConnectedToolRecord, DataRepository } from '@/server/repositories/types';
import type { SupabaseConnectionDiagnostics } from '@/server/supabase/client';

/** Current JARVIS-X core version string. */
export const JARVIS_CORE_VERSION = '1.3.0-deep-research';

const DEFAULT_ACTOR: AuthSessionStatus = {
  authenticated: false,
  userId: DEFAULT_GUEST_USER_ID,
  displayName: 'Guest Operator',
  callsign: 'GUEST-EPHEMERAL',
  verificationMode: 'anonymous_ephemeral',
};

/**
 * JARVIS Core
 * High-level facade uniting the 14 architectural engines with the central
 * server-side `JarvisCoreRuntime` state-machine orchestrator.
 */
export class JarvisCore {
  public readonly conversationEngine: ConversationEngine;
  public readonly personalityEngine: PersonalityEngine;
  public readonly contextEmotionEngine: ContextEmotionEngine;
  public readonly memoryManager: MemoryManager;
  public readonly reasoningPlanningEngine: ReasoningPlanningEngine;
  public readonly modelRouter: AIModelRouter;
  public readonly voiceEngine: VoiceEngine;
  public readonly visionEngine: VisionEngine;
  public readonly toolConnectorManager: ToolConnectorManager;
  public readonly specialistAgentManager: SpecialistAgentManager;
  public readonly verificationEngine: VerificationEngine;
  public readonly permissionSecurityManager: PermissionSecurityManager;
  public readonly proactiveMonitoringEngine: ProactiveMonitoringEngine;

  // Production Core Runtime components
  public readonly codingEngine: CodingEngine;
  /** JARVIS-X v1.2.0 Grounded Document Intelligence + Hybrid RAG engine. */
  public readonly documentEngine: DocumentIntelligenceEngine;
  public readonly researchEngine: ResearchEngine;
  public readonly capabilityRegistry: CapabilityRegistry;
  public readonly specialistRegistry: SpecialistRegistry;
  public readonly runtimeMemoryBridge: RuntimeMemoryBridge;
  public readonly runtimeModelRouter: RuntimeModelRouter;
  public readonly runtimeVerifier: RuntimeVerificationLayer;
  public readonly runtime: JarvisCoreRuntime;

  private activeUserId: string;

  constructor(
    private readonly repository: DataRepository,
    private readonly getSupabaseInfo: (
      authenticated?: boolean
    ) => Promise<SupabaseConnectionDiagnostics> | SupabaseConnectionDiagnostics,
    private readonly actor: AuthSessionStatus = DEFAULT_ACTOR,
    sharedPendingPermissions?: Map<string, PermissionRequest>,
    runtimeOptions?: {
      /** Shared process-wide document engine (server wiring) — keeps ingested
       * documents available across request-scoped JarvisCore instances. */
      documentEngine?: DocumentIntelligenceEngine;
      /** Shared process-wide research engine (server wiring). */
      researchEngine?: ResearchEngine;
    }
  ) {
    this.activeUserId = actor.userId;
    this.conversationEngine = new ConversationEngine();
    this.personalityEngine = new PersonalityEngine();
    this.contextEmotionEngine = new ContextEmotionEngine();
    this.memoryManager = new MemoryManager(repository);
    this.reasoningPlanningEngine = new ReasoningPlanningEngine();
    this.modelRouter = new AIModelRouter();
    this.voiceEngine = new VoiceEngine();
    this.visionEngine = new VisionEngine();
    this.toolConnectorManager = new ToolConnectorManager();
    this.specialistAgentManager = new SpecialistAgentManager({
      recallRelevant: (query) => this.memoryManager.recallRelevant(this.activeUserId, query),
      countEntries: async () => (await this.memoryManager.listEntries(this.activeUserId)).length,
    });
    this.verificationEngine = new VerificationEngine();
    this.permissionSecurityManager = new PermissionSecurityManager(
      repository,
      sharedPendingPermissions
    );
    this.proactiveMonitoringEngine = new ProactiveMonitoringEngine();

    // Wire JARVIS-X v1.1.0 Coding & Software Engineering Engine
    this.codingEngine = createCodingEngine(process.cwd(), { maxRepairIterations: 3 });

    // Wire JARVIS-X v1.2.0 Grounded Document Intelligence + Hybrid RAG Engine
    this.documentEngine =
      runtimeOptions?.documentEngine ?? new DocumentIntelligenceEngine();

    // Wire JARVIS-X v1.3.0 Deep Research & Web Intelligence Engine
    this.researchEngine = runtimeOptions?.researchEngine ?? new ResearchEngine();

    // Wire Core Runtime Orchestrator
    this.capabilityRegistry = new CapabilityRegistry({
      visionEngine: this.visionEngine,
      codingEngine: this.codingEngine,
      researchEngine: this.researchEngine,
      onIngestKnowledgeChunk: async (userId, chunk, meta) => {
        await this.memoryManager.ingestKnowledgeChunk(userId, chunk, {
          sourceLabel: meta.sourceLabel,
          projectId: meta.projectId,
          tags: ['file-intelligence'],
        });
      },
    });
    this.specialistRegistry = new SpecialistRegistry(this.specialistAgentManager);
    this.runtimeMemoryBridge = new RuntimeMemoryBridge(repository, this.memoryManager);
    this.runtimeModelRouter = new RuntimeModelRouter(this.modelRouter);
    this.runtimeVerifier = new RuntimeVerificationLayer(this.verificationEngine);

    this.runtime = new JarvisCoreRuntime({
      contextEmotionEngine: this.contextEmotionEngine,
      personalityEngine: this.personalityEngine,
      voiceEngine: this.voiceEngine,
      permissionSecurityManager: this.permissionSecurityManager,
      memoryBridge: this.runtimeMemoryBridge,
      capabilityRegistry: this.capabilityRegistry,
      specialistRegistry: this.specialistRegistry,
      modelRouter: this.runtimeModelRouter,
      verificationLayer: this.runtimeVerifier,
      getSystemSummary: async (authenticated) => {
        const info = await this.getSupabaseInfo(authenticated);
        return info.statusDetail;
      },
    });
  }

  listArchitectureModules(): ArchitectureModuleStatus[] {
    const voiceDiag = this.voiceEngine.getDiagnostics();
    const repoLabel =
      this.repository.mode === 'supabase_cloud'
        ? 'Supabase Cloud RLS'
        : this.repository.mode === 'degraded_fallback'
          ? 'Degraded Fallback Store'
          : 'Ephemeral Guest Store';

    return [
      {
        id: 'jarvis-core',
        name: 'JARVIS Core Runtime',
        layer: 'core',
        state: 'online',
        summary:
          'Bounded state-machine orchestrator (RECEIVED → COMPLETED / WAITING_FOR_USER_APPROVAL / FAILED / CANCELLED).',
      },
      {
        id: 'conversation-engine',
        name: 'Conversation & Task Classifier',
        layer: 'cognitive',
        state: 'online',
        summary: 'Extensible 10-domain task & risk classifier across text, voice & vision inputs.',
      },
      {
        id: 'personality-engine',
        name: 'Personality Engine',
        layer: 'cognitive',
        state: 'online',
        summary: 'Calm, intelligent, subtly witty persona & Aria female vocal prosody framing.',
      },
      {
        id: 'context-emotion-engine',
        name: 'Context & Emotion Engine',
        layer: 'cognitive',
        state: 'online',
        summary: 'Maps situational cues to 8 conversational delivery styles (non-sentient).',
      },
      {
        id: 'memory-manager',
        name: 'Hierarchical Memory Engine',
        layer: 'cognitive',
        state: 'online',
        summary: `Active (${repoLabel} · All 7 memory scopes live · hybrid 1536-dim recall, decay & supersession).`,
      },
      {
        id: 'reasoning-planning-engine',
        name: 'Structured Task Planner',
        layer: 'cognitive',
        state: 'online',
        summary: 'Acyclic step planner with explicit capabilities & risk levels (zero CoT leak).',
      },
      {
        id: 'ai-model-router',
        name: 'Multi-Model Intelligence Router',
        layer: 'core',
        state: 'online',
        summary: '5 routing policies, circuit breaker, bounded fallback & Foundation Local Core active.',
      },
      {
        id: 'voice-engine',
        name: 'Voice Engine',
        layer: 'multimodal',
        state: voiceDiag.neuralTtsConnected ? 'online' : 'interface_ready',
        summary: 'STT, Aria female TTS prosody & barge-in controller contracts ready.',
      },
      {
        id: 'vision-engine',
        name: 'Vision Engine',
        layer: 'multimodal',
        state: this.visionEngine.isConnected() ? 'online' : 'interface_ready',
        summary: 'Frame validator & camera inspector ready; Vision AIProvider NOT_AVAILABLE.',
      },
      {
        id: 'tool-connector-manager',
        name: 'Capability & Tool Registry',
        layer: 'execution',
        state: 'online',
        summary: '10 runtime capabilities + 15 connector descriptors · v1.1.0 Coding & Software Engineering Engine active (honest NOT_AVAILABLE reporting).',
      },
      {
        id: 'specialist-agent-manager',
        name: 'Specialist Agent Registry',
        layer: 'execution',
        state: 'online',
        summary: '10 specialist agent contracts registered for plug-in orchestration.',
      },
      {
        id: 'verification-engine',
        name: 'Runtime Verification Layer',
        layer: 'governance',
        state: 'online',
        summary: 'Separates execution completion from outcome verification (VERIFIED..NOT_VERIFIABLE).',
      },
      {
        id: 'permission-security-manager',
        name: 'Risk & Permission Gate',
        layer: 'governance',
        state: 'online',
        summary: 'Enforces READ_ONLY, LOW_RISK, CONFIRMATION_REQUIRED & SENSITIVE pauses.',
      },
      {
        id: 'proactive-monitoring-engine',
        name: 'Proactive Monitoring Engine',
        layer: 'governance',
        state: 'online',
        summary: 'System health advisories & future scheduled routine triggers.',
      },
    ];
  }

  async getSystemSnapshot(conversationId = DEFAULT_CONVERSATION_ID): Promise<JarvisSystemSnapshot> {
    const normConvId = normalizeConversationId(conversationId);
    const supabaseDiag = await this.getSupabaseInfo(this.actor.authenticated);
    const [
      preferences,
      history,
      recentMemories,
      conversations,
      permissionAudit,
      auditLogs,
      agentTasks,
    ] = await Promise.all([
      this.repository.getPreferences(this.activeUserId),
      this.repository.getMessages(this.activeUserId, normConvId),
      this.memoryManager.listEntries(this.activeUserId),
      this.repository.listConversations(this.activeUserId, 20),
      this.repository.listPermissionRecords(this.activeUserId, 20),
      this.repository.listAuditLogs(this.activeUserId, 25),
      this.repository.listAgentTasks(this.activeUserId, 15),
    ]);

    const memory = await this.memoryManager.getStatus(this.activeUserId, history.length);
    const effectiveRoutingPolicy = preferences.routingPolicy ?? 'AUTO_BALANCED';
    const effectiveManualModelId = preferences.manualModelId ?? null;

    const catalog = this.runtimeModelRouter.listRegisteredModels();
    const providerHealth = this.runtimeModelRouter.listProviderHealth();
    const legacyDescriptors = this.runtimeModelRouter.listLegacyModelDescriptors();

    let selectedRoutingPreview = {
      selectedProviderId: 'jarvis-foundation',
      selectedModelId: 'foundation-local-v1',
      selectedDisplayName: 'Foundation Deterministic Core v0.4',
      automaticMultiModelRoutingActive: false,
      fallbackUsed: false,
      rationale: 'Operational local fallback active.',
    };
    try {
      const sel = this.runtimeModelRouter.selectModel({
        taskType: 'conversation',
        taskDomain: 'conversation',
        requiredCapabilities: ['conversation'],
        routingPolicy: effectiveRoutingPolicy,
        manualModelId: effectiveManualModelId,
        preferredProviderId: preferences.preferredModelProvider,
        latencyPreference: 'balanced',
        costConstraint: 'unrestricted',
        estimatedContextTokens: 64,
        minimumReliability: 0.75,
      });
      selectedRoutingPreview = sel;
    } catch {
      // Retain foundation preview if strict manual model is currently unavailable
    }

    const activeDescriptor =
      legacyDescriptors.find((d) => d.id === selectedRoutingPreview.selectedModelId) ??
      legacyDescriptors[0] ??
      this.modelRouter.selectModel(preferences.preferredModelProvider).selectedModel;

    const externalConfigured = catalog.some(
      (m) => !m.isDeterministicFallback && m.configurationState === 'CONFIGURED'
    );
    const lastActive = this.runtimeModelRouter.getLastActiveSelection();

    const specialistContracts = this.specialistRegistry.listContracts();
    const specialists = specialistContracts.map((c) => ({
      id: c.id,
      name: c.displayName,
      roleSummary: c.roleSummary,
      readiness:
        c.status === 'OPERATIONAL_LOCAL'
          ? ('operational_local' as const)
          : ('interface_ready' as const),
      defaultPermissionTier: mapRiskToPermissionTier(c.defaultRiskLevel),
      missingDependencies: c.missingDependencies,
    }));

    const recentTasks: RuntimeTaskMetadata[] = agentTasks.map((t) => ({
      taskId: t.id,
      userId: this.activeUserId,
      conversationId: t.conversationId,
      projectId: t.projectId ?? null,
      taskType: t.taskType ?? 'conversation',
      riskLevel: t.riskLevel ?? 'READ_ONLY',
      selectedCapability: t.selectedCapability ?? 'direct_conversation',
      selectedSpecialist:
        t.specialistAgent !== 'direct_core'
          ? (t.specialistAgent as RuntimeTaskMetadata['selectedSpecialist'])
          : undefined,
      executionState: t.executionState ?? 'COMPLETED',
      approvalState: t.approvalState ?? 'not_required',
      verificationStatus: t.verificationStatus ?? 'VERIFIED',
      errorStatus: t.errorStatus ?? null,
      retryCount: 0,
      toolCallsCount: 0,
      startedAt: t.startedAt ?? t.createdAt,
      completedAt: t.completedAt ?? t.createdAt,
      durationMs: 1,
    }));

    return {
      version: JARVIS_CORE_VERSION,
      coreState:
        supabaseDiag.serverReachability === 'degraded_unreachable' ? 'degraded' : 'online',
      serverTimestamp: new Date().toISOString(),
      auth: this.actor,
      supabase: {
        configured: supabaseDiag.configured,
        projectRef: supabaseDiag.projectRef,
        serverReachability: supabaseDiag.serverReachability,
        authReady: supabaseDiag.authReady,
        pgvectorEnabled: supabaseDiag.pgvectorEnabled,
        rlsForced: supabaseDiag.rlsForced,
        persistenceMode: this.repository.mode,
        domainsPrepared: supabaseDiag.domainsPrepared,
        migrationPath: supabaseDiag.migrationPath,
        migrationPaths: supabaseDiag.migrationPaths,
        statusDetail: supabaseDiag.statusDetail,
      },
      activeModel: activeDescriptor,
      registeredModels: legacyDescriptors,
      modelSystem: {
        routingPolicy: effectiveRoutingPolicy,
        manualModelId: effectiveManualModelId,
        activeProviderId: selectedRoutingPreview.selectedProviderId,
        activeModelId: selectedRoutingPreview.selectedModelId,
        automaticMultiModelRoutingActive:
          selectedRoutingPreview.automaticMultiModelRoutingActive,
        fallbackActive: selectedRoutingPreview.fallbackUsed || lastActive.fallbackUsed,
        catalog,
        providerHealth,
        recentTelemetry: this.runtimeModelRouter.getTelemetryHistory(15),
      },
      modules: this.listArchitectureModules(),
      specialists,
      specialistContracts,
      runtimeCapabilities: this.capabilityRegistry.listDefinitions(),
      recentTasks,
      capabilities: this.toolConnectorManager.listCapabilities(),
      conversations,
      memory,
      recentMemories: recentMemories.slice(0, 15),
      preferences,
      permissionAudit,
      auditLogs,
      proactiveAdvisories: this.proactiveMonitoringEngine.getAdvisories({
        supabaseConfigured: supabaseDiag.configured,
        serverReachability: supabaseDiag.serverReachability,
        authenticated: this.actor.authenticated,
        externalModelsConfigured: externalConfigured,
        proactiveEnabled: preferences.proactiveAssistanceEnabled,
      }),
      documentIntelligence: this.documentIntelligenceSummary(),
      research: this.researchSummary(),
    };
  }

  /** Concise, non-secret document intelligence status for the HUD/snapshot. */
  documentIntelligenceSummary() {
    const embedding = this.documentEngine.embeddingStatus();
    const documents = this.documentEngine.listDocuments(this.activeUserId);
    const lifecycleCounts: Record<string, number> = {};
    for (const doc of documents) {
      lifecycleCounts[doc.lifecycle] = (lifecycleCounts[doc.lifecycle] ?? 0) + 1;
    }
    return {
      version: '1.2.0-document-intelligence',
      documentCount: documents.length,
      indexedChunkCount: this.documentEngine.retrievableChunkCount(this.activeUserId),
      embeddingMode: embedding.mode,
      embeddingProviderId: embedding.providerId,
      embeddingHonestNote: embedding.honestNote,
      rerankingMode: this.documentEngine.reranking.mode,
      parserCapabilities: this.documentEngine.parserCapabilities().map((c) => ({
        format: c.format,
        status: c.status,
        parser: c.parser,
        notes: c.notes,
      })),
      lifecycleCounts,
    };
  }

  /**
   * v1.3 research state for the HUD. Reports the provider's REAL status so the
   * UI can never imply live web research is available when it is not.
   */
  researchSummary() {
    const provider = this.researchEngine.providerHealth();
    const tasks = this.researchEngine.listTasks(this.activeUserId, 20);
    const last = tasks[0] ?? null;

    return {
      version: RESEARCH_ENGINE_VERSION,
      modes: [...RESEARCH_MODES],
      provider: {
        providerId: provider.providerId,
        label: provider.label,
        status: provider.status,
        live: provider.live,
        zeroCost: provider.zeroCost,
        detail: provider.detail,
      },
      liveWebResearch: provider.live,
      activeTasks: tasks.filter((t) => t.status === 'RUNNING').length,
      completedTasks: tasks.filter((t) => t.status === 'COMPLETED' || t.status === 'PARTIAL').length,
      cancelledTasks: tasks.filter((t) => t.status === 'CANCELLED').length,
      lastTask: last
        ? {
            taskId: last.taskId,
            mode: last.mode,
            status: last.status,
            confidence: last.metrics?.confidence ?? 'INSUFFICIENT',
            citations: last.metrics?.citationCount ?? 0,
            live: last.metrics?.live ?? false,
          }
        : null,
    };
  }

  /**
   * =========================================================================
   * JARVIS-X v1.2.0 — Secure Grounded Document Intelligence interface
   * =========================================================================
   * Owner-only. Owner identity is ALWAYS resolved server-side from the
   * authenticated session — a client-supplied owner ID is never trusted.
   * Voice alone is never identity proof.
   */

  private documentAccessError(
    action: string
  ): { ok: false; errorCode: string; error: string } | null {
    if (!this.actor.authenticated) {
      return {
        ok: false,
        errorCode: 'UNAUTHORIZED_ACCESS',
        error: `${action} requires an authenticated owner session. Guest/voice-only sessions are never granted document access.`,
      };
    }
    return null;
  }

  private researchAccessError(
    action: string
  ): { ok: false; errorCode: string; error: string } | null {
    if (!this.actor.authenticated) {
      return {
        ok: false,
        errorCode: 'UNAUTHORIZED_ACCESS',
        error: `${action} requires an authenticated owner session. Research is never performed for guest or voice-only sessions.`,
      };
    }
    return null;
  }

  /**
   * Run a bounded, evidence-grounded research task for the authenticated owner.
   *
   * Read-only by default: nothing is written to memory unless the caller asks
   * for it through the research-memory path, and web content never gains
   * command authority.
   */
  async runResearch(input: {
    query: string;
    mode?: ResearchMode;
    projectId?: string | null;
    documentIds?: string[];
    freshness?: 'any' | 'recent' | 'latest';
    maxSources?: number;
    maxQueries?: number;
    signal?: AbortSignal;
    /** Owner-controlled: persist a research summary into hierarchical memory. */
    saveToMemory?: boolean;
  }) {
    const denied = this.researchAccessError('Web research');
    if (denied) return denied;

    // Document evidence is supplied per call so it is bound to THIS owner's
    // authorized document store — never a shared process-wide reader.
    const documentProvider = async (
      query: string,
      options: { projectId: string | null; documentIds: string[] }
    ) => {
      try {
        const result = await this.documentEngine.query({
          ownerId: this.activeUserId,
          query,
          projectId: options.projectId,
          documentIds: options.documentIds,
          topK: 5,
        });
        if (!result.ok || !result.retrieval) return [];
        const byDocument = new Map<
          string,
          { documentId: string; documentTitle: string; passages: Array<{ text: string; page: number | null; section: string | null }> }
        >();
        for (const scored of result.retrieval.selected) {
          const entry = byDocument.get(scored.chunk.documentId) ?? {
            documentId: scored.chunk.documentId,
            documentTitle: scored.chunk.documentId,
            passages: [],
          };
          entry.passages.push({ text: scored.chunk.text, page: scored.chunk.page, section: scored.chunk.section });
          byDocument.set(scored.chunk.documentId, entry);
        }
        // Attach real filenames where the store knows them.
        for (const document of this.documentEngine.listDocuments(this.activeUserId)) {
          const entry = byDocument.get(document.documentId);
          if (entry) entry.documentTitle = document.filename;
        }
        return [...byDocument.values()];
      } catch {
        return [];
      }
    };

    const result = await this.researchEngine.run({
      ownerId: this.activeUserId,
      query: input.query,
      mode: input.mode,
      projectId: input.projectId ?? null,
      documentIds: input.documentIds ?? [],
      freshness: input.freshness,
      maxSources: input.maxSources,
      maxQueries: input.maxQueries,
      signal: input.signal,
      documentProvider,
    });

    // ---- Persist the research record (bounded, owner-scoped) ----
    // Research artefacts are stored as research data, never promoted to facts.
    if (result.report) {
      try {
        const session = await this.repository.recordResearchSession?.(this.activeUserId, {
          projectId: input.projectId ?? null,
          taskId: result.taskId,
          query: result.query,
          mode: result.mode,
          status: result.status,
          live: result.report.live,
          searchProvider: result.metrics.searchProvider,
          providerStatus: result.metrics.searchProviderStatus,
          confidenceLevel: result.report.confidence.level,
          confidenceScore: result.report.confidence.score,
          sourceCount: result.report.sourcesUsed,
          evidenceCount: result.metrics.evidenceUnits,
          contradictionCount: result.metrics.contradictions,
          citationCount: result.metrics.citationCount,
          followUpRounds: result.metrics.followUpRounds,
          queryCount: result.metrics.queryCount,
          durationMs: result.durationMs,
          cancelled: result.status === 'CANCELLED',
          failureCodes: result.errors,
          limitations: result.report.limitations,
          reportSummary: result.report.executiveSummary.slice(0, 4000),
        });

        if (session) {
          // Bounded snippets only — never a full-page mirror.
          await this.repository.recordResearchSources?.(
            this.activeUserId,
            session.id,
            result.sources.slice(0, 40).map((source) => ({
              sourceId: source.sourceId,
              url: source.url,
              canonicalUrl: source.canonicalUrl,
              domain: source.domain,
              title: source.title,
              author: source.author,
              publishedAt: source.publishedAt,
              retrievedAt: source.retrievedAt,
              contentHash: source.contentHash,
              sourceType: source.sourceType,
              provenance: source.provenance,
              fetchStatus: source.fetchStatus,
              qualityScore: Number((source.quality?.overall ?? 0).toFixed(3)),
              freshnessScore: Number((source.quality?.freshness ?? 0).toFixed(3)),
              snippet: source.extractedText.slice(0, 1200),
              duplicateOf: source.duplicateOf,
              independenceGroup: source.independenceGroup,
              trustSignals: source.trustSignals,
            }))
          );

          await this.repository.recordResearchClaims?.(
            this.activeUserId,
            session.id,
            result.claimGraph.nodes.slice(0, 40).map((node) => ({
              claimId: node.claimId,
              claim: node.claim.slice(0, 2000),
              verificationState: node.state,
              independentSupport: node.independentSupportCount,
              sourceCount: node.supportingSourceIds.length,
              confidence: Number(node.confidence.toFixed(3)),
              contested: node.contested,
              supportingSourceIds: node.supportingSourceIds,
              contradictingSourceIds: node.contradictingSourceIds,
              evidenceIds: [...node.supportingEvidenceIds, ...node.contradictingEvidenceIds],
              notes: node.notes,
            }))
          );
        }

        // ---- Optional memory artefact (owner-controlled, verified only) ----
        if (input.saveToMemory && result.report.verifiedFindings.length > 0) {
          const summary = result.report.verifiedFindings
            .slice(0, 5)
            .map((finding) => `- ${finding.text}`)
            .join('\n');
          await this.memoryManager.storeMemory(
            this.activeUserId,
            `Research (${result.mode}) — ${result.query}\nConfidence: ${result.report.confidence.level}. Live: ${
              result.report.live ? 'yes' : 'no (non-live evidence)'
            }.\nVerified findings:\n${summary}`,
            'research_summary',
            ['research', 'v1.3.0', result.mode.toLowerCase()],
            undefined,
            undefined,
            {
              memoryScope: 'knowledge',
              projectId: input.projectId ?? null,
              importance: 4,
              // Web-derived, so it is NEVER tagged as a user assertion. Only
              // findings that reached the VERIFIED section are stored, and the
              // provenance keeps them distinguishable from operator knowledge.
              provenance: 'untrusted_external',
              confidence: result.report.confidence.score,
              metadata: {
                kind: 'research_summary',
                version: '1.3.0',
                taskId: result.taskId,
                mode: result.mode,
                live: result.report.live,
                confidenceLevel: result.report.confidence.level,
                citations: result.report.citations.slice(0, 8).map((citation) => citation.canonicalUrl),
              },
            }
          );
        }
      } catch {
        // Persistence is best-effort and must never mask a research result.
      }
    }

    return result;
  }

  /** Retrieve a research task owned by the active user. */
  getResearchTask(taskId: string) {
    const denied = this.researchAccessError('Research task lookup');
    if (denied) return denied;
    return this.researchEngine.getTask(taskId, this.activeUserId);
  }

  /** Cancel a running research task owned by the active user. */
  cancelResearchTask(taskId: string) {
    const denied = this.researchAccessError('Research cancellation');
    if (denied) return denied;
    return { cancelled: this.researchEngine.cancel(taskId, this.activeUserId) };
  }

  /** Bounded research history for the active user. */
  listResearchHistory(limit = 20) {
    const denied = this.researchAccessError('Research history');
    if (denied) return denied;
    return this.researchEngine.listTasks(this.activeUserId, limit);
  }

  /** Honest provider status for the HUD. */
  researchProviderStatus() {
    return this.researchEngine.providerHealth();
  }

  async ingestDocument(input: {
    fileName: string;
    mimeType: string;
    bytes?: Uint8Array;
    textContent?: string;
    projectId?: string | null;
    source?: 'upload' | 'camera' | 'workspace' | 'url_import';
  }) {
    const denied = this.documentAccessError('Document ingestion');
    if (denied) return denied;

    const sink: MemoryIngestSink = async (ownerId, chunk, meta) => {
      // Document evidence is written to the `knowledge` scope, explicitly
      // tagged as unverified evidence — never as a verified personal fact.
      const outcome = await this.memoryManager.ingestKnowledgeChunk(ownerId, chunk.text, {
        sourceLabel: meta.sourceLabel,
        projectId: meta.projectId,
        tags: meta.tags,
      });
      return { entryId: outcome.entry?.id };
    };

    return this.documentEngine.ingest({
      ownerId: this.activeUserId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      bytes: input.bytes,
      textContent: input.textContent,
      projectId: input.projectId ?? null,
      source: input.source ?? 'upload',
      memorySink: sink,
    });
  }

  async queryDocuments(input: {
    query: string;
    projectId?: string | null;
    documentIds?: string[];
    includeAllProjects?: boolean;
    topK?: number;
  }) {
    const denied = this.documentAccessError('Document query');
    if (denied) return denied;

    return this.documentEngine.query({
      ownerId: this.activeUserId,
      query: input.query,
      projectId: input.projectId ?? null,
      documentIds: input.documentIds,
      includeAllProjects: input.includeAllProjects ?? false,
      topK: input.topK,
    });
  }

  async summarizeDocuments(input: {
    documentIds: string[];
    kind: 'quick' | 'detailed' | 'section' | 'key_points' | 'action_items' | 'technical' | 'compare';
  }) {
    const denied = this.documentAccessError('Document summarization');
    if (denied) return denied;

    if (!Array.isArray(input.documentIds) || input.documentIds.length === 0) {
      return {
        ok: false as const,
        errorCode: 'INVALID_INPUT',
        error: 'At least one document id is required.',
      };
    }

    return this.documentEngine.summarize({
      ownerId: this.activeUserId,
      documentIds: input.documentIds.slice(0, 20),
      kind: input.kind,
    });
  }

  async listDocuments(projectId?: string | null) {
    const denied = this.documentAccessError('Document listing');
    if (denied) return denied;
    return {
      ok: true as const,
      documents: this.documentEngine.listDocuments(this.activeUserId, { projectId }),
    };
  }

  async getDocumentMetadata(documentId: string) {
    const denied = this.documentAccessError('Document access');
    if (denied) return denied;
    const document = this.documentEngine.getDocument(this.activeUserId, documentId);
    if (!document) {
      return {
        ok: false as const,
        errorCode: 'NOT_FOUND',
        error: 'Document not found for this owner.',
      };
    }
    return { ok: true as const, document };
  }

  async deleteDocument(documentId: string) {
    const denied = this.documentAccessError('Document deletion');
    if (denied) return denied;

    const result = await this.documentEngine.removeDocument(this.activeUserId, documentId, {
      memoryRevoker: (memoryEntryId) =>
        this.memoryManager.deleteMemory(this.activeUserId, memoryEntryId),
    });
    if (result.ok) {
      await this.permissionSecurityManager.evaluate({
        userId: this.activeUserId,
        conversationId: normalizeConversationId(undefined),
        actionCode: 'DOCUMENT_DELETION',
        actionTitle: 'Document Removal (chunks revoked)',
        targetResource: `document:${documentId}`,
        tier: 'CONFIRMATION_REQUIRED',
        summary: 'Owner requested deletion of an ingested document and its retrievable chunks.',
        pendingPayload: { documentId },
      });
    }
    return result;
  }

  /**
   * Direct programmatic entrypoint to the Core Runtime Orchestrator (decoupled from chat UI).
   */
  async executeRuntimeTask(request: RuntimeRequest) {
    return this.runtime.execute(this.actor, request);
  }

  /**
   * Conversational turn handler wrapping `JarvisCoreRuntime.execute(...)` with
   * conversation message persistence for the HUD & API routes.
   */
  async handleTurn(request: TurnRequest): Promise<TurnResponse> {
    const conversationId = normalizeConversationId(request.conversationId);
    const runtimeOut = await this.runtime.execute(this.actor, {
      conversationId,
      projectId: request.projectId,
      modality: request.modality,
      voiceInput: request.voiceMeta,
      voiceMeta: request.voiceMeta,
      message: request.message,
      visionAttachment: request.visionAttachment,
      documentAttachment: request.documentAttachment,
      limits: request.limits,
      signal: request.signal,
    });

    const { result, activitySteps, contextSignals, legacyRouteDecision, legacyVerification } =
      runtimeOut;

    const userMessage: ChatMessage = {
      id: generateUuid(),
      conversationId,
      role: 'user',
      content: request.message.trim(),
      createdAt: result.metadata.startedAt,
      taskId: result.taskId,
    };

    const preferences = await this.repository.getPreferences(this.activeUserId);
    const prosodyHint = this.personalityEngine.buildVoiceProsodyHint(
      result.responseStyle,
      preferences.voiceProfileId
    );

    const assistantMessage: ChatMessage = {
      id: generateUuid(),
      conversationId,
      role: 'assistant',
      content: result.responseContent,
      createdAt: new Date().toISOString(),
      responseStyle: result.responseStyle,
      prosodyHint,
      modelId: legacyRouteDecision.selectedModel.id,
      specialistAgent: result.metadata.selectedSpecialist,
      verification: legacyVerification,
      pendingPermission: result.pendingApproval,
      activityTrace: activitySteps,
      taskId: result.taskId,
    };

    if (result.error?.code !== 'UNAUTHORIZED_ACCESS') {
      await this.repository.appendMessage(this.activeUserId, userMessage);
      await this.repository.appendMessage(this.activeUserId, assistantMessage);
    }

    const history = await this.repository.getMessages(this.activeUserId, conversationId);
    const memoryStatus = await this.memoryManager.getStatus(
      this.activeUserId,
      history.length
    );

    return {
      taskId: result.taskId,
      conversationId,
      userMessage,
      assistantMessage,
      activitySteps,
      contextSignals,
      routeDecision: legacyRouteDecision,
      verification: legacyVerification,
      memoryStatus,
      pendingPermission: result.pendingApproval,
      runtime: result,
    };
  }

  async resolvePermissionDecision(input: {
    requestId: string;
    approve: boolean;
    stepUpPasscode?: string;
  }): Promise<{
    resolved: boolean;
    decision: string;
    followUpMessage?: ChatMessage;
    savedMemoryId?: string;
    errorReason?: string;
    memoryStatus: Awaited<ReturnType<MemoryManager['getStatus']>>;
  }> {
    const outcome = await this.permissionSecurityManager.resolveRequest(
      this.activeUserId,
      input.requestId,
      input.approve,
      input.stepUpPasscode
    );

    const linkedTaskId =
      typeof outcome.request?.pendingPayload?.taskId === 'string'
        ? outcome.request.pendingPayload.taskId
        : undefined;

    if (!outcome.resolved || !outcome.request) {
      if (linkedTaskId && outcome.decision === 'blocked_unauthenticated') {
        await this.repository.updateAgentTask(this.activeUserId, linkedTaskId, {
          approvalState: 'blocked_unauthenticated',
          statusSummary: 'Step-up verification rejected on sensitive action.',
        });
      }
      const memStatus = await this.memoryManager.getStatus(this.activeUserId, 0);
      return {
        resolved: false,
        decision: outcome.decision,
        errorReason: outcome.errorReason,
        memoryStatus: memStatus,
      };
    }

    const req = outcome.request;
    let content: string;
    let savedMemoryId: string | undefined;
    let verificationStatus: RuntimeTaskMetadata['verificationStatus'] = 'VERIFIED';

    if (outcome.decision === 'denied') {
      content = `Understood — request **${req.actionCode}** was **declined** and logged to the permission & audit trail. No changes were made.`;
      verificationStatus = 'NOT_VERIFIABLE';
    } else if (req.actionCode === 'MEMORY_STORE_WRITE') {
      const fact = String(req.pendingPayload.extractedMemoryFact || '').trim();
      const outcome = await this.memoryManager.storeMemoryWithOutcome(
        this.activeUserId,
        {
          category: /\b(prefer|preferred|style|tone)\b/i.test(fact)
            ? 'preference'
            : /\b(workflow|runbook|pipeline|always run)\b/i.test(fact)
              ? 'workflow'
              : 'fact',
          content: fact,
          tags: ['confirmed-by-operator'],
          importance: 4,
          provenance: 'user_explicit',
          sourceConversationId: req.conversationId,
          verified: true,
        }
      );
      if (!outcome.entry) {
        content = `Memory governance check declined persistence: ${outcome.reason}`;
        verificationStatus = 'NOT_VERIFIABLE';
      } else {
        const saved = outcome.entry;
        savedMemoryId = saved.id;
        const layerLabel =
          saved.persistenceLayer === 'supabase_cloud'
            ? 'Supabase Cloud (`long_term_memories`)'
            : saved.persistenceLayer === 'degraded_fallback'
              ? 'degraded fallback store'
              : 'ephemeral session store';
        const supersessionNote =
          outcome.supersededIds.length > 0
            ? ` *(superseded ${outcome.supersededIds.length} older contradicting record)*`
            : outcome.action === 'deduplicated_reinforced'
              ? ' *(reinforced existing record — duplicate prevented)*'
              : '';
        content = `Confirmed. Stored **\`${saved.memoryScope ?? 'semantic'}/${saved.category}\`** memory record **\`${saved.id}\`** in ${layerLabel}${supersessionNote}:\n\n> "${saved.content}"`;
        verificationStatus = 'VERIFIED';
      }
    } else if (req.actionCode === 'MEMORY_PURGE_SENSITIVE') {
      const existing = await this.memoryManager.listEntries(this.activeUserId, {
        includeSuperseded: true,
        includeExpired: true,
      });
      for (const item of existing) {
        await this.memoryManager.deleteMemory(this.activeUserId, item.id);
      }
      content = `Step-up authorization verified. Cleared **${existing.length}** memory entries (across active & superseded history) and recorded the Tier-3 audit entry.`;
      verificationStatus = 'VERIFIED';
    } else {
      const capId = String(req.pendingPayload.selectedCapability || 'external_tools');
      const capDef = this.capabilityRegistry.getDefinition(capId);
      content = `Authorization verified for **${req.actionCode}** (*"${req.targetResource}"*). Checked capability **\`${capDef.id}\`** status: **Not Connected (\`${capDef.availability}\`)** — governance flow succeeded and zero physical/external side effects were fabricated.`;
      verificationStatus = 'NOT_VERIFIABLE';
    }

    if (linkedTaskId) {
      await this.repository.updateAgentTask(this.activeUserId, linkedTaskId, {
        lifecycleStage: outcome.decision === 'denied' ? 'CANCELLED' : 'COMPLETED',
        executionState: outcome.decision === 'denied' ? 'CANCELLED' : 'COMPLETED',
        approvalState: outcome.decision === 'approved' ? 'approved' : 'denied',
        verificationStatus,
        completedAt: new Date().toISOString(),
        statusSummary: content.slice(0, 220),
      });
    }

    const verification = this.verificationEngine.verifyTurn({
      responseContent: content,
      permissionTier: req.tier,
      permissionHalted: false,
      externalLiveClaimBlocked: true,
    });

    const followUpMessage: ChatMessage = {
      id: generateUuid(),
      conversationId: req.conversationId,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
      responseStyle: outcome.decision === 'approved' ? 'confidence' : 'calm',
      modelId: 'foundation-local-v1',
      verification,
      taskId: linkedTaskId,
    };

    await this.repository.appendMessage(this.activeUserId, followUpMessage);
    const history = await this.repository.getMessages(this.activeUserId, req.conversationId);
    const memoryStatus = await this.memoryManager.getStatus(
      this.activeUserId,
      history.length
    );

    return {
      resolved: true,
      decision: outcome.decision,
      followUpMessage,
      savedMemoryId,
      memoryStatus,
    };
  }

  /**
   * =========================================================================
   * JARVIS-X v1.1.0 — Secure server-side Coding Task interface
   * =========================================================================
   * Owner-only. Voice alone is never accepted as identity proof. The client
   * never supplies a filesystem path: the workspace is always the server root.
   */
  async runCodingTask(input: {
    goal: string;
    mode: CodingTaskInput['mode'];
    conversationId?: string;
    projectId?: string | null;
    verificationPreference?: CodingTaskInput['verificationPreference'];
    maxRepairIterations?: number;
    /** Explicit operator acknowledgement for mutating coding modes. */
    acknowledgeMutations?: boolean;
    signal?: AbortSignal;
  }): Promise<
    | { ok: true; result: CodingTaskResult }
    | { ok: false; errorCode: string; error: string }
  > {
    // --- Owner-only gate -------------------------------------------------
    if (!this.actor.authenticated) {
      return {
        ok: false,
        errorCode: 'UNAUTHORIZED_ACCESS',
        error:
          'Coding tasks require an authenticated owner session. Guest/voice-only sessions are never granted privileged engineering access.',
      };
    }

    const goal = input.goal.trim();
    if (!goal) {
      return { ok: false, errorCode: 'INVALID_INPUT', error: 'Coding goal cannot be empty.' };
    }

    const readOnly = input.mode === 'analyze' || input.mode === 'review';

    // --- Mutation gate: mutating modes need explicit acknowledgement -----
    if (!readOnly && !input.acknowledgeMutations) {
      return {
        ok: false,
        errorCode: 'CONFIRMATION_REQUIRED',
        error:
          'Mutating coding modes (feature / debug / refactor / implement-api) require explicit operator acknowledgement before execution.',
      };
    }

    // --- Audit the request through the permission manager ----------------
    const conversationId = normalizeConversationId(input.conversationId);
    const tier = readOnly ? 'SAFE_READ' : 'CONFIRMATION_REQUIRED';
    await this.permissionSecurityManager.evaluate({
      userId: this.activeUserId,
      conversationId,
      actionCode: `CODING_TASK_${input.mode.toUpperCase()}`,
      actionTitle: readOnly ? 'Coding Repository Analysis' : 'Coding Workspace Mutation',
      targetResource: 'Server Workspace (authorized root only)',
      tier,
      summary: goal.slice(0, 180),
      pendingPayload: { mode: input.mode, readOnly },
    });

    const result = await this.codingEngine.executeCodingTask({
      goal,
      conversationId,
      projectId: input.projectId ?? null,
      mode: input.mode,
      // Never trust a client-supplied path.
      authorizedWorkspace: this.codingEngine.workspaceRoot,
      verificationPreference: input.verificationPreference ?? 'standard',
      maxRepairIterations: input.maxRepairIterations,
      signal: input.signal,
      // v1.2 integration: ground the plan in authorized spec evidence only.
      specRetriever: async (specGoal, specOptions) => {
        const evidence = await this.documentEngine.query({
          ownerId: this.activeUserId,
          query: specGoal,
          projectId: specOptions.projectId,
          includeAllProjects: specOptions.projectId === null,
          topK: 5,
        });
        if (!evidence.ok || !evidence.answer) return [];
        return evidence.answer.citations.map((citation) => {
          const chunk = evidence.retrieval?.selected.find(
            (s) => s.chunk.chunkId === citation.chunkId
          );
          return {
            documentId: citation.documentId,
            documentTitle: citation.documentTitle,
            chunkId: citation.chunkId,
            locationLabel: citation.locationLabel,
            excerpt: chunk?.chunk.text.slice(0, 600) ?? '',
            trustLevel: chunk?.chunk.trustLevel ?? 'untrusted_external',
          };
        });
      },
    });

    // Persist reusable project knowledge into hierarchical memory (no secrets).
    try {
      await this.memoryManager.storeMemory(
        this.activeUserId,
        `Coding task (${result.mode}) → ${result.status}. Changed ${result.changedFiles.length} file(s); repair attempts: ${result.repairAttempts}.`,
        'project_context',
        ['coding-engine', 'v1.1.0'],
        undefined,
        undefined,
        {
          memoryScope: 'project',
          projectId: input.projectId ?? null,
          importance: 3,
          provenance: 'system_seed',
        }
      );
    } catch {
      // Project memory is best-effort and must never mask the coding result.
    }

    return { ok: true, result };
  }

  async getConversationMessages(conversationId = DEFAULT_CONVERSATION_ID): Promise<ChatMessage[]> {
    return this.repository.getMessages(this.activeUserId, normalizeConversationId(conversationId));
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return this.repository.listConversations(this.activeUserId, 25);
  }

  async createConversation(input?: {
    id?: string;
    title?: string;
    projectId?: string | null;
    style?: ResponseStyle;
  }): Promise<ConversationSummary> {
    return this.repository.createConversation(this.activeUserId, input);
  }

  async getConversation(conversationId: string): Promise<ConversationSummary | null> {
    return this.repository.getConversation(this.activeUserId, conversationId);
  }

  async updateOperatorPreferences(
    patch: Parameters<DataRepository['updatePreferences']>[1]
  ) {
    return this.repository.updatePreferences(this.activeUserId, patch);
  }

  async addManualMemory(
    content: string,
    category:
      | 'fact'
      | 'preference'
      | 'project_context'
      | 'episodic_summary'
      | 'workflow'
      | 'knowledge_chunk'
      | 'event_record' = 'fact',
    options?: {
      memoryScope?:
        | 'working'
        | 'episodic'
        | 'semantic'
        | 'project'
        | 'knowledge'
        | 'procedural'
        | 'event';
      projectId?: string | null;
      importance?: 1 | 2 | 3 | 4 | 5;
      tags?: string[];
      provenance?:
        | 'user_explicit'
        | 'operator_manual'
        | 'episodic_consolidation'
        | 'system_seed'
        | 'untrusted_external';
      expiresAt?: string | null;
    }
  ) {
    return this.memoryManager.storeMemory(
      this.activeUserId,
      content,
      category,
      options?.tags ?? ['manual-entry'],
      undefined,
      undefined,
      {
        memoryScope: options?.memoryScope,
        projectId: options?.projectId,
        importance: options?.importance ?? 4,
        provenance: options?.provenance ?? 'operator_manual',
        expiresAt: options?.expiresAt,
      }
    );
  }

  async consolidateConversationMemory(
    conversationId = DEFAULT_CONVERSATION_ID,
    projectId?: string | null
  ) {
    return this.memoryManager.consolidateConversation(
      this.activeUserId,
      normalizeConversationId(conversationId),
      { projectId }
    );
  }

  async removeMemory(memoryId: string) {
    return this.memoryManager.deleteMemory(this.activeUserId, memoryId);
  }

  async listConnectedToolMetadata(): Promise<ConnectedToolRecord[]> {
    return this.repository.listConnectedTools(this.activeUserId);
  }

  async upsertConnectedToolMetadata(
    tool: Omit<ConnectedToolRecord, 'id' | 'updatedAt'>
  ): Promise<ConnectedToolRecord> {
    return this.repository.upsertConnectedTool(this.activeUserId, tool);
  }
}
