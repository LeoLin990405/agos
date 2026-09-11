import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppTopbar, TopbarAction, TOPBAR_ICONS } from '@/components/layout/AppTopbar';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { CommandDeck, CONTINUE_PROMPT, canEmptySubmitContinue, type CommandDeckMessage } from '@/components/chat/CommandDeck';
import { sessionPromptMode } from '@/components/chat/tool-cards';
import { TurnEvidenceStrip } from '@/components/chat/TurnEvidenceStrip';
import type { ImageAttachmentDraft } from '@/components/chat/ImageAttachments';
import { VisionArbiterCard, type VisionArbiterCardState } from '@/components/chat/VisionArbiterCard';
import {
  requestVisionAnalysisWithPanelTexts,
  VisionRequestError,
  type ArbitratedVisionResponse,
  type VisionPanelEntry,
} from '@/components/chat/vision-arbiter-api';
import { NewSessionModal } from '@/components/chat/NewSessionModal';
import { ProgressDock } from '@/components/chat/ProgressDock';
import { SessionContextMenu, type MenuPoint } from '@/components/chat/SessionContextMenu';
import {
  fetchSessionMeta,
  formatSessionRelativeTime,
  mergeArchivedSnapshot,
  mergePinnedSnapshot,
  partitionSessions,
  pickFirstVisibleSession,
  setSessionArchived,
  setSessionPinned,
  trashSession,
  type SessionMetaSnapshot,
} from '@/components/chat/session-management';
import { SessionTrashPanel } from '@/components/chat/SessionTrashPanel';
import { EmptyStateHero, EmptyStateBelow } from '@/components/chat/EmptyState';
import { NEW_SESSION_EVENT } from '@/components/layout/AppRail';
import { consumeNewSessionRequest, requestNewSession } from '@/components/layout/new-session-intent';
import '@/design-system/chat-empty.css';
import '@/design-system/session-menu.css';
import {
  canHostOpenPath,
  conversationStore,
  ensureLiveConnection,
  fleetProgressStore,
  getEventClientId,
  liveConnectionStore,
  loadEarlierHistory,
  openConversation,
  openHostPath,
  refreshSessions,
  renameSession,
  searchSessions,
  sendPromptParts,
  sessionsStore,
  streamStore,
  watchHostArchivedSessions,
  type HostArchivedSessionsSnapshot,
} from '@/stores/live';
import { HistoryIntegrity } from '@/components/chat/HistoryIntegrity';
import { connectionHealthFromLive, deriveConnectionSurface } from '@/lib/connection-health';
import { LiveTranscript, useTranscriptItemCount, type OptimisticImageMessage } from '@/pages/chat-transcript';
import { AgosComputer } from '@/components/stage/AgosComputer';
import { ReplayScrubber } from '@/components/stage/ReplayScrubber';
import { deriveChatConnectionState } from '@/pages/chat-connection-state';
import { shortSessionRef } from '@/pages/session-short-id';

/** DeepSeek 原生四模式 id → 名(agentPreset.list 实测)。 */
const PRESET_NAMES: Record<string, string> = { standard: '标准模式', code: 'PTC 模式', minimal: '极简模式', cordis: '创造模式' };

interface SessionListItem {
  id: string;
  title: string;
  cwd: string;
  running: boolean;
  meta: string;
  time: string;
  updatedAt: number;
}

interface LocalVisionCard {
  id: string;
  sessionId: string;
  imageName: string;
  state: VisionArbiterCardState;
  result?: ArbitratedVisionResponse;
  panel?: VisionPanelEntry[];
  error?: string;
  notice?: string;
  controller: AbortController;
}

const localId = (prefix: string): string =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

const EMPTY_SESSION_META: SessionMetaSnapshot = {
  pinned: [],
  archived: [],
  hostArchived: [],
  hostArchivedAvailable: false,
};

const EMPTY_HOST_ARCHIVE: HostArchivedSessionsSnapshot = { sessionIds: [], available: false };

interface OpenSessionMenu {
  sessionId: string;
  point: MenuPoint;
  returnFocus: HTMLElement;
}

export const ChatPage: React.FC<{
  onNavigateConsole?: () => void;
  onNavigateStudio?: () => void;
  onNavigateAssemble?: () => void;
  onNavigateFleet?: (batchId?: string) => void;
  onNavigateGraph?: (intent?: { sessionId?: string; nodeId?: string }) => void;
  initialSessionId?: string;
  /** 消费掉 initialSessionId 后回调,由 App 清空 —— 它是一次性跳转意图,不是持久状态。 */
  onInitialSessionConsumed?: () => void;
}> = ({
  onNavigateConsole,
  onNavigateStudio,
  onNavigateAssemble,
  onNavigateFleet,
  onNavigateGraph,
  initialSessionId,
  onInitialSessionConsumed,
}) => {
  const [activeSessionId, setActiveSessionId] = useState(initialSessionId ?? '');
  const [searchQuery, setSearchQuery] = useState('');
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const [pendingPresetId, setPendingPresetId] = useState<string | undefined>(undefined);
  const [isComputerOpen, setIsComputerOpen] = useState(false);
  // undefined = 跟随最新(唯一的「实时」表示法);数字 = 回卷到第 N 项
  const [replayValue, setReplayValue] = useState<number | undefined>(undefined);
  const [optimisticImageMessages, setOptimisticImageMessages] = useState<OptimisticImageMessage[]>([]);
  const [visionCards, setVisionCards] = useState<LocalVisionCard[]>([]);
  const [sessionMeta, setSessionMeta] = useState<SessionMetaSnapshot>(EMPTY_SESSION_META);
  const [sessionMetaAvailable, setSessionMetaAvailable] = useState(false);
  const [hostArchive, setHostArchive] = useState<HostArchivedSessionsSnapshot>(EMPTY_HOST_ARCHIVE);
  const [canRevealPath, setCanRevealPath] = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [remoteSearchIds, setRemoteSearchIds] = useState<string[] | undefined>(undefined);
  const [searchMode, setSearchMode] = useState<'idle' | 'loading' | 'rpc' | 'fallback'>('idle');
  const [titleOverrides, setTitleOverrides] = useState<Record<string, string>>({});
  const [deletedSessionIds, setDeletedSessionIds] = useState<Set<string>>(() => new Set());
  const [openSessionMenu, setOpenSessionMenu] = useState<OpenSessionMenu | undefined>(undefined);
  const [renamingSessionId, setRenamingSessionId] = useState<string | undefined>(undefined);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SessionListItem | undefined>(undefined);
  const [deletePending, setDeletePending] = useState(false);
  const [metaMutationPending, setMetaMutationPending] = useState(false);
  const [renameMutationPending, setRenameMutationPending] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | undefined>(undefined);
  const visionControllersRef = useRef(new Map<string, AbortController>());
  const searchGenerationRef = useRef(0);
  const mutationVersionsRef = useRef(new Map<string, number>());
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const canCreateSessionRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of visionControllersRef.current.values()) controller.abort();
      visionControllersRef.current.clear();
    };
  }, []);

  // 侧栏 / 顶栏 / rail / ⌘K 走同一入口。rail 切页时事件可能先于监听到达,所以还要消费待办标记。
  useEffect(() => {
    const open = (): void => {
      if (canCreateSessionRef.current) setIsNewSessionOpen(true);
    };
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
    };
    if (consumeNewSessionRequest()) {
      if (canCreateSessionRef.current) open();
      else requestNewSession();
    }
    window.addEventListener(NEW_SESSION_EVENT, open);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(NEW_SESSION_EVENT, open);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // 订阅真实 stores
  const liveSessions = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);
  const isStreamOnline = useSyncExternalStore(streamStore.subscribe, streamStore.getSnapshot);
  const liveConnectionPhase = useSyncExternalStore(liveConnectionStore.subscribe, liveConnectionStore.getSnapshot);
  const fleetProgress = useSyncExternalStore(fleetProgressStore.subscribe, fleetProgressStore.getSnapshot);

  useEffect(() => {
    ensureLiveConnection();
  }, []);

  const chatConnectionState = deriveChatConnectionState({
    sessionsLoadedAt: liveSessions.loadedAt,
    sessionsError: liveSessions.error,
    sessionCount: liveSessions.rows.length,
    muxPhase: liveConnectionPhase,
  });
  const disconnectedService = liveConnectionPhase === 'offline' ? 'remote.mux' : 'session.list';
  const liveMode = chatConnectionState === 'ready';
  canCreateSessionRef.current = chatConnectionState === 'empty' || liveMode;
  useEffect(() => {
    if (canCreateSessionRef.current && consumeNewSessionRequest()) setIsNewSessionOpen(true);
  }, [chatConnectionState]);
  const hasActiveLiveSession = liveMode
    && activeSessionId !== ''
    && liveSessions.rows.some((row) => row.sessionId === activeSessionId && !deletedSessionIds.has(row.sessionId));

  useEffect(() => {
    if (!liveMode) return undefined;
    let disposed = false;
    const stopHostArchive = watchHostArchivedSessions((snapshot) => {
      if (!disposed && mountedRef.current) setHostArchive(snapshot);
    });
    void fetchSessionMeta().then((snapshot) => {
      if (!disposed && mountedRef.current) {
        setSessionMeta(snapshot);
        setSessionMetaAvailable(true);
      }
    }).catch(() => {
      if (!disposed && mountedRef.current) setSessionMetaAvailable(false);
    });
    void canHostOpenPath().then((available) => {
      if (!disposed && mountedRef.current) setCanRevealPath(available);
    });
    return () => {
      disposed = true;
      stopHostArchive();
    };
  }, [liveMode]);

  useEffect(() => {
    const query = searchQuery.trim();
    const generation = ++searchGenerationRef.current;
    const controller = new AbortController();
    if (query === '') {
      setRemoteSearchIds(undefined);
      setSearchMode('idle');
      return () => controller.abort();
    }
    if (!liveMode) {
      setRemoteSearchIds(undefined);
      setSearchMode('fallback');
      return () => controller.abort();
    }
    setSearchMode('loading');
    const timer = window.setTimeout(() => {
      void searchSessions(query, controller.signal).then((result) => {
        if (!mountedRef.current || generation !== searchGenerationRef.current) return;
        if (result === undefined) {
          setRemoteSearchIds(undefined);
          setSearchMode('fallback');
        } else {
          setRemoteSearchIds(result.sessionIds);
          setSearchMode('rpc');
        }
      }).catch(() => {
        if (mountedRef.current && generation === searchGenerationRef.current && !controller.signal.aborted) {
          setRemoteSearchIds(undefined);
          setSearchMode('fallback');
        }
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [liveMode, searchQuery]);

  // 空态判定:当前会话已就绪但一条消息都没有(不是「后端有没有会话」)
  const convo = useSyncExternalStore(
    conversationStore.subscribe,
    useCallback(() => conversationStore.getSnapshot(activeSessionId), [activeSessionId])
  );
  const connectionHealth = connectionHealthFromLive({
    muxPhase: liveConnectionPhase,
    clientId: getEventClientId(),
    sessionId: activeSessionId || undefined,
    followPhase: convo.phase,
    followError: convo.error,
  });
  const followUnavailable = deriveConnectionSurface(connectionHealth) === 'follow-unavailable';
  const isEmptyConversation = liveMode && (
    !hasActiveLiveSession
    || (convo.phase === 'live' && !convo.historyIncomplete && !convo.historyRetryable
      && (convo.snapshot?.items.length ?? 0) === 0)
  );
  const activeRunning = liveSessions.rows.find((row) => row.sessionId === activeSessionId)?.running === true;
  const canContinue = canEmptySubmitContinue({
    hasActiveSession: liveMode && hasActiveLiveSession,
    historyReady: convo.phase === 'live',
    historyCount: convo.snapshot?.items.length ?? 0,
    running: activeRunning,
  });

  // 回放:总项数来自 fold 快照;换会话时把回卷位置清掉,否则会把上一个会话的位置带过来
  const replayTotal = useTranscriptItemCount(activeSessionId);
  const evidenceItem = replayValue === undefined ? undefined : convo.snapshot?.items[Math.max(0, Math.floor(replayValue)) - 1];
  const evidencePosition = replayValue === undefined
    ? convo.currentStep
    : evidenceItem?.kind === 'assistant' || evidenceItem?.kind === 'tool'
      ? { turn: evidenceItem.turn, step: evidenceItem.step }
      : undefined;
  useEffect(() => { setReplayValue(undefined); }, [activeSessionId]);
  // 真连接就绪后自动选中最近会话并打开。
  useEffect(() => {
    if (!liveMode) return;
    const hidden = new Set([
      ...sessionMeta.archived,
      ...(hostArchive.available ? hostArchive.sessionIds : sessionMeta.hostArchived),
    ]);
    const exists = liveSessions.rows.some((r) => (
      r.sessionId === activeSessionId
      && !deletedSessionIds.has(r.sessionId)
      && !hidden.has(r.sessionId)
    ));
    if (!exists) {
      const first = pickFirstVisibleSession(
        liveSessions.rows.map((row) => ({ ...row, id: row.sessionId })),
        deletedSessionIds,
        hidden,
      );
      if (first !== undefined) { setActiveSessionId(first.sessionId); openConversation(first.sessionId); }
      else if (activeSessionId !== '') setActiveSessionId('');
    }
  }, [activeSessionId, deletedSessionIds, hostArchive, liveMode, liveSessions.rows, sessionMeta.archived, sessionMeta.hostArchived]);

  const renderedSessions: SessionListItem[] = liveSessions.rows
    .filter((r) => !deletedSessionIds.has(r.sessionId))
    .map((r) => ({
      id: r.sessionId,
      title: titleOverrides[r.sessionId] ?? r.title,
      cwd: r.cwd,
      running: r.running,
      meta: `${r.turns} 轮 · ${(r.tokens / 1000).toFixed(1)}k`,
      time: formatSessionRelativeTime(r.updatedAt),
      updatedAt: r.updatedAt,
    }));

  const effectiveHostArchivedIds = hostArchive.available
    ? hostArchive.sessionIds
    : sessionMeta.hostArchived;
  const hostArchivedIds = useMemo(() => new Set(effectiveHostArchivedIds), [effectiveHostArchivedIds]);
  const archivedIds = useMemo(
    () => new Set([...sessionMeta.archived, ...effectiveHostArchivedIds]),
    [effectiveHostArchivedIds, sessionMeta.archived],
  );
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const remoteMatches = useMemo(() => new Set(remoteSearchIds ?? []), [remoteSearchIds]);
  const filteredSessions = renderedSessions.filter((session) => {
    if (normalizedSearch === '') return true;
    const localMatch = session.title.toLowerCase().includes(normalizedSearch)
      || session.id.toLowerCase().includes(normalizedSearch)
      || session.cwd.toLowerCase().includes(normalizedSearch);
    return localMatch || (searchMode === 'rpc' && remoteMatches.has(session.id));
  });
  const sectionedSessions = useMemo(
    () => partitionSessions(filteredSessions, sessionMeta.pinned, archivedIds),
    [archivedIds, filteredSessions, sessionMeta.pinned],
  );

  const findSessionOpenButton = (sessionId: string): HTMLButtonElement | null => {
    const row = [...document.querySelectorAll<HTMLElement>('[data-session-id]')]
      .find((element) => element.dataset['sessionId'] === sessionId);
    return row?.querySelector<HTMLButtonElement>('.session-row-open') ?? null;
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    openConversation(id);
  };

  useEffect(() => {
    if (!initialSessionId) return;
    setActiveSessionId(initialSessionId);
    openConversation(initialSessionId);
    // 用完即清。不清的话,从控制台点过一次「接入」之后,每次导航回对话页
    // 组件重挂载会再取一次 initialSessionId 并再跑一次这个 effect,
    // **之后每次回来都被强制拉回那条会话**(2026-08-22 验收 P1)。
    onInitialSessionConsumed?.();
  }, [initialSessionId, onInitialSessionConsumed]);

  const openMenuAt = (sessionId: string, point: MenuPoint, returnFocus: HTMLElement): void => {
    if (!liveMode) return;
    setSessionActionError(undefined);
    menuReturnFocusRef.current = returnFocus;
    setOpenSessionMenu({ sessionId, point, returnFocus });
  };

  const handleTogglePin = async (session: SessionListItem): Promise<void> => {
    if (metaMutationPending || renameMutationPending || deletePending) return;
    const pinned = sessionMeta.pinned.includes(session.id);
    const mutationKey = `pin:${session.id}`;
    const generation = (mutationVersionsRef.current.get(mutationKey) ?? 0) + 1;
    mutationVersionsRef.current.set(mutationKey, generation);
    menuReturnFocusRef.current = document.querySelector<HTMLInputElement>('[aria-label="搜索会话"]');
    setMetaMutationPending(true);
    setSessionActionError(undefined);
    setSessionMeta((current) => ({
      ...current,
      pinned: pinned
        ? current.pinned.filter((id) => id !== session.id)
        : [...current.pinned.filter((id) => id !== session.id), session.id],
    }));
    try {
      const snapshot = await setSessionPinned(session.id, !pinned);
      if (mountedRef.current && generation === mutationVersionsRef.current.get(mutationKey)) {
        setSessionMeta((current) => mergePinnedSnapshot(current, snapshot));
      }
    } catch (error) {
      if (mountedRef.current && generation === mutationVersionsRef.current.get(mutationKey)) {
        setSessionMeta((current) => ({
          ...current,
          pinned: pinned
            ? [...current.pinned.filter((id) => id !== session.id), session.id]
            : current.pinned.filter((id) => id !== session.id),
        }));
        setSessionActionError(String((error as Error)?.message ?? error));
      }
    } finally {
      if (mountedRef.current && generation === mutationVersionsRef.current.get(mutationKey)) setMetaMutationPending(false);
    }
  };

  const handleToggleArchive = async (session: SessionListItem): Promise<void> => {
    if (hostArchivedIds.has(session.id) || metaMutationPending || renameMutationPending || deletePending) return;
    const archived = sessionMeta.archived.includes(session.id);
    const mutationKey = `archive:${session.id}`;
    const generation = (mutationVersionsRef.current.get(mutationKey) ?? 0) + 1;
    mutationVersionsRef.current.set(mutationKey, generation);
    menuReturnFocusRef.current = document.querySelector<HTMLInputElement>('[aria-label="搜索会话"]');
    setMetaMutationPending(true);
    setSessionActionError(undefined);
    try {
      const snapshot = await setSessionArchived(session.id, !archived);
      if (mountedRef.current && generation === mutationVersionsRef.current.get(mutationKey)) {
        setSessionMeta((current) => mergeArchivedSnapshot(current, snapshot));
        if (!archived && activeSessionId === session.id) {
          const next = pickFirstVisibleSession(renderedSessions, new Set([session.id]), archivedIds);
          if (next !== undefined) handleSelectSession(next.id);
          else {
            setActiveSessionId('');
            setIsNewSessionOpen(true);
          }
        }
      }
    } catch (error) {
      if (mountedRef.current && generation === mutationVersionsRef.current.get(mutationKey)) {
        setSessionActionError(String((error as Error)?.message ?? error));
      }
    } finally {
      if (mountedRef.current && generation === mutationVersionsRef.current.get(mutationKey)) setMetaMutationPending(false);
    }
  };

  const startRename = (session: SessionListItem): void => {
    if (renameMutationPending || metaMutationPending || deletePending) return;
    setRenamingSessionId(session.id);
    setRenameDraft(session.title);
    setSessionActionError(undefined);
  };

  const cancelRename = (): void => {
    setRenamingSessionId(undefined);
    setRenameDraft('');
  };

  const submitRename = async (session: SessionListItem): Promise<void> => {
    if (renameMutationPending || metaMutationPending || deletePending) return;
    const title = renameDraft.trim();
    if (title === '' || title === session.title) {
      cancelRename();
      return;
    }
    const previousOverride = titleOverrides[session.id];
    const mutationKey = `rename:${session.id}`;
    const generation = (mutationVersionsRef.current.get(mutationKey) ?? 0) + 1;
    mutationVersionsRef.current.set(mutationKey, generation);
    setRenameMutationPending(true);
    setTitleOverrides((current) => ({ ...current, [session.id]: title }));
    cancelRename();
    try {
      const result = await renameSession(session.id, title);
      if (!mountedRef.current || generation !== mutationVersionsRef.current.get(mutationKey)) return;
      if (result.ok) {
        setTitleOverrides((current) => ({ ...current, [session.id]: result.title }));
        return;
      }
      setTitleOverrides((current) => {
        const next = { ...current };
        if (previousOverride === undefined) delete next[session.id];
        else next[session.id] = previousOverride;
        return next;
      });
      setSessionActionError(result.error);
    } finally {
      if (mountedRef.current && generation === mutationVersionsRef.current.get(mutationKey)) setRenameMutationPending(false);
    }
  };

  const copySessionValue = (value: string, label: string): void => {
    void navigator.clipboard.writeText(value).catch((error: unknown) => {
      if (mountedRef.current) setSessionActionError(`${label}拷贝失败：${String((error as Error)?.message ?? error)}`);
    });
  };

  const revealSession = (session: SessionListItem): void => {
    void openHostPath(session.cwd).then((result) => {
      if (mountedRef.current && !result.ok) setSessionActionError(result.error ?? '无法在访达中显示');
    });
  };

  const confirmDeleteSession = async (): Promise<void> => {
    const target = deleteTarget;
    if (target === undefined || target.running || deletePending || metaMutationPending || renameMutationPending) return;
    const mutationKey = `delete:${target.id}`;
    const generation = (mutationVersionsRef.current.get(mutationKey) ?? 0) + 1;
    mutationVersionsRef.current.set(mutationKey, generation);
    setDeletePending(true);
    setSessionActionError(undefined);
    try {
      await trashSession(target.id);
      if (!mountedRef.current || generation !== mutationVersionsRef.current.get(mutationKey)) return;
      setDeletedSessionIds((current) => new Set(current).add(target.id));
      setSessionMeta((current) => ({
        ...current,
        pinned: current.pinned.filter((id) => id !== target.id),
        archived: current.archived.filter((id) => id !== target.id),
      }));
      deleteReturnFocusRef.current = document.querySelector<HTMLInputElement>('[aria-label="搜索会话"]');
      setDeleteTarget(undefined);
      if (activeSessionId === target.id) {
        const next = pickFirstVisibleSession(renderedSessions, new Set([target.id]), archivedIds);
        if (next !== undefined) {
          deleteReturnFocusRef.current = findSessionOpenButton(next.id)
            ?? document.querySelector<HTMLInputElement>('[aria-label="搜索会话"]');
          handleSelectSession(next.id);
        }
        else {
          setActiveSessionId('');
          setIsNewSessionOpen(true);
        }
      }
      void refreshSessions();
    } catch (error) {
      if (mountedRef.current && generation === mutationVersionsRef.current.get(mutationKey)) {
        setSessionActionError(String((error as Error)?.message ?? error));
      }
    } finally {
      if (mountedRef.current && generation === mutationVersionsRef.current.get(mutationKey)) setDeletePending(false);
    }
  };

  const handleSend = async (message: CommandDeckMessage) => {
    if (!liveMode || !hasActiveLiveSession) return { ok: false, error: '事件信道未就绪，请先连接并选择会话' };
    if (convo.phase !== 'live') return { ok: false, error: '本会话事件订阅未就绪，请等待恢复后发送' };
    const result = await sendPromptParts(activeSessionId, message.parts, sessionPromptMode(activeRunning));
    if (mountedRef.current && result.ok && message.images.length > 0) {
      setOptimisticImageMessages((previous) => [...previous, {
        id: message.optimisticId ?? localId('image-message'),
        sessionId: activeSessionId,
        text: message.text,
        images: message.images,
        at: Date.now(),
      }].slice(-20));
    }
    return result;
  };

  /** 权限胶囊点击:滚到流内第一个「未决」审批面板。
   *  已决面板渲染成 .pc-approval-resolved,所以 .approval-panel 只会命中待批的那些。 */
  const handleFocusApproval = (): void => {
    if (!liveMode) return;
    document.querySelector('.chat-scroll-view .approval-panel')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const updateVisionCard = (id: string, update: Partial<LocalVisionCard>) => {
    if (!mountedRef.current) return;
    setVisionCards((previous) => previous.map((card) => card.id === id ? { ...card, ...update } : card));
  };

  const handleAnalyzeImage = (image: ImageAttachmentDraft) => {
    if (!liveMode || !hasActiveLiveSession) return;
    const id = localId('vision');
    const controller = new AbortController();
    visionControllersRef.current.set(id, controller);
    setVisionCards((previous) => [...previous, {
      id,
      sessionId: activeSessionId,
      imageName: image.name,
      state: 'running',
      controller,
    }]);

    void requestVisionAnalysisWithPanelTexts({
      sessionId: activeSessionId,
      name: image.name,
      mime: image.mediaType,
      data: image.data,
    }, { signal: controller.signal }).then((result) => {
      visionControllersRef.current.delete(id);
      if (result.native) {
        const selection = result.selection === null
          ? ''
          : `（${result.selection.provider}/${result.selection.model}）`;
        updateVisionCard(id, {
          state: 'done',
          notice: `当前会话模型${selection}支持原生图片；保留图片并直接发送即可。`,
        });
        return;
      }
      updateVisionCard(id, { state: 'done', result });
    }).catch((error: unknown) => {
      visionControllersRef.current.delete(id);
      if (controller.signal.aborted) {
        updateVisionCard(id, { state: 'cancelled', error: '本次交叉读图已停止。' });
        return;
      }
      if (error instanceof VisionRequestError) {
        updateVisionCard(id, {
          state: 'failed',
          error: error.message,
          panel: error.payload.panel,
        });
        return;
      }
      updateVisionCard(id, { state: 'failed', error: String((error as Error)?.message ?? error) });
    });
  };

  const closeSessionMenu = useCallback(() => {
    const returnFocus = menuReturnFocusRef.current;
    menuReturnFocusRef.current = null;
    setOpenSessionMenu(undefined);
    if (returnFocus !== null) {
      window.requestAnimationFrame(() => {
        if (mountedRef.current && returnFocus.isConnected) returnFocus.focus();
      });
    }
  }, []);
  const resolveDeleteReturnFocus = useCallback(() => deleteReturnFocusRef.current, []);
  const menuSession = openSessionMenu === undefined
    ? undefined
    : renderedSessions.find((session) => session.id === openSessionMenu.sessionId);
  const canUseClipboard = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';

  const renderSessionRow = (session: SessionListItem, options: { pinned?: boolean, archived?: boolean } = {}) => (
    <div
      key={session.id}
      data-session-id={session.id}
      className={`session-row${activeSessionId === session.id ? ' is-active' : ''}${options.archived ? ' is-archived' : ''}`}
      title={session.cwd}
      onContextMenu={(event) => {
        event.preventDefault();
        const openButton = event.currentTarget.querySelector<HTMLButtonElement>('.session-row-open');
        openMenuAt(session.id, { x: event.clientX, y: event.clientY }, openButton ?? event.currentTarget);
      }}
    >
      <button
        type="button"
        className="session-row-open"
        aria-label={`打开会话：${session.title}`}
        aria-current={activeSessionId === session.id ? 'page' : undefined}
        tabIndex={renamingSessionId === session.id ? -1 : 0}
        onClick={() => handleSelectSession(session.id)}
      />
      <div className="session-row-content">
        <div className="session-row-title-line">
          {options.pinned && (
            <svg className="session-row-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
              <path d="M12 14v6" />
            </svg>
          )}
          {session.running && <Dot state="running" size={8} title="会话运行中" />}
          {renamingSessionId === session.id ? (
            <input
              className="session-rename-input"
              aria-label={`重命名会话“${session.title}”`}
              value={renameDraft}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRenameDraft(event.target.value)}
              onBlur={cancelRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submitRename(session);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelRename();
                }
              }}
            />
          ) : (
            <span className="session-row-title" title={session.title}>{session.title}</span>
          )}
          <span className="session-row-time u-num">{session.time}</span>
        </div>
      </div>
      {liveMode && (
        <button
          type="button"
          className="session-row-more"
          aria-label={`管理会话“${session.title}”`}
          title="会话操作"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenuAt(session.id, { x: rect.right, y: rect.bottom }, event.currentTarget);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="19" cy="12" r="1.5" />
          </svg>
        </button>
      )}
    </div>
  );

  return (
    <div className="chat-workspace">
      <aside className="session-sidebar" aria-label="会话侧栏">
        <div className="session-sidebar-header">
          <div className="session-sidebar-heading">
            <span className="u-microlabel">
              会话{chatConnectionState === 'ready' || chatConnectionState === 'empty' ? ` (${renderedSessions.length})` : ''}
            </span>
            <Button
              variant="primary"
              size="sm"
              className="session-new-btn"
              aria-label="新建会话"
              disabled={chatConnectionState === 'connecting' || chatConnectionState === 'disconnected'}
              title={chatConnectionState === 'disconnected' ? 'remote.mux 未连接，当前无法新建会话' : undefined}
              onClick={() => setIsNewSessionOpen(true)}
            >
              <span>+</span>
              <span>新建会话</span>
            </Button>
          </div>
          <div className="session-search">
            <svg className="session-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              aria-label="搜索会话"
              placeholder="搜索标题、目录或对话内容..."
              maxLength={500}
              value={searchQuery}
              disabled={chatConnectionState !== 'ready'}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="session-search-status" role="status" aria-live="polite">
            {searchMode === 'loading' && '正在搜索对话内容…'}
            {searchMode === 'fallback' && searchQuery.trim() !== '' && '内容搜索暂不可用，已按标题、目录和 ID 筛选'}
          </div>
        </div>

        <div className="session-list-scroll">
          {chatConnectionState === 'connecting' && (
            <div className="session-empty-note" role="status">正在连接宿主事件信道…</div>
          )}
          {chatConnectionState === 'disconnected' && (
            <div className="session-empty-note" role="alert">
              {disconnectedService === 'remote.mux'
                ? 'remote.mux 未连接，会话与事件暂不可读。'
                : 'session.list 未连接，会话列表暂不可读。'}
            </div>
          )}
          {chatConnectionState === 'empty' && (
            <div className="session-empty-note" role="status">还没有会话。使用“新建会话”开始。</div>
          )}
          {chatConnectionState === 'ready' && (<>
            {sectionedSessions.pinned.length > 0 && (
              <section className="session-section" aria-labelledby="session-pinned-heading">
                <div className="session-section-heading" id="session-pinned-heading">
                  <span className="u-microlabel">置顶</span>
                  <span className="u-num">{sectionedSessions.pinned.length}</span>
                </div>
                {sectionedSessions.pinned.map((session) => renderSessionRow(session, { pinned: true }))}
              </section>
            )}

            <section className="session-section" aria-labelledby="session-recent-heading">
              <div className="session-section-heading" id="session-recent-heading">
                <span className="u-microlabel">最近</span>
                <span className="u-num">{sectionedSessions.recent.length}</span>
              </div>
              {sectionedSessions.recent.map((session) => renderSessionRow(session))}
              {sectionedSessions.recent.length === 0 && sectionedSessions.pinned.length === 0 && (
                <div className="session-empty-note">没有匹配的会话</div>
              )}
            </section>

            <section className="session-section" aria-labelledby="session-archived-heading">
              <button
                type="button"
                className="session-archive-toggle"
                aria-expanded={archivedExpanded}
                aria-controls="session-archived-list"
                onClick={() => setArchivedExpanded((expanded) => !expanded)}
              >
                <span className="u-microlabel" id="session-archived-heading">已归档 ({sectionedSessions.archived.length})</span>
                <svg className="session-archive-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
              <div
                id="session-archived-list"
                className="session-archive-body"
                style={{ height: archivedExpanded ? `${sectionedSessions.archived.length * 48}px` : '0px' }}
                aria-hidden={!archivedExpanded}
              >
                {archivedExpanded && sectionedSessions.archived.map((session) => renderSessionRow(session, { archived: true }))}
              </div>
            </section>

            <SessionTrashPanel />

            {sessionActionError !== undefined && (
              <div className="session-action-error" role="alert">{sessionActionError}</div>
            )}
          </>)}
        </div>
      </aside>

      {menuSession !== undefined && openSessionMenu !== undefined && (
        <SessionContextMenu
          point={openSessionMenu.point}
          sessionId={menuSession.id}
          cwd={menuSession.cwd}
          title={menuSession.title}
          pinned={sessionMeta.pinned.includes(menuSession.id)}
          archived={sessionMeta.archived.includes(menuSession.id)}
          hostArchived={hostArchivedIds.has(menuSession.id)}
          running={menuSession.running}
          metaAvailable={sessionMetaAvailable}
          managementPending={metaMutationPending || renameMutationPending || deletePending}
          canOpenPath={canRevealPath}
          canUseClipboard={canUseClipboard}
          onClose={closeSessionMenu}
          onTogglePin={() => { void handleTogglePin(menuSession); }}
          onRename={() => {
            menuReturnFocusRef.current = null;
            startRename(menuSession);
          }}
          onToggleArchive={() => { void handleToggleArchive(menuSession); }}
          onReveal={() => revealSession(menuSession)}
          onCopy={copySessionValue}
          onDelete={() => {
            deleteReturnFocusRef.current = openSessionMenu.returnFocus;
            menuReturnFocusRef.current = null;
            setDeleteTarget(menuSession);
          }}
        />
      )}

      {/* 舞台 Stage */}
      <main className={`app-stage${isEmptyConversation || chatConnectionState !== 'ready' ? ' is-empty' : ''}`}>
        <AppTopbar
          title={liveMode
            ? (renderedSessions.find((x) => x.id === activeSessionId)?.title ?? 'AgOS 对话甲板')
            : chatConnectionState === 'connecting'
              ? '正在连接 AgOS'
              : chatConnectionState === 'disconnected'
                ? `${disconnectedService} 未连接`
                : 'AgOS 对话甲板'}
          runningState={renderedSessions.find((x) => x.id === activeSessionId)?.running === true}
          badge={liveMode
            ? (() => {
              const p = liveSessions.rows.find((x) => x.sessionId === activeSessionId)?.agentPreset ?? '';
              const n = PRESET_NAMES[p] ?? p;
              const header = convo.snapshot?.header;
              const parent = header?.parentSession;
              const isSub = header !== undefined && header.origin !== 'top';
              return (
                <>
                  {n !== '' ? <Chip active>{n}</Chip> : undefined}
                  {isSub && (
                    parent !== undefined ? (
                      <button
                        type="button"
                        className="topbar-parent-link"
                        onClick={() => handleSelectSession(parent)}
                        aria-label={`跳回父会话 ${parent}`}
                      >
                        <Chip variant="amber">
                          {`子代理 · 深度 ${header.delegationDepth} · 父会话 #${shortSessionRef(parent)}`}
                        </Chip>
                      </button>
                    ) : (
                      <Chip variant="amber">{`子代理 · 深度 ${header.delegationDepth}`}</Chip>
                    )
                  )}
                </>
              );
            })()
            : undefined}
          rightActions={
            <>
              <span className={`conn-chip ${followUnavailable ? 'is-pending' : isStreamOnline ? 'is-ok' : chatConnectionState === 'connecting' ? 'is-pending' : 'is-off'}`}>
                {followUnavailable ? '会话订阅中断' : isStreamOnline ? '已连接' : chatConnectionState === 'connecting' ? '连接中' : '未连接'}
              </span>
              <TopbarAction
                label="新会话"
                icon={TOPBAR_ICONS.plus}
                variant="primary"
                collapsible={false}
                disabled={chatConnectionState === 'connecting' || chatConnectionState === 'disconnected'}
                title={chatConnectionState === 'disconnected' ? 'remote.mux 未连接，当前无法新建会话' : '新会话 (⌘K)'}
                onClick={() => setIsNewSessionOpen(true)}
              />
              <TopbarAction
                label="AgOS 的电脑"
                icon={TOPBAR_ICONS.console}
                onClick={() => setIsComputerOpen((v) => !v)}
              />
              <TopbarAction label="记忆" icon={TOPBAR_ICONS.graph} onClick={() => onNavigateGraph?.()} />
              <Button variant="primary" size="sm" onClick={onNavigateConsole}>
                控制台概览
              </Button>
            </>
          }
        />

        {/* 消息滚动流只呈现 fold 真值或明确的连接/空状态。 */}
        <div className="chat-scroll-view">
          {chatConnectionState === 'connecting' ? (
            <div className="es-tagline" role="status">正在连接宿主事件信道 remote.mux…</div>
          ) : chatConnectionState === 'disconnected' ? (
            <div className="es-hero" role="alert">
              <div className="es-logotype">{disconnectedService} 未连接</div>
              <div className="es-tagline">
                {disconnectedService === 'remote.mux'
                  ? '宿主事件信道不可达，当前无法读取会话列表与实时事件。'
                  : '宿主会话接口未响应，当前无法确认会话列表；实时输入已停用。'}
              </div>
              <div className="es-tagline">在终端重启本地服务：</div>
              <code>pkill -f 'dsh web --port 3091'; sleep 3; nohup dsh web --port 3091 --no-open &gt;/tmp/dsh.log 2&gt;&amp;1 &amp;</code>
            </div>
          ) : chatConnectionState === 'empty' || isEmptyConversation ? (
            <EmptyStateHero />
          ) : (
            <>
            {followUnavailable && (
              <div className="surface-status surface-status--amber" role="status">
                事件信道在线，但本会话的 follow 暂不可用。
              </div>
            )}
            <HistoryIntegrity
              historyIncomplete={convo.historyIncomplete}
              retryable={convo.historyRetryable}
              loading={convo.historyLoading}
              error={convo.historyError}
              onLoadEarlier={() => { void loadEarlierHistory(activeSessionId); }}
              onRetry={() => { void loadEarlierHistory(activeSessionId); }}
            />
            <LiveTranscript
              sessionId={activeSessionId}
              optimisticImageMessages={optimisticImageMessages}
              replayLimit={replayValue}
              sessionRunning={activeRunning}
              onContinue={canContinue ? () => {
                void handleSend({
                  text: CONTINUE_PROMPT,
                  parts: [{ type: 'text', text: CONTINUE_PROMPT }],
                  images: [],
                });
              } : undefined}
            />
            </>
          )}
          {liveMode && visionCards.filter((card) => card.sessionId === activeSessionId).map((card) => (
            <div className="message-wrap" key={card.id}>
              <VisionArbiterCard
                imageName={card.imageName}
                state={card.state}
                result={card.result}
                panel={card.panel}
                error={card.error}
                notice={card.notice}
                onCancel={() => {
                  card.controller.abort();
                  updateVisionCard(card.id, { state: 'cancelled', error: '本次交叉读图已停止。' });
                }}
                onClose={() => {
                  card.controller.abort();
                  visionControllersRef.current.delete(card.id);
                  setVisionCards((previous) => previous.filter((item) => item.id !== card.id));
                }}
              />
            </div>
          ))}
        </div>

        {liveMode && !isEmptyConversation && replayTotal > 0 && (
          <ReplayScrubber
            sessionId={activeSessionId}
            total={replayTotal}
            value={replayValue ?? replayTotal}
            onChange={setReplayValue}
            onLive={() => setReplayValue(undefined)}
          />
        )}

        {(fleetProgress !== undefined || liveMode) && (
          <div className="progress-dock-stack">
            <ProgressDock
              summary={fleetProgress}
              onSelectBatch={onNavigateFleet}
            />
            {liveMode && <ProgressDock />}
          </div>
        )}

        {liveMode && hasActiveLiveSession ? (
          <>
          <TurnEvidenceStrip sessionId={activeSessionId} turn={evidencePosition?.turn} step={evidencePosition?.step} />
          <CommandDeck sessionId={activeSessionId}
            onSend={handleSend}
            onAnalyzeImage={handleAnalyzeImage}
            onFocusApproval={handleFocusApproval}
            canContinue={canContinue}
            sessionRunning={activeRunning}
            queuedTexts={convo.snapshot?.queuedUserTexts}
          />
          </>
        ) : (
          <div className="session-no-active" role="status">
            <span>
              {chatConnectionState === 'connecting'
                ? '正在连接 remote.mux，输入将在连接完成后可用。'
                : chatConnectionState === 'disconnected'
                  ? `输入已停用：${disconnectedService} 未连接，发送内容无法安全送达宿主。`
                  : chatConnectionState === 'empty'
                    ? '当前没有会话可接收输入，请先新建会话。'
                    : '没有可用会话，请先选择或新建会话。'}
            </span>
            {(chatConnectionState === 'empty' || chatConnectionState === 'ready') && (
              <Button variant="primary" size="sm" aria-label="新建可用会话" onClick={() => setIsNewSessionOpen(true)}>
                新建会话
              </Button>
            )}
          </div>
        )}

        {(chatConnectionState === 'empty' || isEmptyConversation) && (
          <div className="es-below-host">
            <EmptyStateBelow
              onSelectPreset={(presetId) => { setPendingPresetId(presetId); setIsNewSessionOpen(true); }}
              onNavigate={(tab) => { if (tab === 'graph') onNavigateGraph?.(); else if (tab === 'console') onNavigateConsole?.(); }}
              onOpenStudio={onNavigateStudio}
              onOpenAssemble={onNavigateAssemble}
              onOpenSession={handleSelectSession}
            />
          </div>
        )}
      </main>

      {isComputerOpen && (
        <AgosComputer
          sessionId={hasActiveLiveSession ? activeSessionId : undefined}
          onClose={() => setIsComputerOpen(false)}
          onOpenMemory={hasActiveLiveSession
            ? () => onNavigateGraph?.({ sessionId: activeSessionId })
            : undefined}
        />
      )}

      <Modal
        isOpen={deleteTarget !== undefined}
        maxWidth="430px"
        title="删除会话"
        overlayClassName="session-delete-overlay"
        initialFocusSelector=".session-delete-cancel"
        returnFocus={resolveDeleteReturnFocus}
        onClose={() => { if (!deletePending) setDeleteTarget(undefined); }}
        footer={(
          <>
            <Button
              variant="ghost"
              size="sm"
              className="session-delete-cancel"
              aria-label="取消删除会话"
              disabled={deletePending}
              onClick={() => setDeleteTarget(undefined)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              aria-label="确认将会话移入回收站目录"
              disabled={deletePending}
              onClick={() => { void confirmDeleteSession(); }}
            >
              {deletePending ? '正在移动…' : '移入回收站'}
            </Button>
          </>
        )}
      >
        <div className="session-delete-copy">
          <p>确认删除 <strong>{deleteTarget?.title}</strong>？</p>
          <p>会话目录将移入带日期的回收站目录，不会永久销毁，可从磁盘恢复。</p>
          {sessionActionError !== undefined && <p className="session-action-error" role="alert">{sessionActionError}</p>}
        </div>
      </Modal>

      {/* 新建会话弹窗 */}
      <NewSessionModal
        isOpen={isNewSessionOpen}
        initialPresetId={pendingPresetId}
        onClose={() => { setIsNewSessionOpen(false); setPendingPresetId(undefined); }}
        onCreated={(sid, title) => {
          setActiveSessionId(sid);
          if (title !== undefined && title !== '') {
            setTitleOverrides((current) => ({ ...current, [sid]: title }));
          }
          setPendingPresetId(undefined);
        }}
      />
    </div>
  );
};
