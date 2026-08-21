/**
 * W3 能量门限 VAD(纯函数,可测;零依赖)。
 *
 *  NOTES(按任务书写明):这不是语义判停。业界做法是双层——轻量 VAD(Silero)
 *  判「有没有人声」+ 独立语义判停模型(如 Pipecat Smart Turn v3,8MB int8
 *  ONNX,纯 CPU 10-65ms,看韵律不看文本)判「说完没有」。本模块只做能量层:
 *  检测到过人声后,静音持续 silenceMs 即自动停止。升级路径 = 引入 ONNX 模型
 *  (需要放宽零依赖红线,由 Leo 决定)。
 *
 * 设计要点:
 * - 没检测到人声之前永不自动停(防止「还没开口就被截断」)。
 * - 电平 = 时域样本 RMS,归一化到 0..1(AnalyserNode getByteTimeDomainData
 *   的 128 中位偏移,或任何 float/int 样本数组)。
 */

export interface VadOptions {
  /** 静音持续多少毫秒自动停(默认 1500)。 */
  silenceMs: number;
  /** 人声能量门限(RMS,默认 0.02;环境吵就调高)。 */
  threshold: number;
  /**
   * 需要持续多少毫秒过门限才算「开过口」(默认 200)。
   * 单个探针就 latch 会让一次门响/键盘声在 1.5 秒后触发自动停,录到一段静音、
   * 恰好越过 400ms/1200B 两道下限,被真的送去 ASR(2026-08-21 验收 P1)。
   * 可选:省略时取 VAD_DEFAULTS.minSpeechMs,既有调用方不受影响。
   */
  minSpeechMs?: number;
}

export const VAD_DEFAULTS: VadOptions = { silenceMs: 1500, threshold: 0.02, minSpeechMs: 200 };

export interface VadState {
  /** 本次录音里是否检测到过**持续**人声(没说过话就不许自动停)。 */
  hasSpeech: boolean;
  /** 进入连续静音的时间戳;有声时为 undefined。 */
  silenceSince: number | undefined;
  /** 当前这段连续过门限声音的起始时间戳;不在声音里时为 undefined。 */
  speechSince: number | undefined;
}

export const createVadState = (): VadState => ({
  hasSpeech: false, silenceSince: undefined, speechSince: undefined,
});

/** 时域样本 → RMS 电平(0..1)。字节中位 128;float 样本按 ±1 满幅。 */
export function computeLevel(samples: ArrayLike<number>, center = 128, scale = 128): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = ((samples[i] ?? center) - center) / scale;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / n));
}

export interface VadTickResult {
  state: VadState;
  /** true = 静音超时,调用方应停止录音并提交。 */
  shouldStop: boolean;
}

export function vadTick(
  state: VadState,
  level: number,
  now: number,
  options: VadOptions = VAD_DEFAULTS,
): VadTickResult {
  const minSpeechMs = options.minSpeechMs ?? VAD_DEFAULTS.minSpeechMs ?? 200;
  if (level >= options.threshold) {
    const speechSince = state.speechSince ?? now;
    return {
      state: {
        // 只有连续过门限达到 minSpeechMs 才认作「开过口」;瞬时尖峰不 latch。
        hasSpeech: state.hasSpeech || now - speechSince >= minSpeechMs,
        silenceSince: undefined,
        speechSince,
      },
      shouldStop: false,
    };
  }
  if (!state.hasSpeech) return { state: { ...state, speechSince: undefined }, shouldStop: false };
  const silenceSince = state.silenceSince ?? now;
  return {
    state: { hasSpeech: true, silenceSince, speechSince: undefined },
    shouldStop: now - silenceSince >= options.silenceMs,
  };
}
