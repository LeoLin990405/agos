import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PromptContentPart } from '@/contract/api';
import { Button } from '@/components/ui/Button';
import { Dot } from '@/components/ui/Dot';
import { conversationStore } from '@/stores/live';
import { ModelSelector } from './ModelSelector';
import { VoiceInput, type VoiceTranscriptMeta } from './VoiceInput';
import {
  ImageAttachments,
  buildPromptParts,
  type ImageAttachmentDraft,
  type ImageAttachmentSnapshot,
  type ImageAttachmentsHandle,
  type OptimisticImageAttachment,
} from './ImageAttachments';

/** W22(b):本条消息里来自语音识别的片段及其度量。只在确有 ASR 片段时存在。 */
export interface AsrSegment { text: string; meta: VoiceTranscriptMeta }

export interface CommandDeckMessage {
  /** Text persisted by the fold; includes the image-count placeholder. */
  text: string;
  parts: PromptContentPart[];
  images: OptimisticImageAttachment[];
  optimisticId?: string;
  /**
   * 留痕:哪些片段是语音识别来的。PromptContentPart(冻结契约)没有 meta 槽,宿主事件也不收,
   * 所以它今天只到 ChatPage 为止;落盘通道(给 W20 按来源降权)另开,不在本条里。
   */
  provenance?: { asr: AsrSegment[] };
}

export interface CommandDeckSendResult {
  ok: boolean;
  error?: string;
}

export interface CommandDeckProps {
  onSend?: (
    message: CommandDeckMessage,
  ) => CommandDeckSendResult | void | Promise<CommandDeckSendResult | void>;
  onAnalyzeImage?: (image: ImageAttachmentDraft) => void;
  /** 当前会话 id(模型选择器按会话拉真实路由清单)。 */
  sessionId?: string;
  /**
   * 权限胶囊在「有待决审批」时点击的出口:请求把视口滚到流内第一个 ApprovalPanel。
   * 组件自己不碰 deck 之外的 DOM;没给回调就退化成不可点的强调态。
   */
  onFocusApproval?: () => void;
  /**
   * 当前会话已有历史且未在跑时,空提交发送「继续」。
   * 由 ChatPage 按 fold 相位 / running 实值计算,组件自己不猜。
   */
  canContinue?: boolean;
}

let multimodalMessageSequence = 0;
const nextMultimodalMessageId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  multimodalMessageSequence += 1;
  return `${Date.now()}-${multimodalMessageSequence}`;
};

const MULTIMODAL_MESSAGE_MARKER = /\n?<!-- agos-image:([A-Za-z0-9-]+) -->/g;

export const stripMultimodalMessageMarker = (text: string): string =>
  text.replace(MULTIMODAL_MESSAGE_MARKER, '');

/* W5:消息带真图片块时,展示层收起 [图片 ×N] 占位(占位本身仍写进持久文本,
   附件取不回时它是最后的现场说明)。 */
const IMAGE_COUNT_PLACEHOLDER = /\n?\[图片 ×\d+\]/g;

export const stripImagePlaceholder = (text: string): string =>
  text.replace(IMAGE_COUNT_PLACEHOLDER, '');

export function extractMultimodalMessageId(text: string): string | undefined {
  MULTIMODAL_MESSAGE_MARKER.lastIndex = 0;
  return MULTIMODAL_MESSAGE_MARKER.exec(text)?.[1];
}

/** Preserve ASR text that arrives while the submitted prompt RPC is still in flight. */
export function remainingDraftAfterSend(current: string, submitted: string): string {
  if (current === submitted) return '';
  const base = submitted.trimEnd();
  if (base !== '' && current.startsWith(base)) {
    const remainder = current.slice(base.length);
    if (/^\s/.test(remainder)) return remainder.trimStart();
  }
  return current;
}

/** 太短的识别结果(单字 / 纯标点)几乎必然出现在任何手打文本里,不当来源证据。 */
export const ASR_SEGMENT_MIN_CHARS = 2;
const PUNCT_ONLY = /^[\s\p{P}\p{S}]*$/u;
export function isAsrEvidence(text: string): boolean {
  const t = text.trim();
  return [...t].length >= ASR_SEGMENT_MIN_CHARS && !PUNCT_ONLY.test(t);
}

/**
 * 只保留仍出现在提交文本里的 ASR 片段(用户可能删掉/改写了识别结果;改写过的就不算语音来源)。
 * 调用方必须在每次发送后清空片段(见 CommandDeck 的 asrSegmentsRef):否则被删掉的片段会跨消息滞留,
 * 在后面某条恰好含同串的手打消息上被当成语音来源(对抗验证 2026-08-23 P2)。
 */
export function selectAsrSegments(submittedText: string, segments: readonly AsrSegment[]): AsrSegment[] {
  return segments.filter((s) => isAsrEvidence(s.text) && submittedText.includes(s.text.trim()));
}

/** 空提交继续：补发给宿主的原文。不是自动续跑，只在用户点发送/继续时发出。 */
export const CONTINUE_PROMPT = '继续';

/** 有已折叠出的历史、会话当前没在跑，空提交才变成「继续」。空会话 / 折叠中 / 运行中一律不发。 */
export function canEmptySubmitContinue(input: {
  hasActiveSession: boolean;
  historyReady: boolean;
  historyCount: number;
  running: boolean;
}): boolean {
  return input.hasActiveSession && input.historyReady && input.historyCount > 0 && !input.running;
}

export function buildCommandDeckMessage(
  inputText: string,
  snapshot: ImageAttachmentSnapshot,
  asrSegments: readonly AsrSegment[] = [],
  options: { emptyAsContinue?: boolean } = {},
): CommandDeckMessage | null {
  const text = inputText.trim();
  const imageCount = snapshot.items.length;
  if (text === '' && imageCount === 0) {
    if (options.emptyAsContinue !== true) return null;
    return {
      text: CONTINUE_PROMPT,
      parts: [{ type: 'text', text: CONTINUE_PROMPT }],
      images: [],
    };
  }
  const asr = selectAsrSegments(text, asrSegments);
  const optimisticId = imageCount > 0 ? nextMultimodalMessageId() : undefined;
  // fold 当前只投影 text part；把轻量占位写进同一条用户消息，刷新后仍能知道曾带图。
  const persistedText = imageCount > 0
    ? `${text}${text ? '\n\n' : ''}[图片 ×${imageCount}]\n<!-- agos-image:${optimisticId} -->`
    : text;
  return {
    text: persistedText,
    parts: buildPromptParts(persistedText, snapshot.items),
    images: snapshot.optimisticImages,
    ...(optimisticId === undefined ? {} : { optimisticId }),
    ...(asr.length === 0 ? {} : { provenance: { asr } }),
  };
}

/* ==========================================================================
   P1-9 权限胶囊:composer 内常驻的权限 / 审批态
   --------------------------------------------------------------------------
   数据全部来自 fold 快照(conversationStore),没有一处是编的:
   - 待决数 = 快照里 kind==='approval' 且 outcome===undefined 的条目数
     (fold 由 approval/asked 建条目、approval/decided 回填 outcome)。
   - 安静态文案 = 快照的 sandboxMode / approvalPolicy,分别来自
     sandbox/mode 与 approval/policy 事件。
   三样都取不到(无会话 / 未折叠 / 老会话不带这两类事件)则整枚胶囊不渲染。
   语料实测(~/.dsh/sessions-trash-20260820,392 会话)出现过的取值:
     mode   = workspace-write | danger-full-access | read-only
     policy = never | ask
   未登记的取值原样透出,不做猜测性翻译。
   ========================================================================== */

const SANDBOX_LABELS: Record<string, string> = {
  'read-only': '只读',
  'workspace-write': '可写工作区',
  'danger-full-access': '全权访问',
};

/** never 是安静默认,不占宽度;其余策略才需要在胶囊上露出。 */
const APPROVAL_POLICY_LABELS: Record<string, string> = {
  ask: '需审批',
};

export interface PermissionPosture {
  pending: number;
  sandboxMode: string | undefined;
  approvalPolicy: string | undefined;
}

/** 从 fold 快照里读权限态。纯函数,便于测试;拿不到就留 undefined。 */
export function readPermissionPosture(
  snapshot: {
    items: readonly { kind: string, outcome?: string | undefined }[];
    sandboxMode: string | undefined;
    approvalPolicy: string | undefined;
  } | undefined,
): PermissionPosture {
  if (snapshot === undefined) {
    return { pending: 0, sandboxMode: undefined, approvalPolicy: undefined };
  }
  let pending = 0;
  for (const item of snapshot.items) {
    if (item.kind === 'approval' && item.outcome === undefined) pending += 1;
  }
  return { pending, sandboxMode: snapshot.sandboxMode, approvalPolicy: snapshot.approvalPolicy };
}

const ShieldIcon: React.FC = () => (
  <svg
    className="pc-capsule__icon"
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3.2 5 6v5.4c0 4.2 2.8 7.6 7 9.4 4.2-1.8 7-5.2 7-9.4V6z" />
  </svg>
);

const PermissionCapsule: React.FC<{
  sessionId: string | undefined;
  onFocusApproval?: (() => void) | undefined;
}> = ({ sessionId, onFocusApproval }) => {
  const convo = useSyncExternalStore(
    conversationStore.subscribe,
    useCallback(() => conversationStore.getSnapshot(sessionId), [sessionId]),
  );
  const posture = readPermissionPosture(convo.snapshot);

  if (posture.pending > 0) {
    const label = `${posture.pending} 项待批`;
    const body = (
      <>
        <Dot state="running" size={6} />
        <span className="pc-capsule__count">{posture.pending}</span>
        <span>项待批</span>
      </>
    );
    if (onFocusApproval === undefined) {
      // 没有出口就不做成假按钮:只报状态,不承诺跳转。
      return <span className="pc-capsule is-pending" role="status" aria-label={label}>{body}</span>;
    }
    return (
      <button
        type="button"
        className="pc-capsule is-pending"
        onClick={onFocusApproval}
        title="跳到流内第一个待决审批"
        aria-label={`${label},跳到流内第一个待决审批`}
      >
        {body}
      </button>
    );
  }

  const sandboxLabel = posture.sandboxMode === undefined
    ? undefined
    : SANDBOX_LABELS[posture.sandboxMode] ?? posture.sandboxMode;
  const policyLabel = posture.approvalPolicy === undefined
    ? undefined
    : APPROVAL_POLICY_LABELS[posture.approvalPolicy]
      ?? (posture.approvalPolicy === 'never' ? undefined : posture.approvalPolicy);

  // 两样都没有(会话未折叠出这两类事件)就整枚不渲染,不填占位文案。
  if (sandboxLabel === undefined && policyLabel === undefined) return null;

  // title 给原始取值(排障时要看得到 workspace-write 本身);
  // aria-label 跟可见文案一致,窄屏文字收起后仍有可读名字。
  const title = [
    posture.sandboxMode === undefined ? undefined : `沙箱模式:${posture.sandboxMode}`,
    posture.approvalPolicy === undefined ? undefined : `审批策略:${posture.approvalPolicy}`,
  ].filter((line) => line !== undefined).join(' / ');
  const ariaLabel = `权限态:${[sandboxLabel, policyLabel].filter((v) => v !== undefined).join(' ')}`;

  return (
    <span className="pc-capsule" role="status" title={title} aria-label={ariaLabel}>
      <ShieldIcon />
      {sandboxLabel !== undefined && <span className="pc-capsule__value">{sandboxLabel}</span>}
      {sandboxLabel !== undefined && policyLabel !== undefined && (
        <span className="pc-capsule__sep" aria-hidden="true">·</span>
      )}
      {policyLabel !== undefined && <span className="pc-capsule__aux">{policyLabel}</span>}
    </span>
  );
};

export const CommandDeck: React.FC<CommandDeckProps> = ({
  onSend,
  onAnalyzeImage,
  sessionId,
  onFocusApproval,
  canContinue = false,
}) => {
  const [text, setText] = useState('');
  const [swarmMode, setSwarmMode] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [imageCount, setImageCount] = useState(0);
  const imageInputRef = useRef<ImageAttachmentsHandle>(null);
  const sendInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  /** W22(b):本轮输入里尚未随消息发出的 ASR 片段(最多 20 段);每段带到达序号,发送后只保留发送开始之后到达的。 */
  const asrSegmentsRef = useRef<(AsrSegment & { seq: number })[]>([]);
  const asrSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSend = async () => {
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setSendError('');
    try {
      await imageInputRef.current?.settle();
      if (!mountedRef.current) return;
      const snapshot = imageInputRef.current?.getSnapshot() ?? {
        items: [],
        parts: [],
        optimisticImages: [],
      };
      const sendSeq = asrSeqRef.current;
      const emptyAsContinue = canContinue && text.trim() === '' && snapshot.items.length === 0;
      const message = buildCommandDeckMessage(text, snapshot, asrSegmentsRef.current, { emptyAsContinue });
      if (message === null) return;
      const submittedText = text;
      const result = await onSend?.(message);
      if (!mountedRef.current) return;
      if (result?.ok === false) {
        setSendError(result.error || '发送失败，请重试');
        return;
      }
      // ASR may finish while session.prompt is in flight. Clear only the draft
      // that was actually submitted and retain any transcript appended meanwhile.
      setText((current) => remainingDraftAfterSend(current, submittedText));
      // 发送开始前到达的 ASR 片段无论有没有进文本都清掉(被删掉/改写的不能跨消息滞留);发送中才到的留给下一条。
      asrSegmentsRef.current = asrSegmentsRef.current.filter((s) => s.seq >= sendSeq);
      imageInputRef.current?.clear();
      setImageCount(0);
    } catch (error) {
      if (mountedRef.current) setSendError(String((error as Error)?.message ?? error));
    } finally {
      sendInFlightRef.current = false;
      if (mountedRef.current) setSending(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void handleSend();
    }
  };

  return (
    <footer className="chat-input-deck">
      <div
        className="input-box-container"
        aria-busy={sending}
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          void imageInputRef.current?.addFiles(event.dataTransfer.files);
        }}
      >
        <textarea
          className="chat-textarea"
          placeholder={canContinue
            ? '输入新指令，或空提交发送「继续」…'
            : '输入需求、执行指令，或使用 / 唤起工具与技能...'}
          value={text}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => {
            if (imageInputRef.current?.addClipboard(event.clipboardData)) event.preventDefault();
          }}
        />

        <ImageAttachments
          ref={imageInputRef}
          disabled={sending}
          onAnalyze={onAnalyzeImage}
          onChange={(snapshot) => setImageCount(snapshot.items.length)}
        />

        <div className="input-deck-footer">
          <div className="input-deck-tools">
            <VoiceInput
              disabled={sending}
              onTranscript={(transcript, meta) => {
                asrSeqRef.current += 1;
                asrSegmentsRef.current = [...asrSegmentsRef.current, { text: transcript, meta, seq: asrSeqRef.current }].slice(-20);
                setText((previous) => previous.trim()
                  ? `${previous.trimEnd()} ${transcript}`
                  : transcript);
                setSendError('');
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSwarmMode(!swarmMode)}
              title="切换 Swarm 多智能体并发模式"
            >
              <Dot state={swarmMode ? 'running' : 'queued'} size={6} />
              <span>Swarm 并发 ({swarmMode ? '开' : '关'})</span>
            </Button>
            <ModelSelector sessionId={sessionId} />
            <PermissionCapsule sessionId={sessionId} onFocusApproval={onFocusApproval} />
          </div>

          <div className="composer-send">
            <span className="kbd">⌘ + ↵</span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { void handleSend(); }}
              disabled={sending}
              title={canContinue && text.trim() === '' && imageCount === 0
                ? '空输入将发送「继续」，接着当前会话'
                : undefined}
              aria-label={canContinue && text.trim() === '' && imageCount === 0 ? '继续当前会话' : '发送'}
            >
              <span>{sending ? '发送中…' : canContinue && text.trim() === '' && imageCount === 0 ? '继续' : '发送'}</span>
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </Button>
          </div>
        </div>

        {sendError !== '' && (
          <div role="alert" className="composer-error">
            {sendError}
          </div>
        )}
      </div>
    </footer>
  );
};
