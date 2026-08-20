/**
 * ReplayScrubber —— 会话回放刻度条(P1-7)。
 *
 * 受控组件:自己不持任何状态,只把 seek 结果通过 onChange / onLive 发回去。
 * 数据全部来自调用方传入的真实条目总数(LiveTranscript 的 items.length);
 * total <= 0(会话为空或还没折叠出条目)时直接 return null,不渲染空壳。
 *
 * 视觉自绘、行为借原生:透明的 input[type=range] 覆盖在轨道上,拖动、点击、
 * 方向键、Home/End、屏幕阅读器全部由浏览器原生提供,4px 刻度条只负责好看。
 */
import React from 'react';
import { Button } from '@/components/ui/Button';
import '@/design-system/replay-scrubber.css';

export interface ReplayScrubberProps {
  /** 仅用于生成稳定且互不冲突的控件 id(同页多会话时不撞车)。 */
  sessionId: string;
  /** 可回放的条目总数。 */
  total: number;
  /** 当前播放到第几条(1..total)。 */
  value: number;
  /** seek 回调,入参已 clamp 到 [1, total]。 */
  onChange: (next: number) => void;
  /** 「跳到最新」回调。 */
  onLive: () => void;
}

/** 把任意输入收进 [1, total];非有限数按「最新」处理。纯函数,便于测试。 */
export function clampReplayValue(value: number, total: number): number {
  if (total < 1) return 1;
  if (!Number.isFinite(value)) return total;
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > total) return total;
  return rounded;
}

/** 刻度稀疏到能看清才画。上限 40:再密 1px 竖线就糊成一片灰。 */
const TICK_MAX_TOTAL = 40;

const StepBackIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polygon points="18 6.5 9.5 12 18 17.5" fill="currentColor" stroke="none" />
    <line x1="6.5" y1="6" x2="6.5" y2="18" />
  </svg>
);

const StepForwardIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polygon points="6 6.5 14.5 12 6 17.5" fill="currentColor" stroke="none" />
    <line x1="17.5" y1="6" x2="17.5" y2="18" />
  </svg>
);

export const ReplayScrubber: React.FC<ReplayScrubberProps> = ({
  sessionId,
  total,
  value,
  onChange,
  onLive,
}) => {
  if (!Number.isFinite(total) || total < 1) return null;

  const safeTotal = Math.floor(total);
  const current = clampReplayValue(value, safeTotal);
  const atLive = current >= safeTotal;
  const single = safeTotal <= 1;
  /* 填充与把手对齐原生滑块的落点:min 处 0%,max 处 100%。 */
  const percent = single ? 100 : ((current - 1) / (safeTotal - 1)) * 100;
  const inputId = `replay-scrubber-${sessionId}`;

  const tickStyle: React.CSSProperties | undefined =
    safeTotal >= 2 && safeTotal <= TICK_MAX_TOTAL
      ? { backgroundImage: `repeating-linear-gradient(90deg, var(--border-bold) 0 1px, transparent 1px ${100 / safeTotal}%)` }
      : undefined;

  return (
    <div className="rs-root" role="group" aria-label="会话回放">
      <div className="rs-steps">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rs-step"
          onClick={() => onChange(clampReplayValue(current - 1, safeTotal))}
          disabled={current <= 1}
          aria-label="上一步"
          title="上一步"
        >
          <StepBackIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rs-step"
          onClick={() => onChange(clampReplayValue(current + 1, safeTotal))}
          disabled={atLive}
          aria-label="下一步"
          title="下一步"
        >
          <StepForwardIcon />
        </Button>
      </div>

      <div className="rs-bar">
        <input
          id={inputId}
          className="rs-range"
          type="range"
          min={1}
          max={safeTotal}
          step={1}
          value={current}
          disabled={single}
          onChange={(e) => onChange(clampReplayValue(Number(e.currentTarget.value), safeTotal))}
          aria-label="回放进度"
          aria-valuetext={`第 ${current} 条,共 ${safeTotal} 条`}
        />
        <div className="rs-track">
          <div className="rs-fill" style={{ width: `${percent}%` }} />
          {tickStyle !== undefined && <div className="rs-ticks" style={tickStyle} />}
        </div>
        <span className="rs-knob" style={{ left: `${percent}%` }} />
      </div>

      <span className="rs-count u-num">
        {current}
        <span className="rs-total"> / {safeTotal}</span>
      </span>

      {atLive ? (
        <span className="rs-live">
          <span className="rs-live-dot" aria-hidden />
          <span>实时</span>
        </span>
      ) : (
        <Button type="button" variant="ghost" size="sm" className="rs-jump" onClick={onLive}>
          跳到最新
        </Button>
      )}
    </div>
  );
};
