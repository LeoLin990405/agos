import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react';
import type { PromptContentPart } from '@/contract/api';

export const IMAGE_ATTACHMENT_MAX_COUNT = 4;
export const IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type ImageAttachmentMediaType = typeof IMAGE_ATTACHMENT_MEDIA_TYPES[number];

/** One browser-local image, ready both for session.prompt and optimistic display. */
export interface ImageAttachmentDraft {
  id: string;
  name: string;
  mediaType: ImageAttachmentMediaType;
  bytes: number;
  /** Raw base64 required by PromptContentPart; never contains a data URL prefix. */
  data: string;
  /** Persistent browser-display URL suitable for an optimistic message. */
  previewUrl: string;
}

export interface OptimisticImageAttachment {
  id: string;
  name: string;
  mediaType: ImageAttachmentMediaType;
  bytes: number;
  url: string;
}

export interface ImageAttachmentSnapshot {
  items: readonly ImageAttachmentDraft[];
  /** Image-only prompt parts; use buildPromptParts to prepend the text block. */
  parts: PromptContentPart[];
  optimisticImages: OptimisticImageAttachment[];
  error?: string;
}

export interface ImageAttachmentsHandle {
  addFiles(files: readonly File[] | FileList): Promise<void>;
  /** Returns false for a text-only clipboard so the caller can preserve normal paste. */
  addClipboard(clipboardData: DataTransfer): boolean;
  remove(id: string): void;
  /** Waits until every intake already queued (including chained drops) is published. */
  settle(): Promise<void>;
  clear(): void;
  getSnapshot(): ImageAttachmentSnapshot;
}

export interface ImageAttachmentsProps {
  disabled?: boolean;
  className?: string;
  onChange?: (snapshot: ImageAttachmentSnapshot) => void;
  /** Optional cross-vision action owned by the surrounding chat surface. */
  onAnalyze?: (image: ImageAttachmentDraft) => void;
}

export interface PreparedImageFiles {
  attachments: ImageAttachmentDraft[];
  errors: string[];
}

let attachmentSequence = 0;

function nextAttachmentId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  attachmentSequence += 1;
  return `image-${Date.now()}-${attachmentSequence}`;
}

function isImageMediaType(value: string): value is ImageAttachmentMediaType {
  return (IMAGE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * W5 粘贴取图:files 优先;部分浏览器(如 Safari 截图粘贴)files 为空、
 * 图片在 items 里 —— 逐项按 image/* getAsFile 兜底。mime 白名单由
 * prepareImageFiles 统一校验,两条入口同一套口径。
 */
export function clipboardImageFiles(clipboardData: DataTransfer): File[] {
  const fromFiles = Array.from(clipboardData.files ?? []);
  if (fromFiles.length > 0) return fromFiles;
  const out: File[] = [];
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file !== null) out.push(file);
  }
  return out;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const FULL_PREVIEW_MAX_EDGE = 320;
const FALLBACK_IMAGE_PREVIEW = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="#121723"/><path d="M72 174l54-58 38 38 28-30 56 50H72z" fill="#77839a"/><circle cx="212" cy="78" r="22" fill="#77839a"/><text x="160" y="215" fill="#aab2c0" font-family="sans-serif" font-size="16" text-anchor="middle">图片预览不可用</text></svg>',
)}`;

/** Keep optimistic history light: the prompt retains original base64, while UI keeps a bounded thumbnail. */
async function createImagePreview(file: File): Promise<string> {
  if (
    typeof document === 'undefined'
    || typeof Image === 'undefined'
    || typeof URL.createObjectURL !== 'function'
  ) return FALLBACK_IMAGE_PREVIEW;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图片预览解码失败'));
      image.src = objectUrl;
    });
    const scale = Math.min(1, FULL_PREVIEW_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (context === null) return FALLBACK_IMAGE_PREVIEW;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL('image/webp', 0.78);
    return preview.startsWith('data:image/') ? preview : FALLBACK_IMAGE_PREVIEW;
  } catch {
    return FALLBACK_IMAGE_PREVIEW;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Converts bytes without ever constructing or returning a data URL. */
export async function imageFileToAttachment(file: File): Promise<ImageAttachmentDraft> {
  if (!isImageMediaType(file.type)) {
    throw new Error(`${file.name}: 仅支持 PNG、JPEG、WEBP 或 GIF`);
  }
  if (file.size > IMAGE_ATTACHMENT_MAX_BYTES) {
    throw new Error(`${file.name}: 单张图片不能超过 5 MB`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  const data = btoa(binary);
  const mediaType = file.type;
  return {
    id: nextAttachmentId(),
    name: file.name || 'image',
    mediaType,
    bytes: file.size,
    data,
    previewUrl: await createImagePreview(file),
  };
}

/** Validates and reads one intake batch while respecting the already queued count. */
export async function prepareImageFiles(
  files: readonly File[] | FileList,
  currentCount = 0,
): Promise<PreparedImageFiles> {
  const candidates = Array.from(files);
  const attachments: ImageAttachmentDraft[] = [];
  const errors: string[] = [];
  let remaining = Math.max(0, IMAGE_ATTACHMENT_MAX_COUNT - currentCount);
  let countErrorAdded = false;

  for (const file of candidates) {
    if (!isImageMediaType(file.type)) {
      errors.push(`${file.name}: 仅支持 PNG、JPEG、WEBP 或 GIF`);
      continue;
    }
    if (file.size > IMAGE_ATTACHMENT_MAX_BYTES) {
      errors.push(`${file.name}: 单张图片不能超过 5 MB`);
      continue;
    }
    if (remaining === 0) {
      if (!countErrorAdded) errors.push(`最多可添加 ${IMAGE_ATTACHMENT_MAX_COUNT} 张图片`);
      countErrorAdded = true;
      continue;
    }

    try {
      attachments.push(await imageFileToAttachment(file));
      remaining -= 1;
    } catch (error) {
      errors.push(String((error as Error)?.message ?? error));
    }
  }

  return { attachments, errors };
}

export function buildPromptParts(
  text: string,
  images: readonly ImageAttachmentDraft[],
): PromptContentPart[] {
  const parts: PromptContentPart[] = [];
  if (text !== '') parts.push({ type: 'text', text });
  for (const image of images) {
    parts.push({
      type: 'image',
      mediaType: image.mediaType,
      data: image.data,
      name: image.name,
    });
  }
  return parts;
}

export function createImageAttachmentSnapshot(
  items: readonly ImageAttachmentDraft[],
  error?: string,
): ImageAttachmentSnapshot {
  return {
    items,
    parts: buildPromptParts('', items),
    optimisticImages: items.map((image) => ({
      id: image.id,
      name: image.name,
      mediaType: image.mediaType,
      bytes: image.bytes,
      url: image.previewUrl,
    })),
    ...(error === undefined || error === '' ? {} : { error }),
  };
}

/**
 * Image intake surface for the chat composer. It owns its queue and exposes an
 * imperative bridge so the surrounding textarea can forward paste events.
 */
export const ImageAttachments = forwardRef<ImageAttachmentsHandle, ImageAttachmentsProps>(function ImageAttachments(
  { disabled = false, className, onChange, onAnalyze },
  ref,
) {
  const [items, setItems] = useState<ImageAttachmentDraft[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef<ImageAttachmentDraft[]>([]);
  const errorRef = useRef<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);
  const intakeChain = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const publish = useCallback((next: ImageAttachmentDraft[], nextError?: string) => {
    if (!mountedRef.current) return;
    itemsRef.current = next;
    errorRef.current = nextError;
    setItems(next);
    setError(nextError);
    onChange?.(createImageAttachmentSnapshot(next, nextError));
  }, [onChange]);

  const addFiles = useCallback((files: readonly File[] | FileList): Promise<void> => {
    const copiedFiles = Array.from(files);
    const generation = generationRef.current;
    const run = intakeChain.current.then(async () => {
      if (disabled || copiedFiles.length === 0) return;
      const prepared = await prepareImageFiles(copiedFiles, itemsRef.current.length);
      if (!mountedRef.current || generation !== generationRef.current) return;
      publish(
        [...itemsRef.current, ...prepared.attachments],
        prepared.errors.length > 0 ? prepared.errors.join('；') : undefined,
      );
    });
    intakeChain.current = run.catch(() => undefined);
    return run;
  }, [disabled, publish]);

  const remove = useCallback((id: string) => {
    publish(itemsRef.current.filter((item) => item.id !== id));
  }, [publish]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    if (inputRef.current !== null) inputRef.current.value = '';
    publish([]);
  }, [publish]);

  const addClipboard = useCallback((clipboardData: DataTransfer): boolean => {
    const files = clipboardImageFiles(clipboardData);
    if (files.length === 0) return false;
    void addFiles(files);
    return true;
  }, [addFiles]);

  const settle = useCallback(async () => {
    // A completion may enqueue another intake before React has rendered the
    // disabled sending state. Drain until the chain reference stays stable.
    for (;;) {
      const pending = intakeChain.current;
      await pending;
      if (pending === intakeChain.current) return;
    }
  }, []);

  useImperativeHandle(ref, () => ({
    addFiles,
    addClipboard,
    remove,
    settle,
    clear,
    getSnapshot: () => createImageAttachmentSnapshot(itemsRef.current, errorRef.current),
  }), [addClipboard, addFiles, clear, remove, settle]);

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (addClipboard(event.clipboardData)) event.preventDefault();
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    // CommandDeck also accepts drops outside this panel; do not enqueue twice when
    // the drop lands on the panel itself and bubbles to the parent container.
    event.stopPropagation();
    setDragging(false);
    if (!disabled) void addFiles(event.dataTransfer.files);
  };

  return (
    <div
      className={className}
      onPaste={handlePaste}
      onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragOver={(event) => { event.preventDefault(); }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: items.length > 0 ? '9px' : '7px 9px',
        border: `1px dashed ${dragging ? 'var(--state-running)' : 'var(--border-subtle)'}`,
        borderRadius: '10px',
        background: dragging ? 'var(--state-running-bg)' : 'transparent',
        opacity: disabled ? 0.55 : 1,
      }}
      aria-label="图片附件"
    >
      {items.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                position: 'relative',
                width: '72px',
                height: '72px',
                borderRadius: '8px',
                overflow: 'hidden',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-layer-1)',
              }}
              title={`${item.name} · ${formatBytes(item.bytes)}`}
            >
              <img
                src={item.previewUrl}
                alt={item.name}
                style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }}
              />
              <button
                type="button"
                aria-label={`删除 ${item.name}`}
                title={`删除 ${item.name}`}
                disabled={disabled}
                onClick={() => remove(item.id)}
                style={{
                  position: 'absolute',
                  top: '4px',
                  right: '4px',
                  width: '20px',
                  height: '20px',
                  padding: 0,
                  borderRadius: '999px',
                  border: '1px solid rgba(255,255,255,.35)',
                  background: 'rgba(0,0,0,.72)',
                  color: '#fff',
                  cursor: disabled ? 'default' : 'pointer',
                  lineHeight: '17px',
                }}
              >×</button>
              {onAnalyze !== undefined && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onAnalyze(item)}
                  title={`交叉读图: ${item.name}`}
                  style={{
                    position: 'absolute',
                    left: '4px',
                    bottom: '4px',
                    maxWidth: '64px',
                    padding: '2px 5px',
                    borderRadius: '5px',
                    border: '1px solid var(--state-running-border)',
                    background: 'var(--bg-glass)',
                    color: 'var(--state-running)',
                    fontSize: '9.5px',
                    fontWeight: 600,
                    cursor: disabled ? 'default' : 'pointer',
                    backdropFilter: 'blur(8px)',
                  }}
                >交叉读图</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '24px' }}>
        <input
          ref={inputRef}
          type="file"
          accept={IMAGE_ATTACHMENT_MEDIA_TYPES.join(',')}
          multiple
          disabled={disabled}
          aria-label="选择图片"
          style={{ display: 'none' }}
          onChange={(event) => {
            if (event.target.files !== null) void addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={disabled || items.length >= IMAGE_ATTACHMENT_MAX_COUNT}
          onClick={() => inputRef.current?.click()}
          style={{
            padding: '3px 8px',
            borderRadius: '6px',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-layer-1)',
            color: 'var(--text-secondary)',
            fontSize: '11.5px',
            cursor: disabled || items.length >= IMAGE_ATTACHMENT_MAX_COUNT ? 'default' : 'pointer',
          }}
        >选择图片</button>
        <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>
          粘贴或拖入图片 · {items.length}/{IMAGE_ATTACHMENT_MAX_COUNT} · 单张 ≤ 5 MB
        </span>
      </div>

      {error !== undefined && (
        <div role="alert" style={{ color: 'var(--state-failed)', fontSize: '11.5px', lineHeight: 1.45 }}>
          {error}
        </div>
      )}
    </div>
  );
});
