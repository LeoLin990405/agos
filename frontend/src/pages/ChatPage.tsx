import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppTopbar, TopbarAction, TOPBAR_ICONS } from '@/components/layout/AppTopbar';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { GoalBanner } from '@/components/chat/GoalBanner';
import { ReasoningBlock } from '@/components/chat/ReasoningBlock';
import { TerminalCard } from '@/components/ui/TerminalCard';
import { DiffCard } from '@/components/ui/DiffCard';
import { SwarmBatchCard } from '@/components/chat/SwarmBatchCard';
import { TeamCard } from '@/components/chat/TeamCard';
import { MemoryCard } from '@/components/chat/MemoryCard';
import { PlanCard } from '@/components/chat/PlanCard';
import { TodoBar } from '@/components/chat/TodoBar';
import { ApprovalPanel } from '@/components/chat/ApprovalPanel';
import { QuestionPanel } from '@/components/chat/QuestionPanel';
import { CommandDeck, type CommandDeckMessage } from '@/components/chat/CommandDeck';
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
  basenameOfPath,
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
import { EmptyStateHero, EmptyStateBelow } from '@/components/chat/EmptyState';
import { NEW_SESSION_EVENT } from '@/components/layout/AppRail';
import '@/design-system/chat-empty.css';
import '@/design-system/session-menu.css';
import {
  canHostOpenPath,
  conversationStore,
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
import { LiveTranscript, useTranscriptItemCount, type OptimisticImageMessage } from '@/pages/chat-transcript';
import { AgosComputer } from '@/components/stage/AgosComputer';
import { ReplayScrubber } from '@/components/stage/ReplayScrubber';

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
  onNavigateGraph?: (nodeId?: string) => void;
}> = ({ onNavigateConsole, onNavigateGraph }) => {
  const [activeSessionId, setActiveSessionId] = useState('1');
  const [searchQuery, setSearchQuery] = useState('');
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const [pendingPresetId, setPendingPresetId] = useState<string | undefined>(undefined);
  const [isComputerOpen, setIsComputerOpen] = useState(false);
  // undefined = 跟随最新(唯一的「实时」表示法);数字 = 回卷到第 N 项
  const [replayValue, setReplayValue] = useState<number | undefined>(undefined);
  const [activeModel, setActiveModel] = useState('DeepSeek-V3');
  const [hasGoal, setHasGoal] = useState(true);
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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of visionControllersRef.current.values()) controller.abort();
      visionControllersRef.current.clear();
    };
  }, []);

  // 侧栏「新会话」按钮与 ⌘K 走同一入口:CustomEvent → 打开建会话弹窗
  useEffect(() => {
    const open = (): void => setIsNewSessionOpen(true);
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
    };
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

  const liveMode = liveSessions.rows.length > 0;
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
  const isEmptyConversation = liveMode && (
    !hasActiveLiveSession
    || (convo.phase === 'live' && (convo.snapshot?.items.length ?? 0) === 0)
  );

  // 回放:总项数来自 fold 快照;换会话时把回卷位置清掉,否则会把上一个会话的位置带过来
  const replayTotal = useTranscriptItemCount(activeSessionId);
  useEffect(() => { setReplayValue(undefined); }, [activeSessionId]);
  // 有真后端时自动选中最近会话并打开(mock id '1' 不可用)
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

  // 真实会话列表映射 (兼顾回退)
  const defaultSessions: SessionListItem[] = [
    {
      id: '1',
      title: '分布式认证令牌轮转与流式事件管道重构',
      cwd: '/Users/leo/Projects/auth-matrix',
      running: true,
      meta: '8 轮 · 38.4k',
      time: '刚刚',
      updatedAt: Date.now(),
    },
    {
      id: '2',
      title: 'PostgreSQL DataConnect 模式迁移回归',
      cwd: '/Users/leo/Projects/dataconnect',
      running: false,
      meta: '14 轮 · 52.1k',
      time: '1小时前',
      updatedAt: Date.now() - 3_600_000,
    },
    {
      id: '3',
      title: 'Seccomp 宿主内核隔离逃逸巡检',
      cwd: '/Users/leo/Projects/security',
      running: false,
      meta: '22 轮 · 84.0k',
      time: '3小时前',
      updatedAt: Date.now() - 10_800_000,
    },
    {
      id: '4',
      title: 'AgOS 遥测甲板设计系统 Token 提取',
      cwd: '/Users/leo/Documents/kimi/workspace/agos-frontend',
      running: false,
      meta: '5 轮 · 19.8k',
      time: '昨天',
      updatedAt: Date.now() - 86_400_000,
    },
  ];

  const renderedSessions: SessionListItem[] =
    liveSessions.rows.length > 0
      ? liveSessions.rows.filter((r) => !deletedSessionIds.has(r.sessionId)).map((r) => ({
          id: r.sessionId,
          title: titleOverrides[r.sessionId] ?? r.title,
          cwd: r.cwd,
          running: r.running,
          meta: `${r.turns} 轮 · ${(r.tokens / 1000).toFixed(1)}k`,
          time: formatSessionRelativeTime(r.updatedAt),
          updatedAt: r.updatedAt,
        }))
      : defaultSessions;

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
    if (liveMode && !hasActiveLiveSession) return { ok: false, error: '请先新建或选择会话' };
    const result = await sendPromptParts(activeSessionId, message.parts);
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
   *  已决面板渲染成 .pc-approval-resolved,所以 .approval-panel 只会命中待批的那些。
   *  只在 liveMode 下动作 —— demo 态流里也有一张展示用的面板,不该被命中。 */
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
    if (liveMode && !hasActiveLiveSession) return;
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
        </div>
        <div className="session-row-cwd" title={session.cwd}>{basenameOfPath(session.cwd)}</div>
        <div className="session-row-meta">
          <span className="u-num">{session.meta}</span>
          <span className="u-num">{session.time}</span>
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
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      <aside className="session-sidebar" aria-label="会话侧栏">
        <div className="session-sidebar-header">
          <div className="session-sidebar-heading">
            <span className="u-microlabel">会话 ({renderedSessions.length})</span>
            <Button
              variant="primary"
              size="sm"
              style={{ padding: '0 10px', gap: '4px' }}
              aria-label="新建会话"
              onClick={() => setIsNewSessionOpen(true)}
            >
              <span style={{ fontSize: '14px', lineHeight: 1 }}>+</span>
              <span>新建会话</span>
            </Button>
          </div>
          <div className="session-search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              aria-label="搜索会话"
              placeholder="搜索标题、目录或对话内容..."
              maxLength={500}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="session-search-status" role="status" aria-live="polite">
            {searchMode === 'loading' && '正在搜索对话内容…'}
            {searchMode === 'fallback' && searchQuery.trim() !== '' && '内容搜索暂不可用，已按标题、目录和 ID 筛选'}
          </div>
        </div>

        <div className="session-list-scroll">
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
              style={{ height: archivedExpanded ? `${sectionedSessions.archived.length * 68}px` : '0px' }}
              aria-hidden={!archivedExpanded}
            >
              {archivedExpanded && sectionedSessions.archived.map((session) => renderSessionRow(session, { archived: true }))}
            </div>
          </section>

          {sessionActionError !== undefined && (
            <div className="session-action-error" role="alert">{sessionActionError}</div>
          )}
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
      <main className={`app-stage${isEmptyConversation ? ' is-empty' : ''}`}>
        <AppTopbar
          title={liveMode
            ? (renderedSessions.find((x) => x.id === activeSessionId)?.title ?? 'AgOS 对话甲板')
            : '分布式认证令牌轮转与流式事件管道重构'}
          badge={liveMode
            ? (() => { const p = liveSessions.rows.find((x) => x.sessionId === activeSessionId)?.agentPreset ?? ''; const n = PRESET_NAMES[p] ?? p; return n !== '' ? <Chip active>{n}</Chip> : undefined; })()
            : <Chip active>{activeModel} · 671B</Chip>}
          rightActions={
            <>

              <div className="telemetry-pill">
                <span className="u-microlabel">RPC 管道</span>
                <span className="val" style={{ color: isStreamOnline ? 'var(--state-done)' : 'var(--state-running)', fontSize: '10.5px' }}>
                  ● {isStreamOnline ? 'ONLINE WS' : 'OFFLINE'}
                </span>
              </div>

              <TopbarAction
                label="AgOS 的电脑"
                icon={TOPBAR_ICONS.console}
                onClick={() => setIsComputerOpen((v) => !v)}
              />
              <TopbarAction label="记忆星图" icon={TOPBAR_ICONS.graph} onClick={() => onNavigateGraph?.()} />
              <Button variant="primary" size="sm" onClick={onNavigateConsole}>
                控制台概览
              </Button>
            </>
          }
        />

        {/* 顶部目标横幅 */}
        {hasGoal && !liveMode && (  /* goal.* 未接线,mock 横幅只在 demo 态 */
          <GoalBanner
            goalId="GOAL-8402"
            title="完成分布式认证租约升级并完成 8 节点 Swarm 攻防 Fuzzing 回归"
            progressPercent={65}
            onClear={() => setHasGoal(false)}
          />
        )}

        {/* 消息滚动流:真后端=fold 真渲染;无后端=展示 mock(demo 态) */}
        <div className="chat-scroll-view">
          {isEmptyConversation ? (
            <EmptyStateHero />
          ) : liveMode ? (
            <LiveTranscript
              sessionId={activeSessionId}
              optimisticImageMessages={optimisticImageMessages}
              replayLimit={replayValue}
            />
          ) : (<>
          {/* 用户 Prompt */}
          <div className="message-wrap">
            <div className="message-user">
              <div className="message-user-header">
                <span style={{ fontWeight: 700, fontSize: '12.5px' }}>Leo (Architect)</span>
                <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>18:42:10</span>
              </div>
              <div style={{ fontSize: '13.5px', lineHeight: 1.6 }}>
                请对 <code>auth-matrix</code> 模块执行深度安全审计与高并发回归。需要拉起 8 节点并发 Swarm 编队，覆盖 Token 重放、内存竞争、Redis Failover 及沙箱边界。最后将修复后的令牌轮转配置写入受保护环境。
              </div>
              <div className="user-attachments">
                <Chip>📎 auth_matrix.go:L1-84</Chip>
                <Chip>📎 jwt_verifier.rs</Chip>
                <Chip>📎 cluster-prod.yaml</Chip>
              </div>
            </div>
          </div>

          {/* 助手消息 */}
          <div className="message-wrap">
            <div className="message-assistant">
              <div className="assistant-meta">
                <span style={{ fontWeight: 700, color: 'var(--state-running)', fontSize: '12px' }}>AgOS Core Agent</span>
                <span>·</span>
                <span className="u-num">耗时 4.2s</span>
                <span>·</span>
                <Chip variant="purple">Swarm Orchestrator</Chip>
              </div>

              {/* Todo 看板条 */}
              <TodoBar
                todos={[
                  { content: '定位 18ms 并发竞争窗', status: 'completed' },
                  { content: '引入分布式租约锁机制', status: 'completed' },
                  { content: 'Swarm 8 节点攻防 Fuzzing 回归', status: 'in_progress' },
                  { content: '记忆沉淀与架构图谱固化', status: 'pending' },
                ]}
              />

              <ReasoningBlock duration="3.4s" tokens="1,420 tokens">
                1. 分析了 <code>auth_matrix.go</code> 中的令牌刷新锁机制，发现并发更新时存在 18ms 的时间窗未加分布式互斥锁。<br />
                2. 规划 8 节点并发 Swarm 编队 (#BATCH-8402)，分别派遣给独立的特化子代理进行 Fuzzing 和故障演练。<br />
                3. 组建特化安全编队，并在完成审计后将经验固化为 Memory 节点写入知识图谱。
              </ReasoningBlock>

              <div style={{ fontSize: '13.5px', lineHeight: 1.6, color: 'var(--text-primary)' }}>
                已为您编排 8 节点并发审计编队 <strong>#BATCH-8402</strong>。在启动 Swarm 前，已在本地隔离容器中通过基础单元测试，以下为测试回执与代码补丁：
              </div>

              {/* 1. 终端卡 */}
              <TerminalCard
                title="bash_exec: cargo test --package auth-matrix --lib"
                command="cargo test --package auth-matrix --lib"
                output={`running 18 tests\ntest token::tests::test_jwt_signature_verify ... ok\ntest token::tests::test_refresh_token_rotation ... ok\ntest matrix::tests::test_acl_permission_grant ... ok\ntest session::tests::test_store_concurrency ... ok\ntest result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.18s`}
                duration="1.2s"
                exitCode={0}
              />

              {/* 2. 代码 Diff 卡 */}
              <DiffCard
                filePath="pkg/auth/token_rotator.rs"
                stats="+4 / -2 行"
                lines={[
                  { type: 'ctx', lineNo: 42, content: '    let current_token = self.store.get_token(session_id).await?;' },
                  { type: 'del', lineNo: 43, content: '    if current_token.is_expired() {' },
                  { type: 'del', lineNo: 44, content: '        return self.issue_new_token(session_id).await;' },
                  { type: 'add', lineNo: 43, content: '    // 加分布式互斥租约，消除 18ms 并发竞争窗' },
                  { type: 'add', lineNo: 44, content: '    let _lease = self.lock_manager.acquire_lease(session_id, Duration::from_millis(500)).await?;' },
                  { type: 'add', lineNo: 45, content: '    if current_token.is_expired() {' },
                  { type: 'add', lineNo: 46, content: '        return self.issue_new_token_atomic(session_id, _lease).await;' },
                  { type: 'ctx', lineNo: 47, content: '    }' },
                ]}
              />

              {/* 3. Team 编队卡 */}
              <TeamCard
                teamId="TEAM-SEC-ALPHA"
                teamName="认证攻防特化编队"
                leader="auth-crypto-auditor"
                members={[
                  { name: 'auth-crypto-auditor', role: 'Leader', model: 'Claude-3.5', status: 'done', currentAction: '已生成密钥对' },
                  { name: 'token-replay-verifier', role: 'Fuzzer', model: 'Qwen-2.5', status: 'done', currentAction: '0 重放注入成功' },
                  { name: 'redis-cluster-failover', role: 'Chaos', model: 'DeepSeek', status: 'running', currentAction: '哨兵重选压测中' },
                ]}
              />

              {/* 4. Swarm 批次卡 (含 CivStrip 投票/晋升门) */}
              <SwarmBatchCard
                batchId="BATCH-8402"
                title="8 节点并发安全巡检与契约回归"
                completedCount={5}
                totalCount={8}
                isRunning={true}
                civStats={{
                  passed: '7/8 赞成',
                  vetoed: 1,
                  gateState: '⚠️ 晋升门阻塞 (等待特权授权)',
                }}
                rows={[
                  { idx: '01', name: 'auth-crypto-auditor', role: '🎭⤴ 审计', provider: 'Claude-3.5', time: '1.2s', state: 'done', stateLabel: '已完成' },
                  { idx: '02', name: 'token-replay-verifier', role: '🎭⛓ 重放', provider: 'Qwen-2.5', time: '2.4s', state: 'done', stateLabel: '已完成' },
                  { idx: '03', name: 'session-store-race-check', role: '🎭⤴ 竞争', provider: 'DeepSeek', time: '3.1s', state: 'done', stateLabel: '已完成' },
                  { idx: '04', name: 'event-mux-benchmark', role: '🎭 基准', provider: 'Local-7B', time: '4.5s', state: 'done', stateLabel: '已完成' },
                  { idx: '05', name: 'jwt-leak-fuzzer', role: '🎭⤴ 模糊', provider: 'Claude-3.5', time: '5.2s', state: 'done', stateLabel: '已完成' },
                  { idx: '06', name: 'redis-cluster-failover', role: '🎭⛓ 演练', provider: 'DeepSeek', time: '12.8s', state: 'running', stateLabel: '处理中' },
                  { idx: '07', name: 'tls-handshake-loadtest', role: '🎭 压测', provider: 'Qwen-2.5', time: '--', state: 'queued', stateLabel: '等待中' },
                  { idx: '08', name: 'sandbox-escape-probe', role: '🎭⛓ 探针', provider: 'DeepSeek', time: '8.9s', state: 'failed', stateLabel: '未成功' },
                ]}
              />

              {/* 5. 记忆沉淀卡 (带新节点生长动效) */}
              <MemoryCard
                memoryId="mem-incident-redis-failover-race"
                category="incident"
                title="Redis 哨兵重选期间租约竞争修复"
                description="沉淀了关于在 18ms 时间窗内通过 LockManager 强互斥租约消除 Token 重放风险的工程结论，已向图谱注入 3 条双链。"
                wikilinks={['proj-swarm-orchestration', 'proj-dataconnect-postgres', 'ref-sym-respiration-spec']}
                bytes={2750}
                onOpenGraph={(id) => onNavigateGraph?.(id)}
              />

              {/* 6. 人工提问面板 (input_required 独立态) */}
              <QuestionPanel
                questionId="q-8402"
                prompt="检测到集群共有 3 个备选 Redis 哨兵节点，请决策是否在演练中允许跨机房多活仲裁？"
                options={[
                  '允许跨机房多活仲裁 (推荐, 延时 +8ms, 高可用最高)',
                  '仅限本地同机房 Failover (延时最低, 无跨域一致性保证)',
                  '使用自建 Paxos 仲裁网关',
                ]}
              />

              {/* 7. 特权审批面板 */}
              <ApprovalPanel
                title="特权操作审批请求: 写入受保护生产配置"
                riskLevel="LEVEL 4 · 高风险"
                actionSummary="write_to_file -> /etc/agos/secrets.env"
                diffSnippet={[
                  '+ AGOS_AUTH_MUTEX_LEASE_MS=500',
                  '+ AGOS_REDIS_FAILOVER_CLUSTER_NODES="10.0.4.11:6379,10.0.4.12:6379"',
                ]}
              />

              {/* 流式指示器 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  marginTop: '6px',
                  padding: '10px 14px',
                  backgroundColor: 'var(--bg-layer-2)',
                  borderRadius: '8px',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div className="stream-live-indicator">
                  <Dot state="running" />
                  <span style={{ fontWeight: 600 }}>正在汇聚 Redis Failover 遥测探针与内核阻断日志...</span>
                  <span className="stream-cursor" />
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                    74.2 tok/s · 18.4s
                  </span>
                  <Button variant="danger" size="sm" style={{ height: '22px', padding: '0 8px' }}>
                    中止
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </>)}
          {visionCards.filter((card) => card.sessionId === activeSessionId).map((card) => (
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

        <ProgressDock />

        {(!liveMode || hasActiveLiveSession) ? (
          <CommandDeck sessionId={hasActiveLiveSession ? activeSessionId : undefined}
            onSend={handleSend}
            onAnalyzeImage={handleAnalyzeImage}
            onFocusApproval={handleFocusApproval}
          />
        ) : (
          <div className="session-no-active" role="status">
            <span>没有可用会话，请先选择或新建会话。</span>
            <Button variant="primary" size="sm" aria-label="新建可用会话" onClick={() => setIsNewSessionOpen(true)}>
              新建会话
            </Button>
          </div>
        )}

        {isEmptyConversation && (
          <div className="es-below-host">
            <EmptyStateBelow
              onSelectPreset={(presetId) => { setPendingPresetId(presetId); setIsNewSessionOpen(true); }}
              onNavigate={(tab) => { if (tab === 'graph') onNavigateGraph?.(); else if (tab === 'console') onNavigateConsole?.(); }}
              onOpenSession={handleSelectSession}
            />
          </div>
        )}
      </main>

      {isComputerOpen && (
        <AgosComputer
          sessionId={hasActiveLiveSession ? activeSessionId : undefined}
          onClose={() => setIsComputerOpen(false)}
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
        onCreated={(sid) => { setActiveSessionId(sid); setPendingPresetId(undefined); }}
      />
    </div>
  );
};
