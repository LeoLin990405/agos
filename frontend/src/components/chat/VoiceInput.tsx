import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dot } from '@/components/ui/Dot';
import { computeLevel, createVadState, vadTick, VAD_DEFAULTS, type VadState } from './vad-model';

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing' | 'error';

/** W3:录音电平采样器(可注入,测试无需真实音频设备)。sample() 返回 0..1 RMS 电平。 */
export interface VoiceLevelSampler {
  sample: () => number;
  dispose: () => void;
}

/** 浏览器默认采样器:Web Audio AnalyserNode 时域 RMS(零依赖)。拿不到 AudioContext 返回 null(降级为无 VAD/无电平条)。 */
export const createAnalyserSampler = (stream: MediaStream): VoiceLevelSampler | null => {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (Ctor === undefined) return null;
  try {
    const ctx = new Ctor();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    return {
      sample: () => { analyser.getByteTimeDomainData(buf); return computeLevel(buf); },
      dispose: () => { source.disconnect(); void ctx.close().catch(() => undefined); },
    };
  } catch {
    return null;
  }
};

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
  /** W3:静音持续该毫秒数自动停止并提交(默认 1500;0 = 关闭自动停)。 */
  silenceStopMs?: number;
  /** W3:人声能量门限(RMS 0..1,默认 0.02)。 */
  vadThreshold?: number;
  /** W3:电平采样器注入点(测试/预览用);缺省用 AnalyserNode。 */
  createLevelSampler?: (stream: MediaStream) => VoiceLevelSampler | null;
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
  silenceStopMs = VAD_DEFAULTS.silenceMs,
  vadThreshold = VAD_DEFAULTS.threshold,
  createLevelSampler,
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
  // W3:电平采样 / VAD / 自动停
  const [level, setLevel] = useState(0);
  const [levelAvailable, setLevelAvailable] = useState(false);
  const samplerRef = useRef<VoiceLevelSampler | null>(null);
  const levelTimerRef = useRef<number | null>(null);
  const vadRef = useRef<VadState>(createVadState());
  const stoppingRef = useRef(false);
  const stopRecordingRef = useRef<() => void>(() => undefined);

  /** 停采样器与电平定時器(录音结束/出错/卸载都走这里)。 */
  const stopSampler = useCallback(() => {
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    samplerRef.current?.dispose();
    samplerRef.current = null;
    setLevel(0);
    setLevelAvailable(false);
  }, []);

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
      stopSampler();
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
        stopSampler();
        stoppingRef.current = false;
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

        stopSampler();
        stoppingRef.current = false;
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
      stoppingRef.current = false;

      // W3:电平采样 + 能量 VAD。
      // ⚠️ prefers-reduced-motion 是**动画**偏好,不是「可以少听我说话」。原来把整个
      // 采样循环降到 2Hz,于是设了减少动效的用户(常见于前庭障碍)拿到更差的判停:
      // 1.5s 静音窗只剩 3 个采样点,句中停顿容易被误判成说完(2026-08-21 验收 P1)。
      // 现在 VAD 恒定 66Hz 采样,reduced-motion 只降**电平条的视觉刷新**到约 2Hz。
      vadRef.current = createVadState();
      const sampler = (createLevelSampler ?? createAnalyserSampler)(stream);
      samplerRef.current = sampler;
      setLevel(0);
      setLevelAvailable(sampler !== null);
      if (sampler !== null) {
        const reduced = typeof globalThis.matchMedia === 'function'
          && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const visualEvery = reduced ? 8 : 1;
        let ticks = 0;
        levelTimerRef.current = window.setInterval(() => {
          const active = samplerRef.current;
          if (active === null) return;
          const currentLevel = active.sample();
          ticks += 1;
          if (ticks % visualEvery === 0) setLevel(currentLevel);
          if (silenceStopMs > 0 && !stoppingRef.current) {
            const tick = vadTick(vadRef.current, currentLevel, Date.now(), {
              silenceMs: silenceStopMs,
              threshold: vadThreshold,
              minSpeechMs: VAD_DEFAULTS.minSpeechMs,
            });
            vadRef.current = tick.state;
            if (tick.shouldStop) stopRecordingRef.current();
          }
        }, 66);
      }
    } catch {
      stopSampler();
      stopTracks(stream);
      streamRef.current = null;
      recorderRef.current = null;
      fail(new Error('拿不到麦克风，请检查系统权限'));
    } finally {
      startingRef.current = false;
    }
  }, [
    createLevelSampler,
    createMediaRecorder,
    disabled,
    fail,
    getUserMedia,
    mediaConstraints,
    mediaRecorderOptions,
    minRecordingBytes,
    minRecordingMs,
    runTranscription,
    silenceStopMs,
    status,
    stopSampler,
    vadThreshold,
  ]);

  const stopRecording = useCallback(() => {
    if (status !== 'recording' || stoppingRef.current) return;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      stopSampler();
      stopTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      fail(new Error('录音已意外中断'));
      return;
    }

    stoppingRef.current = true;
    setStatus('transcribing');
    try {
      recorder.stop();
    } catch (error) {
      stoppingRef.current = false;
      stopSampler();
      stopTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      fail(error);
    }
  }, [fail, status, stopSampler]);

  // 自动停(VAD)经 ref 调最新 stopRecording,避免定时器闭包里吃过期状态。
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

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

      {/* W3:实时电平条(transform-only,无颜色过渡;reduced-motion 下降视觉刷新)。
          采样器建不起来时**不画** —— 一条恒 0 的电平条看起来像「没听到声音」,
          而 title 还在承诺「说完会自动停」,那条定时器根本没启动(验收 P1)。*/}
      {isRecording && !levelAvailable && (
        <span className="u-microlabel" style={{ color: 'var(--accent-amber)' }}>
          电平不可用,请手动停止
        </span>
      )}
      {isRecording && levelAvailable && (
        <span
          role="meter"
          aria-label="录音电平"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          title={silenceStopMs > 0 ? `说完停顿约 ${(silenceStopMs / 1000).toFixed(1)} 秒自动停止并转写` : '录音电平'}
          style={{
            display: 'inline-block',
            width: '48px',
            height: '4px',
            borderRadius: '2px',
            background: 'var(--border-dim)',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              transformOrigin: 'left center',
              transform: `scaleX(${Math.min(1, level * 3)})`,
              background: 'var(--state-running)',
            }}
          />
        </span>
      )}

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
