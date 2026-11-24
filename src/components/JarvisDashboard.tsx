'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, BookOpen, Code2, Cpu, Globe, MessageSquare } from 'lucide-react';
import { DEFAULT_CONVERSATION_ID } from '@/core/utils/uuid';
import type {
  AgentActivityStep,
  ChatMessage,
  JarvisSystemSnapshot,
  PermissionRequest,
  PersonalityPreferences,
  ResponseStyle,
  TurnResponse,
} from '@/core/types';
import {
  createConversationCloudRls,
  deleteMemoryFromCloudRls,
  getActiveBrowserSession,
  loadCloudRlsWorkspace,
  mirrorMemoryToCloudRls,
  mirrorPreferencesToCloudRls,
  mirrorTurnToCloudRls,
  signInOperatorBrowser,
  signOutOperatorBrowser,
  signUpOperatorBrowser,
  type BrowserOperatorSession,
} from '@/lib/supabase-browser';
import {
  BrowserVoiceSessionController,
  cancelBrowserSpeech,
  detectBrowserVoiceCapabilities,
  loadCachedVoicePreferences,
  saveCachedVoicePreferences,
  type BrowserVoiceControllerSnapshot,
  type RecognizedSpeechTurn,
} from '@/lib/browser-voice';
import { ErrorBoundary } from './ErrorBoundary';
import { TopStatusBar } from './TopStatusBar';
import { AuthModal } from './AuthModal';
import { IntelligenceCoreOrb, type CoreVisualState } from './IntelligenceCoreOrb';
import { LiveWaveformPanel } from './LiveWaveformPanel';
import { ConversationPanel } from './ConversationPanel';
import {
  MultimodalInputBar,
  type StagedDocumentAttachment,
  type StagedVisionAttachment,
} from './MultimodalInputBar';
import { AgentActivityPanel } from './AgentActivityPanel';
import { EngineeringWorkspacePanel } from './EngineeringWorkspacePanel';
import {
  KnowledgeWorkspacePanel,
  type KnowledgeDocument,
  type KnowledgeQueryResult,
} from './KnowledgeWorkspacePanel';
import {
  ResearchWorkspacePanel,
  type ResearchMode,
  type ResearchProviderView,
  type ResearchResultView,
} from './ResearchWorkspacePanel';
import { SystemTelemetryPanel } from './SystemTelemetryPanel';
import { VisionInspectorModal } from './VisionInspectorModal';
import { SettingsDrawer } from './SettingsDrawer';

interface JarvisDashboardProps {
  initialSnapshot?: JarvisSystemSnapshot | null;
  initialMessages?: ChatMessage[];
}

export function JarvisDashboard({
  initialSnapshot = null,
  initialMessages = [],
}: JarvisDashboardProps) {
  const [snapshot, setSnapshot] = useState<JarvisSystemSnapshot | null>(initialSnapshot);
  const [activeConversationId, setActiveConversationId] = useState<string>(
    initialSnapshot?.conversations?.[0]?.id ?? DEFAULT_CONVERSATION_ID
  );
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [activitySteps, setActivitySteps] = useState<AgentActivityStep[]>([]);
  const [latestRuntimeResult, setLatestRuntimeResult] =
    useState<TurnResponse['runtime'] | null>(null);
  const [activeStyle, setActiveStyle] = useState<ResponseStyle>(
    initialSnapshot?.preferences.preferredResponseStyle ?? 'calm'
  );
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Supabase Operator Auth & RLS Sync State
  const [operatorSession, setOperatorSession] =
    useState<BrowserOperatorSession | null>(null);
  const [clientRlsSynced, setClientRlsSynced] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // Mobile responsive view tab
  const [mobileView, setMobileView] = useState<
    'console' | 'activity' | 'systems' | 'engineering' | 'knowledge' | 'research'
  >('console');

  // --- v1.2 Knowledge/Documents workspace state -------------------------
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocument[]>([]);
  const [knowledgeEmbedding, setKnowledgeEmbedding] = useState<{
    mode: string;
    honestNote: string;
  } | null>(null);
  const [researchProvider, setResearchProvider] = useState<ResearchProviderView | null>(null);
  const [knowledgeRerankingMode, setKnowledgeRerankingMode] = useState<string>(
    'deterministic_fallback'
  );

  const refreshKnowledgeDocuments = useCallback(async () => {
    try {
      const response = await fetch('/api/jarvis/files', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        intelligence?: {
          documents?: KnowledgeDocument[];
          embedding?: { mode: string; honestNote: string };
          rerankingMode?: string;
        };
      };
      setKnowledgeDocuments(payload.intelligence?.documents ?? []);
      if (payload.intelligence?.embedding) {
        setKnowledgeEmbedding(payload.intelligence.embedding);
      }
      if (payload.intelligence?.rerankingMode) {
        setKnowledgeRerankingMode(payload.intelligence.rerankingMode);
      }
    } catch {
      // Silent: the workspace still functions with an empty list.
    }
  }, []);

  const handleKnowledgeUpload = useCallback(
    async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/jarvis/files/ingest', {
        method: 'POST',
        body: form,
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        ingestion?: { warnings?: string[] };
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? 'Document ingestion failed.');
      }
      await refreshKnowledgeDocuments();
    },
    [refreshKnowledgeDocuments]
  );

  const handleKnowledgeRemove = useCallback(
    async (documentId: string) => {
      const response = await fetch(`/api/jarvis/files/${encodeURIComponent(documentId)}`, {
        method: 'DELETE',
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? 'Document removal failed.');
      }
      await refreshKnowledgeDocuments();
    },
    [refreshKnowledgeDocuments]
  );

  const refreshResearchProvider = useCallback(async () => {
    try {
      const response = await fetch('/api/jarvis/research', { method: 'GET' });
      if (!response.ok) return;
      const payload = (await response.json()) as { provider?: ResearchProviderView };
      if (payload.provider) setResearchProvider(payload.provider);
    } catch {
      // Provider status is advisory; failures must not break the HUD.
    }
  }, []);

  const handleResearchRun = useCallback(
    async (input: { query: string; mode: ResearchMode }): Promise<ResearchResultView | null> => {
      const response = await fetch('/api/jarvis/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: input.query, mode: input.mode }),
      });
      const payload = (await response.json()) as
        | (ResearchResultView & { ok?: boolean; error?: string })
        | { ok?: false; error?: string };

      if (!response.ok || !('taskId' in payload)) {
        throw new Error(('error' in payload && payload.error) || 'Research request failed.');
      }
      return payload as ResearchResultView;
    },
    []
  );

  const handleResearchCancel = useCallback(async (taskId: string): Promise<boolean> => {
    const response = await fetch(`/api/jarvis/research/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
    });
    const payload = (await response.json()) as { ok?: boolean; cancelled?: boolean };
    return Boolean(response.ok && payload.cancelled);
  }, []);

  const handleKnowledgeQuery = useCallback(
    async (query: string): Promise<KnowledgeQueryResult> => {
      const response = await fetch('/api/jarvis/files/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        answer?: KnowledgeQueryResult['answer'];
        citations?: KnowledgeQueryResult['citations'];
        verification?: KnowledgeQueryResult['verification'];
        retrieval?: KnowledgeQueryResult['retrieval'];
      };
      if (!response.ok || !payload.ok || !payload.answer) {
        throw new Error(payload.error ?? 'Document query failed.');
      }
      return {
        answer: payload.answer,
        citations: payload.citations ?? [],
        verification: payload.verification,
        retrieval: payload.retrieval,
      };
    },
    []
  );

  // Real-Time Browser Voice & Female Persona Controller State (never auto-started)
  const voiceControllerRef = useRef<BrowserVoiceSessionController | null>(null);
  const [voiceSnap, setVoiceSnap] = useState<BrowserVoiceControllerSnapshot>(() => ({
    state: 'IDLE',
    capabilities: detectBrowserVoiceCapabilities(),
    interimTranscript: '',
    finalTranscript: '',
    discoveredVoices: [],
    selectedVoice: null,
    voiceSelectionReason: 'no_voices_available',
    preferredVoiceMissing: false,
    micLevels: undefined,
    errorCode: null,
    errorMessage: null,
    bargeInCount: 0,
    rawAudioPersisted: false,
  }));
  const [localVoiceMuted, setLocalVoiceMuted] = useState<boolean>(
    Boolean(initialSnapshot?.preferences.voiceMuted)
  );
  const [localPreferredVoiceUri, setLocalPreferredVoiceUri] = useState<string | null>(
    initialSnapshot?.preferences.preferredBrowserVoiceUri ?? null
  );
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);

  // Vision & Document Intelligence UI state
  const [visionModalOpen, setVisionModalOpen] = useState(false);
  const [stagedAttachment, setStagedAttachment] =
    useState<StagedVisionAttachment | null>(null);
  const [stagedDocument, setStagedDocument] =
    useState<StagedDocumentAttachment | null>(null);

  // Settings drawer state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    'persona' | 'models' | 'supabase' | 'security'
  >('persona');

  // Permission resolution state
  const [resolvedPermissions, setResolvedPermissions] = useState<
    Record<string, 'approved' | 'denied'>
  >({});
  const [permissionError, setPermissionError] = useState<Record<string, string>>({});

  const isVoiceMuted = Boolean(snapshot?.preferences.voiceMuted ?? localVoiceMuted);
  const preferredBrowserVoiceUri =
    snapshot?.preferences.preferredBrowserVoiceUri !== undefined
      ? snapshot.preferences.preferredBrowserVoiceUri
      : localPreferredVoiceUri;
  const activePersonaLabel =
    snapshot?.preferences.voiceProfileId === 'jarvis-x-lyra-female-v1'
      ? 'Lyra Persona'
      : 'Aria Persona';

  const handleStopSpeaking = useCallback(() => {
    if (voiceControllerRef.current) {
      voiceControllerRef.current.stopSpeaking('operator_stop_voice');
    } else {
      cancelBrowserSpeech();
    }
    setSpeakingMessageId(null);
  }, []);

  const handleSpeakMessage = useCallback(
    (msg: ChatMessage, styleOverride?: ResponseStyle) => {
      if (isVoiceMuted) return;
      const profileId =
        snapshot?.preferences.voiceProfileId ?? 'jarvis-x-aria-female-v1';
      const style = styleOverride ?? msg.responseStyle ?? activeStyle;

      if (voiceControllerRef.current) {
        voiceControllerRef.current.speakResponse(msg.content, {
          turnId: msg.id,
          style,
          voiceProfileId: profileId,
          onStart: () => setSpeakingMessageId(msg.id),
          onEnd: () =>
            setSpeakingMessageId((curr) => (curr === msg.id ? null : curr)),
        });
      }
    },
    [activeStyle, isVoiceMuted, snapshot?.preferences.voiceProfileId]
  );

  const buildAuthHeaders = useCallback(
    (sessionOverride?: BrowserOperatorSession | null): Record<string, string> => {
      const sess = sessionOverride !== undefined ? sessionOverride : operatorSession;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (sess?.accessToken) {
        headers.Authorization = `Bearer ${sess.accessToken}`;
      }
      return headers;
    },
    [operatorSession]
  );

  const syncWorkspaceState = useCallback(
    async (
      convId: string,
      sessionOverride?: BrowserOperatorSession | null
    ) => {
      const sess = sessionOverride !== undefined ? sessionOverride : operatorSession;
      try {
        const res = await fetch(
          `/api/jarvis/status?conversationId=${encodeURIComponent(convId)}`,
          {
            headers: buildAuthHeaders(sess),
          }
        );
        const data = await res.json();
        if (!data.ok || !data.snapshot) return;

        let nextSnapshot: JarvisSystemSnapshot = data.snapshot;
        let nextMessages: ChatMessage[] = Array.isArray(data.messages)
          ? data.messages
          : [];

        if (
          sess &&
          nextSnapshot.supabase.serverReachability === 'degraded_unreachable'
        ) {
          const cloud = await loadCloudRlsWorkspace(sess.userId, convId);
          if (cloud.synced) {
            setClientRlsSynced(true);
            if (cloud.messages && cloud.messages.length > 0) {
              nextMessages = cloud.messages;
            }
            nextSnapshot = {
              ...nextSnapshot,
              conversations:
                cloud.conversations && cloud.conversations.length > 0
                  ? cloud.conversations
                  : nextSnapshot.conversations,
              recentMemories: cloud.memories ?? nextSnapshot.recentMemories,
              memory: {
                ...nextSnapshot.memory,
                storedEntriesCount:
                  cloud.memories?.length ?? nextSnapshot.memory.storedEntriesCount,
                persistenceMode: 'supabase_cloud',
                statusLabel: `Supabase Cloud RLS Active (${cloud.memories?.length ?? 0} persisted records)`,
              },
              preferences: cloud.preferences ?? nextSnapshot.preferences,
              permissionAudit: cloud.permissionAudit ?? nextSnapshot.permissionAudit,
              auditLogs: cloud.auditLogs ?? nextSnapshot.auditLogs,
            };
          } else {
            setClientRlsSynced(false);
          }
        } else {
          setClientRlsSynced(
            Boolean(sess && nextSnapshot.supabase.persistenceMode === 'supabase_cloud')
          );
        }

        setSnapshot(nextSnapshot);
        setMessages(nextMessages);
        setActiveStyle(nextSnapshot.preferences.preferredResponseStyle);
        setLocalVoiceMuted(Boolean(nextSnapshot.preferences.voiceMuted));
        setLocalPreferredVoiceUri(
          nextSnapshot.preferences.preferredBrowserVoiceUri ?? null
        );
      } catch {
        // Keep current UI snapshot gracefully on transient network hiccups
      }
    },
    [buildAuthHeaders, operatorSession]
  );

  const transmitMessage = useCallback(
    async (
      overrideMessage?: string,
      voiceTurnMeta?: {
        modality: 'voice_transcript';
        voiceMeta: {
          transcriptConfidence?: number;
          languageCode?: string;
          durationMs?: number;
          bargeInTriggered?: boolean;
        };
      }
    ) => {
      const text = (overrideMessage ?? inputText).trim();
      if (!text || isSending) {
        voiceControllerRef.current?.markRuntimeProcessingComplete();
        return;
      }

      setErrorBanner(null);
      setIsSending(true);
      if (!overrideMessage) {
        setInputText('');
      }
      const attachmentToSend = stagedAttachment ?? undefined;
      const documentToSend = stagedDocument ?? undefined;
      setStagedAttachment(null);
      setStagedDocument(null);
      handleStopSpeaking();

      const resolvedModality = attachmentToSend
        ? 'vision_multimodal'
        : voiceTurnMeta?.modality ?? 'text';

      try {
        const res = await fetch('/api/jarvis/chat', {
          method: 'POST',
          headers: buildAuthHeaders(),
          body: JSON.stringify({
            conversationId: activeConversationId,
            modality: resolvedModality,
            voiceMeta: voiceTurnMeta?.voiceMeta,
            message: text,
            visionAttachment: attachmentToSend,
            documentAttachment: documentToSend,
          }),
        });
        const data = await res.json();

        if (!res.ok || !data.ok) {
          setErrorBanner(data.error || 'Failed to process directive.');
          voiceControllerRef.current?.markRuntimeProcessingComplete();
          return;
        }

        const { turn, snapshot: updatedSnapshot } = data;
        setMessages((prev) => [...prev, turn.userMessage, turn.assistantMessage]);
        setActivitySteps(turn.activitySteps ?? []);
        setLatestRuntimeResult(turn.runtime ?? null);
        if (turn.contextSignals?.recommendedStyle) {
          setActiveStyle(turn.contextSignals.recommendedStyle);
        }

        const effectiveMuted = Boolean(
          updatedSnapshot?.preferences?.voiceMuted ??
            snapshot?.preferences?.voiceMuted ??
            localVoiceMuted
        );
        const shouldSpeakReply =
          !effectiveMuted &&
          Boolean(turn.assistantMessage?.content) &&
          (resolvedModality === 'voice_transcript' ||
            Boolean(
              updatedSnapshot?.preferences?.voiceAutoSpeak ??
                snapshot?.preferences?.voiceAutoSpeak
            ));

        if (shouldSpeakReply && voiceControllerRef.current) {
          const started = voiceControllerRef.current.speakResponse(
            turn.assistantMessage.content,
            {
              turnId: turn.assistantMessage.id,
              style:
                turn.contextSignals?.recommendedStyle ??
                turn.assistantMessage.responseStyle ??
                activeStyle,
              voiceProfileId:
                updatedSnapshot?.preferences?.voiceProfileId ??
                snapshot?.preferences?.voiceProfileId ??
                'jarvis-x-aria-female-v1',
              onStart: () => setSpeakingMessageId(turn.assistantMessage.id),
              onEnd: () =>
                setSpeakingMessageId((curr) =>
                  curr === turn.assistantMessage.id ? null : curr
                ),
            }
          );
          if (!started) {
            voiceControllerRef.current.markRuntimeProcessingComplete();
          }
        } else {
          voiceControllerRef.current?.markRuntimeProcessingComplete();
        }

        if (
          operatorSession &&
          updatedSnapshot?.supabase?.serverReachability === 'degraded_unreachable'
        ) {
          const mirrored = await mirrorTurnToCloudRls(operatorSession.userId, turn);
          setClientRlsSynced(mirrored);
        }

        if (updatedSnapshot) {
          setSnapshot(updatedSnapshot);
        }
      } catch {
        setErrorBanner('Network error communicating with JARVIS-X Core API.');
        voiceControllerRef.current?.markRuntimeProcessingComplete();
      } finally {
        setIsSending(false);
      }
    },
    [
      activeConversationId,
      activeStyle,
      buildAuthHeaders,
      handleStopSpeaking,
      inputText,
      isSending,
      localVoiceMuted,
      operatorSession,
      snapshot?.preferences?.voiceAutoSpeak,
      snapshot?.preferences?.voiceMuted,
      snapshot?.preferences?.voiceProfileId,
      stagedAttachment,
      stagedDocument,
    ]
  );

  const transmitVoiceRef = useRef(transmitMessage);
  useEffect(() => {
    transmitVoiceRef.current = transmitMessage;
  }, [transmitMessage]);

  // Initialize lifecycle-managed BrowserVoiceSessionController (NEVER auto-starts mic!)
  useEffect(() => {
    const cached = loadCachedVoicePreferences();
    if (cached.voiceMuted !== undefined) {
      setLocalVoiceMuted(cached.voiceMuted);
    }
    if (cached.preferredBrowserVoiceUri !== undefined) {
      setLocalPreferredVoiceUri(cached.preferredBrowserVoiceUri);
    }

    const controller = new BrowserVoiceSessionController({
      preferredBrowserVoiceUri:
        cached.preferredBrowserVoiceUri ??
        initialSnapshot?.preferences.preferredBrowserVoiceUri ??
        null,
      voiceProfileId:
        cached.voiceProfileId ??
        initialSnapshot?.preferences.voiceProfileId ??
        'jarvis-x-aria-female-v1',
      muted:
        cached.voiceMuted ?? Boolean(initialSnapshot?.preferences.voiceMuted),
      onStateChange: (nextSnap) => {
        setVoiceSnap(nextSnap);
        if (nextSnap.state !== 'SPEAKING') {
          setSpeakingMessageId((curr) =>
            nextSnap.state === 'INTERRUPTING' || nextSnap.state === 'LISTENING'
              ? null
              : curr
          );
        }
      },
      onFinalTranscript: async (turn: RecognizedSpeechTurn) => {
        await transmitVoiceRef.current(turn.transcript, {
          modality: 'voice_transcript',
          voiceMeta: {
            transcriptConfidence: turn.confidence,
            languageCode: turn.languageCode,
            durationMs: turn.durationMs,
            bargeInTriggered: turn.bargeInTriggered,
          },
        });
      },
    });

    voiceControllerRef.current = controller;
    setVoiceSnap(controller.getSnapshot());

    return () => {
      controller.destroy();
      voiceControllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep controller preferences synced when snapshot/local preferences change
  useEffect(() => {
    voiceControllerRef.current?.updatePreferences({
      preferredBrowserVoiceUri,
      voiceProfileId:
        snapshot?.preferences.voiceProfileId ?? 'jarvis-x-aria-female-v1',
      muted: isVoiceMuted,
    });
  }, [
    isVoiceMuted,
    preferredBrowserVoiceUri,
    snapshot?.preferences.voiceProfileId,
  ]);

  // Restore browser operator session on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      const existing = await getActiveBrowserSession();
      if (!mounted) return;
      if (existing) {
        setOperatorSession(existing);
        await syncWorkspaceState(activeConversationId, existing);
      } else if (!initialSnapshot) {
        await syncWorkspaceState(activeConversationId, null);
      }
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isMicActive = voiceSnap.state === 'LISTENING';
  const isSpeaking =
    (speakingMessageId !== null || voiceSnap.state === 'SPEAKING') && !isVoiceMuted;

  const hasUnresolvedPermission = messages.some(
    (m) => m.pendingPermission && !resolvedPermissions[m.pendingPermission.id]
  );

  const coreVisualState: CoreVisualState = isMicActive
    ? 'listening'
    : isSending || voiceSnap.state === 'PROCESSING'
      ? 'processing'
      : isSpeaking
        ? 'speaking'
        : hasUnresolvedPermission
          ? 'awaiting_permission'
          : 'idle';

  const handleToggleMic = useCallback(async () => {
    if (!voiceControllerRef.current) return;
    await voiceControllerRef.current.toggleListening();
  }, []);

  const handleInterruptAndListen = useCallback(async () => {
    setSpeakingMessageId(null);
    if (!voiceControllerRef.current) return;
    await voiceControllerRef.current.startListening();
  }, []);

  const handleOpenSettings = (
    tab: 'persona' | 'models' | 'supabase' | 'security' = 'persona'
  ) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  const handleSignIn = async (email: string, password: string) => {
    const res = await signInOperatorBrowser({ email, password });
    if (res.ok && res.session) {
      setOperatorSession(res.session);
      await syncWorkspaceState(activeConversationId, res.session);
    }
    return { ok: res.ok, error: res.error };
  };

  const handleSignUp = async (
    email: string,
    password: string,
    displayName: string
  ) => {
    const res = await signUpOperatorBrowser({ email, password, displayName });
    if (res.ok && res.session) {
      setOperatorSession(res.session);
      await syncWorkspaceState(activeConversationId, res.session);
    }
    return { ok: res.ok, error: res.error };
  };

  const handleSignOut = async () => {
    await signOutOperatorBrowser();
    setOperatorSession(null);
    setClientRlsSynced(false);
    setResolvedPermissions({});
    await syncWorkspaceState(DEFAULT_CONVERSATION_ID, null);
    setActiveConversationId(DEFAULT_CONVERSATION_ID);
  };

  const handleSelectConversation = async (conversationId: string) => {
    handleStopSpeaking();
    setActiveConversationId(conversationId);
    setActivitySteps([]);
    setLatestRuntimeResult(null);
    await syncWorkspaceState(conversationId);
  };

  const handleCreateConversation = async () => {
    setErrorBanner(null);
    handleStopSpeaking();
    try {
      const res = await fetch('/api/jarvis/conversations', {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({
          title: `Session ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorBanner(data.error || 'Could not create conversation.');
        return;
      }

      if (
        operatorSession &&
        data.snapshot?.supabase?.serverReachability === 'degraded_unreachable'
      ) {
        await createConversationCloudRls(operatorSession.userId, data.conversation);
      }

      setActiveConversationId(data.conversation.id);
      setMessages([]);
      setActivitySteps([]);
      setLatestRuntimeResult(null);
      if (data.snapshot) {
        setSnapshot(data.snapshot);
      }
      await syncWorkspaceState(data.conversation.id);
    } catch {
      setErrorBanner('Network error while creating conversation.');
    }
  };

  const handleResolvePermission = async (
    req: PermissionRequest,
    approve: boolean,
    stepUpPasscode?: string
  ) => {
    setPermissionError((prev) => ({ ...prev, [req.id]: '' }));

    try {
      const res = await fetch('/api/jarvis/permissions', {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({
          requestId: req.id,
          approve,
          stepUpPasscode,
          conversationId: req.conversationId,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setPermissionError((prev) => ({
          ...prev,
          [req.id]: data.error || 'Authorization rejected.',
        }));
        if (data.snapshot) setSnapshot(data.snapshot);
        return;
      }

      setResolvedPermissions((prev) => ({
        ...prev,
        [req.id]: approve ? 'approved' : 'denied',
      }));

      if (data.result?.followUpMessage) {
        setMessages((prev) => [...prev, data.result.followUpMessage]);
      }

      if (
        operatorSession &&
        data.snapshot?.supabase?.serverReachability === 'degraded_unreachable' &&
        approve &&
        data.result?.savedMemoryId
      ) {
        const savedEntry = (data.snapshot.recentMemories ?? []).find(
          (m: { id: string }) => m.id === data.result.savedMemoryId
        );
        if (savedEntry) {
          await mirrorMemoryToCloudRls(operatorSession.userId, savedEntry);
        }
      }

      if (data.snapshot) {
        setSnapshot(data.snapshot);
      }
    } catch {
      setPermissionError((prev) => ({
        ...prev,
        [req.id]: 'Failed to reach permission verification endpoint.',
      }));
    }
  };

  const handleUpdatePreferences = useCallback(
    async (patch: Partial<PersonalityPreferences>) => {
      if (patch.voiceMuted !== undefined) {
        setLocalVoiceMuted(patch.voiceMuted);
        if (patch.voiceMuted) {
          handleStopSpeaking();
        }
      }
      if (patch.preferredBrowserVoiceUri !== undefined) {
        setLocalPreferredVoiceUri(patch.preferredBrowserVoiceUri);
      }

      saveCachedVoicePreferences({
        preferredBrowserVoiceUri: patch.preferredBrowserVoiceUri,
        voiceMuted: patch.voiceMuted,
        voiceAutoSpeak: patch.voiceAutoSpeak,
        voiceProfileId: patch.voiceProfileId,
      });

      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              preferences: { ...prev.preferences, ...patch },
            }
          : prev
      );

      try {
        const res = await fetch('/api/jarvis/preferences', {
          method: 'PATCH',
          headers: buildAuthHeaders(),
          body: JSON.stringify(patch),
        });
        const data = await res.json();
        if (data.ok && data.snapshot) {
          if (
            operatorSession &&
            data.snapshot.supabase.serverReachability === 'degraded_unreachable'
          ) {
            await mirrorPreferencesToCloudRls(
              operatorSession.userId,
              data.preferences
            );
          }
          setSnapshot(data.snapshot);
          if (patch.preferredResponseStyle) {
            setActiveStyle(patch.preferredResponseStyle);
          }
        }
      } catch {
        // Local cached preference remains intact even on transient offline state
      }
    },
    [buildAuthHeaders, handleStopSpeaking, operatorSession]
  );

  const handleToggleMute = useCallback(() => {
    void handleUpdatePreferences({ voiceMuted: !isVoiceMuted });
  }, [handleUpdatePreferences, isVoiceMuted]);

  const handleSelectBrowserVoiceUri = useCallback(
    (voiceUri: string | null) => {
      void handleUpdatePreferences({ preferredBrowserVoiceUri: voiceUri });
    },
    [handleUpdatePreferences]
  );

  const handleAddMemory = async (content: string) => {
    const res = await fetch('/api/jarvis/memory', {
      method: 'POST',
      headers: buildAuthHeaders(),
      body: JSON.stringify({ content, category: 'fact' }),
    });
    const data = await res.json();
    if (data.ok && data.snapshot) {
      if (
        operatorSession &&
        data.entry &&
        data.snapshot.supabase.serverReachability === 'degraded_unreachable'
      ) {
        await mirrorMemoryToCloudRls(operatorSession.userId, data.entry);
      }
      setSnapshot(data.snapshot);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    const res = await fetch(`/api/jarvis/memory?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: buildAuthHeaders(),
    });
    const data = await res.json();
    if (data.ok && data.snapshot) {
      if (
        operatorSession &&
        data.snapshot.supabase.serverReachability === 'degraded_unreachable'
      ) {
        await deleteMemoryFromCloudRls(operatorSession.userId, id);
      }
      setSnapshot(data.snapshot);
    }
  };

  const connectedToolCount =
    snapshot?.capabilities.filter((c) => c.state === 'connected_local').length ?? 3;

  return (
    <ErrorBoundary>
      <div className="jarvis-atmosphere min-h-screen w-full text-slate-100">
        <div className="jarvis-grid-overlay flex min-h-screen flex-col">
          {/* Top Command & Telemetry Bar */}
          <TopStatusBar
            snapshot={snapshot}
            operatorSession={operatorSession}
            clientRlsSynced={clientRlsSynced}
            onOpenAuth={() => setAuthModalOpen(true)}
            onOpenSettings={handleOpenSettings}
          />

          {/* Mobile Compact Status Strip (< 1024px) */}
          <div className="border-b border-slate-800/80 bg-slate-950/75 px-3 py-2 lg:hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-slate-300">
              <span className="truncate">
                AUTH:{' '}
                <strong
                  className={
                    operatorSession ? 'text-emerald-300' : 'text-cyan-200'
                  }
                >
                  {operatorSession ? `${operatorSession.displayName} (RLS)` : 'GUEST'}
                </strong>
              </span>
              <span>
                VOICE:{' '}
                <strong className="text-cyan-200">{voiceSnap.state}</strong> · MEM:{' '}
                <strong className="text-indigo-200">
                  {snapshot?.memory.storedEntriesCount ?? 2}
                </strong>{' '}
                · TOOLS:{' '}
                <strong className="text-emerald-300">{connectedToolCount} READY</strong>
              </span>
            </div>
          </div>

          {errorBanner && (
            <div className="mx-auto mt-3 w-full max-w-[1600px] px-3 sm:px-5">
              <div className="rounded-xl border border-rose-400/35 bg-rose-950/35 px-4 py-2.5 font-mono text-xs text-rose-200">
                {errorBanner}
              </div>
            </div>
          )}

          {/* Main Responsive Workspace */}
          <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col px-3 py-3 sm:px-5 lg:py-4">
            {/* Desktop 3-Column Command Architecture (lg+) */}
            <div className="hidden lg:grid lg:grid-cols-12 lg:gap-4">
              {/* Left Column: Central Animated Core + Live Waveform + System/Memory Telemetry */}
              <div className="flex max-h-[calc(100vh-92px)] flex-col gap-4 overflow-y-auto pr-1 lg:col-span-3">
                <IntelligenceCoreOrb
                  visualState={coreVisualState}
                  activeStyle={activeStyle}
                  voiceProfileName={`${activePersonaLabel} (Style Profile)`}
                />
                <LiveWaveformPanel
                  voiceState={voiceSnap.state}
                  isMicActive={isMicActive}
                  isProcessing={isSending || voiceSnap.state === 'PROCESSING'}
                  isSpeaking={isSpeaking}
                  isMuted={isVoiceMuted}
                  autoSpeakEnabled={Boolean(snapshot?.preferences.voiceAutoSpeak)}
                  personaProfileLabel={activePersonaLabel}
                  activeStyle={activeStyle}
                  discoveredVoices={voiceSnap.discoveredVoices}
                  selectedBrowserVoice={voiceSnap.selectedVoice}
                  preferredBrowserVoiceUri={preferredBrowserVoiceUri}
                  ttsSupported={voiceSnap.capabilities.ttsSupported}
                  sttSupported={voiceSnap.capabilities.sttSupported}
                  micLevels={voiceSnap.micLevels}
                  onStopSpeaking={handleStopSpeaking}
                  onInterruptAndListen={handleInterruptAndListen}
                  onToggleMute={handleToggleMute}
                  onSelectBrowserVoiceUri={handleSelectBrowserVoiceUri}
                />
                <SystemTelemetryPanel
                  snapshot={snapshot}
                  onAddMemory={handleAddMemory}
                  onDeleteMemory={handleDeleteMemory}
                />
              </div>

              {/* Center Column: Primary Conversation & Multimodal Command Stage */}
              <div className="glass-panel flex h-[calc(100vh-92px)] flex-col overflow-hidden lg:col-span-6">
                <ConversationPanel
                  conversations={snapshot?.conversations ?? []}
                  activeConversationId={activeConversationId}
                  onSelectConversation={handleSelectConversation}
                  onCreateConversation={handleCreateConversation}
                  messages={messages}
                  isSending={isSending}
                  resolvedPermissions={resolvedPermissions}
                  permissionError={permissionError}
                  onSelectQuickPrompt={(prompt) => transmitMessage(prompt)}
                  onResolvePermission={handleResolvePermission}
                  speakingMessageId={speakingMessageId}
                  onSpeakMessage={
                    voiceSnap.capabilities.ttsSupported && !isVoiceMuted
                      ? handleSpeakMessage
                      : undefined
                  }
                  onStopSpeaking={handleStopSpeaking}
                />
                <MultimodalInputBar
                  inputText={inputText}
                  onChangeText={setInputText}
                  onSubmit={() => transmitMessage()}
                  isSending={isSending}
                  stagedAttachment={stagedAttachment}
                  onClearAttachment={() => setStagedAttachment(null)}
                  stagedDocument={stagedDocument}
                  onStageDocument={setStagedDocument}
                  onOpenVisionModal={() => setVisionModalOpen(true)}
                  isMicActive={isMicActive}
                  voiceState={voiceSnap.state}
                  sttSupported={voiceSnap.capabilities.sttSupported}
                  interimTranscript={voiceSnap.interimTranscript}
                  lastRecognizedTranscript={voiceSnap.finalTranscript}
                  voiceErrorCode={voiceSnap.errorCode}
                  voiceErrorMessage={voiceSnap.errorMessage}
                  isSpeaking={isSpeaking}
                  isVoiceMuted={isVoiceMuted}
                  onToggleMic={handleToggleMic}
                  onStopSpeaking={handleStopSpeaking}
                  onToggleMute={handleToggleMute}
                  onBargeInInterrupt={handleStopSpeaking}
                />
              </div>

              {/* Right Column: Real Runtime State Telemetry & Specialist Contracts */}
              <div className="max-h-[calc(100vh-92px)] overflow-y-auto pl-1 lg:col-span-3">
                <AgentActivityPanel
                  steps={activitySteps}
                  runtimeResult={latestRuntimeResult}
                  isProcessing={isSending}
                  specialists={snapshot?.specialists ?? []}
                />
              </div>
            </div>

            {/* Mobile & Tablet Adaptive View (< 1024px) */}
            <div className="flex flex-1 flex-col gap-3 lg:hidden">
              {/* Mobile Segmented Navigation (44px+ accessible touch targets) */}
              <nav
                aria-label="Mobile Workspace Sections"
                className="grid grid-cols-2 gap-1.5 rounded-2xl border border-cyan-400/15 bg-slate-950/80 p-1.5 sm:grid-cols-4"
              >
                <button
                  type="button"
                  onClick={() => setMobileView('console')}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl font-display text-xs font-semibold transition ${
                    mobileView === 'console'
                      ? 'border border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <MessageSquare className="h-4 w-4" />
                  <span>Console</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMobileView('activity')}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl font-display text-xs font-semibold transition ${
                    mobileView === 'activity'
                      ? 'border border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Activity className="h-4 w-4" />
                  <span>Activity</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMobileView('systems')}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl font-display text-xs font-semibold transition ${
                    mobileView === 'systems'
                      ? 'border border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Cpu className="h-4 w-4" />
                  <span>Core &amp; Mem</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMobileView('engineering')}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl font-display text-xs font-semibold transition ${
                    mobileView === 'engineering'
                      ? 'border border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Code2 className="h-4 w-4" />
                  <span>Engineering</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMobileView('knowledge');
                    void refreshKnowledgeDocuments();
                  }}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl font-display text-xs font-semibold transition ${
                    mobileView === 'knowledge'
                      ? 'border border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <BookOpen className="h-4 w-4" />
                  <span>Knowledge</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMobileView('research');
                    void refreshResearchProvider();
                  }}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl font-display text-xs font-semibold transition ${
                    mobileView === 'research'
                      ? 'border border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Globe className="h-4 w-4" />
                  <span>Research</span>
                </button>
              </nav>

              {mobileView === 'console' && (
                <div className="flex flex-1 flex-col gap-2.5">
                  <IntelligenceCoreOrb
                    visualState={coreVisualState}
                    activeStyle={activeStyle}
                    voiceProfileName={`${activePersonaLabel} (Style Profile)`}
                    compact
                  />
                  <LiveWaveformPanel
                    voiceState={voiceSnap.state}
                    isMicActive={isMicActive}
                    isProcessing={isSending || voiceSnap.state === 'PROCESSING'}
                    isSpeaking={isSpeaking}
                    isMuted={isVoiceMuted}
                    autoSpeakEnabled={Boolean(snapshot?.preferences.voiceAutoSpeak)}
                    personaProfileLabel={activePersonaLabel}
                    activeStyle={activeStyle}
                    discoveredVoices={voiceSnap.discoveredVoices}
                    selectedBrowserVoice={voiceSnap.selectedVoice}
                    preferredBrowserVoiceUri={preferredBrowserVoiceUri}
                    ttsSupported={voiceSnap.capabilities.ttsSupported}
                    sttSupported={voiceSnap.capabilities.sttSupported}
                    micLevels={voiceSnap.micLevels}
                    compact
                    onStopSpeaking={handleStopSpeaking}
                    onInterruptAndListen={handleInterruptAndListen}
                    onToggleMute={handleToggleMute}
                    onSelectBrowserVoiceUri={handleSelectBrowserVoiceUri}
                  />
                  <div className="glass-panel flex min-h-[460px] flex-1 flex-col overflow-hidden">
                    <ConversationPanel
                      conversations={snapshot?.conversations ?? []}
                      activeConversationId={activeConversationId}
                      onSelectConversation={handleSelectConversation}
                      onCreateConversation={handleCreateConversation}
                      messages={messages}
                      isSending={isSending}
                      resolvedPermissions={resolvedPermissions}
                      permissionError={permissionError}
                      onSelectQuickPrompt={(prompt) => transmitMessage(prompt)}
                      onResolvePermission={handleResolvePermission}
                      speakingMessageId={speakingMessageId}
                      onSpeakMessage={
                        voiceSnap.capabilities.ttsSupported && !isVoiceMuted
                          ? handleSpeakMessage
                          : undefined
                      }
                      onStopSpeaking={handleStopSpeaking}
                    />
                    <MultimodalInputBar
                      inputText={inputText}
                      onChangeText={setInputText}
                      onSubmit={() => transmitMessage()}
                      isSending={isSending}
                      stagedAttachment={stagedAttachment}
                      onClearAttachment={() => setStagedAttachment(null)}
                      stagedDocument={stagedDocument}
                      onStageDocument={setStagedDocument}
                      onOpenVisionModal={() => setVisionModalOpen(true)}
                      isMicActive={isMicActive}
                      voiceState={voiceSnap.state}
                      sttSupported={voiceSnap.capabilities.sttSupported}
                      interimTranscript={voiceSnap.interimTranscript}
                      lastRecognizedTranscript={voiceSnap.finalTranscript}
                      voiceErrorCode={voiceSnap.errorCode}
                      voiceErrorMessage={voiceSnap.errorMessage}
                      isSpeaking={isSpeaking}
                      isVoiceMuted={isVoiceMuted}
                      onToggleMic={handleToggleMic}
                      onStopSpeaking={handleStopSpeaking}
                      onToggleMute={handleToggleMute}
                      onBargeInInterrupt={handleStopSpeaking}
                    />
                  </div>
                </div>
              )}

              {mobileView === 'activity' && (
                <AgentActivityPanel
                  steps={activitySteps}
                  runtimeResult={latestRuntimeResult}
                  isProcessing={isSending}
                  specialists={snapshot?.specialists ?? []}
                />
              )}

              {mobileView === 'engineering' && (
                <EngineeringWorkspacePanel
                  authenticated={Boolean(snapshot?.auth.authenticated)}
                />
              )}

              {mobileView === 'research' && (
                <ResearchWorkspacePanel
                  authenticated={Boolean(snapshot?.auth.authenticated)}
                  provider={researchProvider ?? snapshot?.research?.provider ?? null}
                  onRun={handleResearchRun}
                  onCancel={handleResearchCancel}
                />
              )}

              {mobileView === 'knowledge' && (
                <KnowledgeWorkspacePanel
                  documents={knowledgeDocuments}
                  embeddingMode={knowledgeEmbedding?.mode ?? 'deterministic_fallback'}
                  embeddingHonestNote={knowledgeEmbedding?.honestNote}
                  rerankingMode={knowledgeRerankingMode}
                  onUpload={handleKnowledgeUpload}
                  onRemove={handleKnowledgeRemove}
                  onQuery={handleKnowledgeQuery}
                />
              )}

              {mobileView === 'systems' && (
                <div className="space-y-3">
                  <IntelligenceCoreOrb
                    visualState={coreVisualState}
                    activeStyle={activeStyle}
                    voiceProfileName={`${activePersonaLabel} (Style Profile)`}
                  />
                  <LiveWaveformPanel
                    voiceState={voiceSnap.state}
                    isMicActive={isMicActive}
                    isProcessing={isSending || voiceSnap.state === 'PROCESSING'}
                    isSpeaking={isSpeaking}
                    isMuted={isVoiceMuted}
                    autoSpeakEnabled={Boolean(snapshot?.preferences.voiceAutoSpeak)}
                    personaProfileLabel={activePersonaLabel}
                    activeStyle={activeStyle}
                    discoveredVoices={voiceSnap.discoveredVoices}
                    selectedBrowserVoice={voiceSnap.selectedVoice}
                    preferredBrowserVoiceUri={preferredBrowserVoiceUri}
                    ttsSupported={voiceSnap.capabilities.ttsSupported}
                    sttSupported={voiceSnap.capabilities.sttSupported}
                    micLevels={voiceSnap.micLevels}
                    onStopSpeaking={handleStopSpeaking}
                    onInterruptAndListen={handleInterruptAndListen}
                    onToggleMute={handleToggleMute}
                    onSelectBrowserVoiceUri={handleSelectBrowserVoiceUri}
                  />
                  <SystemTelemetryPanel
                    snapshot={snapshot}
                    onAddMemory={handleAddMemory}
                    onDeleteMemory={handleDeleteMemory}
                  />
                </div>
              )}
            </div>
          </main>

          {/* Operator Supabase Auth Modal */}
          <AuthModal
            open={authModalOpen}
            onClose={() => setAuthModalOpen(false)}
            session={operatorSession}
            supabaseConfigured={Boolean(snapshot?.supabase.configured)}
            clientSyncActive={clientRlsSynced}
            onSignIn={handleSignIn}
            onSignUp={handleSignUp}
            onSignOut={handleSignOut}
          />

          {/* Vision / Camera Modal */}
          <VisionInspectorModal
            open={visionModalOpen}
            cloudVisionConnected={Boolean(
              snapshot?.modelSystem?.catalog?.some(
                (m) =>
                  (m.capabilities.includes('vision') ||
                    m.supportedModalities.includes('image')) &&
                  m.configurationState === 'CONFIGURED' &&
                  m.healthStatus === 'AVAILABLE'
              )
            )}
            onClose={() => setVisionModalOpen(false)}
            onStageAttachment={(attachment) => setStagedAttachment(attachment)}
          />

          {/* Settings & Architecture Slide-Over */}
          <SettingsDrawer
            open={settingsOpen}
            initialTab={settingsTab}
            snapshot={snapshot}
            clientRlsSynced={clientRlsSynced}
            discoveredVoices={voiceSnap.discoveredVoices}
            selectedBrowserVoice={voiceSnap.selectedVoice}
            ttsSupported={voiceSnap.capabilities.ttsSupported}
            onClose={() => setSettingsOpen(false)}
            onUpdatePreferences={handleUpdatePreferences}
          />
        </div>
      </div>
    </ErrorBoundary>
  );
}
