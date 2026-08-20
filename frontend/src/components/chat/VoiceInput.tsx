import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dot } from '@/components/ui/Dot';

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing' | 'error';

export type VoiceInputFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface VoiceInputLabels {
  record: string;
  stop: string;
  transcribing: string;
  audioFile: string;
}

export interface VoiceInputProps {
  /** Receives recognised text only. The component never submits the chat. */
  onTranscript: (text: string) => void;
  onStatusChange?: (status: VoiceInputStatus) => void;
  onError?: (error: Error) => void;
  /** Injectable so previews and tests never need the real ASR route. */
  fetchImpl?: VoiceInputFetch;
  endpoint?: string;
  /** Injectable browser seams for deterministic MediaRecorder tests. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createMediaRecorder?: (
    stream: MediaStream,
    options?: MediaRecorderOptions,
  ) => MediaRecorder;
  mediaRecorderOptions?: MediaRecorderOptions;
  mediaConstraints?: MediaStreamConstraints;
  minRecordingMs?: number;
  minRecordingBytes?: number;
  /** The server caps the complete JSON request body, not the source Blob. */
  maxRequestBytes?: number;
  disabled?: boolean;
  className?: string;
  labels?: Partial<VoiceInputLabels>;
}

export interface TranscribeAudioOptions {
  fetchImpl?: VoiceInputFetch;
  endpoint?: string;
  signal?: AbortSignal;
  maxRequestBytes?: number;
}

interface AsrResponse {
  text?: unknown;
  error?: unknown;
}

const DEFAULT_ENDPOINT = '/api/cn/asr';
const DEFAULT_MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const DEFAULT_MIN_RECORDING_MS = 400;
const DEFAULT_MIN_RECORDING_BYTES = 1200;
const FALLBACK_MIME = 'audio/webm';

const DEFAULT_LABELS: VoiceInputLabels = {
  record: '录音',
  stop: '停止',
  transcribing: '转写中…',
  audioFile: '音频文件',
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || '语音输入失败');

const stopTracks = (stream: MediaStream | null): void => {
  stream?.getTracks().forEach((track) => track.stop());
};

/** Exact UTF-8 size of the JSON envelope sent to the host ASR route. */
export const estimateAsrRequestBytes = (audioBytes: number, mime: string): number => {
  const base64Length = 4 * Math.ceil(Math.max(0, audioBytes) / 3);
  return new TextEncoder().encode(JSON.stringify({ audio: '', mime })).byteLength + base64Length;
};

export const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';

  // Keep the argument count well below browser limits for larger audio files.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return globalThis.btoa(binary);
};

/**
 * Shared network path for microphone recordings and selected audio files.
 * The host gateway only accepts JSON, so the Blob is sent as unprefixed base64.
 */
export const transcribeAudioBlob = async (
  blob: Blob,
  options: TranscribeAudioOptions = {},
): Promise<string> => {
  if (blob.size === 0) throw new Error('音频内容为空');

  const mime = blob.type || FALLBACK_MIME;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (estimateAsrRequestBytes(blob.size, mime) > maxRequestBytes) {
    const limitMb = Math.max(1, Math.floor(maxRequestBytes / (1024 * 1024)));
    throw new Error(`音频文件过大（编码后的请求超过 ${limitMb} MB）`);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error('当前环境不支持网络请求');

  let audio: string;
  try {
    audio = await blobToBase64(blob);
  } catch {
    throw new Error('读取音频失败');
  }

  let response: Response;
  try {
    response = await fetchImpl(options.endpoint ?? DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio, mime }),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(`转写请求失败：${messageOf(error)}`);
  }

  let payload: AsrResponse;
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    payload = parsed as AsrResponse;
  } catch {
    throw new Error(response.ok ? '转写服务返回了无效响应' : `转写失败 (${response.status})`);
  }

  if (!response.ok || payload.error) {
    const detail = typeof payload.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : `转写失败 (${response.status})`;
    throw new Error(detail);
  }

  const transcript = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!transcript) throw new Error('没听清，请再试一次');
  return transcript;
};

const formatElapsed = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const MicIcon: React.FC = () => (
  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
  </svg>
);

const AudioFileIcon: React.FC = () => (
  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 18V5l11-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="17" cy="16" r="3" />
  </svg>
);

export const VoiceInput: React.FC<VoiceInputProps> = ({
  onTranscript,
  onStatusChange,
  onError,
  fetchImpl,
  endpoint = DEFAULT_ENDPOINT,
  getUserMedia,
  createMediaRecorder,
  mediaRecorderOptions,
  mediaConstraints,
  minRecordingMs = DEFAULT_MIN_RECORDING_MS,
  minRecordingBytes = DEFAULT_MIN_RECORDING_BYTES,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  disabled = false,
  className = '',
  labels: labelOverrides,
}) => {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const [status, setStatus] = useState<VoiceInputStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  useEffect(() => {
    if (status !== 'recording') return undefined;
    const tick = () => setElapsedMs(Date.now() - startedAtRef.current);
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      abortRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch { /* The stream is released below. */ }
        }
      }
      stopTracks(streamRef.current);
      recorderRef.current = null;
      streamRef.current = null;
      chunksRef.current = [];
    };
  }, []);

  const fail = useCallback((error: unknown) => {
    if (!mountedRef.current) return;
    const normalised = error instanceof Error ? error : new Error(messageOf(error));
    setErrorMessage(normalised.message);
    setStatus('error');
    onError?.(normalised);
  }, [onError]);

  const runTranscription = useCallback(async (blob: Blob, operation: number) => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setErrorMessage('');
    setStatus('transcribing');

    try {
      const transcript = await transcribeAudioBlob(blob, {
        fetchImpl,
        endpoint,
        signal: controller.signal,
        maxRequestBytes,
      });
      if (!mountedRef.current || operation !== operationRef.current) return;
      onTranscript(transcript);
      setStatus('idle');
    } catch (error) {
      if (controller.signal.aborted || operation !== operationRef.current) return;
      fail(error);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [endpoint, fail, fetchImpl, maxRequestBytes, onTranscript]);

  const startRecording = useCallback(async () => {
    if (
      disabled
      || startingRef.current
      || recorderRef.current
      || status === 'recording'
      || status === 'transcribing'
    ) return;

    const browserGetUserMedia = getUserMedia ?? (
      typeof navigator !== 'undefined'
        ? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices)
        : undefined
    );
    const browserCreateRecorder = createMediaRecorder ?? (
      typeof MediaRecorder !== 'undefined'
        ? ((stream: MediaStream, options?: MediaRecorderOptions) => new MediaRecorder(stream, options))
        : undefined
    );
    if (!browserGetUserMedia || !browserCreateRecorder) {
      fail(new Error('此浏览器不支持录音'));
      return;
    }

    startingRef.current = true;
    const operation = ++operationRef.current;
    setErrorMessage('');
    setStatus('idle');

    let stream: MediaStream | null = null;
    try {
      stream = await browserGetUserMedia(mediaConstraints ?? { audio: true });
      if (!mountedRef.current || operation !== operationRef.current) {
        stopTracks(stream);
        return;
      }

      const recorder = browserCreateRecorder(stream, mediaRecorderOptions);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        if (operation !== operationRef.current) return;
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch { /* Tracks are released below. */ }
        }
        stopTracks(streamRef.current);
        streamRef.current = null;
        recorderRef.current = null;
        chunksRef.current = [];
        fail(new Error('录音失败，请重试'));
      };
      recorder.onstop = () => {
        const elapsed = Date.now() - startedAtRef.current;
        const chunks = chunksRef.current;
        const mime = recorder.mimeType || chunks[0]?.type || FALLBACK_MIME;
        const blob = new Blob(chunks, { type: mime });

        stopTracks(streamRef.current);
        streamRef.current = null;
        recorderRef.current = null;
        chunksRef.current = [];

        if (!mountedRef.current || operation !== operationRef.current) return;
        if (elapsed < minRecordingMs || blob.size < minRecordingBytes) {
          fail(new Error('录音太短，请再试一次'));
          return;
        }
        void runTranscription(blob, operation);
      };

      recorder.start();
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setStatus('recording');
    } catch {
      stopTracks(stream);
      streamRef.current = null;
      recorderRef.current = null;
      fail(new Error('拿不到麦克风，请检查系统权限'));
    } finally {
      startingRef.current = false;
    }
  }, [
    createMediaRecorder,
    disabled,
    fail,
    getUserMedia,
    mediaConstraints,
    mediaRecorderOptions,
    minRecordingBytes,
    minRecordingMs,
    runTranscription,
    status,
  ]);

  const stopRecording = useCallback(() => {
    if (status !== 'recording') return;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      stopTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      fail(new Error('录音已意外中断'));
      return;
    }

    setStatus('transcribing');
    try {
      recorder.stop();
    } catch (error) {
      stopTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      fail(error);
    }
  }, [fail, status]);

  const handleRecordClick = useCallback(() => {
    if (status === 'recording') stopRecording();
    else void startRecording();
  }, [startRecording, status, stopRecording]);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || disabled || status === 'recording' || status === 'transcribing') return;
    const operation = ++operationRef.current;
    void runTranscription(file, operation);
  }, [disabled, runTranscription, status]);

  const isBusy = status === 'transcribing';
  const isRecording = status === 'recording';
  const canUseRecordButton = isRecording || (!disabled && !isBusy);

  return (
    <div
      className={`voice-input ${className}`.trim()}
      data-status={status}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}
    >
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={handleRecordClick}
        disabled={!canUseRecordButton}
        aria-pressed={isRecording}
        aria-label={isRecording ? '停止录音并转写' : '开始录音'}
        title={isRecording ? '停止录音并转写' : '录音并转写到输入框'}
        style={isRecording ? {
          color: 'var(--state-running)',
          borderColor: 'var(--state-running-border)',
          background: 'var(--state-running-bg)',
        } : undefined}
      >
        {isRecording ? <Dot state="running" size={6} /> : <MicIcon />}
        <span>{isRecording ? `${labels.stop} ${formatElapsed(elapsedMs)}` : labels.record}</span>
      </Button>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.webm,.wav,.mp3,.m4a,.aac,.ogg,.flac"
        tabIndex={-1}
        aria-hidden="true"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <Button
        variant="ghost"
        size="sm"
        type="button"
        disabled={disabled || isBusy || isRecording}
        onClick={() => fileInputRef.current?.click()}
        title="选择音频文件并转写到输入框"
      >
        <AudioFileIcon />
        <span>{labels.audioFile}</span>
      </Button>

      {isBusy && (
        <small
          aria-live="polite"
          style={{ color: 'var(--text-tertiary)', fontSize: '10.5px' }}
        >
          {labels.transcribing}
        </small>
      )}
      {status === 'error' && errorMessage && (
        <small
          role="alert"
          style={{ color: 'var(--state-failed)', fontSize: '10.5px', lineHeight: 1.3 }}
        >
          {errorMessage}
        </small>
      )}
    </div>
  );
};

export default VoiceInput;
