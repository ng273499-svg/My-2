import { CodingEngine, createCodingEngine } from '@/core/coding-engine';
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
    sharedPendingPermissions?: Map<string, PermissionRequest>
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

    // Wire Core Runtime Orchestrator
    this.capabilityRegistry = new CapabilityRegistry({
      visionEngine: this.visionEngine,
      codingEngine: this.codingEngine,
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
      version: '1.1.0-coding-engine',
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
    };
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
