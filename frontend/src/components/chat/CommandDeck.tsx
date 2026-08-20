import React, { useEffect, useRef, useState } from 'react';
import type { PromptContentPart } from '@/contract/api';
import { Button } from '@/components/ui/Button';
import { Dot } from '@/components/ui/Dot';
import { ModelSelector } from './ModelSelector';
import { VoiceInput } from './VoiceInput';
import {
  ImageAttachments,
  buildPromptParts,
  type ImageAttachmentDraft,
  type ImageAttachmentSnapshot,
  type ImageAttachmentsHandle,
  type OptimisticImageAttachment,
} from './ImageAttachments';

export interface CommandDeckMessage {
  /** Text persisted by the fold; includes the image-count placeholder. */
  text: string;
  parts: PromptContentPart[];
  images: OptimisticImageAttachment[];
  optimisticId?: string;
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

export function buildCommandDeckMessage(
  inputText: string,
  snapshot: ImageAttachmentSnapshot,
): CommandDeckMessage | null {
  const text = inputText.trim();
  const imageCount = snapshot.items.length;
  if (text === '' && imageCount === 0) return null;
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
  };
}

export const CommandDeck: React.FC<CommandDeckProps> = ({
  onSend,
  onAnalyzeImage,
  sessionId,
}) => {
  const [text, setText] = useState('');
  const [swarmMode, setSwarmMode] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const imageInputRef = useRef<ImageAttachmentsHandle>(null);
  const sendInFlightRef = useRef(false);
  const mountedRef = useRef(true);

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
      const message = buildCommandDeckMessage(text, snapshot);
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
      imageInputRef.current?.clear();
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
          placeholder="输入需求、执行指令，或使用 / 唤起工具与技能..."
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
        />

        <div className="input-deck-footer">
          <div className="input-deck-tools">
            <VoiceInput
              disabled={sending}
              onTranscript={(transcript) => {
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
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span className="kbd">⌘ + ↵</span>
            <Button
              variant="primary"
              size="sm"
              style={{ padding: '0 16px' }}
              onClick={() => { void handleSend(); }}
              disabled={sending}
            >
              <span>{sending ? '发送中…' : '发送'}</span>
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </Button>
          </div>
        </div>

        {sendError !== '' && (
          <div role="alert" style={{ color: 'var(--state-failed)', fontSize: '11.5px', lineHeight: 1.45 }}>
            {sendError}
          </div>
        )}
      </div>
    </footer>
  );
};
